/* Curva S x3 */
(function () {
  if (window.__PCM_SCURVE3__) return;
  window.__PCM_SCURVE3__ = true;

  window.sCurve3Chart = null;
  window.SCURVE3_VISIBLE = { ELETRICA: true, MECANICA: true, TGM: true };
  window.SCURVE3_SHOW_REAL = false;
  window.SCURVE3_CACHE = null;
  window.SCURVE3_COLORS = {
    ELETRICA: { line: '#5B9FE3', fill: 'rgba(91,159,227,0.10)' },
    MECANICA: { line: '#F0A430', fill: 'rgba(240,164,48,0.10)' },
    TGM:      { line: '#33C481', fill: 'rgba(51,196,129,0.10)' }
  };

  async function loadSCurve3Data(force) {
    if (window.SCURVE3_CACHE && !force) return window.SCURVE3_CACHE;
    const headers = { 'Content-Type': 'application/json' };
    const tok = (typeof TOKEN !== 'undefined' && TOKEN) || localStorage.getItem('pcm_token');
    if (tok) headers['Authorization'] = 'Bearer ' + tok;
    const res = await fetch('/api/dashboard', { headers: headers, cache: 'no-store' });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
    window.SCURVE3_CACHE = data;
    return data;
  }

  function unifySCurve3Timeline(areasData) {
    var dateSet = {};
    var areaSeries = {};
    var areas = ['ELETRICA', 'MECANICA', 'TGM'];
    for (var ai = 0; ai < areas.length; ai++) {
      var area = areas[ai];
      var block = areasData && areasData[area];
      if (!block) {
        areaSeries[area] = { mapP: {}, mapR: {}, lastP: 0, lastR: 0, label: area };
        continue;
      }
      var curve = block.curve || {};
      var labels = curve.labels || [];
      var planned = curve.planned || [];
      var real = curve.real || [];
      var mapP = {}, mapR = {};
      for (var i = 0; i < labels.length; i++) {
        var lab = String(labels[i]);
        dateSet[lab] = true;
        mapP[lab] = Number(planned[i]) || 0;
        mapR[lab] = Number(real[i]) || 0;
      }
      areaSeries[area] = {
        mapP: mapP,
        mapR: mapR,
        lastP: planned.length ? Number(planned[planned.length - 1]) || 0 : 0,
        lastR: real.length ? Number(real[real.length - 1]) || 0 : 0,
        label: block.label || area
      };
    }
    function labKey(lab) {
      var m = String(lab).match(/(\d{2})\/(\d{2})/);
      if (m) return Number(m[2]) * 100 + Number(m[1]);
      return String(lab);
    }
    var labelsOut = Object.keys(dateSet).sort(function (a, b) {
      var ka = labKey(a), kb = labKey(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return 0;
    });
    return { labels: labelsOut, areaSeries: areaSeries };
  }

  function resizeSCurve3Soon() {
    [50, 150, 400, 800].forEach(function (ms) {
      setTimeout(function () {
        try { if (window.sCurve3Chart) window.sCurve3Chart.resize(); } catch (e) {}
      }, ms);
    });
  }

  window.renderSCurve3 = async function renderSCurve3() {
    var canvas = document.getElementById('sCurve3Chart');
    if (!canvas) { console.warn('[scurve3] canvas missing'); return; }
    if (typeof Chart === 'undefined') { console.warn('[scurve3] Chart.js missing'); return; }
    var box = canvas.parentElement;
    if (box) {
      box.style.minHeight = '420px';
      if (box.clientHeight < 200) box.style.height = '420px';
    }
    var dash = await loadSCurve3Data(true);
    var areasObj = (dash && dash.areas) ? dash.areas : dash;
    if (!areasObj) {
      console.warn('[scurve3] no dashboard data');
      return;
    }
    var unified = unifySCurve3Timeline(areasObj);
    var labels = unified.labels;
    var areaSeries = unified.areaSeries;
    ['ELETRICA', 'MECANICA', 'TGM'].forEach(function (area) {
      var el = document.getElementById('scurve3Pct' + area);
      if (!el) return;
      var s = areaSeries[area];
      if (!s || !Object.keys(s.mapP).length) el.textContent = 'sem dados';
      else el.textContent = s.lastP.toFixed(1) + '% plan';
    });
    var colors = window.SCURVE3_COLORS;
    var datasets = [];
    ['ELETRICA', 'MECANICA', 'TGM'].forEach(function (area) {
      if (!window.SCURVE3_VISIBLE[area]) return;
      var s = areaSeries[area];
      var last = 0;
      var filledP = labels.map(function (lab) {
        if (s.mapP[lab] === undefined) return last;
        last = s.mapP[lab];
        return last;
      });
      datasets.push({
        label: (s.label || area) + ' · Planejado',
        data: filledP,
        borderColor: colors[area].line,
        backgroundColor: colors[area].fill,
        borderWidth: 2.5,
        pointRadius: 2,
        fill: false,
        tension: 0.25,
        spanGaps: true
      });
      if (window.SCURVE3_SHOW_REAL) {
        var lastR = 0;
        var filledR = labels.map(function (lab) {
          if (s.mapR[lab] === undefined) return lastR;
          lastR = s.mapR[lab];
          return lastR;
        });
        datasets.push({
          label: (s.label || area) + ' · Real',
          data: filledR,
          borderColor: colors[area].line,
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.25,
          spanGaps: true
        });
      }
    });
    if (!labels.length || !datasets.length) return;
    if (window.sCurve3Chart) {
      window.sCurve3Chart.data.labels = labels;
      window.sCurve3Chart.data.datasets = datasets;
      window.sCurve3Chart.update('none');
      resizeSCurve3Soon();
      return;
    }
    window.sCurve3Chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: '#8494A3' } },
          tooltip: { backgroundColor: '#121821', borderColor: '#232C36', borderWidth: 1 }
        },
        scales: {
          x: { grid: { color: '#1A222B' }, ticks: { color: '#8494A3', maxTicksLimit: 14 } },
          y: { min: 0, max: 100, grid: { color: '#1A222B' }, ticks: { color: '#8494A3', callback: function (v) { return v + '%'; } } }
        }
      }
    });
    resizeSCurve3Soon();
  };

  function showSCurve3UI(show) {
    var tabBtn = document.querySelector('.tab-btn[data-tab="scurve3"]');
    var s3btn = document.getElementById('scurve3Btn');
    var disp = show ? '' : 'none';
    if (tabBtn) tabBtn.style.display = disp;
    if (s3btn) s3btn.style.display = disp;
  }

  function openSCurve3() {
    console.info('[scurve3] open');
    showSCurve3UI(true);
    document.querySelectorAll('.tab-btn').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === 'scurve3');
    });
    document.querySelectorAll('.tab-panel').forEach(function (p) {
      p.classList.toggle('active', p.id === 'tab-scurve3');
    });
    var s3btn = document.getElementById('scurve3Btn');
    if (s3btn) s3btn.classList.add('active-tool');
    var tabbar = document.getElementById('tabbar');
    if (tabbar) tabbar.style.display = '';
    window.renderSCurve3().then(function () { resizeSCurve3Soon(); }).catch(function (e) {
      console.error(e);
      alert('Erro Curva S x3: ' + (e.message || e));
    });
  }
  window.openSCurve3 = openSCurve3;

  // Clique global — sempre funciona
  if (!window.__PCM_SCURVE3_CLICK__) {
    window.__PCM_SCURVE3_CLICK__ = true;
    document.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest && ev.target.closest('#scurve3Btn, .tab-btn[data-tab="scurve3"], .scurve3-btn');
      if (!t) return;
      ev.preventDefault();
      ev.stopPropagation();
      openSCurve3();
    }, true);
  }

  document.querySelectorAll('.scurve3-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var area = btn.getAttribute('data-area');
      window.SCURVE3_VISIBLE[area] = !window.SCURVE3_VISIBLE[area];
      btn.classList.toggle('active', window.SCURVE3_VISIBLE[area]);
      window.renderSCurve3();
    });
  });
  var realChk = document.getElementById('scurve3ShowReal');
  if (realChk) {
    realChk.addEventListener('change', function () {
      window.SCURVE3_SHOW_REAL = !!realChk.checked;
      window.renderSCurve3();
    });
  }

  showSCurve3UI(true);
})();
