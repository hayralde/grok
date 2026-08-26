// ================= State =================
let TOKEN = localStorage.getItem('pcm_token') || null;
let USER = null; // null = visitante (leitura pública, visão supervisor)
let CURRENT_AREA = localStorage.getItem('pcm_area') || 'ELETRICA';
let TASKS = [];
let META = { projectStart: null, projectFinish: null, sectorOrder: [] };
let TEAM = [];
let socket = null;

let statusFilter = 'todas';
let dateFilter = 'todas';
let techFilter = 'todos';
let collapsedState = {};
let sCurveChart = null;
let homeCharts = {}; // area -> Chart
let HOME_DATA = null;

// ---- Custos ----
let CUSTOS = [];
let CUSTOS_RESUMO = null;
let custosDisciplinaFilter = 'todas';
let custosStatusFilter = 'todas';
let custoEditingId = null;
let abcChart = null;

const DISCIPLINA_LABELS = {
  ELETRICA: 'Elétrica', MECANICA: 'Mecânica', TGM: 'TGM',
  INSTRUMENTACAO: 'Instrumentação', CIVIL: 'Civil / Infra', OUTROS: 'Outros',
};
const DISCIPLINA_COLORS = {
  ELETRICA: '#5B9FE3', MECANICA: '#F0A430', TGM: '#A78BFA',
  INSTRUMENTACAO: '#2DD4BF', CIVIL: '#E5484D', OUTROS: '#8494A3',
};
const STATUS_LABELS = {
  PENDENTE: 'Pendente', EM_ANDAMENTO: 'Em andamento', CONCLUIDO: 'Concluído', CANCELADO: 'Cancelado',
};
const MARCOS_PALETTE = ['mb-purple','mb-blue','mb-teal','mb-orange','mb-yellow','mb-red','mb-green','mb-gray'];


const AREA_LABELS = {
  ELETRICA: 'Elétrica',
  MECANICA: 'Mecânica',
  TGM: 'TGM',
};

// ================= API helper =================
async function api(path, opts = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  if (TOKEN) headers['Authorization'] = 'Bearer ' + TOKEN;

  let url = path;
  const method = (opts.method || 'GET').toUpperCase();
  if (method === 'GET') {
    const sep = path.includes('?') ? '&' : '?';
    if (!/[?&]area=/.test(path)) url = path + sep + 'area=' + encodeURIComponent(CURRENT_AREA);
  }

  const res = await fetch(url, Object.assign({}, opts, { headers }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('Erro ' + res.status));
  return data;
}

// ================= Login (optional modal) =================
const loginModal = document.getElementById('loginModalOverlay');
document.getElementById('loginOpenBtn').addEventListener('click', () => {
  document.getElementById('loginError').classList.add('hidden');
  document.getElementById('loginUsername').value = '';
  document.getElementById('loginPassword').value = '';
  loginModal.classList.remove('hidden');
  document.getElementById('loginUsername').focus();
});
document.getElementById('loginCancelBtn').addEventListener('click', () => loginModal.classList.add('hidden'));
loginModal.addEventListener('click', (e) => { if (e.target === loginModal) loginModal.classList.add('hidden'); });
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('loginPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
document.getElementById('loginUsername').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errEl = document.getElementById('loginError');
  errEl.classList.add('hidden');
  try {
    const data = await api('/api/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    TOKEN = data.token;
    USER = data.user;
    localStorage.setItem('pcm_token', TOKEN);
    loginModal.classList.add('hidden');
    applyUserUI();
    await reloadData();
    renderAll();
  } catch (e) {
    errEl.textContent = e.message || 'Usuário ou senha inválidos.';
    errEl.classList.remove('hidden');
  }
}

document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.removeItem('pcm_token');
  TOKEN = null;
  USER = null;
  applyUserUI();
  reloadData().then(renderAll);
});

document.getElementById('backupBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('backupBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Gerando backup...';
  try {
    const res = await fetch('/api/admin/backup', {
      headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || ('Erro ' + res.status));
    }
    const blob = await res.blob();
    // Reaproveita o nome de arquivo sugerido pelo servidor (Content-Disposition)
    const disp = res.headers.get('Content-Disposition') || '';
    const match = /filename="([^"]+)"/.exec(disp);
    const filename = match ? match[1] : `pcm_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    alert('Erro ao gerar backup: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('backupDriveBtn')?.addEventListener('click', async () => {
  const btn = document.getElementById('backupDriveBtn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Enviando ao Drive...';
  try {
    const data = await api('/api/admin/backup/drive', { method: 'POST' });
    const link = data.file?.webViewLink;
    alert('Backup enviado ao Google Drive com sucesso: ' + (data.file?.name || '') + (link ? '\n' + link : ''));
  } catch (e) {
    alert('Erro ao enviar backup ao Google Drive: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

document.getElementById('googleConnectBtn')?.addEventListener('click', () => {
  if (!TOKEN) return;
  // Navegação de página inteira (precisa ir até a tela de login do Google) —
  // por isso o token vai na URL em vez do header Authorization.
  window.location.href = '/api/admin/google-auth/start?token=' + encodeURIComponent(TOKEN);
});

document.getElementById('googleDisconnectBtn')?.addEventListener('click', async () => {
  if (!confirm('Desconectar a conta do Google usada nos backups automáticos? O backup manual continua funcionando; o automático diário para até reconectar.')) return;
  try {
    await api('/api/admin/google-auth/disconnect', { method: 'POST' });
    await refreshGoogleDriveStatus();
  } catch (e) {
    alert('Erro ao desconectar: ' + e.message);
  }
});

/** Atualiza o texto de status e mostra/esconde os botões conforme o estado da conexão com o Google Drive. */
function setGoogleDriveUI(status) {
  const statusEl = document.getElementById('driveStatus');
  const connectBtn = document.getElementById('googleConnectBtn');
  const disconnectBtn = document.getElementById('googleDisconnectBtn');
  const testBtn = document.getElementById('backupDriveBtn');
  if (!statusEl || !connectBtn || !testBtn) return;

  if (!status || !USER || USER.role !== 'admin') {
    statusEl.classList.add('hidden');
    connectBtn.classList.add('hidden');
    disconnectBtn && disconnectBtn.classList.add('hidden');
    testBtn.classList.add('hidden');
    return;
  }
  if (!status.oauthClientConfigured) {
    statusEl.textContent = 'Backup automático: credenciais do Google não configuradas no servidor';
    statusEl.classList.remove('hidden');
    connectBtn.classList.add('hidden');
    disconnectBtn && disconnectBtn.classList.add('hidden');
    testBtn.classList.add('hidden');
    return;
  }
  if (status.connected) {
    statusEl.textContent = 'Google Drive conectado' + (status.email ? ' (' + status.email + ')' : '');
    statusEl.classList.remove('hidden');
    connectBtn.classList.add('hidden');
    disconnectBtn && disconnectBtn.classList.remove('hidden');
    testBtn.classList.remove('hidden');
  } else {
    statusEl.classList.add('hidden');
    connectBtn.classList.remove('hidden');
    disconnectBtn && disconnectBtn.classList.add('hidden');
    testBtn.classList.add('hidden');
  }
}

async function refreshGoogleDriveStatus() {
  try {
    const status = await api('/api/admin/google-auth/status');
    setGoogleDriveUI(status);
  } catch (_) {
    setGoogleDriveUI(null);
  }
}


/** Restringe o seletor de área se o usuário tiver area_scope (ex.: supertgm → só TGM). */
function applyAreaScopeUI() {
  const scope = USER && USER.area_scope ? String(USER.area_scope).toUpperCase() : null;
  document.querySelectorAll('#areaSwitcher .area-btn').forEach(btn => {
    const a = btn.getAttribute('data-area');
    if (!scope) {
      btn.style.display = '';
      btn.disabled = false;
      return;
    }
    const allowed = a === scope;
    btn.style.display = allowed ? '' : 'none';
    btn.disabled = !allowed;
  });
  if (scope && CURRENT_AREA !== scope) {
    CURRENT_AREA = scope;
    localStorage.setItem('pcm_area', CURRENT_AREA);
    document.querySelectorAll('#areaSwitcher .area-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-area') === CURRENT_AREA);
    });
    const sub = document.getElementById('headerSub');
    if (sub) sub.textContent = AREA_LABELS[CURRENT_AREA] || CURRENT_AREA;
  }
}

function applyUserUI() {
  const nameEl = document.getElementById('userName');
  const roleEl = document.getElementById('userRole');
  const loginBtn = document.getElementById('loginOpenBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const adminControls = document.getElementById('adminControls');
  const areaSwitcher = document.getElementById('areaSwitcher');
  const areaHelp = document.getElementById('areaHelpText');
  const headerSub = document.getElementById('headerSub');

  if (USER) {
    nameEl.textContent = USER.nome;
    roleEl.textContent = USER.area_scope ? (USER.role + ' · ' + USER.area_scope) : USER.role;
    loginBtn.classList.add('hidden');
    logoutBtn.classList.remove('hidden');
    adminControls.classList.toggle('hidden', USER.role !== 'admin');
    const backupBtn = document.getElementById('backupBtn');
    if (backupBtn) backupBtn.classList.toggle('hidden', USER.role !== 'admin');
    if (USER.role === 'admin') refreshGoogleDriveStatus(); else setGoogleDriveUI(null);
    const custosAdmin = document.getElementById('custosAdminControls');
    if (custosAdmin) custosAdmin.classList.toggle('hidden', USER.role !== 'admin');
    const custosAcoesHead = document.getElementById('custosAcoesHead');
    if (custosAcoesHead) custosAcoesHead.classList.toggle('hidden', USER.role !== 'admin');
    if (areaSwitcher) {
      const hideSwitcher = USER.role === 'operador' || !!USER.area_scope;
      areaSwitcher.classList.toggle('hidden', hideSwitcher);
    }
    if (headerSub) headerSub.style.display = '';
  } else {
    nameEl.textContent = 'Visitante';
    roleEl.textContent = 'leitura';
    loginBtn.classList.remove('hidden');
    logoutBtn.classList.add('hidden');
    adminControls.classList.add('hidden');
    const backupBtn = document.getElementById('backupBtn');
    if (backupBtn) backupBtn.classList.add('hidden');
    setGoogleDriveUI(null);
    const custosAdmin = document.getElementById('custosAdminControls');
    if (custosAdmin) custosAdmin.classList.add('hidden');
    const custosAcoesHead = document.getElementById('custosAcoesHead');
    if (custosAcoesHead) custosAcoesHead.classList.add('hidden');
    if (areaSwitcher) areaSwitcher.classList.add('hidden');
    if (areaHelp) {
      areaHelp.textContent = '';
      areaHelp.style.display = 'none';
    }
    if (headerSub) headerSub.style.display = 'none';
  }
  setupTabsForRole();
  applyAreaScopeUI();
}

// ================= Area switcher =================
document.querySelectorAll('#areaSwitcher .area-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    const area = btn.getAttribute('data-area');
    if (area === CURRENT_AREA) return;
    if (USER && USER.area_scope && area !== String(USER.area_scope).toUpperCase()) return;
    CURRENT_AREA = area;
    localStorage.setItem('pcm_area', CURRENT_AREA);
    document.querySelectorAll('#areaSwitcher .area-btn').forEach(b => {
      b.classList.toggle('active', b.getAttribute('data-area') === CURRENT_AREA);
    });
    document.getElementById('headerSub').textContent = AREA_LABELS[CURRENT_AREA] || CURRENT_AREA;
    collapsedState = {};
    dateFilter = 'todas';
    techFilter = 'todos';
    document.getElementById('dateChips').innerHTML = '';
    const _tc = document.getElementById('techChips'); if (_tc) { _tc.innerHTML = ''; _tc.dataset.sig = ''; }
    if (sCurveChart) { sCurveChart.destroy(); sCurveChart = null; }
    await reloadData();
    renderAll();
  });
});

function syncAreaSwitcher() {
  document.querySelectorAll('#areaSwitcher .area-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-area') === CURRENT_AREA);
  });
  document.getElementById('headerSub').textContent = AREA_LABELS[CURRENT_AREA] || CURRENT_AREA;
}

// ================= Boot =================
async function tryRestoreSession() {
  if (!TOKEN) return;
  try {
    const data = await api('/api/me');
    USER = data.user;
  } catch (e) {
    localStorage.removeItem('pcm_token');
    TOKEN = null;
    USER = null;
  }
}

async function boot() {
  syncAreaSwitcher();
  applyUserUI();
  applyAreaScopeUI();
  await reloadData();
  setupSocket();
  renderAll();
}

async function reloadData() {
  await loadMeta();
  await loadTasks();
  await loadTeam();
}

function setupTabsForRole() {
  const tabbar = document.getElementById('tabbar');
  let visible;
  if (!USER) {
    // Visitante: só a página inicial (resumo das 3 disciplinas). Custos exige login.
    visible = ['home'];
  } else if (USER.role === 'operador') {
    visible = ['tarefas', 'custos'];
  } else if (USER.role === 'supervisor') {
    visible = ['tarefas', 'gantt', 'scurve', 'equipe', 'custos'];
  } else {
    // admin
    visible = ['tarefas', 'gantt', 'scurve', 'equipe', 'custos'];
  }

  tabbar.querySelectorAll('.tab-btn').forEach(btn => {
    const t = btn.getAttribute('data-tab');
    btn.style.display = visible.includes(t) ? '' : 'none';
  });

  const active = document.querySelector('.tab-btn.active');
  const activeTab = active && visible.includes(active.getAttribute('data-tab'))
    ? active.getAttribute('data-tab')
    : visible[0];
  activateTab(activeTab);
}

function activateTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tab));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'tab-' + tab));
  if (tab === 'home') {
    renderHome();
    setTimeout(() => {
      Object.values(homeCharts).forEach(ch => { try { ch.resize(); } catch (_) {} });
    }, 50);
  }
  if (tab === 'gantt') renderGantt();
  if (tab === 'scurve') {
    renderSCurve();
    if (sCurveChart) setTimeout(() => { try { sCurveChart.resize(); } catch (_) {} }, 40);
  }
  if (tab === 'equipe') renderEquipe();
  if (tab === 'tarefas') renderTarefas();
  if (tab === 'custos') renderCustos();
}

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.getAttribute('data-tab')));
});

// ================= Data loading =================
async function loadMeta() {
  const data = await api('/api/meta');
  META = data;
  applyAreaConfigUI();
}

function applyAreaConfigUI() {
  const cfg = META && META.config;
  const sub = document.getElementById('headerSub');
  if (sub) {
    if (!USER) {
      sub.style.display = 'none';
    } else {
      sub.style.display = '';
      sub.textContent = (cfg && cfg.label) || (AREA_LABELS[CURRENT_AREA] || CURRENT_AREA);
    }
  }
  const help = document.getElementById('areaHelpText');
  if (help) {
    if (!USER) {
      help.textContent = '';
      help.style.display = 'none';
    } else {
      help.textContent = (cfg && cfg.helpText) || '';
      help.style.display = (cfg && cfg.helpText) ? '' : 'none';
    }
  }
  const hoursTitle = document.getElementById('hoursChartTitle');
  if (hoursTitle && cfg) hoursTitle.textContent = cfg.hoursChartTitle || 'Horas por Responsável';
  const hoursSub = document.getElementById('hoursChartSub');
  if (hoursSub && cfg) hoursSub.textContent = cfg.hoursChartSub || 'Planejado vs. Executado';
}
async function loadTasks() {
  const data = await api('/api/tasks');
  TASKS = data.tasks || [];
  if (Object.keys(collapsedState).length === 0 && META.sectorOrder) {
    META.sectorOrder.forEach(s => { collapsedState[s] = true; });
  }
}
async function loadTeam() {
  const data = await api('/api/team');
  TEAM = data.team || [];
}

// ================= Socket.io (real-time) =================
function setupSocket() {
  if (socket) return;
  socket = io();
  socket.on('task-updated', (task) => {
    if (task.area && task.area === CURRENT_AREA) {
      const idx = TASKS.findIndex(t => t.id === task.id);
      if (idx >= 0) TASKS[idx] = task;
      else TASKS.push(task);
    }
    // Dashboard visitante precisa atualizar mesmo se a área ativa for outra
    HOME_DATA = null;
    renderAll();
  });
  socket.on('progress-reset', async (payload) => {
    HOME_DATA = null;
    if (payload && payload.area && payload.area !== CURRENT_AREA) {
      const homeBtn = document.querySelector('.tab-btn[data-tab="home"]');
      if (homeBtn && homeBtn.style.display !== 'none') renderHome();
      return;
    }
    await reloadData();
    renderAll();
  });
  socket.on('custos-atualizado', async () => {
    const active = document.querySelector('.tab-btn.active');
    if (active && active.getAttribute('data-tab') === 'custos') {
      await loadCustos();
      renderCustos();
    }
  });
  socket.on('cronograma-importado', async (payload) => {
    HOME_DATA = null;
    if (payload && payload.area && payload.area !== CURRENT_AREA) {
      renderHome();
      return;
    }
    collapsedState = {};
    if (sCurveChart) { sCurveChart.destroy(); sCurveChart = null; }
    await reloadData();
    renderAll();
  });
}

function renderAll() {
  const activeTab = document.querySelector('.tab-btn.active');
  if (!activeTab) return;
  activateTab(activeTab.getAttribute('data-tab'));
}

// ================= Helpers =================
function dayKey(iso) { return iso.slice(0, 10); }
function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

async function toggleTask(id, done) {
  if (!USER) {
    alert('Faça login para marcar atividades.');
    renderTarefas();
    return;
  }
  try {
    await api('/api/tasks/' + id + '?area=' + encodeURIComponent(CURRENT_AREA), {
      method: 'PATCH',
      body: JSON.stringify({ done, area: CURRENT_AREA }),
    });
    const idx = TASKS.findIndex(t => t.id === id);
    if (idx >= 0) TASKS[idx].done = done;
    HOME_DATA = null;
    renderAll();
  } catch (e) {
    alert('Erro ao atualizar atividade: ' + e.message);
    renderTarefas();
  }
}

// ================= TAB: Tarefas =================
document.querySelectorAll('#statusChips .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    statusFilter = chip.getAttribute('data-status');
    document.querySelectorAll('#statusChips .chip').forEach(c => c.classList.toggle('active', c === chip));
    renderTarefas();
  });
});

function renderTarefas() {
  const listEl = document.getElementById('tarefasList');
  const subEl = document.getElementById('tarefasSub');
  const titleEl = document.getElementById('tarefasTitle');
  if (!listEl) return;

  let tasks = TASKS.slice();
  if (USER && USER.role === 'operador') {
    titleEl.textContent = 'Minhas Atividades';
    subEl.textContent = 'Atividades atribuídas a você (' + USER.nome + ') · ' + (AREA_LABELS[CURRENT_AREA] || CURRENT_AREA);
  } else {
    titleEl.textContent = 'Atividades';
    subEl.textContent = 'Todas as atividades · ' + (AREA_LABELS[CURRENT_AREA] || CURRENT_AREA);
  }

  const canToggle = !!(USER && (USER.role === 'operador' || USER.role === 'admin' || USER.role === 'supervisor'));

  const dateChipsEl = document.getElementById('dateChips');
  const uniqueDays = [...new Set(tasks.map(t => dayKey(t.inicio)))].sort();
  if (dateChipsEl.childElementCount === 0 || dateChipsEl.dataset.count != uniqueDays.length) {
    dateChipsEl.innerHTML = '';
    dateChipsEl.dataset.count = uniqueDays.length;
    const allChip = document.createElement('button');
    allChip.className = 'chip' + (dateFilter === 'todas' ? ' active' : '');
    allChip.textContent = 'Todas as datas';
    allChip.dataset.date = 'todas';
    dateChipsEl.appendChild(allChip);
    uniqueDays.forEach(d => {
      const c = document.createElement('button');
      c.className = 'chip' + (dateFilter === d ? ' active' : '');
      c.dataset.date = d;
      c.textContent = new Date(d + 'T00:00:00').toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
      dateChipsEl.appendChild(c);
    });
    dateChipsEl.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        dateFilter = chip.dataset.date;
        dateChipsEl.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
        renderTarefas();
      });
    });
  }

  // Filtro por executante (técnico / turno / equipe)
  const techChipsEl = document.getElementById('techChips');
  if (techChipsEl) {
    const uniqueTechs = [...new Set(TASKS.map(t => t.tecnico).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
    const sig = uniqueTechs.join('|');
    if (techChipsEl.dataset.sig !== sig) {
      techChipsEl.dataset.sig = sig;
      techChipsEl.innerHTML = '';
      const allT = document.createElement('button');
      allT.className = 'chip' + (techFilter === 'todos' ? ' active' : '');
      allT.dataset.tech = 'todos';
      allT.textContent = 'Todos os executantes';
      techChipsEl.appendChild(allT);
      uniqueTechs.forEach(name => {
        const c = document.createElement('button');
        c.className = 'chip' + (techFilter === name ? ' active' : '');
        c.dataset.tech = name;
        c.textContent = name;
        techChipsEl.appendChild(c);
      });
      techChipsEl.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
          techFilter = chip.dataset.tech;
          techChipsEl.querySelectorAll('.chip').forEach(x => x.classList.toggle('active', x === chip));
          renderTarefas();
        });
      });
    } else {
      techChipsEl.querySelectorAll('.chip').forEach(c => {
        c.classList.toggle('active', c.dataset.tech === techFilter);
      });
    }
  }

  if (statusFilter === 'pendentes') tasks = tasks.filter(t => !t.done);
  if (statusFilter === 'concluidas') tasks = tasks.filter(t => t.done);
  if (dateFilter !== 'todas') tasks = tasks.filter(t => dayKey(t.inicio) === dateFilter);
  if (techFilter !== 'todos') tasks = tasks.filter(t => t.tecnico === techFilter);

  listEl.innerHTML = tasks.map(t => `
    <div class="tarefa-row${canToggle ? ' tarefa-row-clickable' : ''}" data-id="${t.id}" data-done="${t.done ? '1' : '0'}">
      <input type="checkbox" class="task-check" data-id="${t.id}" ${t.done ? 'checked' : ''} ${canToggle ? '' : 'disabled'}>
      <div class="tf-main">
        <div class="tf-name">${t.nome}</div>
        <div class="tf-sector">${t.setor}${(!USER || USER.role !== 'operador') ? ' &middot; ' + t.tecnico + (t.tecnico_tipo === 'EQUIPE' ? ' <span class="badge-equipe">EQUIPE</span>' : '') : ''}</div>
      </div>
      <div class="tf-hours">${t.horas}h</div>
      <div class="tf-date">${fmtDate(t.inicio)} ${new Date(t.inicio).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'})}</div>
    </div>
  `).join('') || '<div style="padding:20px; color:var(--text-dim); text-align:center;">Nenhuma atividade encontrada para este filtro.</div>';

  listEl.querySelectorAll('.task-check').forEach(cb => {
    cb.addEventListener('change', (e) => {
      e.stopPropagation();
      toggleTask(parseInt(e.target.dataset.id, 10), e.target.checked);
    });
    cb.addEventListener('click', (e) => { e.stopPropagation(); });
  });

  // Clique no texto / linha também marca ou desmarca (quando permitido)
  listEl.querySelectorAll('.tarefa-row-clickable').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('input.task-check')) return;
      const id = parseInt(row.dataset.id, 10);
      const cb = row.querySelector('.task-check');
      if (!cb || cb.disabled) return;
      const next = !cb.checked;
      cb.checked = next;
      toggleTask(id, next);
    });
  });
}

// ================= TAB: Gantt =================
document.getElementById('toggleAllGanttBtn')?.addEventListener('click', () => {
  const anyExpanded = Object.values(collapsedState).some(v => !v);
  (META.sectorOrder || []).forEach(s => { collapsedState[s] = anyExpanded; });
  document.getElementById('toggleAllGanttBtn').textContent = anyExpanded ? 'Expandir Todos' : 'Recolher Todos';
  renderGantt();
});

function renderGantt() {
  const ganttBody = document.getElementById('ganttBody');
  const ganttScale = document.getElementById('ganttScale');
  if (!ganttBody || !ganttScale) return;

  if (!META.projectStart || !META.projectFinish) {
    ganttScale.innerHTML = '';
    ganttBody.innerHTML = '<div class="gantt-empty">Sem cronograma nesta área.</div>';
    return;
  }

  const PROJECT_START = new Date(META.projectStart);
  const PROJECT_FINISH = new Date(META.projectFinish);
  const TOTAL_MS = PROJECT_FINISH - PROJECT_START;
  if (TOTAL_MS <= 0) return;

  ganttScale.innerHTML = '';
  let cur = new Date(PROJECT_START); cur.setHours(0, 0, 0, 0);
  while (cur <= PROJECT_FINISH) {
    const left = ((cur - PROJECT_START) / TOTAL_MS) * 100;
    if (left >= 0 && left <= 100) {
      const tick = document.createElement('div');
      tick.className = 'tick';
      tick.style.left = left + '%';
      tick.textContent = cur.toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
      ganttScale.appendChild(tick);
    }
    cur = new Date(cur.getTime() + 24 * 3600 * 1000);
  }

  const tasksBySector = {};
  (META.sectorOrder || []).forEach(s => { tasksBySector[s] = []; });
  TASKS.forEach(t => {
    if (!tasksBySector[t.setor]) tasksBySector[t.setor] = [];
    tasksBySector[t.setor].push(t);
  });

  const orderedSectors = [...(META.sectorOrder || [])];
  Object.keys(tasksBySector).forEach(s => {
    if (!orderedSectors.includes(s)) orderedSectors.push(s);
  });

  ganttBody.innerHTML = '';
  let rowCount = 0;

  orderedSectors.forEach(sector => {
    const tasks = tasksBySector[sector];
    if (!tasks || tasks.length === 0) return;
    const sStart = tasks.reduce((m, t) => Math.min(m, new Date(t.inicio)), Infinity);
    const sFinish = tasks.reduce((m, t) => Math.max(m, new Date(t.fim)), -Infinity);
    const doneCount = tasks.filter(t => t.done).length;
    if (collapsedState[sector] === undefined) collapsedState[sector] = true;

    const hoursTotal = tasks.reduce((s, t) => s + (Number(t.horas) || 0), 0);
    const hoursDone = tasks.filter(t => t.done).reduce((s, t) => s + (Number(t.horas) || 0), 0);
    const pctByHours = hoursTotal > 0 ? (hoursDone / hoursTotal) * 100 : 0;
    const pctByCount = tasks.length ? (doneCount / tasks.length) * 100 : 0;
    // Usa horas; se horas zeradas, usa contagem. Garante avanço visual ao concluir tarefas.
    const pctProgress = hoursTotal > 0 ? pctByHours : pctByCount;

    // Linha do setor: rótulo + barra na MESMA row (alinhamento garantido)
    const secRow = document.createElement('div');
    secRow.className = 'gantt-row';

    const secLeft = document.createElement('div');
    secLeft.className = 'row-left sector-row' + (collapsedState[sector] ? ' collapsed' : '');
    secLeft.innerHTML = `<span class="chev">&#9660;</span><span class="task-name">${sector}</span><span class="sector-count">${doneCount}/${tasks.length}</span>`;
    secLeft.onclick = () => { collapsedState[sector] = !collapsedState[sector]; renderGantt(); };

    const secTrack = document.createElement('div');
    secTrack.className = 'gantt-row-track';
    const secBar = document.createElement('div');
    secBar.className = 'bar sector-bar';
    const leftPct = Math.max(0, ((sStart - PROJECT_START) / TOTAL_MS) * 100);
    const widthPct = Math.max((((sFinish - sStart) / TOTAL_MS) * 100), 0.4);
    secBar.style.left = leftPct + '%';
    secBar.style.width = widthPct + '%';
    secBar.style.minWidth = '12px';
    secBar.title = sector + ': ' + doneCount + '/' + tasks.length + ' · ' + hoursDone.toFixed(1) + 'h / ' + hoursTotal.toFixed(1) + 'h (' + pctProgress.toFixed(0) + '%)';
    const secFill = document.createElement('div');
    secFill.className = 'sector-bar-fill' + (pctProgress >= 99.9 ? ' complete' : (pctProgress > 0 ? ' progress' : ''));
    secFill.style.width = Math.min(100, Math.max(0, pctProgress)) + '%';
    secBar.appendChild(secFill);
    const secLabel = document.createElement('span');
    secLabel.className = 'sector-bar-pct';
    secLabel.textContent = pctProgress.toFixed(0) + '%';
    if (doneCount > 0 && pctProgress < 1) secLabel.textContent = '<1%';
    secBar.appendChild(secLabel);
    secTrack.appendChild(secBar);

    secRow.appendChild(secLeft);
    secRow.appendChild(secTrack);
    ganttBody.appendChild(secRow);
    rowCount++;

    if (collapsedState[sector]) return;

    tasks.forEach(t => {
      const taskRow = document.createElement('div');
      taskRow.className = 'gantt-row';

      const rowLeft = document.createElement('div');
      rowLeft.className = 'row-left';
      rowLeft.innerHTML = `<span class="task-name" title="${t.nome}">${t.nome}</span><span class="task-tech">${t.tecnico}${t.tecnico_tipo === 'EQUIPE' ? ' ·EQ' : ''}</span>`;

      const track = document.createElement('div');
      track.className = 'gantt-row-track';
      const bar = document.createElement('div');
      bar.className = 'bar ' + (t.done ? 'status-done' : 'status-pending');
      bar.style.left = Math.max(0, ((new Date(t.inicio) - PROJECT_START) / TOTAL_MS) * 100) + '%';
      const wPct = Math.max((((new Date(t.fim) - new Date(t.inicio)) / TOTAL_MS) * 100), 0.25);
      bar.style.width = wPct + '%';
      bar.style.minWidth = t.done ? '10px' : '6px';
      bar.title = t.nome + ' (' + t.tecnico + ', ' + t.horas + 'h)';
      track.appendChild(bar);

      taskRow.appendChild(rowLeft);
      taskRow.appendChild(track);
      ganttBody.appendChild(taskRow);
      rowCount++;
    });
  });

  if (!rowCount) {
    ganttBody.innerHTML = '<div class="gantt-empty">Sem atividades nesta área.</div>';
  }
}


// ================= TAB: Curva S =================
function buildHourBuckets() {
  const PROJECT_START = new Date(META.projectStart);
  const PROJECT_FINISH = new Date(META.projectFinish);
  const buckets = [];
  let cur = new Date(PROJECT_START); cur.setMinutes(0, 0, 0);
  const stepMs = 3 * 3600 * 1000;
  const end = new Date(PROJECT_FINISH.getTime() + stepMs);
  while (cur <= end) { buckets.push(new Date(cur)); cur = new Date(cur.getTime() + stepMs); }
  return buckets;
}

function renderSCurve() {
  const canvas = document.getElementById('sCurveChart');
  if (!canvas) return;

  if (!META.projectStart || !META.projectFinish || TASKS.length === 0) {
    document.getElementById('plannedNowReadout').textContent = '0.0%';
    document.getElementById('realNowReadout').textContent = '0.0%';
    if (sCurveChart) { sCurveChart.destroy(); sCurveChart = null; }
    return;
  }

  const buckets = buildHourBuckets();
  const totalHours = TASKS.reduce((s, t) => s + Number(t.horas), 0);

  const planned = buckets.map(d => {
    const h = TASKS.filter(t => new Date(t.fim) <= d).reduce((s, t) => s + Number(t.horas), 0);
    return totalHours > 0 ? +(h / totalHours * 100).toFixed(2) : 0;
  });
  const real = buckets.map(d => {
    const h = TASKS.filter(t => {
      if (!t.done) return false;
      // Curva independente do planejado: usa a data em que a tarefa foi
      // de fato concluída (done_at), não a data planejada (fim).
      const completedAt = t.done_at ? new Date(t.done_at) : new Date(t.fim);
      return completedAt <= d;
    }).reduce((s, t) => s + Number(t.horas), 0);
    return totalHours > 0 ? +(h / totalHours * 100).toFixed(2) : 0;
  });
  const labels = buckets.map(d => d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }));

  const now = new Date();
  const doneHours = TASKS.filter(t => t.done).reduce((s, t) => s + Number(t.horas), 0);
  const realNow = totalHours > 0 ? (doneHours / totalHours * 100) : 0;
  const plannedNow = totalHours > 0 ? (TASKS.filter(t => new Date(t.fim) <= now).reduce((s, t) => s + Number(t.horas), 0) / totalHours * 100) : 0;
  document.getElementById('plannedNowReadout').textContent = plannedNow.toFixed(1) + '%';
  document.getElementById('realNowReadout').textContent = realNow.toFixed(1) + '%';

  if (sCurveChart) {
    sCurveChart.data.labels = labels;
    sCurveChart.data.datasets[0].data = planned;
    sCurveChart.data.datasets[1].data = real;
    sCurveChart.update();
    return;
  }
  sCurveChart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Planejado (%)', data: planned, borderColor: '#F0A430', backgroundColor: 'rgba(240,164,48,0.08)', borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2.5, fill: true, tension: 0.25 },
        { label: 'Real (%)', data: real, borderColor: '#33C481', backgroundColor: 'rgba(51,196,129,0.12)', borderWidth: 2.5, pointRadius: 2, pointHoverRadius: 5, fill: true, tension: 0.25 },
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 12, right: 16, bottom: 8, left: 4 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#121821',
          titleFont: { family: 'IBM Plex Mono', size: 11 },
          bodyFont: { family: 'IBM Plex Mono', size: 12 },
          borderColor: '#232C36',
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (ctx) => ' ' + ctx.dataset.label + ': ' + Number(ctx.parsed.y).toFixed(1) + '%'
          }
        }
      },
      scales: {
        x: {
          grid: { color: '#1A222B' },
          ticks: {
            color: '#8494A3',
            font: { family: 'IBM Plex Mono', size: 11 },
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 12,
            padding: 6
          }
        },
        y: {
          min: 0,
          max: 100,
          grid: { color: '#1A222B' },
          ticks: {
            color: '#8494A3',
            font: { family: 'IBM Plex Mono', size: 11 },
            stepSize: 10,
            padding: 8,
            callback: v => v + '%'
          }
        }
      }
    }
  });
}

// ================= TAB: Equipe =================
function renderEquipe() {
  const cardsRow = document.getElementById('statusCardsRow');
  if (!cardsRow) return;

  const total = TASKS.length;
  const totalHours = TASKS.reduce((s, t) => s + Number(t.horas), 0);
  const doneTasks = TASKS.filter(t => t.done);
  const doneCount = doneTasks.length;
  const doneHours = doneTasks.reduce((s, t) => s + Number(t.horas), 0);
  const pendCount = total - doneCount;
  const pendHours = totalHours - doneHours;
  const pctHoras = totalHours > 0 ? (doneHours / totalHours * 100) : 0;
  const pctAtividades = total > 0 ? (doneCount / total * 100) : 0;

  cardsRow.innerHTML = `
    <div class="kpi">
      <div class="kpi-label">Concluídas</div>
      <div class="kpi-value green">${doneCount}</div>
      <div class="kpi-sub">${doneHours.toFixed(1)} h</div>
      <div class="mini-bar-track"><div class="mini-bar" style="background:var(--green); width:${pctAtividades.toFixed(1)}%;"></div></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Pendentes</div>
      <div class="kpi-value amber">${pendCount}</div>
      <div class="kpi-sub">${pendHours.toFixed(1)} h</div>
      <div class="mini-bar-track"><div class="mini-bar" style="background:var(--amber); width:${(100 - pctAtividades).toFixed(1)}%;"></div></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">% Horas</div>
      <div class="kpi-value" style="color:var(--blue);">${pctHoras.toFixed(1)}%</div>
      <div class="mini-bar-track" style="margin-top:9px;"><div class="mini-bar" style="background:var(--blue); width:${pctHoras.toFixed(1)}%;"></div></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">% Atividades</div>
      <div class="kpi-value" style="color:var(--purple);">${pctAtividades.toFixed(1)}%</div>
      <div class="mini-bar-track" style="margin-top:9px;"><div class="mini-bar" style="background:var(--purple); width:${pctAtividades.toFixed(1)}%;"></div></div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total Planejado</div>
      <div class="kpi-value">${total}</div>
      <div class="kpi-sub">${totalHours.toFixed(0)} h</div>
      <div class="mini-bar-track"><div class="mini-bar" style="background:var(--text-dim); width:100%;"></div></div>
    </div>
  `;

  // Horas por técnico/equipe: mesma fonte do STATUS GERAL (TASKS), sempre em sincronia
  const techBody = document.getElementById('techPanelBody');
  const byTech = {};
  TASKS.forEach(t => {
    const key = t.tecnico || '(sem responsável)';
    if (!byTech[key]) {
      byTech[key] = {
        tecnico: key,
        tecnico_tipo: t.tecnico_tipo || 'PESSOA',
        total_tarefas: 0,
        tarefas_concluidas: 0,
        horas_planejadas: 0,
        horas_concluidas: 0,
      };
    }
    const row = byTech[key];
    row.total_tarefas += 1;
    row.horas_planejadas += Number(t.horas) || 0;
    if (t.tecnico_tipo === 'EQUIPE') row.tecnico_tipo = 'EQUIPE';
    if (t.done) {
      row.tarefas_concluidas += 1;
      row.horas_concluidas += Number(t.horas) || 0;
    }
  });
  const rows = Object.values(byTech).sort((a, b) => b.horas_planejadas - a.horas_planejadas);
  TEAM = rows;

  techBody.innerHTML = rows.length
    ? rows.map(d => {
      const planned = Number(d.horas_planejadas) || 0;
      const doneH = Number(d.horas_concluidas) || 0;
      const pct = planned > 0 ? (doneH / planned * 100) : 0;
      const color = pct >= 99.9 ? 'var(--green)' : (pct > 0 ? 'var(--amber)' : 'var(--text-dim)');
      const isEquipe = d.tecnico_tipo === 'EQUIPE';
      const label = isEquipe
        ? `${d.tecnico} <span class="badge-equipe">EQUIPE</span>`
        : d.tecnico;
      return `
        <div style="display:flex; align-items:center; gap:14px; padding:6px 0; border-bottom:1px solid var(--border-soft); flex-wrap:wrap;">
          <div style="min-width:110px; max-width:160px; font-family:var(--font-mono); font-size:12px;">${label}</div>
          <div style="flex:1; min-width:120px; height:14px; background:var(--panel-alt); border-radius:3px; overflow:hidden;">
            <div style="height:100%; width:${Math.min(100, pct).toFixed(1)}%; background:${color};"></div>
          </div>
          <div style="width:140px; text-align:right; font-family:var(--font-mono); font-size:11px; color:var(--text-muted);">${doneH.toFixed(1)}h / ${planned.toFixed(1)}h</div>
          <div style="width:80px; text-align:right; font-family:var(--font-mono); font-size:11px; color:var(--text-dim);">${d.tarefas_concluidas}/${d.total_tarefas}</div>
          <div style="width:46px; text-align:right; font-family:var(--font-mono); font-size:13px; font-weight:600; color:${color};">${pct.toFixed(0)}%</div>
        </div>`;
    }).join('')
    : '<div style="padding:12px;color:var(--text-dim);">Nenhum responsável nesta área ainda.</div>';
}


// ================= TAB: Início (dashboard 3 disciplinas) =================
async function loadHomeData(force) {
  if (HOME_DATA && !force) return HOME_DATA;
  const res = await fetch('/api/dashboard');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erro ao carregar dashboard');
  HOME_DATA = data;
  return data;
}

function destroyHomeCharts() {
  Object.keys(homeCharts).forEach(k => {
    try { homeCharts[k].destroy(); } catch (_) {}
    delete homeCharts[k];
  });
}

async function renderHome() {
  const grid = document.getElementById('homeGrid');
  if (!grid) return;

  try {
    const data = await loadHomeData(true);
    const order = data.order || ['ELETRICA', 'MECANICA', 'TGM'];
    const areas = data.areas || {};

    destroyHomeCharts();
    grid.innerHTML = order.map(id => {
      const a = areas[id];
      if (!a) return '';
      const hasTasks = a.total > 0;
      return `
        <div class="home-card" data-area="${id}">
          <div class="home-card-head">
            <div class="home-card-title">${a.label || id}</div>
          </div>
          <div class="home-kpis">
            <div class="home-kpi">
              <div class="home-kpi-label">Concluídas</div>
              <div class="home-kpi-value green">${a.done}</div>
              <div class="home-kpi-sub">${Number(a.horasDone || 0).toFixed(0)} h</div>
            </div>
            <div class="home-kpi">
              <div class="home-kpi-label">Pendentes</div>
              <div class="home-kpi-value amber">${a.pending}</div>
              <div class="home-kpi-sub">${Math.max(0, Number(a.horasTotal || 0) - Number(a.horasDone || 0)).toFixed(0)} h</div>
            </div>
            <div class="home-kpi">
              <div class="home-kpi-label">% Atividades</div>
              <div class="home-kpi-value blue">${Number(a.pctAtividades || 0).toFixed(1)}%</div>
              <div class="home-kpi-sub">${a.done}/${a.total}</div>
            </div>
          </div>
          <div class="home-legend">
            <span class="lg-plan">Planejado</span>
            <span class="lg-real">Real</span>
          </div>
          <div class="home-chart-wrap">
            ${hasTasks && a.curve && a.curve.labels && a.curve.labels.length
              ? `<canvas id="homeChart_${id}"></canvas>`
              : `<div class="home-empty">${hasTasks ? 'Sem horizonte de datas para Curva S' : 'Sem cronograma importado nesta disciplina'}</div>`}
          </div>
        </div>`;
    }).join('');

    order.forEach(id => {
      const a = areas[id];
      if (!a || !a.curve || !a.curve.labels || !a.curve.labels.length) return;
      const canvas = document.getElementById('homeChart_' + id);
      if (!canvas || typeof Chart === 'undefined') return;
      homeCharts[id] = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
          labels: a.curve.labels,
          datasets: [
            {
              label: 'Planejado (%)',
              data: a.curve.planned,
              borderColor: '#F0A430',
              backgroundColor: 'rgba(240,164,48,0.08)',
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 3,
              fill: true,
              tension: 0.25,
            },
            {
              label: 'Real (%)',
              data: a.curve.real,
              borderColor: '#33C481',
              backgroundColor: 'rgba(51,196,129,0.12)',
              borderWidth: 2,
              pointRadius: 0,
              pointHoverRadius: 3,
              fill: true,
              tension: 0.25,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#121821',
              titleFont: { family: 'IBM Plex Mono', size: 10 },
              bodyFont: { family: 'IBM Plex Mono', size: 11 },
              callbacks: {
                label: (ctx) => ' ' + ctx.dataset.label + ': ' + Number(ctx.parsed.y).toFixed(1) + '%',
              },
            },
          },
          scales: {
            x: {
              grid: { color: '#1A222B' },
              ticks: {
                color: '#8494A3',
                font: { family: 'IBM Plex Mono', size: 9 },
                maxRotation: 0,
                autoSkip: true,
                maxTicksLimit: 6,
              },
            },
            y: {
              min: 0,
              max: 100,
              grid: { color: '#1A222B' },
              ticks: {
                color: '#8494A3',
                font: { family: 'IBM Plex Mono', size: 9 },
                callback: (v) => v + '%',
              },
            },
          },
        },
      });
    });
  } catch (e) {
    grid.innerHTML = '<div class="home-loading">Erro ao carregar: ' + (e.message || e) + '</div>';
  }
}

// ================= TAB: Custos =================
async function loadCustos() {
  const data = await api('/api/custos');
  CUSTOS = data.custos || [];
}
async function loadCustosResumo() {
  CUSTOS_RESUMO = await api('/api/custos/resumo');
}

function fmtBRL(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
}
function fmtDateBR(iso) {
  if (!iso) return '—';
  const d = new Date(iso + (String(iso).length <= 10 ? 'T00:00:00' : ''));
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function statusBadgeHtml(status) {
  const cls = 'st-' + String(status || 'PENDENTE').toLowerCase();
  return `<span class="status-badge ${cls}">${STATUS_LABELS[status] || status}</span>`;
}
function abcBadgeHtml(classe) {
  return `<span class="abc-badge abc-${String(classe).toLowerCase()}">${classe}</span>`;
}

async function renderCustos() {
  try {
    await loadCustos();
    await loadCustosResumo();
  } catch (e) {
    const kpiRow = document.getElementById('custosKpiRow');
    if (kpiRow) kpiRow.innerHTML = `<div style="padding:14px; color:var(--red);">Erro ao carregar custos: ${e.message}</div>`;
    return;
  }
  renderCustosKpis();
  renderCustosBarList('custosPorDisciplina', CUSTOS_RESUMO.porDisciplina, 'disciplina', DISCIPLINA_LABELS, DISCIPLINA_COLORS);
  renderCustosBarList('custosPorFornecedor', CUSTOS_RESUMO.porFornecedor, 'fornecedor', null, null, '#F0A430');
  renderAbcChart();
  renderAbcTable();
  renderPendenciasTable();
  renderCustosChips();
  renderCustosTable();
}

function renderCustosKpis() {
  const r = CUSTOS_RESUMO;
  const row = document.getElementById('custosKpiRow');
  if (!row || !r) return;
  row.innerHTML = `
    <div class="kpi">
      <div class="kpi-label">Total Geral</div>
      <div class="kpi-value" style="color:var(--amber); font-size:19px;">${fmtBRL(r.totalGeral)}</div>
      <div class="kpi-sub">custo consolidado da parada</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Itens de Custo</div>
      <div class="kpi-value">${r.totalItens}</div>
      <div class="kpi-sub">contratos / serviços lançados</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Fornecedores</div>
      <div class="kpi-value" style="color:var(--blue);">${r.totalFornecedores}</div>
      <div class="kpi-sub">empresas distintas</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Pendências</div>
      <div class="kpi-value amber">${r.totalPendencias}</div>
      <div class="kpi-sub">não concluídas / dados incompletos</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Ticket Médio</div>
      <div class="kpi-value" style="color:var(--purple); font-size:18px;">${fmtBRL(r.ticketMedio)}</div>
      <div class="kpi-sub">valor médio por item</div>
    </div>
  `;
}

function renderCustosBarList(elId, list, keyField, labels, colors, fallbackColor) {
  const el = document.getElementById(elId);
  if (!el) return;
  if (!list || !list.length) {
    el.innerHTML = '<div class="custo-empty">Nenhum dado lançado ainda.</div>';
    return;
  }
  const maxValor = Math.max(...list.map(d => d.valor), 1);
  el.innerHTML = `<div class="custo-bar-list">${list.map(d => {
    const key = d[keyField];
    const label = labels ? (labels[key] || key) : key;
    const color = colors ? (colors[key] || '#8494A3') : (fallbackColor || '#F0A430');
    const widthPct = (d.valor / maxValor * 100).toFixed(1);
    return `
      <div class="custo-bar-row">
        <div class="custo-bar-label" title="${label}">${label}</div>
        <div class="custo-bar-track"><div class="custo-bar-fill" style="width:${widthPct}%; background:${color};"></div></div>
        <div class="custo-bar-value">${fmtBRL(d.valor)} · ${d.itens} it.</div>
        <div class="custo-bar-pct">${d.pct}%</div>
      </div>`;
  }).join('')}</div>`;
}

function renderAbcChart() {
  const canvas = document.getElementById('abcChart');
  if (!canvas || typeof Chart === 'undefined') return;
  const items = (CUSTOS_RESUMO.curvaABC || []).slice(0, 15); // top 15 para legibilidade
  if (abcChart) { abcChart.destroy(); abcChart = null; }
  if (!items.length) return;

  const classeColor = { A: '#E5484D', B: '#F0A430', C: '#33C481' };
  abcChart = new Chart(canvas.getContext('2d'), {
    data: {
      labels: items.map(i => i.fornecedor),
      datasets: [
        {
          type: 'bar',
          label: 'Valor (R$)',
          data: items.map(i => i.valor),
          backgroundColor: items.map(i => classeColor[i.classe] + 'CC'),
          yAxisID: 'y',
          order: 2,
        },
        {
          type: 'line',
          label: '% Acumulado',
          data: items.map(i => i.pctAcum),
          borderColor: '#5B9FE3',
          backgroundColor: 'rgba(91,159,227,0.1)',
          borderWidth: 2,
          pointRadius: 3,
          pointBackgroundColor: '#5B9FE3',
          yAxisID: 'y1',
          tension: 0.2,
          order: 1,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: '#8494A3', font: { family: 'IBM Plex Mono', size: 10 } },
        },
        tooltip: {
          backgroundColor: '#121821',
          titleFont: { family: 'IBM Plex Mono', size: 11 },
          bodyFont: { family: 'IBM Plex Mono', size: 11 },
          callbacks: {
            label: (ctx) => ctx.dataset.yAxisID === 'y1'
              ? ' % Acumulado: ' + ctx.parsed.y.toFixed(1) + '%'
              : ' Valor: ' + fmtBRL(ctx.parsed.y),
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: '#8494A3', font: { family: 'IBM Plex Mono', size: 9 }, maxRotation: 40, minRotation: 20, autoSkip: false },
        },
        y: {
          position: 'left',
          grid: { color: '#1A222B' },
          ticks: { color: '#8494A3', font: { family: 'IBM Plex Mono', size: 9 }, callback: v => (v / 1000) + 'k' },
        },
        y1: {
          position: 'right',
          min: 0, max: 100,
          grid: { display: false },
          ticks: { color: '#5B9FE3', font: { family: 'IBM Plex Mono', size: 9 }, callback: v => v + '%' },
        },
      },
    },
  });
}

function renderAbcTable() {
  const tbody = document.querySelector('#abcTable tbody');
  if (!tbody) return;
  const items = CUSTOS_RESUMO.curvaABC || [];
  tbody.innerHTML = items.length ? items.map(i => `
    <tr>
      <td>${i.rank}</td>
      <td>${i.fornecedor}</td>
      <td class="small-muted">${i.atividade || '—'}</td>
      <td>${DISCIPLINA_LABELS[i.disciplina] || i.disciplina}</td>
      <td class="num">${fmtBRL(i.valor)}</td>
      <td class="num">${i.pct}%</td>
      <td class="num">${i.pctAcum}%</td>
      <td>${abcBadgeHtml(i.classe)}</td>
    </tr>`).join('') : '<tr class="table-empty-row"><td colspan="8">Nenhum item lançado ainda.</td></tr>';
}

function renderPendenciasTable() {
  const tbody = document.querySelector('#pendenciasTable tbody');
  const sub = document.getElementById('custosPendSub');
  if (!tbody) return;
  const items = CUSTOS_RESUMO.pendencias || [];
  if (sub) sub.textContent = items.length
    ? `${items.length} item(ns) pendente(s) de conclusão ou com dados incompletos`
    : 'Nenhuma pendência — todos os itens concluídos e com dados completos';
  const isAdmin = USER && USER.role === 'admin';
  tbody.innerHTML = items.length ? items.map(i => `
    <tr>
      <td>${i.fornecedor}</td>
      <td>${DISCIPLINA_LABELS[i.disciplina] || i.disciplina}</td>
      <td class="small-muted">${i.atividade || '—'}</td>
      <td class="num">${fmtBRL(i.valor)}</td>
      <td class="num">${fmtDateBR(i.data_fim)}</td>
      <td><div class="motivo-tags">${(i.motivos || []).map(m => `<span class="motivo-tag">${m}</span>`).join('')}</div></td>
      <td>${isAdmin ? statusSelectHtml(i.id, i.status) : statusBadgeHtml(i.status)}</td>
    </tr>`).join('') : '<tr class="table-empty-row"><td colspan="7">Nenhuma pendência no momento.</td></tr>';
  if (isAdmin) bindStatusSelects(tbody);
}

function statusSelectHtml(id, current) {
  return `<select class="status-select" data-custo-id="${id}">
    ${Object.keys(STATUS_LABELS).map(s => `<option value="${s}" ${s === current ? 'selected' : ''}>${STATUS_LABELS[s]}</option>`).join('')}
  </select>`;
}
function bindStatusSelects(container) {
  container.querySelectorAll('.status-select').forEach(sel => {
    sel.addEventListener('change', async () => {
      const id = sel.getAttribute('data-custo-id');
      try {
        await api('/api/custos/' + id + '/status', { method: 'PATCH', body: JSON.stringify({ status: sel.value }) });
        await renderCustos();
      } catch (e) {
        alert('Erro ao atualizar status: ' + e.message);
      }
    });
  });
}

function renderCustosChips() {
  const discEl = document.getElementById('custosDisciplinaChips');
  const statusEl = document.getElementById('custosStatusChips');
  if (discEl && discEl.childElementCount === 0) {
    const disciplinas = ['todas', ...Object.keys(DISCIPLINA_LABELS)];
    discEl.innerHTML = disciplinas.map(d => `<button class="chip${d === custosDisciplinaFilter ? ' active' : ''}" data-disc="${d}">${d === 'todas' ? 'Todas as disciplinas' : DISCIPLINA_LABELS[d]}</button>`).join('');
    discEl.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        custosDisciplinaFilter = chip.getAttribute('data-disc');
        discEl.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
        renderCustosTable();
      });
    });
  }
  if (statusEl && statusEl.childElementCount === 0) {
    const statuses = ['todas', ...Object.keys(STATUS_LABELS)];
    statusEl.innerHTML = statuses.map(s => `<button class="chip${s === custosStatusFilter ? ' active' : ''}" data-status="${s}">${s === 'todas' ? 'Todos os status' : STATUS_LABELS[s]}</button>`).join('');
    statusEl.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        custosStatusFilter = chip.getAttribute('data-status');
        statusEl.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c === chip));
        renderCustosTable();
      });
    });
  }
}

function renderCustosTable() {
  const tbody = document.querySelector('#custosTable tbody');
  if (!tbody) return;
  const isAdmin = USER && USER.role === 'admin';

  let list = CUSTOS.slice();
  if (custosDisciplinaFilter !== 'todas') list = list.filter(c => c.disciplina === custosDisciplinaFilter);
  if (custosStatusFilter !== 'todas') list = list.filter(c => c.status === custosStatusFilter);

  tbody.innerHTML = list.length ? list.map(c => `
    <tr${c.oculto ? ' class="custo-row-oculto"' : ''}>
      <td>${c.fornecedor}${isAdmin && c.oculto ? ' <span class="badge-oculto">Oculto</span>' : ''}</td>
      <td>${DISCIPLINA_LABELS[c.disciplina] || c.disciplina}</td>
      <td class="small-muted">${c.atividade || '—'}</td>
      <td class="num">${fmtBRL(c.valor)}</td>
      <td class="small-muted">${fmtDateBR(c.data_inicio)} – ${fmtDateBR(c.data_fim)}</td>
      <td class="small-muted">${c.responsavel || '—'}</td>
      <td>${isAdmin ? statusSelectHtml(c.id, c.status) : statusBadgeHtml(c.status)}</td>
      ${isAdmin ? `<td><div class="row-actions">
          <button data-edit="${c.id}">Editar</button>
          <button data-toggle-oculto="${c.id}" data-oculto="${c.oculto ? '1' : '0'}">${c.oculto ? 'Mostrar' : 'Ocultar'}</button>
          <button data-del="${c.id}" class="danger">Excluir</button>
        </div></td>` : ''}
    </tr>`).join('') : `<tr class="table-empty-row"><td colspan="${isAdmin ? 8 : 7}">Nenhum item encontrado para este filtro.</td></tr>`;

  if (isAdmin) {
    bindStatusSelects(tbody);
    tbody.querySelectorAll('[data-edit]').forEach(btn => {
      btn.addEventListener('click', () => openCustoModal(btn.getAttribute('data-edit')));
    });
    tbody.querySelectorAll('[data-toggle-oculto]').forEach(btn => {
      btn.addEventListener('click', () => toggleOcultarCusto(
        btn.getAttribute('data-toggle-oculto'),
        btn.getAttribute('data-oculto') !== '1'
      ));
    });
    tbody.querySelectorAll('[data-del]').forEach(btn => {
      btn.addEventListener('click', () => deleteCusto(btn.getAttribute('data-del')));
    });
  }
}

async function toggleOcultarCusto(id, oculto) {
  try {
    await api('/api/custos/' + id + '/ocultar', { method: 'PATCH', body: JSON.stringify({ oculto }) });
    await renderCustos();
  } catch (e) {
    alert('Erro ao ' + (oculto ? 'ocultar' : 'reexibir') + ' item: ' + e.message);
  }
}

// ---- Modal criar/editar ----
const custoModal = document.getElementById('custoModalOverlay');
function openCustoModal(id) {
  custoEditingId = id || null;
  document.getElementById('custoModalTitle').textContent = id ? 'Editar Custo' : 'Novo Custo';
  document.getElementById('custoModalError').classList.add('hidden');

  const c = id ? CUSTOS.find(x => String(x.id) === String(id)) : null;
  document.getElementById('custoFornecedor').value = c ? c.fornecedor : '';
  document.getElementById('custoDisciplina').value = c ? c.disciplina : 'OUTROS';
  document.getElementById('custoStatus').value = c ? c.status : 'PENDENTE';
  document.getElementById('custoAtividade').value = c ? (c.atividade || '') : '';
  document.getElementById('custoValor').value = c ? c.valor : '';
  document.getElementById('custoDataInicio').value = c && c.data_inicio ? String(c.data_inicio).slice(0, 10) : '';
  document.getElementById('custoDataFim').value = c && c.data_fim ? String(c.data_fim).slice(0, 10) : '';
  document.getElementById('custoResponsavel').value = c ? (c.responsavel || '') : '';
  document.getElementById('custoContato').value = c ? (c.contato || '') : '';
  document.getElementById('custoEscopo').value = c ? (c.escopo || '') : '';
  document.getElementById('custoObservacao').value = c ? (c.observacao || '') : '';

  custoModal.classList.remove('hidden');
  document.getElementById('custoFornecedor').focus();
}
document.getElementById('custosNovoBtn')?.addEventListener('click', () => openCustoModal(null));
document.getElementById('custoCancelBtn').addEventListener('click', () => custoModal.classList.add('hidden'));
custoModal.addEventListener('click', (e) => { if (e.target === custoModal) custoModal.classList.add('hidden'); });

document.getElementById('custoSaveBtn').addEventListener('click', async () => {
  const errEl = document.getElementById('custoModalError');
  errEl.classList.add('hidden');
  const body = {
    fornecedor: document.getElementById('custoFornecedor').value.trim(),
    disciplina: document.getElementById('custoDisciplina').value,
    status: document.getElementById('custoStatus').value,
    atividade: document.getElementById('custoAtividade').value.trim(),
    valor: parseFloat(document.getElementById('custoValor').value),
    data_inicio: document.getElementById('custoDataInicio').value || null,
    data_fim: document.getElementById('custoDataFim').value || null,
    responsavel: document.getElementById('custoResponsavel').value.trim(),
    contato: document.getElementById('custoContato').value.trim(),
    escopo: document.getElementById('custoEscopo').value.trim(),
    observacao: document.getElementById('custoObservacao').value.trim(),
  };
  if (!body.fornecedor) { errEl.textContent = 'Informe o fornecedor.'; errEl.classList.remove('hidden'); return; }
  if (isNaN(body.valor) || body.valor < 0) { errEl.textContent = 'Informe um valor válido.'; errEl.classList.remove('hidden'); return; }

  try {
    if (custoEditingId) {
      await api('/api/custos/' + custoEditingId, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      await api('/api/custos', { method: 'POST', body: JSON.stringify(body) });
    }
    custoModal.classList.add('hidden');
    await renderCustos();
  } catch (e) {
    errEl.textContent = e.message || 'Erro ao salvar.';
    errEl.classList.remove('hidden');
  }
});

async function deleteCusto(id) {
  const c = CUSTOS.find(x => String(x.id) === String(id));
  if (!confirm(`Excluir o item de custo de "${c ? c.fornecedor : id}"? Essa ação não pode ser desfeita.`)) return;
  try {
    await api('/api/custos/' + id, { method: 'DELETE' });
    await renderCustos();
  } catch (e) {
    alert('Erro ao excluir: ' + e.message);
  }
}

// ---- Importar custos (admin) ----
document.getElementById('custosImportBtn')?.addEventListener('click', () => {
  document.getElementById('custosImportInput').click();
});
document.getElementById('custosImportInput')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    const items = Array.isArray(json) ? json : json.items;
    if (!Array.isArray(items) || !items.length) throw new Error('JSON deve ser um array ou { items: [...] }');
    if (!confirm(`Importar ${items.length} item(ns)? Isso substitui TODA a lista de custos atual.`)) {
      e.target.value = '';
      return;
    }
    const data = await api('/api/custos/import', { method: 'POST', body: JSON.stringify({ items }) });
    alert('Custos importados: ' + data.totalItens + ' itens.');
    await renderCustos();
  } catch (err) {
    alert('Erro ao importar arquivo: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

// ================= Import cronograma (admin) =================
document.getElementById('importBtn')?.addEventListener('click', () => {
  document.getElementById('importFileInput').click();
});
document.getElementById('importFileInput')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);
    if (!json.area) {
      const use = confirm(
        'O JSON não tem o campo "area".\\nUsar a área atual (' + CURRENT_AREA + ')?'
      );
      if (!use) { e.target.value = ''; return; }
      json.area = CURRENT_AREA;
    }
    const data = await api('/api/import', { method: 'POST', body: JSON.stringify(json) });
    alert('Cronograma importado: ' + data.totalTarefas + ' atividades em ' + (AREA_LABELS[data.area] || data.area) + '.');
    if (data.area && data.area !== CURRENT_AREA) {
      CURRENT_AREA = data.area;
      localStorage.setItem('pcm_area', CURRENT_AREA);
      syncAreaSwitcher();
    }
    collapsedState = {};
    if (sCurveChart) { sCurveChart.destroy(); sCurveChart = null; }
    await reloadData();
    renderAll();
  } catch (err) {
    alert('Erro ao importar arquivo: ' + err.message);
  } finally {
    e.target.value = '';
  }
});

// ================= Reset (admin) — scoped to current area =================
const resetModal = document.getElementById('resetModalOverlay');
document.getElementById('resetBtn')?.addEventListener('click', () => {
  document.getElementById('resetPasswordInput').value = '';
  document.getElementById('resetErrorMsg').classList.add('hidden');
  document.getElementById('resetAreaLabel').textContent = AREA_LABELS[CURRENT_AREA] || CURRENT_AREA;
  resetModal.classList.remove('hidden');
  document.getElementById('resetPasswordInput').focus();
});
document.getElementById('resetCancelBtn').addEventListener('click', () => resetModal.classList.add('hidden'));
resetModal.addEventListener('click', (e) => { if (e.target === resetModal) resetModal.classList.add('hidden'); });
document.getElementById('resetConfirmBtn').addEventListener('click', async () => {
  const pw = document.getElementById('resetPasswordInput').value;
  try {
    await api('/api/reset?area=' + encodeURIComponent(CURRENT_AREA), {
      method: 'POST',
      body: JSON.stringify({ password: pw, area: CURRENT_AREA }),
    });
    resetModal.classList.add('hidden');
    await reloadData();
    renderAll();
  } catch (e) {
    document.getElementById('resetErrorMsg').textContent = e.message;
    document.getElementById('resetErrorMsg').classList.remove('hidden');
  }
});
document.getElementById('resetPasswordInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('resetConfirmBtn').click();
});

// ================= Init =================
(async function init() {
  await tryRestoreSession();
  await boot();
})();
