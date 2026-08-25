/* Restricoes do usuario TGM (area_scope=TGM, ex.: supertgm):
   - esconde aba Custos
   - esconde botao Curva S x3 (header) */
(function () {
  function isTgmUser() {
    try {
      if (typeof USER === 'undefined' || !USER || !USER.area_scope) return false;
      return String(USER.area_scope).toUpperCase() === 'TGM';
    } catch (e) { return false; }
  }

  function applyTgmRestrictions() {
    if (!isTgmUser()) return;

    // Aba Custos
    var custosBtn = document.querySelector('.tab-btn[data-tab="custos"]');
    if (custosBtn) custosBtn.style.display = 'none';
    var custosPanel = document.getElementById('tab-custos');
    if (custosPanel && custosPanel.classList.contains('active')) {
      if (typeof activateTab === 'function') activateTab('tarefas');
    }

    // Botao Curva S x3 (header + eventuais variantes)
    var hdr = document.getElementById('scurve3Btn');
    if (hdr) {
      hdr.style.display = 'none';
      hdr.classList.remove('active-tool');
    }
    document.querySelectorAll('.scurve3-btn, .tab-btn[data-tab="scurve3"]').forEach(function (el) {
      el.style.display = 'none';
      el.classList.remove('active');
    });

    // Se estiver no painel x3, volta para tarefas
    var s3panel = document.getElementById('tab-scurve3');
    if (s3panel && s3panel.classList.contains('active')) {
      if (typeof activateTab === 'function') activateTab('tarefas');
    }
  }

  function wrapSetup() {
    if (window.__PCM_TGM_RESTRICTIONS__) return;
    if (typeof setupTabsForRole !== 'function') return;
    window.__PCM_TGM_RESTRICTIONS__ = true;
    var _orig = setupTabsForRole;
    window.setupTabsForRole = function () {
      _orig();
      applyTgmRestrictions();
    };
    applyTgmRestrictions();
  }

  // Intervalo continuo: scurve3.js reexibe o botao periodicamente
  setInterval(function () {
    wrapSetup();
    applyTgmRestrictions();
  }, 400);

  document.addEventListener('DOMContentLoaded', function () {
    wrapSetup();
    applyTgmRestrictions();
  });
  window.addEventListener('load', function () {
    wrapSetup();
    applyTgmRestrictions();
  });
})();
