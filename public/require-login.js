/* Bloqueia toda a navegação do app até o usuário fazer login — não existe mais
   modo "visitante". Some com o conteúdo e força a tela de login assim que a
   página carrega. Quando o login é concluído, recarrega a página pra
   renderizar tudo normalmente (igual já acontecia pra admin/supervisor). */
(function () {
  function hasToken() {
    try { return !!localStorage.getItem('pcm_token'); } catch (e) { return false; }
  }

  if (hasToken()) return; // já logado, não faz nada

  function hideAppContent() {
    ['tabbar', 'homeGrid'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
  }

  function forceLoginModal() {
    var openBtn = document.getElementById('loginOpenBtn');
    var overlay = document.getElementById('loginModalOverlay');
    var alreadyOpen = overlay && !overlay.classList.contains('hidden');
    if (!alreadyOpen && openBtn) openBtn.click();
    if (overlay) overlay.classList.remove('hidden');
  }

  function run() {
    hideAppContent();
    forceLoginModal();
  }

  run(); // roda imediatamente — não espera nenhum evento do navegador, que pode já ter disparado antes deste script carregar

  document.addEventListener('DOMContentLoaded', run);
  window.addEventListener('load', run);

  var t = setInterval(function () {
    if (hasToken()) {
      clearInterval(t);
      window.location.reload();
      return;
    }
    run();
  }, 500);
})();


/* Logout: limpa token e recarrega para exibir a tela de login (require-login) */
(function () {
  function goLogin() {
    try { localStorage.removeItem('pcm_token'); } catch (e) {}
    try { sessionStorage.clear(); } catch (e) {}
    window.location.reload();
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target && ev.target.closest && ev.target.closest('#logoutBtn, [data-logout], .logout-btn');
    if (!t) return;
    ev.preventDefault();
    ev.stopPropagation();
    goLogin();
  }, true);

  // Se a URL pedir login explicitamente, garante modal
  try {
    if (/[?&]login=1\b/.test(location.search) || /[?&]logout=1\b/.test(location.search)) {
      try { localStorage.removeItem('pcm_token'); } catch (e) {}
    }
  } catch (e) {}
})();
