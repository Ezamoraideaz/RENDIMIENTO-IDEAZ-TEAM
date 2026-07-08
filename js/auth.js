// Adaptador de permisos sobre la sesión global (js/session.js).
// Antes este archivo generaba URLs con las credenciales de Trello embebidas en
// base64 (?access=). Ese mecanismo se eliminó: el acceso ahora es por login con
// contraseña (login.html) y los permisos viven en la BD (tabla operators).
// Solo es válido DESPUÉS de que Session.ready haya resuelto.
const Auth = (() => {
  // rol de BD → rol legado que ya usan las páginas
  const LEGACY_ROLE = {
    superadmin: 'admin',
    admin: 'admin',
    agent: 'agent',
    agenda_full: 'agenda-full',
    agenda_member: 'agenda-member',
    cm: 'cm',
  };

  function getCurrentUser() {
    const u = window.Session && Session.user;
    if (!u) return null;
    return {
      role: LEGACY_ROLE[u.role] || u.role,
      dbRole: u.role,
      name: u.name || null,
      email: u.email,
      memberId: u.trello_member_id || null,
    };
  }

  // page: 'dashboard' | 'proyecto' | 'agenda' | 'monitor' | 'pauta' |
  //       'atencion-cliente' | 'configuracion' | 'protocolo'
  // Mantiene la firma histórica ({allowed, role, name, lockedMemberId});
  // la redirección de páginas no permitidas ya la hace Session al cargar.
  function checkPageAccess(page) {
    const user = getCurrentUser();
    if (!user) return { allowed: false, redirectTo: 'login.html' };
    if (!Session.canView(page)) {
      return { allowed: false, redirectTo: Session.defaultPage(user.dbRole) };
    }
    return {
      allowed: true,
      role: user.role,
      name: user.name,
      lockedMemberId: user.dbRole === 'agenda_member' ? user.memberId : null,
    };
  }

  function isSuperAdmin() {
    return !!(window.Session && Session.user && Session.user.role === 'superadmin');
  }

  return { getCurrentUser, checkPageAccess, isSuperAdmin };
})();

window.Auth = Auth;
