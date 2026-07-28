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

  let clients = [];
  let batches = [];
  let activeClientId = null;
  let activeBatch = null; // último detalle cargado en el modal

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

  async function init() {
    document.getElementById('ap-client-select').addEventListener('change', onClientChange);
    document.getElementById('ap-new-batch-btn').addEventListener('click', openNewBatchModal);
    await loadClients();
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
    await loadBatches();
  }

  function onClientChange(e) {
    activeClientId = Number(e.target.value);
    loadBatches();
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

  return {
    init, openNewBatchModal, closeNewBatchModal, submitNewBatch,
    openBatchModal, closeBatchModal, submitNewItem, deleteItem, generateLink,
  };
})();

window.Aprobaciones = Aprobaciones;
