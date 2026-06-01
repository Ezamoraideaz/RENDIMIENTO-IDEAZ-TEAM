const Storage = {
  // Credentials
  getCredentials() {
    return JSON.parse(localStorage.getItem('ideaz_credentials') || '{}');
  },
  saveCredentials(key, token) {
    localStorage.setItem('ideaz_credentials', JSON.stringify({ key, token }));
  },
  hasCredentials() {
    const c = this.getCredentials();
    return !!(c.key && c.token);
  },
  clearCredentials() {
    localStorage.removeItem('ideaz_credentials');
  },

  // Project financial data (per board)
  getProjectData(boardId) {
    const all = JSON.parse(localStorage.getItem('ideaz_projects') || '{}');
    return all[boardId] || { budget: 0, revenue: 0, currency: 'COP', hoursEstimated: 0, alias: '', category: '', period: '', type: '' };
  },
  saveProjectData(boardId, data) {
    const all = JSON.parse(localStorage.getItem('ideaz_projects') || '{}');
    all[boardId] = { ...this.getProjectData(boardId), ...data };
    localStorage.setItem('ideaz_projects', JSON.stringify(all));
  },
  getAllProjectData() {
    return JSON.parse(localStorage.getItem('ideaz_projects') || '{}');
  },

  // Member hourly rates
  getMemberRate(memberId) {
    const rates = JSON.parse(localStorage.getItem('ideaz_rates') || '{}');
    return rates[memberId] || 0;
  },
  saveMemberRate(memberId, rate) {
    const rates = JSON.parse(localStorage.getItem('ideaz_rates') || '{}');
    rates[memberId] = parseFloat(rate) || 0;
    localStorage.setItem('ideaz_rates', JSON.stringify(rates));
  },
  getAllRates() {
    return JSON.parse(localStorage.getItem('ideaz_rates') || '{}');
  },

  // Time entries per card (boardId -> cardId -> hours)
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

  // Member names cache
  saveMemberName(memberId, name) {
    const names = JSON.parse(localStorage.getItem('ideaz_members') || '{}');
    names[memberId] = name;
    localStorage.setItem('ideaz_members', JSON.stringify(names));
  },
  getMemberName(memberId) {
    const names = JSON.parse(localStorage.getItem('ideaz_members') || '{}');
    return names[memberId] || 'Desconocido';
  },
  getAllMemberNames() {
    return JSON.parse(localStorage.getItem('ideaz_members') || '{}');
  }
};

window.Storage = Storage;
