const TrelloCache = {
  PREFIX: 'ideaz_cache_',

  _key(k) { return this.PREFIX + k; },

  get(k) {
    try {
      const raw = localStorage.getItem(this._key(k));
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (Date.now() > entry.expires) {
        localStorage.removeItem(this._key(k));
        return null;
      }
      return entry.data;
    } catch { return null; }
  },

  set(k, data, ttlMinutes) {
    try {
      localStorage.setItem(this._key(k), JSON.stringify({
        data,
        savedAt: Date.now(),
        expires: Date.now() + ttlMinutes * 60000
      }));
    } catch {
      // localStorage lleno — se omite el caché sin romper nada
    }
  },

  ageMinutes(k) {
    try {
      const raw = localStorage.getItem(this._key(k));
      if (!raw) return null;
      const { savedAt, expires } = JSON.parse(raw);
      if (Date.now() > expires) return null;
      return Math.floor((Date.now() - savedAt) / 60000);
    } catch { return null; }
  },

  invalidate(...keys) {
    keys.forEach(k => localStorage.removeItem(this._key(k)));
  },

  invalidateAll() {
    Object.keys(localStorage)
      .filter(k => k.startsWith(this.PREFIX))
      .forEach(k => localStorage.removeItem(k));
  }
};

window.TrelloCache = TrelloCache;
