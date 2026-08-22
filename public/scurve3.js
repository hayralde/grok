/* Curva S x3 v4.0.2.5 — login obrigatorio + token no fetch */
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

  function getToken() {
    try {
      if (typeof TOKEN !== 'undefined' && TOKEN) return TOKEN;
    } catch (e) {}
    try {
      return localStorage.getItem('pcm_token') || null;
    } catch (e) {
      return null;
    }
  }

  async function loadSCurve3Data(force) {
    if (window.SCURVE3_CACHE && !force) return window.SCURVE3_CACHE;
    var tok = getToken();
    if (!tok) {
      console.warn('[scurve3] sem token — faca login');
      throw new Error('Faca login para ver a Curva S x3');
    }
    var res = await fetch('/api/dashboard', {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + tok
      },
      cache: 'no-store'
    });
    var data = await res.json().catch(function () { return {}; });
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
        try {
          if (window.sCurve3Chart) window.sCurve3Chart.resize();
        } catch (e) {}
      }, ms);
    });
  }

  function destroySCurve3() {
    if (window.sCurve3Chart) {
      try { window.sCurve3Chart.destroy(); } catch (e) {}
      window.sCurve3Chart = null;
    }
  }

  window.renderSCurve3 = async function renderSCurve3() {
    var canvas = document.getElementById('sCurve3Chart');
    if (!canvas) {
      console.warn('[scurve3] canvas #sCurve3Chart nao encontrado');
      return;
    }
    if (typeof Chart === 'undefined') {
      console.warn('[scurve3] Chart.js nao carregado');
      return;
    }
    var box = canvas.parentElement;
    if (box) {
      box.style.minHeight = '420px';
      if (box.clientHeight < 200) box.style.height = '420px';
    }

    var dash;
    try {
      dash = await loadSCurve3Data(true);
    } catch (e) {
      destroySCurve3();
      console.error('[scurve3] dashboard', e);
      alert('Curva S x3: ' + (e.message || e));
      return;
    }

    var areasObj = (dash && dash.areas) ? dash.areas : dash;
    if (!areasObj) {
      destroySCurve3();
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
      else el.textContent = s.lastP.toFixed(1) + '% plan' +
        (window.SCURVE3_SHOW_REAL ? ' · ' + s.lastR.toFixed(1) + '% real' : '');
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
        pointHoverRadius: 5,
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
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
          tension: 0.25,
          spanGaps: true
        });
      }
    });

    if (!labels.length || !datasets.length) {
      destroySCurve3();
      return;
    }

    destroySCurve3();

    window.sCurve3Chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            display: true,
            position: 'bottom',
            labels: { color: '#8494A3', boxWidth: 12, padding: 14 }
          },
          tooltip: {
            backgroundColor: '#121821',
            borderColor: '#232C36',
            borderWidth: 1,
            callbacks: {
              label: function (ctx) {
                return ' ' + ctx.dataset.label + ': ' + Number(ctx.parsed.y).toFixed(1) + '%';
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: '#1A222B' },
            ticks: { color: '#8494A3', maxTicksLimit: 14, maxRotation: 0 }
          },
          y: {
            min: 0,
            max: 100,
            grid: { color: '#1A222B' },
            ticks: {
              color: '#8494A3',
              stepSize: 10,
              callback: function (v) { return v + '%'; }
            }
          }
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
    console.info('[scurve3] openSCurve3');
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
    window.renderSCurve3().catch(function (e) {
      console.error('[scurve3] render', e);
    });
  }
  window.openSCurve3 = openSCurve3;

  if (!window.__PCM_SCURVE3_CLICK__) {
    window.__PCM_SCURVE3_CLICK__ = true;
    document.addEventListener('click', function (ev) {
      var t = ev.target && ev.target.closest &&
        ev.target.closest('#scurve3Btn, .tab-btn[data-tab="scurve3"], .scurve3-btn');
      if (!t) return;
      ev.preventDefault();
      ev.stopPropagation();
      openSCurve3();
    }, true);
  }

  function bindToggles() {
    document.querySelectorAll('.scurve3-toggle').forEach(function (btn) {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', function () {
        var area = btn.getAttribute('data-area');
        window.SCURVE3_VISIBLE[area] = !window.SCURVE3_VISIBLE[area];
        btn.classList.toggle('active', window.SCURVE3_VISIBLE[area]);
        if (!window.SCURVE3_VISIBLE.ELETRICA && !window.SCURVE3_VISIBLE.MECANICA && !window.SCURVE3_VISIBLE.TGM) {
          window.SCURVE3_VISIBLE[area] = true;
          btn.classList.add('active');
        }
        window.renderSCurve3();
      });
    });
    var realChk = document.getElementById('scurve3ShowReal');
    if (realChk && realChk.dataset.bound !== '1') {
      realChk.dataset.bound = '1';
      realChk.addEventListener('change', function () {
        window.SCURVE3_SHOW_REAL = !!realChk.checked;
        window.renderSCurve3();
      });
    }
  }

  function tryHook() {
    if (window.__PCM_SCURVE3_HOOKED__) {
      bindToggles();
      showSCurve3UI(true);
      return true;
    }
    if (typeof activateTab !== 'function') return false;

    var _act = activateTab;
    window.activateTab = function (tab) {
      if (tab === 'scurve3') {
        openSCurve3();
        return;
      }
      _act(tab);
      var s3btn = document.getElementById('scurve3Btn');
      if (s3btn) s3btn.classList.remove('active-tool');
    };

    if (typeof setupTabsForRole === 'function') {
      var _setup = setupTabsForRole;
      window.setupTabsForRole = function () {
        _setup();
        var scurveBtn = document.querySelector('.tab-btn[data-tab="scurve"]');
        var show = !!(scurveBtn && scurveBtn.style.display !== 'none') || !!getToken();
        showSCurve3UI(show);
        bindToggles();
      };
      try { window.setupTabsForRole(); } catch (e) {}
    }

    showSCurve3UI(true);
    bindToggles();
    window.__PCM_SCURVE3_HOOKED__ = true;
    return true;
  }

  var attempts = 0;
  function bootHook() {
    attempts += 1;
    if (tryHook()) return;
    if (attempts < 60) setTimeout(bootHook, 100);
    else {
      showSCurve3UI(true);
      bindToggles();
    }
  }

  showSCurve3UI(true);
  bindToggles();
  bootHook();
})();
