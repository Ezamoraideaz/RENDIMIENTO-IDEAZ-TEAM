// Controlador de aprobaciones.html — arma tandas de contenido para revisión
// del cliente (portal público revisar.html, aún no publicado — Fase 3) y
// muestra el feedback estructurado que ya llegó. Habla con backend/ vía
// Session.apiFetch (misma sesión/CSRF que el resto del sitio).
const Aprobaciones = (() => {
  const TYPE_LABEL = { feed: 'Feed', story: 'Historia', reel: 'Reel', carousel: 'Carrusel' };
  const STATUS_LABEL = {
    draft: 'Borrador', pending: 'Pendiente',
    approved: 'Aprobado', changes_requested: 'Cambios',
  };
  const STATUS_CLASS = {
    draft: 'bg-slate-700 text-slate-300',
    pending: 'bg-amber-500/15 text-amber-400',
    approved: 'bg-emerald-500/15 text-emerald-400',
    changes_requested: 'bg-rose-500/15 text-rose-400',
  };

  const MONTHS_UPPER = ['ENERO','FEBRERO','MARZO','ABRIL','MAYO','JUNIO',
                         'JULIO','AGOSTO','SEPTIEMBRE','OCTUBRE','NOVIEMBRE','DICIEMBRE'];
  const REASON = { OK: 'ok', NO_SHEET_ROW: 'no_sheet_row', NO_DRIVE: 'no_drive', NO_POST_NUMBER: 'no_post_number', DUPLICATE_POST: 'duplicate_post' };

  let clients = [];
  let batches = [];
  let activeClientId = null;
  let activeBatch = null; // último detalle cargado en el modal
  let autoTargetBatchId = null; // si viene seteado, "Generar tanda automática" agrega piezas a esta tanda en vez de crear una nueva
  let autoResults = []; // filas de la búsqueda de "Generar tanda automática"

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso.replace(' ', 'T'));
    if (isNaN(d)) return iso;
    return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso.replace(' ', 'T'));
    if (isNaN(d)) return iso;
    return d.toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  // Acepta un link de Trello (https://trello.com/c/<id>/...) o un ID/shortLink pegado directo.
  function parseTrelloCardId(raw) {
    const v = (raw || '').trim();
    if (!v) return null;
    const m = v.match(/trello\.com\/c\/([a-zA-Z0-9]+)/);
    return m ? m[1] : v;
  }

  function activeClient() {
    return clients.find((c) => c.id === activeClientId) || null;
  }

  async function init() {
    document.getElementById('ap-client-select').addEventListener('change', onClientChange);
    document.getElementById('ap-new-batch-btn').addEventListener('click', openNewBatchModal);
    document.getElementById('ap-auto-batch-btn').addEventListener('click', function () { openAutoModal(); });
    document.getElementById('ap-link-board-btn').addEventListener('click', openBoardModal);
    const sheetBtn = document.getElementById('ap-link-sheet-btn');
    if (Session.user && Session.user.role !== 'cm') {
      sheetBtn.style.display = '';
      sheetBtn.addEventListener('click', linkSheet);
    }
    document.getElementById('ap-link-approval-folder-btn')?.addEventListener('click', linkApprovalFolder);
    document.getElementById('ap-board-list').addEventListener('click', onBoardListClick);
    document.getElementById('ap-auto-results').addEventListener('input', onAutoResultsInput);
    document.getElementById('ap-auto-results').addEventListener('click', onAutoResultsClick);
    const autoResultsEl = document.getElementById('ap-auto-results');
    autoResultsEl.addEventListener('dragstart', onAutoFileDragStart);
    autoResultsEl.addEventListener('dragover', onAutoFileDragOver);
    autoResultsEl.addEventListener('drop', onAutoFileDrop);
    await loadClients();
  }

  function getTrelloApi() {
    const { key, token } = Storage.getCredentials();
    if (!key || !token) throw new Error('Faltan las credenciales de Trello — configúralas en Configuración');
    return new TrelloAPI(key, token);
  }

  async function loadClients() {
    const sel = document.getElementById('ap-client-select');
    try {
      const data = await Session.apiFetch('api/clients.php');
      clients = data.clients || [];
    } catch (e) {
      sel.innerHTML = '<option value="">Error cargando clientes</option>';
      Utils.showToast(e.message, 'danger');
      return;
    }
    if (!clients.length) {
      sel.innerHTML = '<option value="">No hay clientes creados todavía</option>';
      return;
    }
    sel.innerHTML = clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    document.getElementById('ap-new-batch-btn').disabled = false;
    activeClientId = Number(sel.value);
    renderBoardStatus();
    await loadBatches();
  }

  function onClientChange(e) {
    activeClientId = Number(e.target.value);
    renderBoardStatus();
    loadBatches();
  }

  function renderBoardStatus() {
    const c = activeClient();
    const boardEl = document.getElementById('ap-board-status');
    const sheetEl = document.getElementById('ap-sheet-status');
    const approvalEl = document.getElementById('ap-approval-folder-status');
    const autoBtn = document.getElementById('ap-auto-batch-btn');
    if (!c) {
      boardEl.textContent = '—'; sheetEl.textContent = '—';
      if (approvalEl) approvalEl.textContent = '—';
      autoBtn.disabled = true;
      return;
    }
    boardEl.textContent = c.trello_board_id ? `vinculado (${c.trello_board_id})` : 'sin vincular';
    sheetEl.textContent = c.sheet_id ? `vinculado (${c.sheet_id})` : 'sin vincular';
    if (approvalEl) approvalEl.textContent = c.drive_approval_folder_id ? `vinculada (${c.drive_approval_folder_id})` : 'sin vincular';
    autoBtn.disabled = !c.trello_board_id || !c.sheet_id;
    autoBtn.title = !c.trello_board_id
      ? 'Vincula primero el tablero de Trello'
      : (!c.sheet_id ? 'Este cliente no tiene un Google Sheet vinculado' : '');
  }

  async function linkSheet() {
    const c = activeClient();
    if (!c) return;
    const id = prompt('ID del Google Sheet de este cliente (está en su URL: .../spreadsheets/d/ESTE-ID/edit):', c.sheet_id || '');
    if (id === null) return;
    try {
      await Session.apiFetch('api/clients.php', {
        method: 'PUT',
        body: JSON.stringify({ id: c.id, sheet_id: id.trim() || null }),
      });
      c.sheet_id = id.trim() || null;
      renderBoardStatus();
      Utils.showToast('Google Sheet vinculado', 'success');
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // Carpeta externa "Para aprobación" de la marca (separada de ARTES): el
  // contenido aprobado se mueve automáticamente de aquí hacia ARTES/año/mes/
  // POST # cuando el cliente aprueba en el portal (backend/includes/drive_approval_sync.php).
  async function linkApprovalFolder() {
    const c = activeClient();
    if (!c) return;
    const id = prompt('ID de la carpeta "Para aprobación" de este cliente (está en su URL de Drive, después de /folders/):', c.drive_approval_folder_id || '');
    if (id === null) return;
    try {
      await Session.apiFetch('api/clients.php', {
        method: 'PUT',
        body: JSON.stringify({ id: c.id, drive_approval_folder_id: id.trim() || null }),
      });
      c.drive_approval_folder_id = id.trim() || null;
      renderBoardStatus();
      Utils.showToast('Carpeta "Para aprobación" vinculada', 'success');
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function loadBatches() {
    if (!activeClientId) return;
    const list = document.getElementById('ap-batches-list');
    list.innerHTML = '<p class="text-slate-500 text-sm">Cargando…</p>';
    try {
      const data = await Session.apiFetch(`api/content_batches.php?client_id=${activeClientId}`);
      batches = data.batches || [];
    } catch (e) {
      list.innerHTML = '';
      Utils.showToast(e.message, 'danger');
      return;
    }
    renderBatches();
  }

  function renderBatches() {
    const list = document.getElementById('ap-batches-list');
    const empty = document.getElementById('ap-empty');
    document.getElementById('ap-count').textContent = batches.length ? `${batches.length} tanda${batches.length !== 1 ? 's' : ''}` : '';

    if (!batches.length) {
      list.innerHTML = '';
      empty.style.display = 'block';
      return;
    }
    empty.style.display = 'none';

    list.innerHTML = batches.map((b) => {
      const linkBadge = b.link_generated
        ? (b.completed_at ? '<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Completada</span>'
          : '<span class="text-xs px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400">Link enviado</span>')
        : '<span class="text-xs px-2 py-0.5 rounded-full bg-slate-700 text-slate-400">Sin link</span>';
      return `
        <div class="bg-slate-900 border border-slate-700 rounded-xl p-4 hover:border-indigo-500 transition-colors cursor-pointer"
             onclick="Aprobaciones.openBatchModal(${b.id})">
          <div class="flex items-center justify-between gap-3 flex-wrap">
            <div class="min-w-0">
              <h3 class="font-bold text-slate-100 truncate">${esc(b.label)}</h3>
              <p class="text-xs text-slate-500">${b.item_count} pieza${b.item_count !== 1 ? 's' : ''} · creada ${fmtDate(b.created_at)}</p>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
              ${b.pending_count > 0 ? `<span class="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">${b.pending_count} pendiente${b.pending_count !== 1 ? 's' : ''}</span>` : ''}
              ${b.changes_count > 0 ? `<span class="text-xs px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400">${b.changes_count} con cambios</span>` : ''}
              ${linkBadge}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  // ── Nueva tanda ──────────────────────────────────────────────────────────
  function openNewBatchModal() {
    document.getElementById('ap-new-label').value = '';
    document.getElementById('ap-modal-new').style.display = 'flex';
  }
  function closeNewBatchModal() {
    document.getElementById('ap-modal-new').style.display = 'none';
  }
  async function submitNewBatch() {
    const label = document.getElementById('ap-new-label').value.trim();
    if (!label) return Utils.showToast('Ponle un nombre a la tanda', 'danger');
    try {
      await Session.apiFetch('api/content_batches.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: activeClientId, label }),
      });
      closeNewBatchModal();
      Utils.showToast('Tanda creada', 'success');
      await loadBatches();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // ── Detalle de tanda ─────────────────────────────────────────────────────
  async function openBatchModal(id) {
    try {
      const data = await Session.apiFetch(`api/content_batches.php?id=${id}`);
      activeBatch = data.batch;
    } catch (e) {
      return Utils.showToast(e.message, 'danger');
    }
    renderBatchModal();
    document.getElementById('ap-modal-batch').style.display = 'flex';
  }

  function closeBatchModal() {
    document.getElementById('ap-modal-batch').style.display = 'none';
    activeBatch = null;
  }

  function renderBatchModal() {
    const b = activeBatch;
    document.getElementById('ap-batch-title').textContent = b.label;
    document.getElementById('ap-batch-client').textContent = b.client_name;

    document.getElementById('ap-link-section').innerHTML = renderLinkSection(b);

    const itemsList = document.getElementById('ap-items-list');
    if (!b.items.length) {
      itemsList.innerHTML = '<p class="text-slate-500 text-sm">Todavía no hay piezas en esta tanda.</p>';
    } else {
      itemsList.innerHTML = b.items.map(renderItemRow).join('');
    }

    document.getElementById('ap-auto-add-section').innerHTML = renderAutoAddSection(b);
  }

  // Agregar piezas a una tanda YA enviada buscando en Trello/Sheet/Drive (lo
  // mismo que "Generar tanda automática", pero sumando a esta tanda en vez de
  // crear una nueva) — solo tiene sentido mientras el cliente no completó su
  // feedback, porque una vez completed_at el portal ya no vuelve a mostrarle
  // nada de esta tanda.
  function renderAutoAddSection(b) {
    if (b.completed_at) {
      return '<span class="text-xs text-slate-500" title="El cliente ya completó esta tanda">Tanda completada</span>';
    }
    const client = activeClient();
    if (!client || !client.trello_board_id) {
      return '';
    }
    return `<button type="button" onclick="Aprobaciones.openAutoModal(${b.id})"
      class="text-xs px-2 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold whitespace-nowrap">
      ⚡ Agregar desde Enviado
    </button>`;
  }

  function renderLinkSection(b) {
    if (!b.link_generated) {
      const disabled = b.items.length === 0 ? 'disabled title="Agrega al menos una pieza primero"' : '';
      return `
        <p class="text-sm text-slate-400 mb-3">Todavía no se generó el link de revisión para esta tanda.</p>
        <button ${disabled} onclick="Aprobaciones.generateLink(${b.id})"
          class="px-3 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 disabled:text-slate-500 disabled:cursor-not-allowed text-white">
          Generar link
        </button>`;
    }
    const statusLine = b.completed_at
      ? `Completada el ${fmtDateTime(b.completed_at)}`
      : (b.opened_at ? `Abierta por el cliente el ${fmtDateTime(b.opened_at)}, en espera` : 'Todavía no fue abierta por el cliente');
    return `
      <p class="text-sm text-slate-300 mb-1">${statusLine}</p>
      <p class="text-xs text-slate-500 mb-3">Vence: ${fmtDateTime(b.expires_at)}</p>
      <button onclick="Aprobaciones.generateLink(${b.id}, true)"
        class="px-3 py-2 rounded-lg text-sm font-semibold bg-slate-700 hover:bg-slate-600 text-slate-200">
        Regenerar link
      </button>
      <span class="text-xs text-slate-500 ml-2">Regenerar invalida el link anterior — el cliente tendrá que usar el nuevo.</span>`;
  }

  function renderItemRow(item) {
    const statusCls = STATUS_CLASS[item.status] || STATUS_CLASS.pending;
    const statusLbl = STATUS_LABEL[item.status] || item.status;
    let feedback = '';
    if (item.status === 'changes_requested' && item.last_comment) {
      const tags = (item.last_reason_tags || []).map((t) => `<span class="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/10 text-rose-400 mr-1">${esc(t)}</span>`).join('');
      feedback = `<div class="mt-2 text-xs text-slate-400 bg-slate-800/60 rounded p-2">${tags}<p class="mt-1">"${esc(item.last_comment)}"</p></div>`;
    }
    return `
      <div class="bg-slate-800/40 border border-slate-700 rounded-lg p-3">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <span class="text-sm font-semibold text-slate-200">${TYPE_LABEL[item.type] || item.type}</span>
            <span class="text-xs text-slate-500 ml-2">Se publica: ${fmtDate(item.scheduled_at)}</span>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="text-xs px-2 py-0.5 rounded-full ${statusCls}">${statusLbl}</span>
            ${item.status === 'changes_requested' ? `<button onclick="Aprobaciones.resendForReview(${item.id})" class="text-xs px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-semibold" title="Ya se corrigió — volver a mandarla al cliente">Reenviar a revisión</button>` : ''}
            ${item.status === 'pending' ? `<button onclick="Aprobaciones.deleteItem(${item.id})" class="text-slate-500 hover:text-rose-400 text-xs" title="Eliminar pieza">🗑</button>` : ''}
          </div>
        </div>
        ${item.caption ? `<p class="text-xs text-slate-400 mt-2 line-clamp-2">${esc(item.caption)}</p>` : ''}
        ${feedback}
      </div>`;
  }

  // ── Agregar pieza ────────────────────────────────────────────────────────
  async function submitNewItem() {
    if (!activeBatch) return;
    const type = document.getElementById('ap-item-type').value;
    const date = document.getElementById('ap-item-date').value;
    const caption = document.getElementById('ap-item-caption').value.trim();
    const mediaRaw = document.getElementById('ap-item-media').value;
    const trelloRaw = document.getElementById('ap-item-trello').value;

    const media = mediaRaw.split('\n').map((s) => s.trim()).filter(Boolean).map((url, i) => ({ url, order: i }));
    if (!media.length) return Utils.showToast('Agrega al menos un link de archivo', 'danger');

    try {
      await Session.apiFetch('api/content_items.php', {
        method: 'POST',
        body: JSON.stringify({
          batch_id: activeBatch.id,
          type,
          caption: caption || null,
          scheduled_at: date ? `${date} 00:00:00` : null,
          media,
          trello_card_id: parseTrelloCardId(trelloRaw),
          position: activeBatch.items.length,
        }),
      });
      document.getElementById('ap-item-caption').value = '';
      document.getElementById('ap-item-media').value = '';
      document.getElementById('ap-item-trello').value = '';
      document.getElementById('ap-add-item-details').open = false;
      Utils.showToast('Pieza agregada', 'success');
      await openBatchModal(activeBatch.id);
      await loadBatches();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // Reenviar a revisión sin crear una tanda nueva: la pieza vuelve a
  // 'pending' y reaparece en el mismo link que ya tiene el cliente (si venció,
  // hay que regenerarlo aparte con el botón de arriba).
  async function resendForReview(id) {
    if (!confirm('¿Reenviar esta pieza a revisión? Volverá a aparecer como pendiente para el cliente.')) return;
    try {
      await Session.apiFetch('api/content_items.php', {
        method: 'PUT',
        body: JSON.stringify({ id, action: 'resend_for_review' }),
      });
      Utils.showToast('Pieza reenviada a revisión', 'success');
      await openBatchModal(activeBatch.id);
      await loadBatches();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function deleteItem(id) {
    if (!confirm('¿Eliminar esta pieza de la tanda?')) return;
    try {
      await Session.apiFetch(`api/content_items.php?id=${id}`, { method: 'DELETE' });
      Utils.showToast('Pieza eliminada', 'success');
      await openBatchModal(activeBatch.id);
      await loadBatches();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // ── Link de revisión ─────────────────────────────────────────────────────
  async function generateLink(batchId, isRegenerate = false) {
    if (isRegenerate && !confirm('Esto invalida el link anterior de esta tanda. ¿Continuar?')) return;
    try {
      const data = await Session.apiFetch('api/content_batches.php', {
        method: 'PUT',
        body: JSON.stringify({ id: batchId, action: 'generate_link' }),
      });
      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      const url = `${base}revisar.html?t=${data.token}`;
      await navigator.clipboard.writeText(url).catch(() => {});
      Utils.showToast('Link generado y copiado al portapapeles', 'success');
      prompt('Link de revisión (ya copiado al portapapeles) — pégalo en el WhatsApp del cliente:', url);
      await openBatchModal(batchId);
      await loadBatches();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // ── Vincular tablero de Trello ───────────────────────────────────────────
  async function openBoardModal() {
    if (!activeClientId) return;
    document.getElementById('ap-modal-board').style.display = 'flex';
    const list = document.getElementById('ap-board-list');
    list.innerHTML = 'Cargando tableros…';
    try {
      const api = getTrelloApi();
      const boards = await api.getBoards();
      if (!boards.length) {
        list.innerHTML = '<p class="text-slate-500 text-sm">No se encontraron tableros.</p>';
        return;
      }
      const linkedId = (activeClient() || {}).trello_board_id;
      list.innerHTML = boards.map((b) => `
        <button type="button" data-board-id="${esc(b.id)}" data-board-name="${esc(b.name)}"
          class="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-slate-800 text-slate-200 flex items-center justify-between">
          <span>${esc(b.name)}</span>
          ${linkedId === b.id ? '<span class="text-emerald-400 text-xs flex-shrink-0">✓ vinculado</span>' : ''}
        </button>`).join('');
    } catch (e) {
      list.innerHTML = `<p class="text-rose-400 text-sm">${esc(e.message)}</p>`;
    }
  }

  function closeBoardModal() {
    document.getElementById('ap-modal-board').style.display = 'none';
  }

  function onBoardListClick(e) {
    const btn = e.target.closest('[data-board-id]');
    if (!btn) return;
    selectBoard(btn.dataset.boardId, btn.dataset.boardName);
  }

  async function selectBoard(boardId, boardName) {
    try {
      await Session.apiFetch('api/clients.php', {
        method: 'PUT',
        body: JSON.stringify({ id: activeClientId, trello_board_id: boardId }),
      });
      const c = activeClient();
      if (c) c.trello_board_id = boardId;
      renderBoardStatus();
      Utils.showToast(`Tablero "${boardName}" vinculado`, 'success');
      closeBoardModal();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // ── Generar tanda automática ─────────────────────────────────────────────
  // batchId: si viene (desde el botón "⚡ Agregar desde Enviado" dentro de una
  // tanda ya existente), las piezas marcadas se agregan a esa tanda en vez de
  // crear una nueva — ver autoCreateBatch().
  function openAutoModal(batchId) {
    autoTargetBatchId = batchId || null;
    const addingToExisting = !!autoTargetBatchId;

    document.getElementById('ap-auto-modal-title').textContent =
      addingToExisting ? 'Agregar piezas desde Enviado' : 'Generar tanda automática';
    document.getElementById('ap-auto-modal-desc').textContent = addingToExisting
      ? 'Busca en el tablero las tarjetas en "Enviado" y las agrega a esta misma tanda.'
      : 'Busca en el tablero las tarjetas en "Enviado" y las cruza con la parrilla del mes elegido.';
    document.getElementById('ap-auto-label-wrap').style.display = addingToExisting ? 'none' : '';
    document.getElementById('ap-auto-create-btn').textContent =
      addingToExisting ? 'Agregar las marcadas' : 'Crear tanda con las marcadas';

    const monthSel = document.getElementById('ap-auto-month');
    const now = new Date();
    monthSel.innerHTML = MONTHS_UPPER.map((m, i) =>
      `<option value="${m}" ${i === now.getMonth() ? 'selected' : ''}>${m.charAt(0) + m.slice(1).toLowerCase()}</option>`
    ).join('');
    document.getElementById('ap-auto-year').value = now.getFullYear();
    document.getElementById('ap-auto-status').textContent = '';
    document.getElementById('ap-auto-results').innerHTML = '';
    document.getElementById('ap-auto-footer').style.display = 'none';
    document.getElementById('ap-auto-label').value = '';
    autoResults = [];
    document.getElementById('ap-modal-auto').style.display = 'flex';
  }

  function closeAutoModal() {
    document.getElementById('ap-modal-auto').style.display = 'none';
    autoTargetBatchId = null;
  }

  async function autoSearch() {
    const client = activeClient();
    if (!client || !client.trello_board_id) return;
    const month = document.getElementById('ap-auto-month').value;
    const statusEl = document.getElementById('ap-auto-status');
    const searchBtn = document.getElementById('ap-auto-search-btn');
    searchBtn.disabled = true;
    statusEl.textContent = 'Buscando tarjetas en "Enviado"…';
    document.getElementById('ap-auto-results').innerHTML = '';
    document.getElementById('ap-auto-footer').style.display = 'none';
    autoResults = [];

    try {
      const api = getTrelloApi();
      const boardId = client.trello_board_id;
      const [lists, cards] = await Promise.all([api.getLists(boardId), api.getCards(boardId)]);
      // Comparación sin distinguir mayúsculas: algunos tableros usan "ENVIADO"
      // todo en mayúsculas en vez de "Enviado" (protocolo-trello.html).
      const enviadoList = lists.find((l) => l.name.trim().toUpperCase() === 'ENVIADO');
      if (!enviadoList) throw new Error('Este tablero no tiene una lista llamada "Enviado"');
      const enviadoCards = cards.filter((c) => c.idList === enviadoList.id && !c.closed);
      if (!enviadoCards.length) {
        statusEl.textContent = 'No hay tarjetas en "Enviado" ahora mismo.';
        return;
      }

      statusEl.textContent = `${enviadoCards.length} tarjeta(s) en Enviado — cruzando con la parrilla de ${month}…`;
      let sheetRows = [];
      let sheetWarning = '';
      try {
        const sheetData = await Session.apiFetch(`api/sheet_import.php?client_id=${client.id}&tab=${encodeURIComponent(month)}`);
        sheetRows = sheetData.rows || [];
      } catch (e) {
        sheetWarning = ` ⚠ No se pudo leer la parrilla (${e.message}) — completa los campos a mano.`;
      }

      // La carpeta "Para aprobación" es externa a ARTES y se vincula por
      // cliente (no por tablero) — ver botón "Vincular / cambiar" junto a
      // Trello/Sheet arriba en la página.
      const approvalFolderId = (client.drive_approval_folder_id || '').trim();
      const driveReady = DriveAPI.isConnected() && !!approvalFolderId;
      let driveWarning = '';
      if (!driveReady) {
        driveWarning = DriveAPI.isConnected()
          ? ' ⚠ Este cliente no tiene carpeta "Para aprobación" vinculada.'
          : ' ⚠ Drive no conectado — ve a Configuración.';
      }

      const results = [];
      for (const card of enviadoCards) {
        const m = card.name.match(/post\s*#?\s*(\d+)/i) || card.name.match(/\b(\d+)\b/);
        const postNumber = m ? parseInt(m[1], 10) : null;
        const row = postNumber ? sheetRows.find((r) => r.post_number === postNumber) : null;

        let files = [];
        let duplicateFolders = null;
        if (driveReady && postNumber) {
          try {
            const found = await DriveAPI.findApprovalMedia(approvalFolderId, postNumber);
            files = found.files || [];
            duplicateFolders = found.duplicateFolders || null;
          } catch (e) { /* sin medios — la CM completa a mano */ }
        }

        let reason = REASON.OK;
        if (duplicateFolders) reason = REASON.DUPLICATE_POST;
        else if (!postNumber) reason = REASON.NO_POST_NUMBER;
        else if (!row) reason = REASON.NO_SHEET_ROW;
        else if (!files.length) reason = REASON.NO_DRIVE;

        results.push({
          cardId: card.id,
          cardName: card.name,
          postNumber,
          type: row ? row.type : 'feed',
          day: row ? row.day : '',
          caption: row ? row.caption : '',
          manualUrl: '',
          files,
          duplicateFolders,
          selectedFileIds: new Set(
            files.length ? (row && row.type === 'carousel' ? files.map((f) => f.id) : [files[0].id]) : []
          ),
          reason,
          selected: reason === REASON.OK,
        });
      }
      autoResults = results;
      statusEl.textContent = `${results.length} tarjeta(s) encontradas — revisa antes de crear la tanda.${sheetWarning}${driveWarning}`;
      renderAutoResults();
      document.getElementById('ap-auto-footer').style.display = 'flex';
      document.getElementById('ap-auto-label').value = `${month.charAt(0) + month.slice(1).toLowerCase()} — Enviado`;
    } catch (e) {
      statusEl.textContent = '';
      Utils.showToast(e.message, 'danger');
    } finally {
      searchBtn.disabled = false;
    }
  }

  function renderAutoResults() {
    const el = document.getElementById('ap-auto-results');
    if (!autoResults.length) { el.innerHTML = ''; return; }
    const BADGE = {
      [REASON.OK]: '<span class="text-xs px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">✓ listo</span>',
      [REASON.NO_SHEET_ROW]: '<span class="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">⚠ sin fila en el Excel</span>',
      [REASON.NO_DRIVE]: '<span class="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">⚠ sin archivo en Drive</span>',
      [REASON.NO_POST_NUMBER]: '<span class="text-xs px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400">⚠ sin # de post en el nombre</span>',
      [REASON.DUPLICATE_POST]: '<span class="text-xs px-2 py-0.5 rounded-full bg-rose-500/15 text-rose-400">⚠ post duplicado en Drive</span>',
    };
    el.innerHTML = autoResults.map((r, i) => {
      const filesHtml = r.duplicateFolders
        ? `<p class="text-xs text-rose-400 mt-2">⚠ Hay ${r.duplicateFolders.length} carpetas para el POST #${r.postNumber} en "Para aprobación": `
          + r.duplicateFolders.map((f) => esc(f.name)).join(', ')
          + '. Corrige el nombre de las carpetas en Drive (debe quedar una sola) antes de crear la tanda.</p>'
        : (r.files.length
          ? `<div class="flex flex-wrap gap-1.5 mt-2">` + r.files.map((f, fi) => `
              <button type="button" draggable="true" data-auto-file="${i}:${esc(f.id)}" title="Arrastrar para reordenar el carrusel"
                class="text-[11px] px-2 py-1 rounded border cursor-move ${r.selectedFileIds.has(f.id) ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-600 text-slate-400'}">
                ${fi + 1}. ${esc(f.name)}
              </button>`).join('') + `</div>`
            + (r.files.length > 1 ? '<p class="text-[10px] text-slate-500 mt-1">Arrastra los archivos para corregir el orden del carrusel si no quedó como 1, 2, 3…</p>' : '')
          : '<p class="text-xs text-slate-500 mt-2">Sin archivos encontrados en Drive.</p>');
      return `
        <div class="bg-slate-800/40 border border-slate-700 rounded-lg p-3">
          <div class="flex items-start gap-3">
            <input type="checkbox" data-auto-select="${i}" ${r.selected ? 'checked' : ''} class="mt-1.5 flex-shrink-0">
            <div class="flex-1 min-w-0">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="text-sm font-semibold text-slate-200">${esc(r.cardName)}</span>
                ${BADGE[r.reason] || ''}
              </div>
              <div class="grid grid-cols-2 gap-2 mt-2">
                <select data-auto-type="${i}" class="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100">
                  ${Object.entries(TYPE_LABEL).map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}
                </select>
                <input type="text" data-auto-day="${i}" value="${esc(r.day)}" placeholder="Día del mes" class="bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100">
              </div>
              <textarea data-auto-caption="${i}" rows="2" placeholder="Copy (vacío si es historia)" class="w-full mt-2 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100">${esc(r.caption)}</textarea>
              <input type="text" data-auto-manual-media="${i}" value="${esc(r.manualUrl)}" placeholder="O pega un link manualmente" class="w-full mt-2 bg-slate-800 border border-slate-600 rounded px-2 py-1.5 text-xs text-slate-100">
              ${filesHtml}
            </div>
          </div>
        </div>`;
    }).join('');
  }

  function onAutoResultsInput(e) {
    const t = e.target;
    if (t.matches('[data-auto-select]')) { autoResults[+t.dataset.autoSelect].selected = t.checked; return; }
    if (t.matches('[data-auto-type]')) { autoResults[+t.dataset.autoType].type = t.value; return; }
    if (t.matches('[data-auto-day]')) { autoResults[+t.dataset.autoDay].day = t.value; return; }
    if (t.matches('[data-auto-caption]')) { autoResults[+t.dataset.autoCaption].caption = t.value; return; }
    if (t.matches('[data-auto-manual-media]')) { autoResults[+t.dataset.autoManualMedia].manualUrl = t.value; return; }
  }

  function onAutoResultsClick(e) {
    const btn = e.target.closest('[data-auto-file]');
    if (!btn) return;
    const raw = btn.dataset.autoFile;
    const sep = raw.indexOf(':');
    const idx = +raw.slice(0, sep);
    const fileId = raw.slice(sep + 1);
    const r = autoResults[idx];
    if (r.selectedFileIds.has(fileId)) r.selectedFileIds.delete(fileId); else r.selectedFileIds.add(fileId);
    renderAutoResults();
  }

  // Reordenar a mano el carrusel por si el auto-orden (número en el nombre
  // del archivo) no coincidió con el orden real — arrastrar un chip de
  // archivo sobre otro los intercambia de posición dentro de esa misma tarjeta.
  function onAutoFileDragStart(e) {
    const btn = e.target.closest('[data-auto-file]');
    if (!btn) return;
    e.dataTransfer.setData('text/plain', btn.dataset.autoFile);
    e.dataTransfer.effectAllowed = 'move';
  }
  function onAutoFileDragOver(e) {
    if (e.target.closest('[data-auto-file]')) e.preventDefault();
  }
  function onAutoFileDrop(e) {
    const targetBtn = e.target.closest('[data-auto-file]');
    if (!targetBtn) return;
    e.preventDefault();
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    const srcSep = raw.indexOf(':');
    const srcIdx = +raw.slice(0, srcSep);
    const srcFileId = raw.slice(srcSep + 1);
    const dstRaw = targetBtn.dataset.autoFile;
    const dstSep = dstRaw.indexOf(':');
    const dstIdx = +dstRaw.slice(0, dstSep);
    const dstFileId = dstRaw.slice(dstSep + 1);
    if (srcIdx !== dstIdx || srcFileId === dstFileId) return;
    const r = autoResults[srcIdx];
    const from = r.files.findIndex((f) => f.id === srcFileId);
    const to = r.files.findIndex((f) => f.id === dstFileId);
    if (from < 0 || to < 0) return;
    const [moved] = r.files.splice(from, 1);
    r.files.splice(to, 0, moved);
    renderAutoResults();
  }

  function buildScheduledAt(day, monthUpper, year) {
    const monthIdx = MONTHS_UPPER.indexOf(monthUpper);
    const d = parseInt(day, 10);
    if (monthIdx < 0 || !d || !year) return null;
    const mm = String(monthIdx + 1).padStart(2, '0');
    const dd = String(d).padStart(2, '0');
    return `${year}-${mm}-${dd} 00:00:00`;
  }

  async function autoCreateBatch() {
    const addingToExisting = !!autoTargetBatchId;
    const label = addingToExisting ? '' : document.getElementById('ap-auto-label').value.trim();
    if (!addingToExisting && !label) return Utils.showToast('Ponle un nombre a la tanda', 'danger');
    const selected = autoResults.filter((r) => r.selected);
    if (!selected.length) return Utils.showToast('Marca al menos una pieza', 'danger');

    const client = activeClient();
    const month = document.getElementById('ap-auto-month').value;
    const year = document.getElementById('ap-auto-year').value;

    try {
      let batchId;
      let startPosition = 0;
      if (addingToExisting) {
        batchId = autoTargetBatchId;
        // Posición siguiente a las piezas que ya tiene la tanda, para no pisar
        // el orden de lo que el cliente ya pudo haber revisado.
        const current = await Session.apiFetch(`api/content_batches.php?id=${batchId}`);
        startPosition = current.batch.items.length;
      } else {
        const batchData = await Session.apiFetch('api/content_batches.php', {
          method: 'POST',
          body: JSON.stringify({ client_id: client.id, label }),
        });
        batchId = batchData.id;
      }

      let created = 0, skipped = 0;
      for (const r of selected) {
        // mimeType se guarda junto al archivo para que revisar.html sepa si es
        // un video (y lo reproduzca con <video> nativo) sin adivinar por la URL.
        const media = r.files.filter((f) => r.selectedFileIds.has(f.id)).map((f) => ({ url: f.webViewLink, mimeType: f.mimeType }));
        if (r.manualUrl && r.manualUrl.trim()) media.push({ url: r.manualUrl.trim() });
        if (!media.length) { skipped++; continue; }
        media.forEach((m, i) => { m.order = i; });
        await Session.apiFetch('api/content_items.php', {
          method: 'POST',
          body: JSON.stringify({
            batch_id: batchId,
            type: r.type,
            post_number: r.postNumber || null,
            caption: r.caption || null,
            scheduled_at: buildScheduledAt(r.day, month, year),
            media,
            trello_card_id: r.cardId,
            position: startPosition + created,
          }),
        });
        created++;
      }
      Utils.showToast(
        addingToExisting
          ? `${created} pieza(s) agregada(s) a la tanda${skipped ? ` — ${skipped} sin medios se omitieron` : ''}`
          : `Tanda creada con ${created} pieza(s)${skipped ? ` — ${skipped} sin medios se omitieron` : ''}`,
        created ? 'success' : 'danger'
      );
      closeAutoModal();
      await loadBatches();
      if (created) await openBatchModal(batchId);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  return {
    init, openNewBatchModal, closeNewBatchModal, submitNewBatch,
    openBatchModal, closeBatchModal, submitNewItem, deleteItem, generateLink, resendForReview,
    openBoardModal, closeBoardModal, selectBoard,
    openAutoModal, closeAutoModal, autoSearch, autoCreateBatch,
  };
})();

window.Aprobaciones = Aprobaciones;
