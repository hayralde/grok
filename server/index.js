const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const { Server } = require('socket.io');

const jwt = require('jsonwebtoken');
const { pool, init, AREAS, DEFAULT_AREA, normalizeArea, CUSTO_DISCIPLINAS, CUSTO_STATUS } = require('./db');
const { signToken, authRequired, requireRole, JWT_SECRET } = require('./auth');
const { getAreaConfig, listAreas } = require('./areaConfig');
const { buildBackupPayload, backupFilename } = require('./backup');
const googleDrive = require('./googleDrive');
const { startScheduler: startBackupScheduler, runBackupNow } = require('./backupScheduler');

const RESET_PASSWORD = process.env.RESET_PASSWORD || '654321';

const app = express();
app.set('trust proxy', 1); // Render fica atrás de um proxy; sem isso req.protocol vem como 'http' mesmo em produção, quebrando o redirect_uri do OAuth do Google
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

function resolveArea(req) {
  const raw = (req.query && req.query.area) || (req.body && req.body.area) || DEFAULT_AREA;
  const area = normalizeArea(raw);
  if (!area) return null;
  return area;
}

/** Se o usuário tem area_scope, só pode operar nessa área. */
function enforceUserArea(req, area) {
  if (!req.user || !req.user.area_scope) return null;
  const scoped = normalizeArea(req.user.area_scope);
  if (scoped && area !== scoped) {
    return `Acesso restrito à área ${scoped}.`;
  }
  return null;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formatDateTimeBR(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------- Auth ----------
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Usuario e senha obrigatorios' });

    const uname = String(username).trim().toLowerCase();
    const { rows } = await pool.query('SELECT * FROM users WHERE LOWER(username) = $1', [uname]);
    const user = rows[0];
    if (!user) return res.status(401).json({ error: 'Usuario ou senha invalidos' });
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Conta sem senha configurada. Reinicie o serviço ou contate o admin.' });
    }

    const ok = await bcrypt.compare(String(password), user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Usuario ou senha invalidos' });

    const token = signToken(user);
    res.json({
      token,
      user: {
        username: user.username,
        role: user.role,
        nome: user.nome,
        tecnico: user.tecnico,
        area_scope: user.area_scope || null,
      },
    });
  } catch (e) {
    console.error('Erro no login:', e);
    res.status(500).json({ error: 'Erro interno no login' });
  }
});

app.get('/api/me', authRequired, (req, res) => {
  res.json({ user: req.user });
});

app.get('/api/areas', (_req, res) => {
  res.json({ areas: listAreas(), default: DEFAULT_AREA });
});

/** Dashboard visitante: KPIs + pontos da Curva S das 3 áreas */
app.get('/api/dashboard', authRequired, async (req, res) => {
  try {
    const result = {};
    for (const area of AREAS) {
      const cfg = getAreaConfig(area);
      const { rows: metaRows } = await pool.query(
        'SELECT key, value FROM meta WHERE key LIKE $1',
        [area + ':%']
      );
      const meta = {};
      metaRows.forEach(r => {
        meta[r.key.slice(area.length + 1)] = r.value;
      });
      const { rows: tasks } = await pool.query(
        'SELECT id, inicio, fim, horas, done, done_at FROM tasks WHERE area = $1 ORDER BY id',
        [area]
      );

      const total = tasks.length;
      const doneCount = tasks.filter(t => t.done).length;
      const pendCount = total - doneCount;
      const horasTotal = tasks.reduce((s, t) => s + (Number(t.horas) || 0), 0);
      const horasDone = tasks.filter(t => t.done).reduce((s, t) => s + (Number(t.horas) || 0), 0);
      const pctAtividades = total > 0 ? (doneCount / total) * 100 : 0;
      const pctHoras = horasTotal > 0 ? (horasDone / horasTotal) * 100 : 0;

      let labels = [];
      let planned = [];
      let real = [];
      const ps = meta.projectStart ? new Date(meta.projectStart) : null;
      const pf = meta.projectFinish ? new Date(meta.projectFinish) : null;
      if (ps && pf && !isNaN(ps.getTime()) && !isNaN(pf.getTime()) && pf > ps && horasTotal > 0) {
        const dayMs = 24 * 3600 * 1000;
        let cur = new Date(ps);
        cur.setHours(0, 0, 0, 0);
        const end = new Date(pf);
        end.setHours(23, 59, 59, 999);
        while (cur <= end) {
          const dayEnd = new Date(cur);
          dayEnd.setHours(23, 59, 59, 999);
          labels.push(cur.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }));
          const pH = tasks
            .filter(t => new Date(t.fim) <= dayEnd)
            .reduce((s, t) => s + (Number(t.horas) || 0), 0);
          planned.push(+(pH / horasTotal * 100).toFixed(2));
          // Curva independente do planejado: usa a data em que a tarefa foi
          // de fato concluída (done_at), não a data planejada (fim).
          const rH = tasks
            .filter(t => {
              if (!t.done) return false;
              const completedAt = t.done_at ? new Date(t.done_at) : new Date(t.fim);
              return completedAt <= dayEnd;
            })
            .reduce((s, t) => s + (Number(t.horas) || 0), 0);
          real.push(+(rH / horasTotal * 100).toFixed(2));
          cur = new Date(cur.getTime() + dayMs);
        }
      }

      result[area] = {
        id: area,
        label: (cfg && cfg.label) || area,
        projectStart: meta.projectStart || null,
        projectFinish: meta.projectFinish || null,
        total,
        done: doneCount,
        pending: pendCount,
        pctAtividades: +pctAtividades.toFixed(1),
        horasTotal: +horasTotal.toFixed(1),
        horasDone: +horasDone.toFixed(1),
        pctHoras: +pctHoras.toFixed(1),
        curve: { labels, planned, real },
      };
    }
    res.json({ areas: result, order: AREAS });
  } catch (e) {
    console.error('dashboard error', e);
    res.status(500).json({ error: 'Erro ao montar dashboard' });
  }
});

// ---------- Meta (public read) ----------
app.get('/api/meta', authRequired, async (req, res) => {
  const area = resolveArea(req);
  if (!area) return res.status(400).json({ error: 'Area invalida. Use ELETRICA, MECANICA ou TGM.' });
  const denied = enforceUserArea(req, area);
  if (denied) return res.status(403).json({ error: denied });

  const { rows } = await pool.query(
    `SELECT key, value FROM meta WHERE key LIKE $1`,
    [area + ':%']
  );
  const meta = {};
  rows.forEach(r => {
    const short = r.key.slice(area.length + 1);
    meta[short] = r.value;
  });
  const cfg = getAreaConfig(area);
  res.json({
    area,
    projectStart: meta.projectStart || null,
    projectFinish: meta.projectFinish || null,
    sectorOrder: meta.sectorOrder ? JSON.parse(meta.sectorOrder) : [],
    config: cfg ? {
      label: cfg.label,
      defaultTecnicoTipo: cfg.defaultTecnicoTipo,
      allowOverlap: cfg.allowOverlap,
      operatorLoginRequired: cfg.operatorLoginRequired,
      helpText: cfg.helpText,
      hoursChartTitle: cfg.hoursChartTitle,
      hoursChartSub: cfg.hoursChartSub,
      responsibleLabel: cfg.responsibleLabel,
      doneByRoles: cfg.doneByRoles,
    } : null,
  });
});

// ---------- Tasks (public read; operador logged-in sees only own tasks) ----------
app.get('/api/tasks', authRequired, async (req, res) => {
  const area = resolveArea(req);
  if (!area) return res.status(400).json({ error: 'Area invalida. Use ELETRICA, MECANICA ou TGM.' });
  const denied = enforceUserArea(req, area);
  if (denied) return res.status(403).json({ error: denied });

  let query = 'SELECT * FROM tasks WHERE area = $1 ORDER BY id ASC';
  let params = [area];

  if (req.user && req.user.role === 'operador') {
    query = 'SELECT * FROM tasks WHERE area = $1 AND tecnico = $2 ORDER BY id ASC';
    params = [area, req.user.tecnico];
  }

  const { rows } = await pool.query(query, params);
  res.json({ area, tasks: rows });
});

// ---------- Export da programação em CSV (mesma visibilidade de /api/tasks) ----------
app.get('/api/tasks/export', authRequired, async (req, res) => {
  const area = resolveArea(req);
  if (!area) return res.status(400).json({ error: 'Area invalida. Use ELETRICA, MECANICA ou TGM.' });
  const denied = enforceUserArea(req, area);
  if (denied) return res.status(403).json({ error: denied });

  let query = 'SELECT * FROM tasks WHERE area = $1 ORDER BY setor ASC, inicio ASC, id ASC';
  let params = [area];

  if (req.user && req.user.role === 'operador') {
    query = 'SELECT * FROM tasks WHERE area = $1 AND tecnico = $2 ORDER BY setor ASC, inicio ASC, id ASC';
    params = [area, req.user.tecnico];
  }

  const { rows } = await pool.query(query, params);
  const cfg = getAreaConfig(area);
  const responsavelLabel = (cfg && cfg.responsibleLabel) || 'Responsável';

  const header = ['ID', 'Setor', 'TAG', 'Descrição', responsavelLabel, 'Início', 'Fim', 'Horas', 'Status', 'Concluído por', 'Concluído em'];
  const lines = [header.map(csvEscape).join(',')];
  for (const t of rows) {
    lines.push([
      t.id,
      t.setor,
      t.tag,
      t.descricao,
      t.tecnico,
      formatDateTimeBR(t.inicio),
      formatDateTimeBR(t.fim),
      t.horas,
      t.done ? 'Concluído' : 'Pendente',
      t.done_by || '',
      formatDateTimeBR(t.done_at),
    ].map(csvEscape).join(','));
  }
  // BOM no início para o Excel abrir os acentos em UTF-8 corretamente
  const csv = '﻿' + lines.join('\r\n') + '\r\n';

  const label = ((cfg && cfg.labelShort) || area).normalize('NFD').replace(/[̀-ͯ]/g, '');
  const dateTag = new Date().toISOString().slice(0, 10);
  const filename = `programacao_${label}_${dateTag}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

// Toggle done — requires login
app.patch('/api/tasks/:id', authRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const area = resolveArea(req);
  if (!area) return res.status(400).json({ error: 'Area invalida. Use ELETRICA, MECANICA ou TGM.' });
  const denied = enforceUserArea(req, area);
  if (denied) return res.status(403).json({ error: denied });

  const { done } = req.body || {};
  if (typeof done !== 'boolean') return res.status(400).json({ error: '"done" deve ser true/false' });

  const { rows: existingRows } = await pool.query(
    'SELECT * FROM tasks WHERE area = $1 AND id = $2',
    [area, id]
  );
  const task = existingRows[0];
  if (!task) return res.status(404).json({ error: 'Tarefa nao encontrada' });

  if (req.user.role === 'operador' && task.tecnico !== req.user.tecnico) {
    return res.status(403).json({ error: 'Voce so pode alterar suas proprias atividades' });
  }

  const doneBy = done ? req.user.nome : null;
  const doneAt = done ? new Date().toISOString() : null;

  const { rows } = await pool.query(
    `UPDATE tasks SET done = $1, done_by = $2, done_at = $3
     WHERE area = $4 AND id = $5 RETURNING *`,
    [done, doneBy, doneAt, area, id]
  );
  const updated = rows[0];

  io.emit('task-updated', updated);
  res.json({ task: updated });
});

// ---------- Reset progress (admin only + password) — scoped to area ----------
app.post('/api/reset', authRequired, requireRole('admin'), async (req, res) => {
  const { password } = req.body || {};
  if (password !== RESET_PASSWORD) return res.status(401).json({ error: 'Senha incorreta' });

  const area = resolveArea(req);
  if (!area) return res.status(400).json({ error: 'Area invalida. Use ELETRICA, MECANICA ou TGM.' });

  await pool.query(
    `UPDATE tasks SET done = FALSE, done_by = NULL, done_at = NULL WHERE area = $1`,
    [area]
  );
  io.emit('progress-reset', { area });
  res.json({ ok: true, area });
});

// ---------- Team summary (public read) ----------
app.get('/api/team', authRequired, async (req, res) => {
  const area = resolveArea(req);
  if (!area) return res.status(400).json({ error: 'Area invalida. Use ELETRICA, MECANICA ou TGM.' });
  const denied = enforceUserArea(req, area);
  if (denied) return res.status(403).json({ error: denied });

  const { rows } = await pool.query(`
    SELECT tecnico,
           COALESCE(MAX(tecnico_tipo), 'PESSOA') AS tecnico_tipo,
           COUNT(*)::int AS total_tarefas,
           COUNT(*) FILTER (WHERE done)::int AS tarefas_concluidas,
           COALESCE(SUM(horas), 0)::float AS horas_planejadas,
           COALESCE(SUM(horas) FILTER (WHERE done), 0)::float AS horas_concluidas
    FROM tasks
    WHERE area = $1
    GROUP BY tecnico
    ORDER BY horas_planejadas DESC
  `, [area]);
  res.json({ area, team: rows });
});

// ---------- Backup do banco (admin only) — dump completo em JSON para download ----------
// Descobre as tabelas do schema dinamicamente (não precisa manter lista manual
// conforme o app evolui) e devolve cada uma com suas linhas. Não depende do
// binário pg_dump (que normalmente não está disponível no ambiente do Render).
app.get('/api/admin/backup', authRequired, requireRole('admin'), async (_req, res) => {
  try {
    const payload = await buildBackupPayload();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${backupFilename()}"`);
    res.send(JSON.stringify(payload, null, 2));
  } catch (e) {
    console.error('backup error', e);
    res.status(500).json({ error: 'Erro ao gerar backup do banco' });
  }
});

// Dispara um backup imediato para o Google Drive (fora do agendamento diário) —
// útil pra validar a configuração das credenciais antes de confiar no automático.
app.post('/api/admin/backup/drive', authRequired, requireRole('admin'), async (_req, res) => {
  if (!(await googleDrive.isConfigured())) {
    return res.status(400).json({ error: 'Google Drive não conectado. Use o botão "Conectar Google Drive".' });
  }
  try {
    const file = await runBackupNow();
    res.json({ ok: true, file });
  } catch (e) {
    console.error('backup drive error', e);
    res.status(500).json({ error: 'Erro ao enviar backup ao Google Drive: ' + e.message });
  }
});

// ---------- Conectar Google Drive (OAuth2 — login com a conta pessoal do admin) ----------
// Guarda estados pendentes (proteção CSRF simples): state -> expiração
const pendingOAuthStates = new Map();
function newOAuthState() {
  const state = require('crypto').randomBytes(16).toString('hex');
  pendingOAuthStates.set(state, Date.now() + 5 * 60 * 1000); // expira em 5 min
  return state;
}
function consumeOAuthState(state) {
  const exp = pendingOAuthStates.get(state);
  pendingOAuthStates.delete(state);
  return !!exp && exp > Date.now();
}
function oauthRedirectUri(req) {
  const uri = `${req.protocol}://${req.get('host')}/api/admin/google-auth/callback`;
  console.log('[google-auth] redirect_uri usado:', uri);
  return uri;
}

app.get('/api/admin/google-auth/status', authRequired, requireRole('admin'), async (_req, res) => {
  res.json(await googleDrive.getStatus());
});

// Navegação de página inteira (não é chamada via fetch), então o token JWT vem
// por query string em vez do header Authorization.
app.get('/api/admin/google-auth/start', (req, res) => {
  let user;
  try {
    user = jwt.verify(String(req.query.token || ''), JWT_SECRET);
  } catch (e) {
    return res.status(401).send('Não autenticado. Faça login como admin no painel e tente de novo.');
  }
  if (user.role !== 'admin') return res.status(403).send('Apenas admin pode conectar o Google Drive.');
  if (!googleDrive.oauthClientConfigured()) {
    return res.status(400).send('GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET não configurados no Render.');
  }
  const state = newOAuthState();
  res.redirect(googleDrive.getAuthUrl(oauthRedirectUri(req), state));
});

app.get('/api/admin/google-auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.status(400).send(`Autorização cancelada ou negada pelo Google (${error}). Pode fechar esta aba e tentar de novo.`);
  if (!state || !consumeOAuthState(String(state))) {
    return res.status(400).send('Solicitação inválida ou expirada. Volte ao painel e clique em "Conectar Google Drive" de novo.');
  }
  try {
    const email = await googleDrive.completeAuth(String(code), oauthRedirectUri(req));
    res.send(`
      <html><body style="font-family:sans-serif; padding:40px; text-align:center;">
        <h2>Google Drive conectado com sucesso${email ? ' — ' + email : ''}!</h2>
        <p>Pode fechar esta aba e voltar ao painel do PCM.</p>
      </body></html>
    `);
  } catch (e) {
    console.error('google-auth callback error', e);
    res.status(500).send('Erro ao concluir a conexão com o Google: ' + e.message);
  }
});

app.post('/api/admin/google-auth/disconnect', authRequired, requireRole('admin'), async (_req, res) => {
  await googleDrive.disconnect();
  res.json({ ok: true });
});

// ---------- Users (admin only) ----------
app.get('/api/users', authRequired, requireRole('admin'), async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, username, role, nome, tecnico FROM users ORDER BY role, username'
  );
  res.json({ users: rows });
});

// ---------- Import cronograma (admin only) — routes by "area" field ----------
// Body: { area, projectStart, projectFinish, sectorOrder, tasks: [...] }
// Only the matching area is replaced; the other two are left untouched.
function normalizeTecnicoTipo(raw, areaDefault) {
  if (raw === undefined || raw === null || raw === '') {
    return areaDefault === 'EQUIPE' ? 'EQUIPE' : 'PESSOA';
  }
  const v = String(raw).trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (v === 'EQUIPE' || v === 'TURNO' || v === 'FORNECEDOR' || v === 'TIME') return 'EQUIPE';
  if (v === 'PESSOA' || v === 'OPERADOR' || v === 'TECNICO') return 'PESSOA';
  return null;
}

function intervalsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

app.post('/api/import', authRequired, requireRole('admin'), async (req, res) => {
  const body = req.body || {};
  const area = normalizeArea(body.area);
  if (!area) {
    return res.status(400).json({
      error: 'Campo "area" obrigatorio e deve ser ELETRICA, MECANICA ou TGM.',
    });
  }

  const deniedImport = enforceUserArea(req, area);
  if (deniedImport) return res.status(403).json({ error: deniedImport });

  const areaCfg = getAreaConfig(area);
  if (!areaCfg) {
    return res.status(400).json({ error: 'Configuracao da area nao encontrada.' });
  }

  const { projectStart, projectFinish, sectorOrder, tasks } = body;

  if (!projectStart || !projectFinish || !Array.isArray(sectorOrder) || !Array.isArray(tasks)) {
    return res.status(400).json({
      error: 'JSON invalido. Esperado: { area, projectStart, projectFinish, sectorOrder: [], tasks: [] }',
    });
  }
  if (tasks.length === 0) {
    return res.status(400).json({ error: 'A lista de tarefas ("tasks") esta vazia.' });
  }

  const requiredFields = ['id', 'setor', 'tag', 'descricao', 'tecnico', 'inicio', 'fim', 'horas'];
  const normalized = [];
  const seenIds = new Set();

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    for (const f of requiredFields) {
      if (t[f] === undefined || t[f] === null || t[f] === '') {
        return res.status(400).json({
          error: `Tarefa na posicao ${i} esta sem o campo obrigatorio "${f}".`,
        });
      }
    }
    const inicioMs = new Date(t.inicio).getTime();
    const fimMs = new Date(t.fim).getTime();
    if (isNaN(inicioMs) || isNaN(fimMs)) {
      return res.status(400).json({
        error: `Tarefa id=${t.id}: "inicio" ou "fim" nao e uma data valida (use ISO 8601).`,
      });
    }
    if (fimMs <= inicioMs) {
      return res.status(400).json({
        error: `Tarefa id=${t.id}: "fim" deve ser posterior a "inicio".`,
      });
    }
    if (seenIds.has(t.id)) {
      return res.status(400).json({ error: `id duplicado no arquivo: ${t.id}` });
    }
    seenIds.add(t.id);

    // tecnicoTipo: se omitido, usa o padrão da ÁREA (TGM→EQUIPE, demais→PESSOA)
    const rawTipo = t.tecnicoTipo !== undefined ? t.tecnicoTipo
      : (t.tecnico_tipo !== undefined ? t.tecnico_tipo : undefined);
    const tipo = normalizeTecnicoTipo(rawTipo, areaCfg.defaultTecnicoTipo);
    if (!tipo) {
      return res.status(400).json({
        error: `Tarefa id=${t.id}: tecnicoTipo invalido (use PESSOA ou EQUIPE).`,
      });
    }

    normalized.push({
      id: t.id,
      setor: t.setor,
      tag: t.tag,
      descricao: t.descricao,
      nome: t.nome || [t.tag, t.descricao].filter(Boolean).join(' - '),
      tecnico: String(t.tecnico).trim(),
      tecnico_tipo: tipo,
      inicio: t.inicio,
      fim: t.fim,
      inicioMs,
      fimMs,
      horas: t.horas,
    });
  }

  // Sobreposição: só valida se a CONFIG DA ÁREA não permite overlap
  // (ELETRICA/MECANICA: false → checa PESSOA; TGM: true → não checa)
  if (!areaCfg.allowOverlap) {
    const byPerson = {};
    for (const t of normalized) {
      // No modo restrito, só pessoas físicas entram na checagem;
      // EQUIPE explícito na tarefa ainda pode coexistir se alguém mandar, mas
      // o padrão da área já força PESSOA quando omitido.
      if (t.tecnico_tipo === 'EQUIPE') continue;
      const key = t.tecnico.toUpperCase();
      if (!byPerson[key]) byPerson[key] = [];
      byPerson[key].push(t);
    }
    for (const [name, list] of Object.entries(byPerson)) {
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (intervalsOverlap(a.inicioMs, a.fimMs, b.inicioMs, b.fimMs)) {
            return res.status(400).json({
              error: `Sobreposicao de tecnico na area ${area} (modo sem sobreposicao): id ${a.id} e id ${b.id} (${name}).`,
            });
          }
        }
      }
    }
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tasks WHERE area = $1', [area]);
    for (const t of normalized) {
      await client.query(
        `INSERT INTO tasks (area, id, setor, tag, descricao, nome, tecnico, tecnico_tipo, inicio, fim, horas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [area, t.id, t.setor, t.tag, t.descricao, t.nome, t.tecnico, t.tecnico_tipo, t.inicio, t.fim, t.horas]
      );
    }
    await client.query(
      `INSERT INTO meta (key, value) VALUES ($1,$2),($3,$4),($5,$6)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        `${area}:projectStart`, projectStart,
        `${area}:projectFinish`, projectFinish,
        `${area}:sectorOrder`, JSON.stringify(sectorOrder),
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Erro ao importar: ' + err.message });
  } finally {
    client.release();
  }

  const equipes = normalized.filter(t => t.tecnico_tipo === 'EQUIPE').length;
  io.emit('cronograma-importado', { area });
  res.json({
    ok: true,
    area,
    areaLabel: areaCfg.label,
    modoPadrao: areaCfg.defaultTecnicoTipo,
    allowOverlap: areaCfg.allowOverlap,
    totalTarefas: normalized.length,
    tarefasEquipe: equipes,
    tarefasPessoa: normalized.length - equipes,
  });
});

// ================= Custos (aba "Custos" — transversal às áreas) =================

function normalizeDisciplina(raw) {
  if (!raw) return null;
  const v = String(raw).trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (CUSTO_DISCIPLINAS.includes(v)) return v;
  if (v === 'ELETRICA' || v === 'ELECTRICA') return 'ELETRICA';
  if (v === 'MECANICA' || v === 'MECHANICA') return 'MECANICA';
  if (v === 'INSTRUMENTACAO' || v === 'INSTRUMENTOS') return 'INSTRUMENTACAO';
  return null;
}
function normalizeCustoStatus(raw) {
  if (!raw) return 'PENDENTE';
  const v = String(raw).trim().toUpperCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '_');
  return CUSTO_STATUS.includes(v) ? v : null;
}

function custoRowToJson(r) {
  return {
    id: r.id,
    fornecedor: r.fornecedor,
    disciplina: r.disciplina,
    atividade: r.atividade,
    escopo: r.escopo,
    valor: Number(r.valor) || 0,
    data_inicio: r.data_inicio,
    data_fim: r.data_fim,
    responsavel: r.responsavel,
    contato: r.contato,
    status: r.status,
    observacao: r.observacao,
    oculto: !!r.oculto,
    updated_at: r.updated_at,
  };
}

// Aba Custos NÃO é pública: exige login (operador/supervisor/admin). Visitante não vê.
// Itens marcados "oculto" somem para quem não é admin (admin continua vendo tudo,
// para poder gerenciar/reverter em "Todos os Custos").
app.get('/api/custos', authRequired, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM custos ORDER BY data_inicio ASC NULLS LAST, id ASC`
    );
    const isAdmin = req.user && req.user.role === 'admin';
    const visiveis = isAdmin ? rows : rows.filter(r => !r.oculto);
    res.json({ custos: visiveis.map(custoRowToJson), disciplinas: CUSTO_DISCIPLINAS, status: CUSTO_STATUS });
  } catch (e) {
    console.error('custos list error', e);
    res.status(500).json({ error: 'Erro ao listar custos' });
  }
});

// Painel consolidado — total por disciplina, por fornecedor, geral, Curva ABC e pendências.
// "oculto" aqui vale para TODO MUNDO, inclusive admin: é um outro panorama dos custos,
// como se aquele fornecedor não existisse — os totais, gráficos, Curva ABC e pendências
// são recalculados sem ele. (A lista "Todos os Custos" — /api/custos — é a exceção: lá o
// admin continua vendo o item, esmaecido, só para poder reativá-lo.)
app.get('/api/custos/resumo', authRequired, async (_req, res) => {
  try {
    const { rows: allRows } = await pool.query(`SELECT * FROM custos ORDER BY valor DESC, id ASC`);
    const rows = allRows.filter(r => !r.oculto);
    const ativos = rows.filter(r => r.status !== 'CANCELADO');

    const totalGeral = ativos.reduce((s, r) => s + (Number(r.valor) || 0), 0);
    const totalItens = rows.length;
    const totalFornecedores = new Set(rows.map(r => (r.fornecedor || '').trim().toUpperCase())).size;

    // ---- Total por disciplina ----
    const discMap = {};
    for (const r of ativos) {
      const key = r.disciplina || 'OUTROS';
      if (!discMap[key]) discMap[key] = { disciplina: key, valor: 0, itens: 0 };
      discMap[key].valor += Number(r.valor) || 0;
      discMap[key].itens += 1;
    }
    const porDisciplina = Object.values(discMap)
      .map(d => ({ ...d, pct: totalGeral > 0 ? +(d.valor / totalGeral * 100).toFixed(1) : 0 }))
      .sort((a, b) => b.valor - a.valor);

    // ---- Total por fornecedor ----
    const fornMap = {};
    for (const r of ativos) {
      const key = (r.fornecedor || 'Não informado').trim();
      if (!fornMap[key]) fornMap[key] = { fornecedor: key, valor: 0, itens: 0 };
      fornMap[key].valor += Number(r.valor) || 0;
      fornMap[key].itens += 1;
    }
    const porFornecedor = Object.values(fornMap)
      .map(f => ({ ...f, pct: totalGeral > 0 ? +(f.valor / totalGeral * 100).toFixed(1) : 0 }))
      .sort((a, b) => b.valor - a.valor);

    // ---- Curva ABC (Pareto por item de custo) ----
    let acumulado = 0;
    const curvaABC = ativos
      .slice()
      .sort((a, b) => Number(b.valor) - Number(a.valor))
      .map((r, idx) => {
        const valor = Number(r.valor) || 0;
        acumulado += valor;
        const pct = totalGeral > 0 ? (valor / totalGeral * 100) : 0;
        const pctAcum = totalGeral > 0 ? (acumulado / totalGeral * 100) : 0;
        const classe = pctAcum <= 80 ? 'A' : (pctAcum <= 95 ? 'B' : 'C');
        return {
          rank: idx + 1,
          id: r.id,
          fornecedor: r.fornecedor,
          atividade: r.atividade,
          disciplina: r.disciplina,
          valor,
          pct: +pct.toFixed(1),
          pctAcum: +pctAcum.toFixed(1),
          classe,
        };
      });
    const resumoABC = ['A', 'B', 'C'].map(classe => {
      const itens = curvaABC.filter(i => i.classe === classe);
      const valor = itens.reduce((s, i) => s + i.valor, 0);
      return { classe, itens: itens.length, valor, pct: totalGeral > 0 ? +(valor / totalGeral * 100).toFixed(1) : 0 };
    });

    // ---- Pendências ----
    const hoje = new Date();
    const pendencias = rows
      .filter(r => r.status === 'PENDENTE' || r.status === 'EM_ANDAMENTO')
      .map(r => {
        const motivos = [];
        if (r.status === 'PENDENTE') motivos.push('Serviço ainda não iniciado');
        if (r.status === 'EM_ANDAMENTO') motivos.push('Serviço em andamento');
        if (!r.responsavel) motivos.push('Responsável não informado');
        if (!r.contato) motivos.push('Contato não informado');
        if (r.data_fim && new Date(r.data_fim) < hoje && r.status !== 'CONCLUIDO') {
          motivos.push('Prazo previsto já vencido');
        }
        return { ...custoRowToJson(r), motivos };
      })
      .sort((a, b) => String(a.data_fim || '9999').localeCompare(String(b.data_fim || '9999')));

    res.json({
      totalGeral: +totalGeral.toFixed(2),
      totalItens,
      totalFornecedores,
      totalPendencias: pendencias.length,
      ticketMedio: totalItens > 0 ? +(totalGeral / totalItens).toFixed(2) : 0,
      porDisciplina,
      porFornecedor,
      curvaABC,
      resumoABC,
      pendencias,
    });
  } catch (e) {
    console.error('custos resumo error', e);
    res.status(500).json({ error: 'Erro ao montar o painel de custos' });
  }
});

function validateCustoBody(body, { partial } = {}) {
  const errors = [];
  const out = {};

  if (!partial || body.fornecedor !== undefined) {
    if (!body.fornecedor || !String(body.fornecedor).trim()) errors.push('"fornecedor" é obrigatório.');
    out.fornecedor = String(body.fornecedor || '').trim();
  }
  if (!partial || body.disciplina !== undefined) {
    const d = normalizeDisciplina(body.disciplina);
    if (!d) errors.push(`"disciplina" inválida. Use: ${CUSTO_DISCIPLINAS.join(', ')}.`);
    out.disciplina = d;
  }
  if (!partial || body.valor !== undefined) {
    const v = Number(body.valor);
    if (isNaN(v) || v < 0) errors.push('"valor" deve ser um número maior ou igual a 0.');
    out.valor = v;
  }
  if (!partial || body.status !== undefined) {
    const s = normalizeCustoStatus(body.status);
    if (!s) errors.push(`"status" inválido. Use: ${CUSTO_STATUS.join(', ')}.`);
    out.status = s;
  }
  if (body.data_inicio !== undefined) out.data_inicio = body.data_inicio || null;
  if (body.data_fim !== undefined) out.data_fim = body.data_fim || null;
  if (body.atividade !== undefined) out.atividade = body.atividade || null;
  if (body.escopo !== undefined) out.escopo = body.escopo || null;
  if (body.responsavel !== undefined) out.responsavel = body.responsavel || null;
  if (body.contato !== undefined) out.contato = body.contato || null;
  if (body.observacao !== undefined) out.observacao = body.observacao || null;

  return { errors, out };
}

// Criar item de custo — admin
app.post('/api/custos', authRequired, requireRole('admin'), async (req, res) => {
  const { errors, out } = validateCustoBody(req.body || {});
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  try {
    const { rows } = await pool.query(
      `INSERT INTO custos (fornecedor, disciplina, atividade, escopo, valor, data_inicio, data_fim, responsavel, contato, status, observacao)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [out.fornecedor, out.disciplina, out.atividade || null, out.escopo || null, out.valor,
       out.data_inicio || null, out.data_fim || null, out.responsavel || null, out.contato || null,
       out.status, out.observacao || null]
    );
    io.emit('custos-atualizado', { tipo: 'criado', id: rows[0].id });
    res.json({ ok: true, custo: custoRowToJson(rows[0]) });
  } catch (e) {
    console.error('custo create error', e);
    res.status(500).json({ error: 'Erro ao criar item de custo' });
  }
});

// Editar item de custo (qualquer campo, inclusive status) — admin
app.put('/api/custos/:id', authRequired, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { errors, out } = validateCustoBody(req.body || {}, { partial: true });
  if (errors.length) return res.status(400).json({ error: errors.join(' ') });

  const fields = Object.keys(out);
  if (fields.length === 0) return res.status(400).json({ error: 'Nenhum campo para atualizar.' });

  const setSql = fields.map((f, i) => `${f} = $${i + 2}`).join(', ');
  try {
    const { rows } = await pool.query(
      `UPDATE custos SET ${setSql}, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, ...fields.map(f => out[f])]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Item de custo não encontrado.' });
    io.emit('custos-atualizado', { tipo: 'editado', id });
    res.json({ ok: true, custo: custoRowToJson(rows[0]) });
  } catch (e) {
    console.error('custo update error', e);
    res.status(500).json({ error: 'Erro ao atualizar item de custo' });
  }
});

// Atualização rápida de status (usada pela lista de pendências) — admin
app.patch('/api/custos/:id/status', authRequired, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const status = normalizeCustoStatus((req.body || {}).status);
  if (!status) return res.status(400).json({ error: `"status" inválido. Use: ${CUSTO_STATUS.join(', ')}.` });

  try {
    const { rows } = await pool.query(
      `UPDATE custos SET status = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Item de custo não encontrado.' });
    io.emit('custos-atualizado', { tipo: 'status', id });
    res.json({ ok: true, custo: custoRowToJson(rows[0]) });
  } catch (e) {
    console.error('custo status error', e);
    res.status(500).json({ error: 'Erro ao atualizar status' });
  }
});

// Excluir item de custo — admin
// Ocultar/reexibir um item — some da visão de operador/supervisor, admin continua vendo
app.patch('/api/custos/:id/ocultar', authRequired, requireRole('admin'), async (req, res) => {
  const id = Number(req.params.id);
  const oculto = !!(req.body || {}).oculto;
  try {
    const { rows, rowCount } = await pool.query(
      `UPDATE custos SET oculto = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, oculto]
    );
    if (!rowCount) return res.status(404).json({ error: 'Item não encontrado' });
    io.emit('custos-atualizado', { tipo: 'oculto', id });
    res.json(custoRowToJson(rows[0]));
  } catch (e) {
    console.error('custos ocultar error', e);
    res.status(500).json({ error: 'Erro ao ocultar/reexibir item' });
  }
});

app.delete('/api/custos/:id', authRequired, requireRole('admin'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  try {
    const { rowCount } = await pool.query('DELETE FROM custos WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Item de custo não encontrado.' });
    io.emit('custos-atualizado', { tipo: 'excluido', id });
    res.json({ ok: true });
  } catch (e) {
    console.error('custo delete error', e);
    res.status(500).json({ error: 'Erro ao excluir item de custo' });
  }
});

// Importar planilha/JSON de custos (substitui a lista inteira) — admin
// Body: { items: [ { fornecedor, disciplina, atividade, escopo, valor, data_inicio, data_fim, responsavel, contato, status, observacao }, ... ] }
app.post('/api/custos/import', authRequired, requireRole('admin'), async (req, res) => {
  const items = (req.body || {}).items;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'JSON inválido. Esperado: { items: [...] }' });
  }

  const normalized = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.fornecedor || !String(it.fornecedor).trim()) {
      return res.status(400).json({ error: `Item na posição ${i}: "fornecedor" é obrigatório.` });
    }
    const disciplina = normalizeDisciplina(it.disciplina) || 'OUTROS';
    const valor = Number(it.valor);
    if (isNaN(valor) || valor < 0) {
      return res.status(400).json({ error: `Item na posição ${i} (${it.fornecedor}): "valor" inválido.` });
    }
    const status = normalizeCustoStatus(it.status) || 'PENDENTE';
    normalized.push({
      fornecedor: String(it.fornecedor).trim(),
      disciplina,
      atividade: it.atividade || null,
      escopo: it.escopo || null,
      valor,
      data_inicio: it.data_inicio || null,
      data_fim: it.data_fim || null,
      responsavel: it.responsavel || null,
      contato: it.contato || null,
      status,
      observacao: it.observacao || null,
    });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM custos');
    for (const c of normalized) {
      await client.query(
        `INSERT INTO custos (fornecedor, disciplina, atividade, escopo, valor, data_inicio, data_fim, responsavel, contato, status, observacao)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [c.fornecedor, c.disciplina, c.atividade, c.escopo, c.valor, c.data_inicio, c.data_fim,
         c.responsavel, c.contato, c.status, c.observacao]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    return res.status(500).json({ error: 'Erro ao importar custos: ' + err.message });
  } finally {
    client.release();
  }

  io.emit('custos-atualizado', { tipo: 'import' });
  res.json({ ok: true, totalItens: normalized.length });
});

// ---------- Static frontend ----------
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

const PORT = process.env.PORT || 3000;

init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
      startBackupScheduler();
    });
  })
  .catch((err) => {
    console.error('Erro ao iniciar (verifique DATABASE_URL):', err);
    process.exit(1);
  });
