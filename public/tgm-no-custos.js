/* Esconde aba Custos para usuario TGM (area_scope=TGM, ex.: supertgm) */
(function () {
  function hideCustosForTgm() {
    try {
      if (typeof USER === 'undefined' || !USER || !USER.area_scope) return;
      if (String(USER.area_scope).toUpperCase() !== 'TGM') return;
      var btn = document.querySelector('.tab-btn[data-tab="custos"]');
      if (btn) btn.style.display = 'none';
      var panel = document.getElementById('tab-custos');
      if (panel && panel.classList.contains('active')) {
        if (typeof activateTab === 'function') activateTab('tarefas');
      }
    } catch (e) {}
  }

  function wrapSetup() {
    if (window.__PCM_TGM_NO_CUSTOS__) return;
    if (typeof setupTabsForRole !== 'function') return;
    window.__PCM_TGM_NO_CUSTOS__ = true;
    var _orig = setupTabsForRole;
    window.setupTabsForRole = function () {
      _orig();
      hideCustosForTgm();
    };
    hideCustosForTgm();
  }

  var n = 0;
  var t = setInterval(function () {
    n++;
    wrapSetup();
    hideCustosForTgm();
    if (window.__PCM_TGM_NO_CUSTOS__ || n > 100) clearInterval(t);
  }, 100);
  document.addEventListener('DOMContentLoaded', function () {
    wrapSetup();
    hideCustosForTgm();
  });
  window.addEventListener('load', function () {
    wrapSetup();
    hideCustosForTgm();
  });
})();
