/* Aba Status — distribuicao Pendente / Em Andamento / Concluida / Atrasada por disciplina */
(function () {
  if (window.__PCM_STATUS_DIST__) return;
  window.__PCM_STATUS_DIST__ = true;

  var STATUS_CHART = null;
  var COLORS = {
    pendente: '#2F80ED',
    andamento: '#F5A623',
    concluida: '#27AE60',
    atrasada: '#E74C5C'
  };
  var LABELS = {
    pendente: 'Pendente',
    andamento: 'Em Andamento',
    concluida: 'Concluida',
    atrasada: 'Atrasada'
  };
  var ORDER = ['pendente', 'andamento', 'concluida', 'atrasada'];

  function ensureDom() {
    var tabbar = document.getElementById('tabbar');
    if (tabbar && !tabbar.querySelector('[data-tab="status"]')) {
      var btn = document.createElement('button');
      btn.className = 'tab-btn';
      btn.setAttribute('data-tab', 'status');
      btn.type = 'button';
      btn.textContent = 'Status';
      var after = tabbar.querySelector('[data-tab="scurve"]');
      if (after && after.nextSibling) tabbar.insertBefore(btn, after.nextSibling);
      else tabbar.appendChild(btn);
      btn.addEventListener('click', function () {
        if (typeof activateTab === 'function') activateTab('status');
        else renderStatusDist();
      });
    }
    if (!document.getElementById('tab-status')) {
      var main = document.querySelector('main');
      if (!main) return;
      var sec = document.createElement('section');
      sec.id = 'tab-status';
      sec.className = 'tab-panel';
      sec.innerHTML =
        '<div class="panel">' +
          '<div class="panel-header"><div>' +
            '<h2 id="statusDistTitle">Distribuicao por status</h2>' +
            '<div class="panel-sub" id="statusDistSub">Situacao atual das tarefas desta disciplina. Atrasada: tarefa nao concluida cuja data de termino ja passou.</div>' +
          '</div></div>' +
          '<div class="panel-body">' +
            '<div class="status-dist-wrap"><div class="status-dist-card">' +
              '<div class="status-dist-head">' +
                '<div class="status-dist-title">Distribuicao por status</div>' +
                '<div class="status-dist-hint">Situacao atual de todas as tarefas pontuais. "Atrasada" e calculada automaticamente: tarefa nao concluida/em andamento cuja data ja passou.</div>' +
              '</div>' +
              '<div class="status-dist-body">' +
                '<table class="status-dist-table">' +
                  '<thead><tr><th>STATUS</th><th>QTD</th></tr></thead>' +
                  '<tbody id="statusDistTableBody"></tbody>' +
                '</table>' +
                '<div class="status-dist-chart-wrap"><canvas id="statusDistChart"></canvas></div>' +
              '</div></div></div>' +
          '</div>' +
        '</div>';
      var equipe = document.getElementById('tab-equipe');
      if (equipe) main.insertBefore(sec, equipe);
      else main.appendChild(sec);
    }
    var card = document.querySelector('.status-dist-card');
    if (card && card.parentElement && !card.parentElement.classList.contains('status-dist-wrap')) {
      var wrap = document.createElement('div');
      wrap.className = 'status-dist-wrap';
      card.parentNode.insertBefore(wrap, card);
      wrap.appendChild(card);
    }
    var st = document.getElementById('statusDistStyle');
    if (!st) {
      st = document.createElement('style');
      st.id = 'statusDistStyle';
      document.head.appendChild(st);
    }
    st.textContent =
        '.status-dist-wrap{display:flex;justify-content:center;width:100%;}' +
        '.status-dist-card{background:#F7F4EE;color:#1B2430;border-radius:12px;padding:16px 16px 8px;width:50%;max-width:50%;margin:0 auto;box-sizing:border-box;}' +
        '.status-dist-title{font-size:15px;font-weight:700;margin:0 0 4px;}' +
        '.status-dist-hint{font-size:11px;color:#5B6773;margin:0 0 10px;line-height:1.35;}' +
        '.status-dist-body{display:flex;gap:12px;align-items:stretch;min-height:180px;}' +
        '.status-dist-table{border-collapse:collapse;min-width:140px;height:fit-content;background:#fff;}' +
        '.status-dist-table th{background:#2F80ED;color:#fff;font-size:10px;letter-spacing:.04em;padding:6px 10px;text-align:left;}' +
        '.status-dist-table th:last-child,.status-dist-table td:last-child{text-align:right;}' +
        '.status-dist-table td{padding:6px 10px;border-bottom:1px solid #E6E2DA;font-size:12px;}' +
        '.status-dist-chart-wrap{flex:1;min-width:0;height:180px;}' +
        '@media(max-width:900px){.status-dist-card{width:90%;max-width:90%;}.status-dist-body{flex-direction:column;}.status-dist-chart-wrap{height:160px;}}';
  }

  function classify(t, now) {
    if (t && t.done) return 'concluida';
    var fim = t && t.fim ? new Date(t.fim) : null;
    var ini = t && t.inicio ? new Date(t.inicio) : null;
    if (fim && !isNaN(fim) && fim < now) return 'atrasada';
    if (ini && !isNaN(ini) && ini <= now && (!fim || isNaN(fim) || fim >= now)) return 'andamento';
    return 'pendente';
  }

  function countsFromTasks(tasks) {
    var now = new Date();
    var c = { pendente: 0, andamento: 0, concluida: 0, atrasada: 0 };
    (tasks || []).forEach(function (t) { c[classify(t, now)]++; });
    return c;
  }

  window.renderStatusDist = function renderStatusDist() {
    ensureDom();
    var title = document.getElementById('statusDistTitle');
    var area = (typeof CURRENT_AREA !== 'undefined' && CURRENT_AREA) ? CURRENT_AREA : '';
    var labels = (typeof AREA_LABELS !== 'undefined' && AREA_LABELS) ? AREA_LABELS : {};
    if (title) title.textContent = 'Distribuicao por status — ' + (labels[area] || area || 'disciplina');

    var tasks = (typeof TASKS !== 'undefined' && Array.isArray(TASKS)) ? TASKS : [];
    var c = countsFromTasks(tasks);
    var body = document.getElementById('statusDistTableBody');
    if (body) {
      body.innerHTML = ORDER.map(function (k) {
        return '<tr><td>' + LABELS[k] + '</td><td>' + c[k] + '</td></tr>';
      }).join('');
    }

    var canvas = document.getElementById('statusDistChart');
    if (!canvas || typeof Chart === 'undefined') return;
    if (STATUS_CHART) {
      try { STATUS_CHART.destroy(); } catch (e) {}
      STATUS_CHART = null;
    }
    try {
      if (Chart.getChart) {
        var old = Chart.getChart(canvas);
        if (old) old.destroy();
      }
    } catch (e) {}

    STATUS_CHART = new Chart(canvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: ORDER.map(function (k) { return LABELS[k]; }),
        datasets: [{
          data: ORDER.map(function (k) { return c[k]; }),
          backgroundColor: ORDER.map(function (k) { return COLORS[k]; }),
          borderWidth: 0,
          barPercentage: 0.62,
          categoryPercentage: 0.7
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: function (ctx) { return ' ' + ctx.parsed.y; }
            }
          }
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#5B6773' }
          },
          y: {
            beginAtZero: true,
            grace: '10%',
            grid: { color: '#E6E2DA' },
            ticks: { color: '#5B6773', precision: 0 }
          }
        }
      }
    });
  };

  function wrapActivate() {
    if (window.__PCM_STATUS_WRAP_ACT__) return;
    if (typeof activateTab !== 'function') return;
    window.__PCM_STATUS_WRAP_ACT__ = true;
    var _orig = activateTab;
    window.activateTab = function (tab) {
      var r = _orig.apply(this, arguments);
      if (tab === 'status') window.renderStatusDist();
      return r;
    };
  }

  function wrapSetup() {
    if (window.__PCM_STATUS_WRAP_SETUP__) return;
    if (typeof setupTabsForRole !== 'function') return;
    window.__PCM_STATUS_WRAP_SETUP__ = true;
    var _orig = setupTabsForRole;
    window.setupTabsForRole = function () {
      var r = _orig.apply(this, arguments);
      var tabbar = document.getElementById('tabbar');
      var btn = tabbar && tabbar.querySelector('[data-tab="status"]');
      if (!btn) { ensureDom(); btn = tabbar && tabbar.querySelector('[data-tab="status"]'); }
      var show = false;
      try {
        if (typeof USER !== 'undefined' && USER) {
          show = USER.role === 'admin' || USER.role === 'supervisor' || USER.role === 'operador';
        }
      } catch (e) {}
      if (btn) btn.style.display = show ? '' : 'none';
      return r;
    };
    try { setupTabsForRole(); } catch (e) {}
  }

  function wrapRenderAll() {
    if (window.__PCM_STATUS_WRAP_ALL__) return;
    if (typeof renderAll !== 'function') return;
    window.__PCM_STATUS_WRAP_ALL__ = true;
    var _orig = renderAll;
    window.renderAll = function () {
      var r = _orig.apply(this, arguments);
      var active = document.querySelector('.tab-btn.active');
      if (active && active.getAttribute('data-tab') === 'status') window.renderStatusDist();
      return r;
    };
  }

  function boot() {
    ensureDom();
    wrapActivate();
    wrapSetup();
    wrapRenderAll();
  }

  var n = 0;
  var t = setInterval(function () {
    n++;
    boot();
    if ((window.__PCM_STATUS_WRAP_ACT__ && window.__PCM_STATUS_WRAP_SETUP__) || n > 80) clearInterval(t);
  }, 120);
  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', boot);
})();
