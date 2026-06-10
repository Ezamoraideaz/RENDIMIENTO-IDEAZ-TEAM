class TrelloAPI {
  constructor(key, token, { forceRefresh = false } = {}) {
    this.key = key;
    this.token = token;
    this.base = 'https://api.trello.com/1';
    this.forceRefresh = forceRefresh;
  }

  async _fetch(endpoint, params = {}) {
    const url = new URL(`${this.base}${endpoint}`);
    url.searchParams.set('key', this.key);
    url.searchParams.set('token', this.token);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Trello ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async _cached(cacheKey, ttlMinutes, fetchFn) {
    if (!this.forceRefresh) {
      const hit = TrelloCache.get(cacheKey);
      if (hit !== null) return hit;
    }
    const data = await fetchFn();
    TrelloCache.set(cacheKey, data, ttlMinutes);
    return data;
  }

  getMe() {
    return this._cached('me', 60, () =>
      this._fetch('/members/me', { fields: 'id,fullName,username,avatarUrl' })
    );
  }

  getBoards() {
    return this._cached('boards_v2', 30, () =>
      this._fetch('/members/me/boards', {
        filter: 'open',
        fields: 'id,name,desc,dateLastActivity,shortUrl,prefs,closed,idOrganization',
        organization: 'true',
        organization_fields: 'id,name,displayName'
      })
    );
  }

  getBoard(id) {
    return this._cached(`board_meta2_${id}`, 30, () =>
      this._fetch(`/boards/${id}`, {
        fields: 'id,name,desc,dateLastActivity,shortUrl,prefs,idOrganization',
        organization: 'true',
        organization_fields: 'id,name,displayName'
      })
    );
  }

  getLists(boardId) {
    return this._cached(`lists_${boardId}`, 20, () =>
      this._fetch(`/boards/${boardId}/lists`, { filter: 'open' })
    );
  }

  getCards(boardId) {
    return this._cached(`cards_${boardId}`, 20, () =>
      this._fetch(`/boards/${boardId}/cards`, {
        fields: 'id,name,idList,idMembers,due,start,dueComplete,dateLastActivity,labels,desc,closed,shortLink',
        filter: 'all'
      })
    );
  }

  getMembers(boardId) {
    return this._cached(`members_${boardId}`, 30, () =>
      this._fetch(`/boards/${boardId}/members`, { fields: 'id,fullName,username,avatarUrl' })
    );
  }

  getBoardActions(boardId) {
    return this._cached(`actions_${boardId}`, 20, () =>
      this._fetch(`/boards/${boardId}/actions`, {
        filter: 'updateCard:idList',
        limit: 1000,
        fields: 'date,data,memberCreator,type'
      })
    );
  }

  getBoardWithDetails(boardId) {
    return Promise.all([
      this.getBoard(boardId),
      this.getLists(boardId),
      this.getCards(boardId),
      this.getMembers(boardId),
      this.getBoardActions(boardId)
    ]).then(([board, lists, cards, members, actions]) => ({ board, lists, cards, members, actions }));
  }
}

window.TrelloAPI = TrelloAPI;
