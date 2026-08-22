/* Curva S x3 - 3 disciplinas sobrepostas */
(function () {
  if (window.__PCM_SCURVE3__) return;
  window.__PCM_SCURVE3__ = true;

  window.sCurve3Chart = window.sCurve3Chart || null;
  window.SCURVE3_VISIBLE = window.SCURVE3_VISIBLE || { ELETRICA: true, MECANICA: true, TGM: true };
  window.SCURVE3_SHOW_REAL = window.SCURVE3_SHOW_REAL || false;
  window.SCURVE3_CACHE = null;
  window.SCURVE3_COLORS = {
    ELETRICA: { line: '#5B9FE3', fill: 'rgba(91,159,227,0.10)' },
    MECANICA: { line: '#F0A430', fill: 'rgba(240,164,48,0.10)' },
    TGM:      { line: '#33C481', fill: 'rgba(51,196,129,0.10)' },
  };

  async function loadSCurve3Data(force) {
    if (window.SCURVE3_CACHE && !force) return window.SCURVE3_CACHE;
    try {
      const data = await api('/api/dashboard');
      window.SCURVE3_CACHE = data;
      return data;
    } catch (e) {
      console.error('scurve3 dashboard', e);
      return null;
    }
  }

  function unifySCurve3Timeline(areasData) {
    const dateSet = new Set();
    const areaSeries = {};
    for (const area of ['ELETRICA', 'MECANICA', 'TGM']) {
      const block = areasData && areasData[area];
      if (!block) {
        areaSeries[area] = { mapP: {}, mapR: {}, lastP: 0, lastR: 0, label: area };
        continue;
      }
      const curve = block.curve || {};
      const labels = curve.labels || block.labels || [];
      const planned = curve.planned || block.planned || [];
      const real = curve.real || block.real || [];
      const mapP = {}, mapR = {};
      for (let i = 0; i < labels.length; i++) {
        const lab = String(labels[i]);
        dateSet.add(lab);
        mapP[lab] = Number(planned[i]) || 0;
        mapR[lab] = Number(real[i]) || 0;
      }
      areaSeries[area] = {
        mapP, mapR,
        lastP: planned.length ? Number(planned[planned.length - 1]) || 0 : 0,
        lastR: real.length ? Number(real[real.length - 1]) || 0 : 0,
        label: block.label || area,
      };
    }
    function labKey(lab) {
      const m = String(lab).match(/(\d{2})\/(\d{2})/);
      if (m) return Number(m[2]) * 100 + Number(m[1]);
      return String(lab);
    }
    const labels = Array.from(dateSet).sort((a, b) => {
      const ka = labKey(a), kb = labKey(b);
      if (ka < kb) return -1;
      if (ka > kb) return 1;
      return 0;
    });
    return { labels, areaSeries };
  }

  window.renderSCurve3 = async function renderSCurve3() {
    const canvas = document.getElementById('sCurve3Chart');
    if (!canvas || typeof Chart === 'undefined') return;
    const dash = await loadSCurve3Data(true);
    const areasObj = (dash && dash.areas) ? dash.areas : dash;
    if (!areasObj) {
      if (window.sCurve3Chart) { window.sCurve3Chart.destroy(); window.sCurve3Chart = null; }
      return;
    }
    const { labels, areaSeries } = unifySCurve3Timeline(areasObj);
    for (const area of ['ELETRICA', 'MECANICA', 'TGM']) {
      const el = document.getElementById('scurve3Pct' + area);
      if (!el) continue;
      const s = areaSeries[area];
      if (!s || !Object.keys(s.mapP).length) el.textContent = 'sem dados';
      else el.textContent = s.lastP.toFixed(1) + '% plan' + (window.SCURVE3_SHOW_REAL ? ' · ' + s.lastR.toFixed(1) + '% real' : '');
    }
    const colors = window.SCURVE3_COLORS;
    const datasets = [];
    for (const area of ['ELETRICA', 'MECANICA', 'TGM']) {
      if (!window.SCURVE3_VISIBLE[area]) continue;
      const s = areaSeries[area];
      let last = 0;
      const filledP = labels.map(lab => {
        const v = s.mapP[lab];
        if (v === undefined) return last;
        last = v; return v;
      });
      const name = s.label || area;
      datasets.push({
        label: name + ' · Planejado',
        data: filledP,
        borderColor: colors[area].line,
        backgroundColor: colors[area].fill,
        borderWidth: 2.5,
        pointRadius: 2,
        pointHoverRadius: 5,
        fill: false,
        tension: 0.25,
        spanGaps: true,
      });
      if (window.SCURVE3_SHOW_REAL) {
        let lastR = 0;
        const filledR = labels.map(lab => {
          const v = s.mapR[lab];
          if (v === undefined) return lastR;
          lastR = v; return v;
        });
        datasets.push({
          label: name + ' · Real',
          data: filledR,
          borderColor: colors[area].line,
          backgroundColor: 'transparent',
          borderWidth: 2,
          borderDash: [6, 4],
          pointRadius: 0,
          pointHoverRadius: 4,
          fill: false,
          tension: 0.25,
          spanGaps: true,
        });
      }
    }
    if (!labels.length || !datasets.length) {
      if (window.sCurve3Chart) { window.sCurve3Chart.destroy(); window.sCurve3Chart = null; }
      return;
    }
    if (window.sCurve3Chart) {
      window.sCurve3Chart.data.labels = labels;
      window.sCurve3Chart.data.datasets = datasets;
      window.sCurve3Chart.update();
      return;
    }
    window.sCurve3Chart = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 12, right: 16, bottom: 8, left: 4 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: true, position: 'bottom', labels: { color: '#8494A3', font: { family: 'IBM Plex Mono', size: 11 }, boxWidth: 12, padding: 14 } },
          tooltip: {
            backgroundColor: '#121821',
            titleFont: { family: 'IBM Plex Mono', size: 11 },
            bodyFont: { family: 'IBM Plex Mono', size: 12 },
            borderColor: '#232C36',
            borderWidth: 1,
            padding: 10,
            callbacks: { label: (ctx) => ' ' + ctx.dataset.label + ': ' + Number(ctx.parsed.y).toFixed(1) + '%' }
          }
        },
        scales: {
          x: { grid: { color: '#1A222B' }, ticks: { color: '#8494A3', font: { family: 'IBM Plex Mono', size: 11 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 14, padding: 6 } },
          y: { min: 0, max: 100, grid: { color: '#1A222B' }, ticks: { color: '#8494A3', font: { family: 'IBM Plex Mono', size: 11 }, stepSize: 10, padding: 8, callback: v => v + '%' } }
        }
      }
    });
  };

  window.setupSCurve3Controls = function setupSCurve3Controls() {
    document.querySelectorAll('.scurve3-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const area = btn.getAttribute('data-area');
        window.SCURVE3_VISIBLE[area] = !window.SCURVE3_VISIBLE[area];
        btn.classList.toggle('active', window.SCURVE3_VISIBLE[area]);
        if (!window.SCURVE3_VISIBLE.ELETRICA && !window.SCURVE3_VISIBLE.MECANICA && !window.SCURVE3_VISIBLE.TGM) {
          window.SCURVE3_VISIBLE[area] = true;
          btn.classList.add('active');
        }
        window.renderSCurve3();
      });
    });
    const realChk = document.getElementById('scurve3ShowReal');
    if (realChk) {
      realChk.addEventListener('change', () => {
        window.SCURVE3_SHOW_REAL = !!realChk.checked;
        window.renderSCurve3();
      });
    }
    const hdr = document.getElementById('scurve3Btn');
    if (hdr) {
      hdr.addEventListener('click', () => {
        const tabBtn = document.querySelector('.tab-btn[data-tab="scurve3"]');
        if (tabBtn && tabBtn.style.display === 'none') return;
        if (typeof activateTab === 'function') activateTab('scurve3');
      });
    }
  };

  // Hook after DOM ready
  function tryHook() {
    if (typeof activateTab === 'function') {
      const _act = activateTab;
      window.activateTab = function (tab) {
        _act(tab);
        if (tab === 'scurve3') {
          window.renderSCurve3();
          if (window.sCurve3Chart) setTimeout(() => { try { window.sCurve3Chart.resize(); } catch (_) {} }, 40);
        }
        const s3btn = document.getElementById('scurve3Btn');
        if (s3btn) s3btn.classList.toggle('active-tool', tab === 'scurve3');
      };
    }
    if (typeof setupTabsForRole === 'function') {
      const _setup = setupTabsForRole;
      window.setupTabsForRole = function () {
        _setup();
        const s3btn = document.getElementById('scurve3Btn');
        const tabBtn = document.querySelector('.tab-btn[data-tab="scurve3"]');
        // show scurve3 for supervisor/admin same as scurve
        if (tabBtn) {
          const scurveBtn = document.querySelector('.tab-btn[data-tab="scurve"]');
          if (scurveBtn) tabBtn.style.display = scurveBtn.style.display;
        }
        if (s3btn) {
          const scurveBtn = document.querySelector('.tab-btn[data-tab="scurve"]');
          s3btn.style.display = scurveBtn ? scurveBtn.style.display : 'none';
        }
        window.setupSCurve3Controls();
      };
    }
    window.setupSCurve3Controls();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(tryHook, 50));
  } else {
    setTimeout(tryHook, 50);
  }
})();
