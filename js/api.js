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
    const urlStr = url.toString();

    // Deduplication: si ya hay una request en vuelo al mismo URL, reusar la promesa
    if (TrelloAPI._inflight[urlStr]) return TrelloAPI._inflight[urlStr];

    const attempt = async (retries = 2, delay = 5000) => {
      const res = await fetch(urlStr);
      if (res.status === 429) {
        if (retries <= 0) throw new Error(`Trello 429: ${await res.text()}`);
        // Respetar Retry-After si Trello lo envía; si no, backoff exponencial
        const retryAfter = parseInt(res.headers.get('Retry-After') || '0', 10);
        const wait = retryAfter > 0 ? retryAfter * 1000 : delay;
        await new Promise(r => setTimeout(r, wait));
        return attempt(retries - 1, delay * 3);
      }
      if (!res.ok) throw new Error(`Trello ${res.status}: ${await res.text()}`);
      return res.json();
    };

    const promise = attempt().finally(() => { delete TrelloAPI._inflight[urlStr]; });
    TrelloAPI._inflight[urlStr] = promise;
    return promise;
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
    return this._cached('me', 240, () =>
      this._fetch('/members/me', { fields: 'id,fullName,username,avatarUrl' })
    );
  }

  getBoards() {
    return this._cached('boards_v2', 120, () =>
      this._fetch('/members/me/boards', {
        filter: 'open',
        fields: 'id,name,desc,dateLastActivity,shortUrl,prefs,closed,idOrganization',
        organization: 'true',
        organization_fields: 'id,name,displayName'
      })
    );
  }

  getBoard(id) {
    return this._cached(`board_meta2_${id}`, 120, () =>
      this._fetch(`/boards/${id}`, {
        fields: 'id,name,desc,dateLastActivity,shortUrl,prefs,idOrganization',
        organization: 'true',
        organization_fields: 'id,name,displayName'
      })
    );
  }

  getLists(boardId) {
    return this._cached(`lists_${boardId}`, 60, () =>
      this._fetch(`/boards/${boardId}/lists`, { filter: 'open' })
    );
  }

  getCards(boardId) {
    return this._cached(`cards_${boardId}`, 60, () =>
      this._fetch(`/boards/${boardId}/cards`, {
        fields: 'id,name,idList,idMembers,due,start,dueComplete,dateLastActivity,labels,desc,closed,shortLink',
        filter: 'all'
      })
    );
  }

  getMembers(boardId) {
    return this._cached(`members_${boardId}`, 120, () =>
      this._fetch(`/boards/${boardId}/members`, { fields: 'id,fullName,username,avatarUrl' })
    );
  }

  getBoardActions(boardId) {
    return this._cached(`actions_${boardId}`, 60, () =>
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

  getBoardCommentActions(boardId) {
    return this._cached(`comments_${boardId}`, 60, () =>
      this._fetch(`/boards/${boardId}/actions`, {
        filter: 'commentCard',
        limit: 1000,
        fields: 'date,data,memberCreator,type'
      })
    );
  }

  async moveCard(cardId, listId) {
    const url = new URL(`${this.base}/cards/${cardId}`);
    url.searchParams.set('key', this.key);
    url.searchParams.set('token', this.token);
    const res = await fetch(url.toString(), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idList: listId })
    });
    if (!res.ok) throw new Error(`Trello ${res.status}: ${await res.text()}`);
    return res.json();
  }

  async postComment(cardId, text) {
    const url = new URL(`${this.base}/cards/${cardId}/actions/comments`);
    url.searchParams.set('key', this.key);
    url.searchParams.set('token', this.token);
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text })
    });
    if (!res.ok) throw new Error(`Trello ${res.status}: ${await res.text()}`);
    return res.json();
  }
}

// Mapa estático compartido entre todas las instancias para deduplicar requests en vuelo
TrelloAPI._inflight = {};

window.TrelloAPI = TrelloAPI;
