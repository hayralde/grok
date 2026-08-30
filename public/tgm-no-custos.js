/* PCM UI fixes:
   1) Usuario TGM (supertgm): esconde Custos
   2) Preserva a aba ativa em atualizacoes em tempo real (nao volta pro inicio) */
(function () {
  function isTgmUser() {
    try {
      if (typeof USER === 'undefined' || !USER || !USER.area_scope) return false;
      return String(USER.area_scope).toUpperCase() === 'TGM';
    } catch (e) { return false; }
  }

  function applyTgmRestrictions() {
    if (!isTgmUser()) return;

    var custosBtn = document.querySelector('.tab-btn[data-tab="custos"]');
    if (custosBtn) custosBtn.style.display = 'none';
    var custosPanel = document.getElementById('tab-custos');
    if (custosPanel && custosPanel.classList.contains('active')) {
      if (typeof activateTab === 'function') activateTab('tarefas');
    }
  }

  function wrapSetupTabs() {
    if (window.__PCM_PRESERVE_TABS__) return;
    if (typeof setupTabsForRole !== 'function') return;
    window.__PCM_PRESERVE_TABS__ = true;
    var _origSetup = setupTabsForRole;
    window.setupTabsForRole = function () {
      var before = null;
      try {
        var a = document.querySelector('.tab-btn.active');
        if (a) before = a.getAttribute('data-tab');
      } catch (e) {}
      _origSetup();
      applyTgmRestrictions();
      try {
        var after = document.querySelector('.tab-btn.active');
        var afterName = after && after.getAttribute('data-tab');
        if (before && afterName && before !== afterName) {
          var prevBtn = document.querySelector('.tab-btn[data-tab="' + before + '"]');
          if (prevBtn && prevBtn.style.display !== 'none' && typeof activateTab === 'function') {
            activateTab(before);
          }
        }
      } catch (e) {}
    };
  }

  function wrapRenderAll() {
    if (window.__PCM_PRESERVE_RENDER__) return;
    if (typeof renderAll !== 'function') return;
    window.__PCM_PRESERVE_RENDER__ = true;
    window.renderAll = function () {
      var activeTab = document.querySelector('.tab-btn.active');
      if (!activeTab) return;
      var tab = activeTab.getAttribute('data-tab');
      try {
        if (tab === 'home' && typeof renderHome === 'function') return renderHome();
        if (tab === 'gantt' && typeof renderGantt === 'function') return renderGantt();
        if (tab === 'scurve' && typeof renderSCurve === 'function') {
          renderSCurve();
          if (typeof sCurveChart !== 'undefined' && sCurveChart) {
            setTimeout(function () { try { sCurveChart.resize(); } catch (e) {} }, 40);
          }
          return;
        }
        if (tab === 'equipe' && typeof renderEquipe === 'function') return renderEquipe();
        if (tab === 'tarefas' && typeof renderTarefas === 'function') return renderTarefas();
        if (tab === 'custos' && typeof renderCustos === 'function') return renderCustos();
        if (tab === 'status' && typeof renderStatusDist === 'function') return renderStatusDist();
      } catch (e) {
        console.warn('[PCM] renderAll preserve', e);
      }
    };
  }

  function tick() {
    wrapSetupTabs();
    wrapRenderAll();
    applyTgmRestrictions();
  }

  setInterval(tick, 500);
  document.addEventListener('DOMContentLoaded', tick);
  window.addEventListener('load', tick);
  tick();
})();

(function () {
  if (document.querySelector('script[src*="status-dist.js"]')) return;
  var s = document.createElement('script');
  s.src = 'status-dist.js?v=4028t';
  document.head.appendChild(s);
})();

(function () {
  if (document.querySelector('script[src*="tgm-enum.js"]')) return;
  var s = document.createElement('script');
  s.src = 'tgm-enum.js?v=4028u';
  document.head.appendChild(s);
})();

(function () {
  if (document.querySelector('script[src*="tgm-scurve2.js"]')) return;
  var s = document.createElement('script');
  s.src = 'tgm-scurve2.js?v=4028v';
  document.head.appendChild(s);
})();
