const Auth = (() => {
  function getCurrentToken() {
    return new URLSearchParams(window.location.search).get('access');
  }

  function decodeToken(token) {
    try {
      return JSON.parse(decodeURIComponent(escape(atob(token))));
    } catch {
      return null;
    }
  }

  function getCurrentUser() {
    const token = getCurrentToken();
    if (!token) return null;
    return decodeToken(token);
  }

  // page: 'agenda' | 'dashboard' | 'configuracion' | 'proyecto'
  function checkPageAccess(page) {
    const user = getCurrentUser();
    // Sin token = acceso admin completo (compatibilidad hacia atrás)
    if (!user) return { allowed: true, role: 'admin' };
    if (user.role === 'admin') return { allowed: true, role: 'admin' };

    if (user.role === 'agenda-full' || user.role === 'agenda-member') {
      const allowedPages = user.role === 'agenda-member' ? ['agenda', 'monitor'] : ['agenda'];
      if (allowedPages.includes(page)) {
        return {
          allowed: true,
          role: user.role,
          name: user.name || null,
          lockedMemberId: user.role === 'agenda-member' ? (user.memberId || null) : null
        };
      }
      return { allowed: false, redirectTo: 'agenda.html?access=' + encodeURIComponent(getCurrentToken()) };
    }

    if (user.role === 'cm') {
      if (page === 'agenda' || page === 'configuracion') {
        return { allowed: true, role: 'cm', name: user.name || null };
      }
      return { allowed: false, redirectTo: 'configuracion.html?access=' + encodeURIComponent(getCurrentToken()) };
    }

    return { allowed: false };
  }

  // Aplica las credenciales de Trello embebidas en el token al localStorage del usuario
  function applyEmbeddedCredentials() {
    const user = getCurrentUser();
    if (!user || !user.trelloKey || !user.trelloToken) return false;
    if (user.role === 'agenda-full' || user.role === 'agenda-member' || user.role === 'cm') {
      Storage.saveCredentials(user.trelloKey, user.trelloToken);
      return true;
    }
    return false;
  }

  // creds: { key, token } — credenciales de Trello del admin para incluir en la URL
  function generateURL(role, name, memberId, creds) {
    const data = { role, name };
    if (memberId) data.memberId = memberId;
    if (creds && creds.key && creds.token) {
      data.trelloKey = creds.key;
      data.trelloToken = creds.token;
    }
    const token = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    const base = window.location.href.replace(/\/[^/?#]*([?#].*)?$/, '/');
    const page = role === 'cm' ? 'configuracion.html' : 'agenda.html';
    return base + page + '?access=' + encodeURIComponent(token);
  }

  return { getCurrentUser, checkPageAccess, generateURL, getCurrentToken, applyEmbeddedCredentials };
})();

window.Auth = Auth;
