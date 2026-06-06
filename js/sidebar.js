const Sidebar = (() => {
  const LINKS = [
    { href: 'index.html',         icon: '📊', label: 'Dashboard',     key: 'dashboard'     },
    { href: 'agenda.html',        icon: '📅', label: 'Agenda',        key: 'agenda'        },
    { href: 'monitor.html',       icon: '🚨', label: 'Monitor',       key: 'monitor'       },
    { href: 'configuracion.html', icon: '⚙️', label: 'Configuración', key: 'configuracion' },
  ];

  const LS_KEY = 'sidebar_collapsed';

  function _isCollapsed() {
    return localStorage.getItem(LS_KEY) === '1';
  }

  function _applyState(aside, mainEl, collapsed) {
    if (collapsed) {
      aside.classList.remove('w-64'); aside.classList.add('w-16');
      if (mainEl) mainEl.style.marginLeft = '4rem';
      aside.setAttribute('data-collapsed', '');
    } else {
      aside.classList.remove('w-16'); aside.classList.add('w-64');
      if (mainEl) mainEl.style.marginLeft = '16rem';
      aside.removeAttribute('data-collapsed');
    }
    const btn = document.getElementById('sidebar-toggle');
    if (btn) btn.textContent = collapsed ? '▶' : '◀';
  }

  function _injectStyles() {
    if (document.getElementById('sidebar-style')) return;
    const s = document.createElement('style');
    s.id = 'sidebar-style';
    s.textContent = `
      #app-sidebar { transition: width 0.2s ease; }
      main { transition: margin-left 0.2s ease; }
      #app-sidebar[data-collapsed] .sidebar-text { display: none; }
      #app-sidebar[data-collapsed] .sidebar-page-content { display: none !important; }
      #app-sidebar[data-collapsed] #sidebar-filters { display: none !important; }
      #app-sidebar[data-collapsed] .sidebar-nav-item {
        justify-content: center;
        padding-left: 0.5rem;
        padding-right: 0.5rem;
      }
    `;
    document.head.appendChild(s);
  }

  // options.allowedKeys — string[] | undefined: filter nav links
  // options.onRefresh   — function: called when refresh button is clicked
  function init(activePage, options = {}) {
    const aside = document.getElementById('app-sidebar');
    if (!aside) return;

    const mainEl = document.querySelector('main');
    if (mainEl) mainEl.setAttribute('data-sidebar-main', '');
    const { allowedKeys, onRefresh } = options;
    const token = new URLSearchParams(window.location.search).get('access');
    const restricted = !!(allowedKeys && token);

    const visibleLinks = allowedKeys ? LINKS.filter(l => allowedKeys.includes(l.key)) : LINKS;

    const navHTML = visibleLinks.map(({ href, icon, label, key }) => {
      const finalHref = restricted ? `${href}?access=${encodeURIComponent(token)}` : href;
      const isActive = key === activePage;
      const cls = isActive ? 'bg-indigo-600/20 text-indigo-400' : 'text-slate-400 hover:bg-slate-800';
      return `<a href="${finalHref}" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold ${cls} transition-colors sidebar-nav-item" title="${label}">
        <span class="text-lg leading-none flex-shrink-0">${icon}</span>
        <span class="sidebar-text">${label}</span>
      </a>`;
    }).join('\n    ');

    const logoHref = restricted ? `agenda.html?access=${encodeURIComponent(token)}` : 'index.html';
    const logoSub  = restricted ? 'Agenda' : 'Dashboard';

    aside.insertAdjacentHTML('afterbegin', `
      <div class="p-4 border-b border-slate-700 flex-shrink-0 flex items-center gap-2">
        <a href="${logoHref}" class="flex items-center gap-3 flex-1 min-w-0">
          <div class="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center flex-shrink-0">
            <span class="text-white font-black text-sm">I</span>
          </div>
          <div class="sidebar-text min-w-0">
            <div class="font-black text-slate-100 leading-none">IDEAZ</div>
            <div class="text-xs text-slate-400 font-medium">${logoSub}</div>
          </div>
        </a>
        <button id="sidebar-toggle"
          class="flex-shrink-0 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-200 hover:bg-slate-800 rounded transition-colors text-xs"
          title="Contraer / expandir sidebar">◀</button>
      </div>
      <nav class="p-3 border-b border-slate-700 flex-shrink-0">
        ${navHTML}
      </nav>`);

    if (onRefresh) {
      aside.insertAdjacentHTML('beforeend', `
        <div id="sidebar-refresh-wrap" class="p-3 border-t border-slate-700 flex-shrink-0 mt-auto">
          <button id="sidebar-refresh-btn"
            class="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 font-medium px-2 py-2 rounded-lg text-xs transition-colors"
            title="Obtener datos frescos de Trello">
            <span class="text-base leading-none flex-shrink-0">↻</span>
            <span class="sidebar-text font-semibold">Actualizar Trello</span>
          </button>
        </div>`);
      document.getElementById('sidebar-refresh-btn').addEventListener('click', onRefresh);
    }

    _injectStyles();

    const collapsed = _isCollapsed();
    _applyState(aside, mainEl, collapsed);

    document.getElementById('sidebar-toggle').addEventListener('click', () => {
      const now = !_isCollapsed();
      localStorage.setItem(LS_KEY, now ? '1' : '0');
      _applyState(aside, mainEl, now);
    });
  }

  return { init };
})();

window.Sidebar = Sidebar;
