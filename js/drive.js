const DriveAPI = (() => {
  const SCOPES  = 'https://www.googleapis.com/auth/drive';
  const MONTHS  = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const MONTHS_UPPER = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO',
                        'JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];

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
    const accessParam = new URLSearchParams(window.location.search).get('access');
    if (accessParam) sessionStorage.setItem('ideaz_pending_access', accessParam);
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
    if (!match) return null;
    const targetNum = parseInt(match[1]);

    const monthIdx  = dueDate.getMonth();
    const prevMName = MONTHS[(monthIdx + 11) % 12];
    const prevYear  = (monthIdx === 0 ? dueDate.getFullYear() - 1 : dueDate.getFullYear()).toString();

    // root → year
    const rootFolders = await _listSubfolders(rootFolderId);
    const yFolder = rootFolders.find(f => _matchYear(f.name, year));
    if (!yFolder) return null;

    // year → month (contains match)
    // If month is January the fallback "december" lives in the previous year's folder
    const yearFolders = await _listSubfolders(yFolder.id);
    let mFolder = yearFolders.find(f => _matchMonth(f.name, mName));

    if (!mFolder) {
      if (prevYear !== year) {
        // Cross-year fallback: diciembre 2026 when card is due in enero 2027
        const prevYFolder = rootFolders.find(f => _matchYear(f.name, prevYear));
        if (prevYFolder) {
          const prevYearFolders = await _listSubfolders(prevYFolder.id);
          mFolder = prevYearFolders.find(f => _matchMonth(f.name, prevMName));
        }
      } else {
        mFolder = yearFolders.find(f => _matchMonth(f.name, prevMName));
      }
    }

    if (!mFolder) return null;

    // month → post (number match — ignores "POST", "#", spaces, case)
    const monthFolders = await _listSubfolders(mFolder.id);
    const pFolder = monthFolders.find(f => _matchPost(f.name, targetNum));
    if (!pFolder) return null;

    const files = await _listFiles(pFolder.id);
    return { folderId: pFolder.id, folderName: pFolder.name, files };
  }

  // ── Create folders ────────────────────────────────────────────────────────────
  async function _createFolder(name, parentId) {
    const token = getToken();
    if (!token) throw new Error('No autenticado con Google Drive');
    const res = await fetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parentId]
      })
    });
    if (res.status === 401) { clearToken(); throw new Error('Sesión de Drive expirada — reconecta en Configuración'); }
    if (!res.ok) throw new Error(`Drive API ${res.status}`);
    return res.json();
  }

  // Creates year/month/POST#1..N under rootFolderId, skipping folders that already exist.
  // onProgress(i, total) is called for each post checked.
  async function createStructure(rootFolderId, year, monthIdx, postCount, onProgress) {
    const yearStr    = year.toString();
    const monthName  = MONTHS[monthIdx];
    const monthLabel = `${MONTHS_UPPER[monthIdx]} ${yearStr}`;
    const results    = { created: [], skipped: [] };

    const rootFolders = await _listSubfolders(rootFolderId);
    let yFolder = rootFolders.find(f => _matchYear(f.name, yearStr));
    if (yFolder) {
      results.skipped.push(yearStr);
    } else {
      yFolder = await _createFolder(yearStr, rootFolderId);
      results.created.push(yearStr);
    }

    const yearFolders = await _listSubfolders(yFolder.id);
    let mFolder = yearFolders.find(f => _matchMonth(f.name, monthName));
    if (mFolder) {
      results.skipped.push(mFolder.name);
    } else {
      mFolder = await _createFolder(monthLabel, yFolder.id);
      results.created.push(monthLabel);
    }

    const monthFolders = await _listSubfolders(mFolder.id);
    for (let i = 1; i <= postCount; i++) {
      if (onProgress) onProgress(i, postCount);
      const exists = monthFolders.find(f => _matchPost(f.name, i));
      if (exists) {
        results.skipped.push(exists.name);
      } else {
        await _createFolder(`POST #${i}`, mFolder.id);
        results.created.push(`POST #${i}`);
      }
    }

    return results;
  }

  return {
    getClientId, saveClientId,
    isConnected, connect, handleCallback, clearToken,
    getFolderForBoard, saveFolderForBoard,
    findPostFolder, createStructure
  };
})();

window.DriveAPI = DriveAPI;
