/* TGM: segunda Curva S na mesma aba, com metade da area do grafico principal. */
(function () {
  if (window.__PCM_TGM_SCURVE2__) return;
  window.__PCM_TGM_SCURVE2__ = true;

  var chart2 = null;

  function isTgm() {
    try {
      return typeof CURRENT_AREA !== 'undefined' && String(CURRENT_AREA).toUpperCase() === 'TGM';
    } catch (e) { return false; }
  }

  function ensureDom() {
    var panel = document.querySelector('#tab-scurve .panel-body');
    if (!panel) return null;
    var wrap = document.getElementById('tgmScurve2Wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'tgmScurve2Wrap';
      wrap.innerHTML =
        '<div class="tgm-scurve2-head">Curva S — TGM <span style="opacity:.7">(50%)</span></div>' +
        '<div class="chart-box tgm-scurve2-box"><canvas id="sCurveChartTgm2"></canvas></div>';
      panel.appendChild(wrap);
    }
    if (!document.getElementById('tgmScurve2Style')) {
      var st = document.createElement('style');
      st.id = 'tgmScurve2Style';
      st.textContent =
        '#tgmScurve2Wrap{display:none;justify-content:center;flex-direction:column;align-items:center;margin-top:18px;width:100%;}' +
        '#tgmScurve2Wrap.on{display:flex;}' +
        '.tgm-scurve2-head{width:50%;max-width:50%;font-size:12px;color:#8494A3;margin:0 0 8px;text-align:left;}' +
        '.tgm-scurve2-box{width:50%;max-width:50%;height:180px;min-height:180px;position:relative;}' +
        '.tgm-scurve2-box canvas{position:absolute;top:0;left:0;width:100%!important;height:100%!important;}';
      document.head.appendChild(st);
    }
    wrap.classList.toggle('on', isTgm());
    return document.getElementById('sCurveChartTgm2');
  }

  function destroy2() {
    if (chart2) {
      try { chart2.destroy(); } catch (e) {}
      chart2 = null;
    }
    var c = document.getElementById('sCurveChartTgm2');
    try {
      if (c && typeof Chart !== 'undefined' && Chart.getChart) {
        var ch = Chart.getChart(c);
        if (ch) ch.destroy();
      }
    } catch (e) {}
  }

  function copyFromMain() {
    var canvas = ensureDom();
    if (!isTgm()) {
      destroy2();
      var w = document.getElementById('tgmScurve2Wrap');
      if (w) w.classList.remove('on');
      return;
    }
    if (!canvas || typeof Chart === 'undefined') return;
    var src = null;
    try { if (typeof sCurveChart !== 'undefined') src = sCurveChart; } catch (e) {}
    if (!src || !src.data) return;

    var labels = (src.data.labels || []).slice();
    var ds = (src.data.datasets || []).map(function (d) {
      return {
        label: d.label,
        data: (d.data || []).slice(),
        borderColor: d.borderColor,
        backgroundColor: d.backgroundColor,
        borderWidth: 2,
        pointRadius: 1,
        pointHoverRadius: 4,
        fill: !!d.fill,
        tension: d.tension || 0.25
      };
    });
    if (!labels.length || !ds.length) { destroy2(); return; }

    if (chart2) {
      chart2.data.labels = labels;
      ds.forEach(function (d, i) {
        if (chart2.data.datasets[i]) chart2.data.datasets[i].data = d.data;
      });
      chart2.update();
      try { chart2.resize(); } catch (e) {}
      return;
    }

    chart2 = new Chart(canvas.getContext('2d'), {
      type: 'line',
      data: { labels: labels, datasets: ds },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        layout: { padding: { top: 6, right: 8, bottom: 4, left: 2 } },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
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
            ticks: { color: '#8494A3', maxTicksLimit: 8, maxRotation: 0, font: { size: 10 } }
          },
          y: {
            min: 0, max: 100,
            grid: { color: '#1A222B' },
            ticks: { color: '#8494A3', stepSize: 20, font: { size: 10 }, callback: function (v) { return v + '%'; } }
          }
        }
      }
    });
    setTimeout(function () { try { if (chart2) chart2.resize(); } catch (e) {} }, 40);
  }

  function wrapRender() {
    if (window.__PCM_TGM_SCURVE2_WRAP__) return;
    if (typeof renderSCurve !== 'function') return;
    window.__PCM_TGM_SCURVE2_WRAP__ = true;
    var orig = renderSCurve;
    window.renderSCurve = async function () {
      var r = orig.apply(this, arguments);
      try { await r; } catch (e) {}
      setTimeout(copyFromMain, 80);
      setTimeout(copyFromMain, 280);
      return r;
    };
  }

  function onAreaOrTab() {
    ensureDom();
    var active = document.querySelector('.tab-btn.active');
    var tab = active && active.getAttribute('data-tab');
    if (tab === 'scurve' && isTgm()) copyFromMain();
    else if (!isTgm()) destroy2();
  }

  function boot() {
    wrapRender();
    ensureDom();
    onAreaOrTab();
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('.area-btn, .tab-btn');
    if (t) setTimeout(onAreaOrTab, 120);
  }, true);

  var n = 0;
  var t = setInterval(function () {
    n++;
    boot();
    if (window.__PCM_TGM_SCURVE2_WRAP__ || n > 80) clearInterval(t);
  }, 150);
  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', boot);
})();
