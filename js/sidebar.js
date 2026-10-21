const Sidebar = (() => {
  const LINKS = [
    { href: 'index.html',         icon: 'dashboard', label: 'Dashboard',     key: 'dashboard'     },
    { href: 'agenda.html',        icon: 'calendar',  label: 'Agenda',        key: 'agenda'        },
    { href: 'monitor.html',       icon: 'pulse',     label: 'Monitor',       key: 'monitor'       },
    { href: 'pauta.html',         icon: 'megaphone', label: 'Pauta',         key: 'pauta'         },
    { href: 'aprobaciones.html',  icon: 'check',     label: 'Aprobaciones',  key: 'aprobaciones'  },
    { href: 'atencion-cliente.html', icon: 'message', label: 'Atención Cliente', key: 'atencion-cliente' },
    { href: 'egresos.html',       icon: 'wallet',    label: 'Egresos',        key: 'egresos'       },
    { href: 'rendicion.html',     icon: 'file',      label: 'Rendición CM',   key: 'rendicion'     },
    { href: 'rendicion-dashboard.html', icon: 'trend', label: 'Rendición Dashboard', key: 'rendicion-dashboard' },
    { href: 'configuracion.html', icon: 'settings',  label: 'Configuración', key: 'configuracion' },
  ];

  // Iconos SVG (trazo estilo Lucide). Disponibles para cualquier módulo vía Icons.svg(nombre, clases).
  const ICONS = {
    dashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    calendar:  '<path d="M8 2v4M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    pulse:     '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    megaphone: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    check:     '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>',
    message:   '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    wallet:    '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
    file:      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
    trend:     '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
    settings:  '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
    moon:      '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
    sun:       '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    refresh:   '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    logout:    '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    menu:      '<path d="M4 6h16M4 12h16M4 18h16"/>',
    panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    panelBottom: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 15h18"/>',
    sliders:   '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
    search:    '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    grid:      '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
    list:      '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    repeat:    '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    package:   '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/>',
    chevron:   '<path d="m6 9 6 6 6-6"/>',
    clock:     '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    folder:    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>',
    x:         '<path d="M18 6 6 18M6 6l12 12"/>',
    tag:       '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>',
    users:     '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    key:       '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    alert:     '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4M12 17h.01"/>',
    chart:     '<path d="M3 3v18h18"/><path d="M18 17V9M13 17V5M8 17v-3"/>',
    external:  '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    arrowLeft: '<path d="m12 19-7-7 7-7M19 12H5"/>',
    pencil:    '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
    trash:     '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    kanban:    '<path d="M6 5v11M12 5v6M18 5v14"/>',
    zap:       '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    plus:      '<path d="M5 12h14M12 5v14"/>',
    bubble:    '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
    sparkles:  '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
    book:      '<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>',
    bot:       '<rect width="16" height="12" x="4" y="8" rx="2"/><path d="M12 8V4H8M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    image:     '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
    gallery:   '<rect width="14" height="16" x="5" y="4" rx="2"/><path d="M2 6v12M22 6v12"/>',
    buttons:   '<rect width="18" height="6" x="3" y="5" rx="3"/><rect width="18" height="6" x="3" y="13" rx="3"/>',
    star:      '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
    split:     '<path d="M16 3h5v5M8 3H3v5M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3M15 9l6-6"/>',
    dice:      '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M16 8h.01M8 8h.01M8 16h.01M16 16h.01M12 12h.01"/>',
    timer:     '<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>',
    hand:      '<path d="M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>',
    phone:     '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
    copy:      '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    bell:      '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    lock:      '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    save:      '<path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7M7 3v4a1 1 0 0 0 1 1h7"/>',
    eye:       '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
    eyeOff:    '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20M9.88 9.88a3 3 0 1 0 4.24 4.24"/>',
    database:  '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14a9 3 0 0 0 18 0V5M3 12a9 3 0 0 0 18 0"/>',
    target:    '<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
    download:  '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    mail:      '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
    clip:      '<path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/>',
    link:      '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
    idCard:    '<rect width="20" height="14" x="2" y="5" rx="2"/><circle cx="8" cy="12" r="2"/><path d="M14 10h4M14 14h4"/>',
    sheet:     '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
  };
  function icon(name, cls = 'w-5 h-5') {
    return `<svg class="${cls} flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  // Reemplaza <span data-icon="nombre" class="..."></span> del HTML estático por su SVG
  // (conserva las clases del span; tamaño por defecto w-4 h-4 o data-size="w-5 h-5").
  function hydrate(root = document) {
    root.querySelectorAll('[data-icon]').forEach((el) => {
      el.outerHTML = icon(el.dataset.icon, `${el.dataset.size || 'w-4 h-4'} ${el.className}`.trim());
    });
  }

  const THEME_KEY = 'ideaz_theme';
  const NAV_KEY   = 'ideaz_nav';   // 'side' (menú a la izquierda) | 'dock' (menú flotante inferior)

  // localStorage puede no estar disponible (modo privado, bloqueos): nunca debe romper la página
  const store = {
    get(k)    { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  // El tema claro es el predeterminado del front nuevo; 'dark' solo si el usuario lo eligió.
  function _getTheme() {
    return store.get(THEME_KEY) === 'dark' ? 'dark' : 'light';
  }

  function _applyTheme(theme) {
    document.documentElement.classList.toggle('light', theme === 'light');
    document.querySelectorAll('[data-theme-icon]').forEach((el) => {
      el.innerHTML = icon(theme === 'light' ? 'moon' : 'sun', el.dataset.cls || 'w-5 h-5');
    });
    document.querySelectorAll('[data-theme-tip]').forEach((el) => {
      el.dataset.tip = theme === 'light' ? 'Modo oscuro' : 'Modo claro';
    });
  }

  function toggleTheme() {
    const next = _getTheme() === 'dark' ? 'light' : 'dark';
    store.set(THEME_KEY, next);
    _applyTheme(next);
    window.dispatchEvent(new CustomEvent('ideaz:theme', { detail: { theme: next } }));
  }

  function _getNavMode() {
    return store.get(NAV_KEY) === 'dock' ? 'dock' : 'side';
  }

  function _applyNavMode(mode) {
    const dock = mode === 'dock';
    document.body.classList.toggle('ideaz-dock', dock);
    const mainEl = document.querySelector('main[data-sidebar-main]');
    if (mainEl) mainEl.style.marginLeft = dock ? '0' : '15rem';
    _closeMobileMenu();
    const btn = document.getElementById('ideaz-mode-btn');
    if (btn) {
      btn.querySelector('[data-mode-icon]').innerHTML = icon(dock ? 'panelLeft' : 'panelBottom');
      btn.querySelector('[data-mode-label]').textContent = dock ? 'Fijar menú a la izquierda' : 'Menú flotante';
    }
  }

  function toggleNavMode() {
    const next = _getNavMode() === 'dock' ? 'side' : 'dock';
    store.set(NAV_KEY, next);
    _applyNavMode(next);
  }

  function _injectStyles() {
    if (document.getElementById('sidebar-style')) return;
    const s = document.createElement('style');
    s.id = 'sidebar-style';
    s.textContent = `
      #app-sidebar { width: 15rem !important; background: var(--s1) !important; border-right: 1px solid var(--line) !important; transition: transform .22s ease; }
      main[data-sidebar-main] { transition: margin-left .22s ease; }
      .ideaz-brand { display:flex; align-items:center; gap:.65rem; padding:1.1rem 1rem .8rem; }
      .ideaz-logo { width:2.25rem; height:2.25rem; border-radius:.8rem; background:var(--accent); color:#fff; display:grid; place-items:center; font-weight:900; flex:none; }
      .ideaz-nav { padding:.25rem .75rem .5rem; display:flex; flex-direction:column; gap:.15rem; flex-shrink:0; }
      .sidebar-nav-item { display:flex; align-items:center; gap:.7rem; width:100%; padding:.6rem .8rem; border-radius:.85rem; font-size:.85rem; font-weight:600; color:var(--mut); text-align:left; transition:background .15s, color .15s; }
      .sidebar-nav-item:hover { background:var(--s2); color:var(--ink); }
      .sidebar-nav-item.is-active, .sidebar-nav-item.is-active:hover { background:var(--accent); color:#fff; box-shadow:0 8px 18px -8px rgba(79,70,229,.7); }
      .ideaz-foot { margin-top:auto; padding:.75rem; border-top:1px solid var(--line); display:flex; flex-direction:column; gap:.15rem; flex-shrink:0; }
      .ideaz-user { display:flex; align-items:center; gap:.6rem; padding:.35rem .5rem .6rem; min-width:0; }
      .ideaz-avatar { width:2.1rem; height:2.1rem; border-radius:999px; background:var(--accent); color:#fff; font-size:.72rem; font-weight:800; display:grid; place-items:center; flex:none; }
      .ideaz-switch { margin-left:auto; width:2.1rem; height:1.2rem; border-radius:999px; background:var(--s4); position:relative; flex:none; transition:background .2s; }
      .ideaz-switch::after { content:""; position:absolute; top:.15rem; left:.15rem; width:.9rem; height:.9rem; border-radius:50%; background:#fff; transition:transform .2s; }
      html:not(.light) .ideaz-switch { background:var(--accent); }
      html:not(.light) .ideaz-switch::after { transform:translateX(.9rem); }
      .ideaz-logout:hover { color:#f43f5e !important; }

      /* Menú flotante (dock) */
      #ideaz-dock { display:none; position:fixed; bottom:16px; left:50%; transform:translateX(-50%); z-index:45; background:#0c0a09; border-radius:1.5rem; padding:.45rem; gap:.15rem; box-shadow:0 20px 40px -10px rgba(0,0,0,.5); max-width:96vw; }
      body.ideaz-dock #ideaz-dock { display:flex; }
      #ideaz-dock .dk { width:44px; height:44px; display:grid; place-items:center; border-radius:13px; color:#d6d3d1; flex:none; transition:transform .2s, background .2s, color .2s; }
      #ideaz-dock .dk:hover { background:#ffffff22; color:#fff; transform:translateY(-5px) scale(1.12); }
      #ideaz-dock .dk.is-active { background:var(--accent); color:#fff; }
      #ideaz-dock .dk-sep { width:1px; background:#ffffff26; margin:.4rem .25rem; flex:none; }
      body.ideaz-dock #app-sidebar { transform:translateX(-100%); }
      body.ideaz-dock #app-sidebar.mobile-open { transform:translateX(0); box-shadow:0 30px 60px -20px rgba(0,0,0,.55); }
      body.ideaz-dock main[data-sidebar-main] { margin-left:0 !important; padding-bottom:6rem; }
      #ideaz-tip { position:fixed; z-index:60; transform:translate(-50%,-100%); background:#0c0a09; color:#fff; font-size:11px; font-weight:600; padding:4px 9px; border-radius:8px; white-space:nowrap; pointer-events:none; opacity:0; transition:opacity .12s; }

      /* Mobile: el sidebar es un panel deslizable (drawer) que se abre con el botón
         de la barra superior fija. Se inyecta acá mismo para que ninguna página
         necesite tocar su propio HTML. */
      #sidebar-mobile-topbar { display:none; background:var(--s1); border-bottom:1px solid var(--line); }
      @media (max-width: 767px) {
        body { padding-top: 3.25rem; }
        #sidebar-mobile-topbar { display:flex; }
        main[data-sidebar-main] { margin-left:0 !important; }
        #app-sidebar { width:17rem !important; transform:translateX(-100%); }
        #app-sidebar.mobile-open { transform:translateX(0); }
        body.ideaz-dock #ideaz-dock { display:none; }
        body.ideaz-dock main[data-sidebar-main] { padding-bottom:0; }
        #ideaz-mode-btn { display:none !important; }
      }
    `;
    document.head.appendChild(s);
  }

  function _closeMobileMenu() {
    document.getElementById('app-sidebar')?.classList.remove('mobile-open');
    const backdrop = document.getElementById('sidebar-mobile-backdrop');
    if (backdrop) backdrop.style.display = 'none';
  }

  function _openMobileMenu() {
    document.getElementById('app-sidebar')?.classList.add('mobile-open');
    const backdrop = document.getElementById('sidebar-mobile-backdrop');
    if (backdrop) backdrop.style.display = 'block';
  }

  function _toggleMobileMenu() {
    const aside = document.getElementById('app-sidebar');
    if (aside && aside.classList.contains('mobile-open')) {
      _closeMobileMenu();
    } else {
      _openMobileMenu();
    }
  }

  // Barra superior fija (solo <768px) con el botón que abre el drawer, + fondo
  // semitransparente para cerrarlo al tocar afuera. El mismo drawer se usa en
  // escritorio con el menú flotante para mostrar el panel de la página y la cuenta.
  function _ensureMobileChrome() {
    if (document.getElementById('sidebar-mobile-topbar')) return;
    document.body.insertAdjacentHTML('afterbegin', `
      <div id="sidebar-mobile-topbar" class="fixed top-0 left-0 right-0 h-[3.25rem] z-[45] items-center px-3 gap-3">
        <button id="sidebar-mobile-toggle" class="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-lg hover:bg-slate-800 text-slate-200" aria-label="Abrir menú">${icon('menu')}</button>
        <div class="flex items-center gap-2 min-w-0">
          <div class="ideaz-logo" style="width:1.75rem;height:1.75rem;border-radius:.6rem;font-size:.75rem">I</div>
          <span class="font-extrabold text-slate-100 text-sm truncate">Monitor Ideaz</span>
        </div>
      </div>
      <div id="sidebar-mobile-backdrop" class="fixed inset-0 bg-black/50 z-40" style="display:none"></div>`);
    document.getElementById('sidebar-mobile-toggle').addEventListener('click', _toggleMobileMenu);
    document.getElementById('sidebar-mobile-backdrop').addEventListener('click', _closeMobileMenu);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') _closeMobileMenu(); });
  }

  // Tooltip único y en posición fija: no lo recorta ningún overflow
  function _ensureTooltip() {
    if (document.getElementById('ideaz-tip')) return;
    const tip = document.createElement('div');
    tip.id = 'ideaz-tip';
    document.body.appendChild(tip);
    const show = (el) => {
      if (!el) { tip.style.opacity = 0; return; }
      const r = el.getBoundingClientRect();
      tip.textContent = el.dataset.tip;
      tip.style.left = Math.min(innerWidth - 50, Math.max(50, r.left + r.width / 2)) + 'px';
      tip.style.top = (r.top - 8) + 'px';
      tip.style.opacity = 1;
    };
    document.addEventListener('mouseover', (e) => show(e.target.closest('#ideaz-dock [data-tip]')));
    document.addEventListener('scroll', () => show(null), true);
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const initials = (s) => String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  // options.allowedKeys — string[] | undefined: filter nav links
  // options.onRefresh   — function: called when refresh button is clicked
  function init(activePage, options = {}) {
    const aside = document.getElementById('app-sidebar');
    if (!aside) return;

    const mainEl = document.querySelector('main');
    if (mainEl) mainEl.setAttribute('data-sidebar-main', '');
    const { allowedKeys, onRefresh } = options;
    // El acceso es por sesión (js/session.js); si la página no pasa
    // allowedKeys, se filtra según el rol del usuario logueado.
    const sessionUser = (window.Session && Session.user) || null;
    const keys = allowedKeys || (sessionUser ? Session.allowedNavKeys() : null);

    const visibleLinks = keys ? LINKS.filter(l => keys.includes(l.key)) : LINKS;

    const showsDashboard = !keys || keys.includes('dashboard');
    const logoHref = showsDashboard ? 'index.html' : 'agenda.html';
    const logoSub  = showsDashboard ? 'Dashboard' : 'Agenda';

    // ── Menú lateral: marca + navegación arriba; el contenido propio de cada
    //    página (filtros, info de proyecto…) queda en medio, tal como estaba.
    aside.insertAdjacentHTML('afterbegin', `
      <a href="${logoHref}" class="ideaz-brand">
        <div class="ideaz-logo">I</div>
        <div class="min-w-0 leading-tight">
          <div class="font-extrabold text-slate-100 text-sm">Monitor Ideaz</div>
          <div class="text-[11px] text-slate-400 font-medium">${logoSub}</div>
        </div>
      </a>
      <nav class="ideaz-nav">
        ${visibleLinks.map(({ href, icon: ic, label, key }) => `
          <a href="${href}" class="sidebar-nav-item ${key === activePage ? 'is-active' : ''}" title="${label}">
            ${icon(ic)}<span class="sidebar-text">${label}</span>
          </a>`).join('')}
      </nav>`);

    // ── Pie: cuenta, actualizar, tema, modo del menú y cerrar sesión
    aside.insertAdjacentHTML('beforeend', `
      <div class="ideaz-foot">
        ${sessionUser ? `
          <div class="ideaz-user">
            <div class="ideaz-avatar">${esc(initials(sessionUser.name || sessionUser.email))}</div>
            <div class="min-w-0">
              <div class="text-xs font-bold text-slate-200 truncate">${esc(sessionUser.name || sessionUser.email)}</div>
              <div class="text-[11px] text-slate-500 truncate">${esc(sessionUser.email)}</div>
            </div>
          </div>` : ''}
        ${onRefresh ? `
          <button id="sidebar-refresh-btn" class="sidebar-nav-item" title="Obtener datos frescos de Trello">
            ${icon('refresh')}<span class="sidebar-text">Actualizar Trello</span>
          </button>` : ''}
        <button id="theme-toggle-btn" class="sidebar-nav-item" title="Cambiar entre tema claro y oscuro">
          <span data-theme-icon></span><span class="sidebar-text">Modo oscuro</span><span class="ideaz-switch"></span>
        </button>
        <button id="ideaz-mode-btn" class="sidebar-nav-item" title="Cambiar entre menú lateral y menú flotante">
          <span data-mode-icon></span><span class="sidebar-text" data-mode-label></span>
        </button>
        ${sessionUser ? `
          <button class="sidebar-nav-item ideaz-logout" onclick="Session.logout()" title="Cerrar sesión">
            ${icon('logout')}<span class="sidebar-text">Cerrar sesión</span>
          </button>` : ''}
      </div>`);

    // ── Menú flotante inferior (solo escritorio, cuando el usuario lo elige)
    if (!document.getElementById('ideaz-dock')) {
      document.body.insertAdjacentHTML('beforeend', `
        <nav id="ideaz-dock" aria-label="Menú">
          ${visibleLinks.map(({ href, icon: ic, label, key }) => `
            <a href="${href}" class="dk ${key === activePage ? 'is-active' : ''}" data-tip="${label}" aria-label="${label}">${icon(ic)}</a>`).join('')}
          <span class="dk-sep"></span>
          <button class="dk" id="ideaz-dock-panel" data-tip="Panel y cuenta" aria-label="Panel y cuenta">${icon('sliders')}</button>
          ${onRefresh ? `<button class="dk" id="ideaz-dock-refresh" data-tip="Actualizar Trello" aria-label="Actualizar Trello">${icon('refresh')}</button>` : ''}
          <button class="dk" id="ideaz-dock-theme" data-theme-icon data-theme-tip data-tip="Cambiar tema" aria-label="Cambiar tema"></button>
          <button class="dk" id="ideaz-dock-mode" data-tip="Fijar menú a la izquierda" aria-label="Fijar menú a la izquierda">${icon('panelLeft')}</button>
        </nav>`);
      document.getElementById('ideaz-dock-panel').addEventListener('click', _toggleMobileMenu);
      document.getElementById('ideaz-dock-theme').addEventListener('click', toggleTheme);
      document.getElementById('ideaz-dock-mode').addEventListener('click', toggleNavMode);
      if (onRefresh) document.getElementById('ideaz-dock-refresh').addEventListener('click', onRefresh);
    }

    if (onRefresh) document.getElementById('sidebar-refresh-btn').addEventListener('click', onRefresh);
    document.getElementById('theme-toggle-btn').addEventListener('click', toggleTheme);
    document.getElementById('ideaz-mode-btn').addEventListener('click', toggleNavMode);

    _injectStyles();
    _ensureMobileChrome();
    _ensureTooltip();
    _applyTheme(_getTheme());
    _applyNavMode(_getNavMode());
    hydrate();
  }

  return { init, toggleTheme, toggleNavMode, icon, hydrate };
})();

window.Sidebar = Sidebar;
// Iconos reutilizables por los módulos: Icons.svg('calendar', 'w-4 h-4') · Icons.hydrate(elemento)
window.Icons = { svg: Sidebar.icon, hydrate: Sidebar.hydrate };
