const Sidebar = (() => {
  const LINKS = [
    { href: 'index.html',         icon: '📊', label: 'Dashboard',     key: 'dashboard'     },
    { href: 'agenda.html',        icon: '📅', label: 'Agenda',        key: 'agenda'        },
    { href: 'configuracion.html', icon: '⚙️', label: 'Configuración', key: 'configuracion' },
  ];

  function init(activePage) {
    const aside = document.getElementById('app-sidebar');
    if (!aside) return;

    const navHTML = LINKS.map(({ href, icon, label, key }) => {
      const isActive = key === activePage;
      const cls = isActive
        ? 'bg-indigo-600/20 text-indigo-400'
        : 'text-slate-400 hover:bg-slate-800';
      return `<a href="${href}" class="flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-semibold ${cls} transition-colors"><span>${icon}</span> ${label}</a>`;
    }).join('\n    ');

    aside.insertAdjacentHTML('afterbegin', `
      <div class="p-5 border-b border-slate-700 flex-shrink-0">
        <a href="index.html" class="flex items-center gap-3">
          <div class="w-9 h-9 rounded-xl bg-indigo-600 flex items-center justify-center">
            <span class="text-white font-black text-sm">I</span>
          </div>
          <div>
            <div class="font-black text-slate-100 leading-none">IDEAZ</div>
            <div class="text-xs text-slate-400 font-medium">Dashboard</div>
          </div>
        </a>
      </div>
      <nav class="p-3 border-b border-slate-700 flex-shrink-0">
        ${navHTML}
      </nav>`);
  }

  return { init };
})();

window.Sidebar = Sidebar;
