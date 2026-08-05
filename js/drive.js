const DriveAPI = (() => {
  const MONTHS  = ['enero','febrero','marzo','abril','mayo','junio',
                   'julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const MONTHS_UPPER = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO',
                        'JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];

  // ── Transporte ───────────────────────────────────────────────────────────────
  // Antes este módulo hablaba directo con la API de Drive usando un token OAuth
  // por usuario guardado en localStorage (flujo implícito de Google, que nunca
  // entrega refresh_token y expira cada hora — cada CM/PM tenía que reconectar
  // varias veces al día). Ahora las lecturas/escrituras pasan por el backend
  // (backend/api/drive_browse.php), que usa la cuenta de servicio compartida —
  // no hay conexión por usuario ni expiración que gestionar desde acá.
  async function _listSubfolders(parentId) {
    const r = await Session.apiFetch(`api/drive_browse.php?action=list_subfolders&parent_id=${encodeURIComponent(parentId)}`);
    return r.files || [];
  }
  async function _listFiles(folderId) {
    const r = await Session.apiFetch(`api/drive_browse.php?action=list_files&folder_id=${encodeURIComponent(folderId)}`);
    return r.files || [];
  }
  async function _createFolder(name, parentId) {
    const r = await Session.apiFetch('api/drive_browse.php', {
      method: 'POST',
      body: JSON.stringify({ action: 'create_folder', name, parent_id: parentId })
    });
    return r.folder;
  }

  // Se mantiene por compatibilidad con las pantallas que todavía preguntan si
  // Drive "está conectado" antes de buscar una carpeta — con la cuenta de
  // servicio siempre lo está; si algo falla (carpeta no compartida, cuenta de
  // servicio mal configurada), el error real llega al rechazar la promesa de
  // la llamada correspondiente (findPostFolder/findApprovalMedia/etc.), no acá.
  function isConnected() { return true; }

  // ── Per-board folder ──────────────────────────────────────────────────────────
  // La carpeta por tablero es parte de la configuración del proyecto en la BD
  // (project_settings.drive_folder_id); cm también puede editarla.
  function getFolderForBoard(boardId) {
    return Storage.getProjectData(boardId).driveFolderId || '';
  }
  function saveFolderForBoard(boardId, folderId) {
    Storage.saveProjectData(boardId, { driveFolderId: folderId.trim() });
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

  // Orden de un archivo dentro del carrusel: el primer número que aparezca en
  // el nombre ("1.jpg", "slide 2.png", "Foto-03.png" → 1, 2, 3). Sin número,
  // se manda al final y desempata por nombre — la API de Drive no garantiza
  // ningún orden propio al listar archivos de una carpeta.
  function _slideOrderNum(name) {
    const m = (name || '').match(/\d+/);
    return m ? parseInt(m[0], 10) : Infinity;
  }
  function _sortBySlideOrder(files) {
    return files.slice().sort((a, b) => {
      const diff = _slideOrderNum(a.name) - _slideOrderNum(b.name);
      return diff !== 0 ? diff : a.name.localeCompare(b.name);
    });
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

  // ── Carpeta "Para aprobación" (módulo aprobaciones) ─────────────────────────
  // Carpeta externa por marca (clients.drive_approval_folder_id), separada de
  // la carpeta ARTES del proyecto — el diseñador sube ahí el contenido listo
  // para revisión, nombrando el archivo o subcarpeta con el identificador del
  // post (columna A del cronograma, ej. "POST #3" — mismo criterio que
  // _matchPost ya usa arriba). approvalFolderId ES esa carpeta directamente,
  // no una carpeta raíz donde buscarla.
  //
  // Devuelve { folder, files } — folder es la subcarpeta del post si existe
  // (y ahí se listan los files), o directamente approvalFolderId si el
  // diseñador subió el archivo suelto ahí con el nombre del post.
  async function findApprovalMedia(approvalFolderId, postNumber) {
    const subfolders = await _listSubfolders(approvalFolderId);
    const matchingFolders = subfolders.filter(f => _matchPost(f.name, postNumber));
    // Dos (o más) subcarpetas para el mismo # de post en "Para aprobación" es
    // ambiguo — no adivinamos cuál usar (podría subirse el contenido
    // equivocado), se avisa para que el equipo lo resuelva a mano.
    if (matchingFolders.length > 1) {
      return { folder: null, files: [], duplicateFolders: matchingFolders };
    }
    const postFolder = matchingFolders[0];
    if (postFolder) {
      const files = await _listFiles(postFolder.id);
      return { folder: postFolder, files: _sortBySlideOrder(files) };
    }

    const looseFiles = await _listFiles(approvalFolderId);
    const matched = looseFiles.filter(f => _matchPost(f.name, postNumber));
    return { folder: matched.length ? { id: approvalFolderId } : null, files: _sortBySlideOrder(matched) };
  }

  return {
    isConnected,
    getFolderForBoard, saveFolderForBoard,
    findPostFolder, createStructure, findApprovalMedia
  };
})();

window.DriveAPI = DriveAPI;
