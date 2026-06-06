const DriveAPI = (() => {
  const SCOPES   = 'https://www.googleapis.com/auth/drive.readonly';
  const MONTHS   = ['enero','febrero','marzo','abril','mayo','junio',
                    'julio','agosto','septiembre','octubre','noviembre','diciembre'];

  // Build redirect URI dynamically so it works on any deployment
  function _redirectUri() {
    const loc = window.location;
    const base = loc.origin + loc.pathname.replace(/\/[^/]*$/, '/');
    return base + 'configuracion.html';
  }

  // ── Credentials ────────────────────────────────────────────────────────────
  function getClientId()     { return localStorage.getItem('ideaz_drive_client_id') || ''; }
  function saveClientId(id)  { localStorage.setItem('ideaz_drive_client_id', id.trim()); }

  function getToken() {
    try {
      const d = JSON.parse(localStorage.getItem('ideaz_drive_token') || '{}');
      if (!d.token || !d.expiry || Date.now() > d.expiry) return null;
      return d.token;
    } catch { return null; }
  }
  function _saveToken(token, expiresIn) {
    localStorage.setItem('ideaz_drive_token', JSON.stringify({
      token,
      expiry: Date.now() + (parseInt(expiresIn) - 60) * 1000
    }));
  }
  function clearToken() { localStorage.removeItem('ideaz_drive_token'); }
  function isConnected() { return !!getToken(); }

  // ── Per-board folder ───────────────────────────────────────────────────────
  function getFolderForBoard(boardId) {
    return JSON.parse(localStorage.getItem('ideaz_drive_folders') || '{}')[boardId] || '';
  }
  function saveFolderForBoard(boardId, folderId) {
    const m = JSON.parse(localStorage.getItem('ideaz_drive_folders') || '{}');
    m[boardId] = folderId.trim();
    localStorage.setItem('ideaz_drive_folders', JSON.stringify(m));
  }

  // ── OAuth ──────────────────────────────────────────────────────────────────
  function connect() {
    const clientId = getClientId();
    if (!clientId) throw new Error('Guarda el Client ID antes de conectar');
    const p = new URLSearchParams({
      client_id:     clientId,
      redirect_uri:  _redirectUri(),
      response_type: 'token',
      scope:         SCOPES,
      prompt:        'consent'
    });
    window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
  }

  // Call on configuracion.html load — captures token from URL hash after redirect
  function handleCallback() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return false;
    const p = new URLSearchParams(hash.slice(1));
    const token = p.get('access_token');
    if (!token) return false;
    _saveToken(token, p.get('expires_in') || 3600);
    window.history.replaceState({}, document.title,
      window.location.pathname + window.location.search);
    return true;
  }

  // ── Drive API v3 ───────────────────────────────────────────────────────────
  async function _fetch(endpoint, params = {}) {
    const token = getToken();
    if (!token) throw new Error('No autenticado con Google Drive');
    const url = new URL(`https://www.googleapis.com/drive/v3/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) { clearToken(); throw new Error('Sesión de Drive expirada — reconecta en Configuración'); }
    if (!res.ok) throw new Error(`Drive API ${res.status}`);
    return res.json();
  }

  async function _findFolder(parentId, candidates) {
    for (const name of candidates) {
      const q = `'${parentId}' in parents and name='${name.replace(/'/g,"\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
      const r = await _fetch('files', { q, fields: 'files(id,name)', pageSize: '1' });
      if (r.files?.length) return r.files[0];
    }
    return null;
  }

  async function _listFiles(folderId) {
    const r = await _fetch('files', {
      q:        `'${folderId}' in parents and trashed=false`,
      fields:   'files(id,name,mimeType,webViewLink,thumbnailLink)',
      pageSize: '20'
    });
    return r.files || [];
  }

  // ── Main search ────────────────────────────────────────────────────────────
  async function findPostFolder(rootFolderId, cardName, dueDate) {
    const year   = dueDate.getFullYear().toString();
    const mName  = MONTHS[dueDate.getMonth()];
    const mCap   = mName.charAt(0).toUpperCase() + mName.slice(1);

    const monthCandidates = [
      mCap, mName, mName.toUpperCase(),
      `${mCap} ${year}`, `${mName} ${year}`, `${mName.toUpperCase()} ${year}`
    ];

    // Extract post number from card name
    const m = cardName.match(/(?:post)\s*#?\s*(\d+)/i) || cardName.match(/\b(\d+)\b/);
    if (!m) return null;
    const n = m[1];
    const postCandidates = [
      `POST #${n}`, `Post #${n}`, `post #${n}`,
      `POST # ${n}`, `Post # ${n}`,
      `POST${n}`, `Post${n}`, n
    ];

    // Strategy 1: root → month → post
    let mFolder = await _findFolder(rootFolderId, monthCandidates);
    if (mFolder) {
      const pFolder = await _findFolder(mFolder.id, postCandidates);
      if (pFolder) {
        const files = await _listFiles(pFolder.id);
        if (files.length) return { folderId: pFolder.id, folderName: pFolder.name, files };
      }
    }

    // Strategy 2: root → year → month → post
    const yFolder = await _findFolder(rootFolderId, [year]);
    if (yFolder) {
      mFolder = await _findFolder(yFolder.id, monthCandidates);
      if (mFolder) {
        const pFolder = await _findFolder(mFolder.id, postCandidates);
        if (pFolder) {
          const files = await _listFiles(pFolder.id);
          if (files.length) return { folderId: pFolder.id, folderName: pFolder.name, files };
        }
      }
    }

    return null;
  }

  return {
    getClientId, saveClientId,
    isConnected, connect, handleCallback, clearToken,
    getFolderForBoard, saveFolderForBoard,
    findPostFolder
  };
})();

window.DriveAPI = DriveAPI;
