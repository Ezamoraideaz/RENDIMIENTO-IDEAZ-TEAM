const DriveAPI = (() => {
  const SCOPES  = 'https://www.googleapis.com/auth/drive.readonly';
  const MONTHS  = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];

  function _redirectUri() {
    const loc = window.location;
    const base = loc.origin + loc.pathname.replace(/\/[^/]*$/, '/');
    return base + 'configuracion.html';
  }

  // ── Credentials ──────────────────────────────────────────────────────────────
  function getClientId()    { return localStorage.getItem('ideaz_drive_client_id') || ''; }
  function saveClientId(id) { localStorage.setItem('ideaz_drive_client_id', id.trim()); }

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
  function clearToken()  { localStorage.removeItem('ideaz_drive_token'); }
  function isConnected() { return !!getToken(); }

  // ── Per-board folder ──────────────────────────────────────────────────────────
  function getFolderForBoard(boardId) {
    return JSON.parse(localStorage.getItem('ideaz_drive_folders') || '{}')[boardId] || '';
  }
  function saveFolderForBoard(boardId, folderId) {
    const m = JSON.parse(localStorage.getItem('ideaz_drive_folders') || '{}');
    m[boardId] = folderId.trim();
    localStorage.setItem('ideaz_drive_folders', JSON.stringify(m));
  }

  // ── OAuth ─────────────────────────────────────────────────────────────────────
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

  function handleCallback() {
    const hash = window.location.hash;
    if (!hash || !hash.includes('access_token')) return false;
    const p     = new URLSearchParams(hash.slice(1));
    const token = p.get('access_token');
    if (!token) return false;
    _saveToken(token, p.get('expires_in') || 3600);
    window.history.replaceState({}, document.title,
      window.location.pathname + window.location.search);
    return true;
  }

  // ── Drive API v3 ──────────────────────────────────────────────────────────────
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

  // List all subfolders of a parent (up to 100)
  async function _listSubfolders(parentId) {
    const r = await _fetch('files', {
      q:        `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields:   'files(id,name)',
      pageSize: '100'
    });
    return r.files || [];
  }

  async function _listFiles(folderId) {
    const r = await _fetch('files', {
      q:        `'${folderId}' in parents and trashed=false`,
      fields:   'files(id,name,mimeType,webViewLink,thumbnailLink)',
      pageSize: '20'
    });
    return r.files || [];
  }

  // ── Fuzzy matchers (client-side) ──────────────────────────────────────────────

  // Year: exact match against the 4-digit year string
  function _matchYear(folderName, year) {
    return folderName.trim() === year;
  }

  // Month: folder name contains the month word (case-insensitive)
  // e.g. "MAYO 2026", "mayo", "Mayo 2026" all match for "mayo"
  function _matchMonth(folderName, monthName) {
    return folderName.toLowerCase().includes(monthName);
  }

  // Post: extract short numbers (≤3 digits, i.e. not a year) from folder name
  // and check if the target post number is among them
  // e.g. "POST #27", "post #27", "post # 27", "Post27" all match for 27
  function _matchPost(folderName, targetNum) {
    const nums = (folderName.match(/\d+/g) || []).filter(n => n.length <= 3);
    return nums.some(n => parseInt(n) === targetNum);
  }

  // ── Main search: artes → year → month → post ──────────────────────────────────
  async function findPostFolder(rootFolderId, cardName, dueDate) {
    const year  = dueDate.getFullYear().toString();
    const mName = MONTHS[dueDate.getMonth()]; // lowercase, e.g. "mayo"

    // Extract post number from card name ("post #27 HISTORIA" → 27)
    const match = cardName.match(/(?:post)\s*#?\s*(\d+)/i) || cardName.match(/\b(\d+)\b/);
    if (!match) { console.warn('[Drive] No se encontró número de post en:', cardName); return null; }
    const targetNum = parseInt(match[1]);
    console.log(`[Drive] Buscando → año:${year} mes:${mName} post:#${targetNum} | root:${rootFolderId}`);

    // root → year
    const rootFolders = await _listSubfolders(rootFolderId);
    console.log('[Drive] Carpetas en root:', rootFolders.map(f => f.name));
    const yFolder = rootFolders.find(f => _matchYear(f.name, year));
    if (!yFolder) { console.warn(`[Drive] No se encontró carpeta de año "${year}"`); return null; }
    console.log(`[Drive] Año encontrado: "${yFolder.name}"`);

    // year → month (contains match — tolerates any prefix/suffix the CM adds)
    const yearFolders = await _listSubfolders(yFolder.id);
    console.log('[Drive] Carpetas en año:', yearFolders.map(f => f.name));
    const mFolder = yearFolders.find(f => _matchMonth(f.name, mName));
    if (!mFolder) { console.warn(`[Drive] No se encontró carpeta que contenga "${mName}"`); return null; }
    console.log(`[Drive] Mes encontrado: "${mFolder.name}"`);

    // month → post (number match — ignores "POST", "#", spaces, case)
    const monthFolders = await _listSubfolders(mFolder.id);
    console.log('[Drive] Carpetas en mes:', monthFolders.map(f => f.name));
    const pFolder = monthFolders.find(f => _matchPost(f.name, targetNum));
    if (!pFolder) { console.warn(`[Drive] No se encontró carpeta para post #${targetNum}`); return null; }
    console.log(`[Drive] Post encontrado: "${pFolder.name}"`);

    const files = await _listFiles(pFolder.id);
    return { folderId: pFolder.id, folderName: pFolder.name, files };
  }

  return {
    getClientId, saveClientId,
    isConnected, connect, handleCallback, clearToken,
    getFolderForBoard, saveFolderForBoard,
    findPostFolder
  };
})();

window.DriveAPI = DriveAPI;
