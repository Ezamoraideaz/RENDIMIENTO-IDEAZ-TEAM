// Configuración y credenciales del sitio. Desde la migración al backend
// (backend/api/settings.php, project_settings.php, member_settings.php) los
// datos viven en MySQL y se comparten entre todos los usuarios: este módulo
// mantiene la MISMA interfaz pública de siempre, pero respaldada por un caché
// en memoria que Session precarga al iniciar (Storage.preload) y que los
// save* sincronizan contra la BD en segundo plano.
// Las horas por tarjeta (ideaz_time / ideaz_overrides) siguen en localStorage.
const Storage = {
  // ── Caché en memoria (poblado por preload) ────────────────────────────────
  _settings: {},   // { trello_key, trello_token, drive_client_id }
  _projects: {},   // { boardId: { budget, revenue, currency, hoursEstimated, alias, category, period, type, driveFolderId } }
  _members: {},    // { memberId: { name, role, rate } }
  _loaded: false,

  // Llamado por js/session.js después de validar la sesión y ANTES de resolver
  // Session.ready, para que las páginas puedan leer de forma síncrona.
  async preload() {
    const [settings, projects, members] = await Promise.all([
      Session.apiFetch('api/settings.php'),
      Session.apiFetch('api/project_settings.php'),
      Session.apiFetch('api/member_settings.php'),
    ]);
    this._settings = settings.settings || {};
    this._projects = projects.projects || {};
    this._members = members.members || {};
    this._loaded = true;
  },

  // ── Envío diferido a la BD (agrupa ráfagas de saves en un solo POST) ──────
  _dirtyProjects: {},
  _dirtyMembers: {},
  _flushTimer: null,

  _scheduleFlush() {
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => this._flush(), 400);
  },
  async _flush() {
    const projects = this._dirtyProjects;
    const members = this._dirtyMembers;
    this._dirtyProjects = {};
    this._dirtyMembers = {};
    try {
      if (Object.keys(projects).length) {
        await Session.apiFetch('api/project_settings.php', { method: 'POST', body: JSON.stringify({ projects }) });
      }
      if (Object.keys(members).length) {
        await Session.apiFetch('api/member_settings.php', { method: 'POST', body: JSON.stringify({ members }) });
      }
    } catch (e) {
      console.error('No se pudo guardar la configuración en la BD:', e.message);
      if (window.Utils && Utils.showToast) Utils.showToast('No se pudo guardar en la BD: ' + e.message, 'error');
    }
  },

  // ── Settings genéricos (credenciales de integraciones) ────────────────────
  getSetting(key) {
    return this._settings[key] || '';
  },
  async saveSetting(key, value) {
    this._settings[key] = value;
    await Session.apiFetch('api/settings.php', {
      method: 'POST',
      body: JSON.stringify({ settings: { [key]: value } }),
    });
  },

  // ── Credentials (Trello — juego único compartido de la agencia) ───────────
  getCredentials() {
    const key = this._settings.trello_key || '';
    const token = this._settings.trello_token || '';
    return key || token ? { key, token } : {};
  },
  async saveCredentials(key, token) {
    this._settings.trello_key = key;
    this._settings.trello_token = token;
    await Session.apiFetch('api/settings.php', {
      method: 'POST',
      body: JSON.stringify({ settings: { trello_key: key, trello_token: token } }),
    });
  },
  hasCredentials() {
    const c = this.getCredentials();
    return !!(c.key && c.token);
  },
  async clearCredentials() {
    await this.saveCredentials('', '');
    delete this._settings.trello_key;
    delete this._settings.trello_token;
  },

  // ── Project data (por tablero, compartido) ────────────────────────────────
  getProjectData(boardId) {
    return this._projects[boardId] ||
      { budget: 0, revenue: 0, currency: 'COP', hoursEstimated: 0, alias: '', category: '', period: '', type: '', driveFolderId: '' };
  },
  saveProjectData(boardId, data) {
    this._projects[boardId] = { ...this.getProjectData(boardId), ...data };
    this._dirtyProjects[boardId] = { ...(this._dirtyProjects[boardId] || {}), ...data };
    this._scheduleFlush();
  },
  getAllProjectData() {
    return this._projects;
  },

  // ── Member hourly rates ───────────────────────────────────────────────────
  getMemberRate(memberId) {
    return (this._members[memberId] && this._members[memberId].rate) || 0;
  },
  saveMemberRate(memberId, rate) {
    const val = parseFloat(rate) || 0;
    this._members[memberId] = { ...(this._members[memberId] || {}), rate: val };
    this._dirtyMembers[memberId] = { ...(this._dirtyMembers[memberId] || {}), rate: val };
    this._scheduleFlush();
  },
  getAllRates() {
    const rates = {};
    for (const [id, m] of Object.entries(this._members)) {
      if (m.rate) rates[id] = m.rate;
    }
    return rates;
  },

  // ── Time entries per card (boardId -> cardId -> hours) — localStorage ─────
  getTimeEntry(boardId, cardId) {
    const all = JSON.parse(localStorage.getItem('ideaz_time') || '{}');
    return (all[boardId] || {})[cardId] || 0;
  },
  saveTimeEntry(boardId, cardId, hours) {
    const all = JSON.parse(localStorage.getItem('ideaz_time') || '{}');
    if (!all[boardId]) all[boardId] = {};
    all[boardId][cardId] = parseFloat(hours) || 0;
    localStorage.setItem('ideaz_time', JSON.stringify(all));
  },
  getBoardTimeEntries(boardId) {
    const all = JSON.parse(localStorage.getItem('ideaz_time') || '{}');
    return all[boardId] || {};
  },
  getAllTimeEntries() {
    return JSON.parse(localStorage.getItem('ideaz_time') || '{}');
  },

  // ── Time overrides with reason — localStorage ─────────────────────────────
  getTimeOverride(boardId, cardId) {
    const all = JSON.parse(localStorage.getItem('ideaz_overrides') || '{}');
    return (all[boardId] || {})[cardId] || null;
  },
  saveTimeOverride(boardId, cardId, override) {
    const all = JSON.parse(localStorage.getItem('ideaz_overrides') || '{}');
    if (!all[boardId]) all[boardId] = {};
    all[boardId][cardId] = { ...override, editedAt: new Date().toISOString() };
    localStorage.setItem('ideaz_overrides', JSON.stringify(all));
  },
  removeTimeOverride(boardId, cardId) {
    const all = JSON.parse(localStorage.getItem('ideaz_overrides') || '{}');
    if (all[boardId]) delete all[boardId][cardId];
    localStorage.setItem('ideaz_overrides', JSON.stringify(all));
  },
  getBoardTimeOverrides(boardId) {
    const all = JSON.parse(localStorage.getItem('ideaz_overrides') || '{}');
    return all[boardId] || {};
  },

  // ── Member names (caché de nombres de Trello, compartido) ─────────────────
  saveMemberName(memberId, name) {
    if ((this._members[memberId] || {}).name === name) return; // sin cambios: no tocar la BD
    this._members[memberId] = { ...(this._members[memberId] || {}), name };
    this._dirtyMembers[memberId] = { ...(this._dirtyMembers[memberId] || {}), name };
    this._scheduleFlush();
  },
  getMemberName(memberId) {
    return (this._members[memberId] && this._members[memberId].name) || 'Desconocido';
  },
  getAllMemberNames() {
    const names = {};
    for (const [id, m] of Object.entries(this._members)) {
      if (m.name) names[id] = m.name;
    }
    return names;
  },

  // ── Member roles (diseñador | cm | pm | otro) ─────────────────────────────
  getMemberRole(memberId) {
    return (this._members[memberId] && this._members[memberId].role) || '';
  },
  setMemberRole(memberId, role) {
    this._members[memberId] = { ...(this._members[memberId] || {}), role };
    this._dirtyMembers[memberId] = { ...(this._dirtyMembers[memberId] || {}), role };
    this._scheduleFlush();
  },
  getAllRoles() {
    const roles = {};
    for (const [id, m] of Object.entries(this._members)) {
      if (m.role) roles[id] = m.role;
    }
    return roles;
  }
};

window.Storage = Storage;
