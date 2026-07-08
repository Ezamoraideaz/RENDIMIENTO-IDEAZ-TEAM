// Guard de sesión global del sitio. Habla con el backend PHP (backend/auth/*)
// usando la misma cookie de sesión del módulo Atención al Cliente.
// Incluir en TODAS las páginas (excepto login.html) ANTES del script de la página:
//   <script src="js/session.js"></script>
// La página debe esperar la sesión antes de iniciar:  Session.ready.then(init)
const Session = (() => {
  const API = 'backend';

  // nombre de archivo → clave de página
  const PAGE_BY_FILE = {
    '': 'dashboard',
    'index.html': 'dashboard',
    'proyecto.html': 'proyecto',
    'agenda.html': 'agenda',
    'monitor.html': 'monitor',
    'pauta.html': 'pauta',
    'atencion-cliente.html': 'atencion-cliente',
    'configuracion.html': 'configuracion',
    'protocolo-trello.html': 'protocolo',
  };

  const ALL_PAGES = ['dashboard', 'proyecto', 'agenda', 'monitor', 'pauta', 'atencion-cliente', 'configuracion', 'protocolo'];

  // Páginas visibles por rol (los roles del Control de Acceso + superadmin)
  const ACCESS = {
    superadmin:    ALL_PAGES,
    admin:         ALL_PAGES,
    agent:         ['atencion-cliente'],
    agenda_full:   ['agenda'],
    agenda_member: ['agenda', 'monitor'],
    cm:            ['agenda', 'configuracion'],
  };

  // Claves de navegación del sidebar (subconjunto de páginas)
  const NAV_KEYS = ['dashboard', 'agenda', 'monitor', 'pauta', 'atencion-cliente', 'configuracion'];

  const FILE_BY_PAGE = {
    dashboard: 'index.html',
    proyecto: 'index.html',
    agenda: 'agenda.html',
    monitor: 'monitor.html',
    pauta: 'pauta.html',
    'atencion-cliente': 'atencion-cliente.html',
    configuracion: 'configuracion.html',
    protocolo: 'protocolo-trello.html',
  };

  let user = null;
  let csrf = '';

  function currentPage() {
    const file = decodeURIComponent((location.pathname.split('/').pop() || '').toLowerCase());
    return PAGE_BY_FILE[file] || 'dashboard';
  }

  function pagesFor(role) {
    return ACCESS[role] || [];
  }

  function canView(page) {
    return !!user && pagesFor(user.role).includes(page);
  }

  function defaultPage(role) {
    const first = pagesFor(role)[0];
    return FILE_BY_PAGE[first] || 'login.html';
  }

  function allowedNavKeys() {
    if (!user) return [];
    return NAV_KEYS.filter((k) => pagesFor(user.role).includes(k));
  }

  // fetch autenticado contra el backend (cookie de sesión + CSRF en escrituras)
  async function apiFetch(path, options = {}) {
    const opts = Object.assign({ credentials: 'include' }, options);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
    if (options.method && options.method !== 'GET' && csrf) {
      opts.headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(`${API}/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function _redirect(url) {
    location.replace(url);
    return new Promise(() => {}); // nunca resuelve: la página se está yendo
  }

  // Verificación de sesión — corre apenas se carga el script
  const ready = (async () => {
    let data;
    try {
      const res = await fetch(`${API}/auth/me.php`, { credentials: 'include' });
      data = await res.json();
    } catch (e) {
      return _redirect('login.html?error=backend');
    }
    if (!data || !data.operator) {
      return _redirect('login.html');
    }
    user = data.operator;
    csrf = data.csrf_token || '';
    if (!canView(currentPage())) {
      return _redirect(defaultPage(user.role));
    }
    return user;
  })();

  async function logout() {
    try {
      await apiFetch('auth/logout.php', { method: 'POST' });
    } catch (e) { /* la sesión igual se abandona */ }
    location.replace('login.html');
  }

  return {
    ready,
    apiFetch,
    logout,
    canView,
    allowedNavKeys,
    currentPage,
    defaultPage,
    get user() { return user; },
    get csrf() { return csrf; },
  };
})();

window.Session = Session;
