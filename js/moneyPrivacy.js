// Ocultar / mostrar visualmente los valores monetarios ($, COP, USD…) de una página.
// Uso: <script src="js/moneyPrivacy.js"></script> y un botón con
//   onclick="MoneyPrivacy.toggle()" data-money-toggle
// Solo es visual: no cambia los datos ni lo que se carga. Al ocultar, el importe se
// reemplaza por puntos (conservando la moneda: "COP ••••••"), y al pasar el mouse por
// encima se muestra el valor real mientras el cursor siga sobre él.
// Funciona sobre cualquier texto renderizado (también el que se inyecta después con
// innerHTML) porque envuelve los importes que detecta en <span class="money-val">.
// La preferencia se recuerda en localStorage (ideaz_hide_money).
const MoneyPrivacy = (() => {
  const KEY = 'ideaz_hide_money';
  // "COP 1,234.00", "-USD 5,000.00", "$1.200", "$ 3,5M"
  const MONEY_RE = /[-−]?\s?(?:COP|USD|MXN|EUR|\$)\s?\d[\d.,]*(?:\s?[KkMm]\b)?/g;
  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'CANVAS', 'NOSCRIPT']);

  let hidden = false;
  try { hidden = localStorage.getItem(KEY) === '1'; } catch (e) { /* sin storage */ }
  const listeners = [];
  let observer = null;
  let queued = false;

  const style = document.createElement('style');
  style.textContent = `
    body.hide-money .money-val { cursor: help; letter-spacing: .05em; }
  `;
  document.head.appendChild(style);

  const PREFIX_RE = /^[-−]?\s?(?:COP|USD|MXN|EUR|\$)\s?/;
  const DOTS = '••••••'; // largo fijo: no revela la magnitud del valor

  function maskText(real) {
    const m = real.match(PREFIX_RE);
    return (m ? m[0] : '') + DOTS;
  }

  function setShown(el, show) {
    const real = el.dataset.real;
    if (real === undefined) return;
    el.textContent = show ? real : maskText(real);
  }

  function wrapTextNode(node) {
    const text = node.nodeValue;
    MONEY_RE.lastIndex = 0;
    if (!MONEY_RE.test(text)) return;
    MONEY_RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = MONEY_RE.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const span = document.createElement('span');
      span.className = 'money-val';
      span.dataset.real = m[0];
      span.textContent = hidden ? maskText(m[0]) : m[0];
      frag.appendChild(span);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }

  function scan(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      const p = root.parentElement;
      if (p && !SKIP.has(p.tagName) && !p.closest('.money-val')) wrapTextNode(root);
      return;
    }
    if (root.nodeType !== 1 || SKIP.has(root.tagName) || root.classList.contains('money-val')) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP.has(p.tagName) || p.closest('.money-val')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(wrapTextNode);
  }

  function renderButtons() {
    document.querySelectorAll('[data-money-toggle]').forEach((btn) => {
      const icon = hidden ? 'eyeOff' : 'eye';
      const cls = btn.dataset.cls || 'w-4 h-4';
      if (window.Icons && Icons.svg) btn.innerHTML = Icons.svg(icon, cls);
      btn.title = hidden ? 'Mostrar valores financieros' : 'Ocultar valores financieros';
      btn.setAttribute('aria-label', btn.title);
      btn.setAttribute('aria-pressed', hidden ? 'true' : 'false');
    });
  }

  function apply() {
    document.body.classList.toggle('hide-money', hidden);
    document.querySelectorAll('.money-val').forEach((el) => setShown(el, !hidden));
    renderButtons();
    listeners.forEach((fn) => { try { fn(hidden); } catch (e) { console.error(e); } });
  }

  function set(value) {
    hidden = !!value;
    try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch (e) { /* sin storage */ }
    apply();
  }

  function init() {
    // Hover: revela el valor real solo mientras el cursor está encima
    document.addEventListener('mouseover', (e) => {
      if (!hidden) return;
      const el = e.target.closest && e.target.closest('.money-val');
      if (el) setShown(el, true);
    });
    document.addEventListener('mouseout', (e) => {
      if (!hidden) return;
      const el = e.target.closest && e.target.closest('.money-val');
      if (el && !el.contains(e.relatedTarget)) setShown(el, false);
    });
    scan(document.body);
    let pending = [];
    observer = new MutationObserver((mutations) => {
      mutations.forEach((mu) => mu.addedNodes.forEach((n) => pending.push(n)));
      if (queued || !pending.length) return;
      queued = true;
      // Se agrupa en un frame para no escanear en cada cambio del render
      requestAnimationFrame(() => {
        queued = false;
        const nodes = pending;
        pending = [];
        observer.disconnect();
        nodes.forEach((n) => { if (n.isConnected) scan(n); });
        observer.observe(document.body, { childList: true, subtree: true });
        renderButtons();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
    apply();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return {
    get hidden() { return hidden; },
    toggle() { set(!hidden); },
    set,
    // fn(hidden) se llama al cambiar el estado (p. ej. para ocultar ejes de gráficos canvas)
    onChange(fn) { listeners.push(fn); },
    refresh: () => scan(document.body),
  };
})();

window.MoneyPrivacy = MoneyPrivacy;
