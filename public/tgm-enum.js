/* Enumera atividades da disciplina TGM (ordem de inicio). */
(function () {
  if (window.__PCM_TGM_ENUM__) return;
  window.__PCM_TGM_ENUM__ = true;

  function isTgm() {
    try {
      return typeof CURRENT_AREA !== 'undefined' && String(CURRENT_AREA).toUpperCase() === 'TGM';
    } catch (e) { return false; }
  }

  function numMap() {
    var tasks = (typeof TASKS !== 'undefined' && Array.isArray(TASKS)) ? TASKS.slice() : [];
    tasks.sort(function (a, b) {
      var da = a && a.inicio ? new Date(a.inicio).getTime() : 0;
      var db = b && b.inicio ? new Date(b.inicio).getTime() : 0;
      if (da !== db) return da - db;
      return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
    });
    var map = {};
    tasks.forEach(function (t, i) {
      if (t && t.id != null) map[t.id] = i + 1;
    });
    return map;
  }

  function fmt(n) {
    return String(n);
  }

  function applyTarefas() {
    if (!isTgm()) return;
    var map = numMap();
    document.querySelectorAll('#tarefasList .tarefa-row').forEach(function (row) {
      var id = row.getAttribute('data-id');
      var n = map[id] || map[Number(id)];
      if (!n) return;
      var name = row.querySelector('.tf-name');
      if (!name) return;
      if (name.dataset.tgmEnum === '1') return;
      name.dataset.tgmEnum = '1';
      name.textContent = fmt(n) + '. ' + name.textContent;
    });
  }

  function applyGantt() {
    if (!isTgm()) return;
    var map = numMap();
    var names = document.querySelectorAll('#ganttBody .task-name');
    if (!names.length) return;
    var tasks = (typeof TASKS !== 'undefined' && Array.isArray(TASKS)) ? TASKS.slice() : [];
    tasks.sort(function (a, b) {
      var da = a && a.inicio ? new Date(a.inicio).getTime() : 0;
      var db = b && b.inicio ? new Date(b.inicio).getTime() : 0;
      if (da !== db) return da - db;
      return (Number(a && a.id) || 0) - (Number(b && b.id) || 0);
    });
    var byName = {};
    tasks.forEach(function (t) {
      var key = String(t.nome || '');
      if (!byName[key]) byName[key] = [];
      byName[key].push(t);
    });
    names.forEach(function (el) {
      if (el.dataset.tgmEnum === '1') return;
      var raw = el.getAttribute('title') || el.textContent || '';
      var list = byName[raw] || [];
      var t = list.shift();
      if (!t) return;
      var n = map[t.id];
      if (!n) return;
      el.dataset.tgmEnum = '1';
      el.textContent = fmt(n) + '. ' + el.textContent;
      el.setAttribute('title', fmt(n) + '. ' + raw);
    });
  }

  function wrap(name, afterFn) {
    if (typeof window[name] !== 'function') return false;
    var flag = '__PCM_TGM_ENUM_' + name;
    if (window[flag]) return true;
    window[flag] = true;
    var orig = window[name];
    window[name] = function () {
      var r = orig.apply(this, arguments);
      try { afterFn(); } catch (e) {}
      return r;
    };
    return true;
  }

  function boot() {
    wrap('renderTarefas', applyTarefas);
    wrap('renderGantt', applyGantt);
    applyTarefas();
    applyGantt();
  }

  var n = 0;
  var t = setInterval(function () {
    n++;
    boot();
    if ((window.__PCM_TGM_ENUM_renderTarefas && window.__PCM_TGM_ENUM_renderGantt) || n > 80) clearInterval(t);
  }, 150);
  document.addEventListener('DOMContentLoaded', boot);
  window.addEventListener('load', boot);
})();
