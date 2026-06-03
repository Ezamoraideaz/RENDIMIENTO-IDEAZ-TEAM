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
      if (page === 'agenda') {
        return {
          allowed: true,
          role: user.role,
          name: user.name || null,
          lockedMemberId: user.role === 'agenda-member' ? (user.memberId || null) : null
        };
      }
      return { allowed: false, redirectTo: 'agenda.html?access=' + encodeURIComponent(getCurrentToken()) };
    }

    return { allowed: false };
  }

  // Genera un código corto con las credenciales de Trello para compartir con el equipo
  function generateTeamCode(creds) {
    if (!creds || !creds.key || !creds.token) return null;
    return btoa(unescape(encodeURIComponent(JSON.stringify({ key: creds.key, token: creds.token }))));
  }

  // Decodifica el código de equipo y guarda las credenciales en localStorage
  function applyTeamCode(code) {
    try {
      const creds = JSON.parse(decodeURIComponent(escape(atob(code.trim()))));
      if (!creds.key || !creds.token) return false;
      Storage.saveCredentials(creds.key, creds.token);
      return true;
    } catch {
      return false;
    }
  }

  // URL de acceso — solo contiene rol, nombre y miembro (sin credenciales)
  function generateURL(role, name, memberId) {
    const data = { role, name };
    if (memberId) data.memberId = memberId;
    const token = btoa(unescape(encodeURIComponent(JSON.stringify(data))));
    const base = window.location.href.replace(/\/[^/?#]*([?#].*)?$/, '/');
    return base + 'agenda.html?access=' + encodeURIComponent(token);
  }

  return { getCurrentUser, checkPageAccess, generateURL, getCurrentToken, generateTeamCode, applyTeamCode };
})();

window.Auth = Auth;
