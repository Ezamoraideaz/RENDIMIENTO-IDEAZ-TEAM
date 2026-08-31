// Controlador de egresos.html — gastos y préstamos del equipo (superadmin,
// admin y agenda_full/"PM"). Habla con backend/api/expenses.php y
// backend/api/expense_attachments.php usando la misma sesión/CSRF de
// js/session.js. Las subidas de fotos van por fetch directo (multipart),
// igual que importOrganicLeadsFile/onClientLogoFileSelected en
// js/atencionCliente.js, porque Session.apiFetch fuerza JSON.
const Egresos = (() => {
  const API = 'backend';
  let expenses = [];
  let pendingFiles = []; // File[] elegidos en el formulario de creación, antes de subir
  const categorySuggestions = new Set(['Software/Suscripciones', 'Insumos de oficina', 'Viáticos/Transporte', 'Servicios', 'Marketing interno', 'Otro']);
  const ACCOUNTS = ['Nu Bank', 'Bancolombia', 'PayPal'];
  const TYPE_LABEL = { gasto: 'Gasto', prestamo: 'Préstamo' };

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  async function apiMultipart(path, formData, method = 'POST') {
    const res = await fetch(`${API}/${path}`, {
      method,
      credentials: 'include',
      headers: Session.csrf ? { 'X-CSRF-Token': Session.csrf } : {},
      body: formData,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  function _money(amount, currency) {
    const n = Number(amount) || 0;
    const prefix = currency && currency !== 'COP' ? currency + ' ' : '$';
    return prefix + n.toLocaleString('es-CO', { maximumFractionDigits: 0 });
  }

  function _fmtDate(d) {
    if (!d) return '—';
    return new Date(d + 'T00:00:00').toLocaleDateString('es-CO', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function _fmtDateTime(d) {
    if (!d) return '—';
    return new Date(d.replace(' ', 'T')).toLocaleString('es-CO', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function _todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // ── Filtros y listado ────────────────────────────────────────────────────

  function _filters() {
    return {
      date_from: document.getElementById('f-date-from').value,
      date_to: document.getElementById('f-date-to').value,
      type: document.getElementById('f-type').value,
      reimbursement_status: document.getElementById('f-reimbursement').value,
      category: document.getElementById('f-category').value.trim(),
    };
  }

  function _qs(filters) {
    const parts = Object.keys(filters).filter((k) => filters[k]).map((k) => `${k}=${encodeURIComponent(filters[k])}`);
    return parts.length ? `?${parts.join('&')}` : '';
  }

  function _renderCategorySuggestions() {
    document.getElementById('egresos-category-suggestions').innerHTML =
      Array.from(categorySuggestions).sort().map((c) => `<option value="${_esc(c)}">`).join('');
  }

  async function load() {
    const wrap = document.getElementById('egresos-table-wrap');
    wrap.innerHTML = `<p class="text-slate-500 text-sm p-4">Cargando…</p>`;
    try {
      const data = await Session.apiFetch(`api/expenses.php${_qs(_filters())}`);
      expenses = data.expenses || [];
      expenses.forEach((e) => {
        if (e.category) categorySuggestions.add(e.category);
      });
      _renderCategorySuggestions();
      renderTable();
      renderStats();
    } catch (e) {
      wrap.innerHTML = `<p class="text-red-400 text-sm p-4">${_esc(e.message)}</p>`;
    }
  }

  function renderStats() {
    const ym = _todayISO().slice(0, 7);
    const gastosMes = expenses
      .filter((e) => e.type === 'gasto' && (e.expense_date || '').startsWith(ym))
      .reduce((sum, e) => sum + e.amount, 0);
    const prestamosPendientes = expenses
      .filter((e) => e.type === 'prestamo' && e.reimbursement_status === 'pendiente')
      .reduce((sum, e) => sum + e.amount, 0);
    document.getElementById('stat-gastos-mes').textContent = _money(gastosMes, 'COP');
    document.getElementById('stat-prestamos-pendientes').textContent = _money(prestamosPendientes, 'COP');
  }

  function _statusBadge(e) {
    if (e.type !== 'prestamo') return '<span class="text-slate-600">—</span>';
    return e.reimbursement_status === 'reembolsado'
      ? `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400">Reembolsado</span>`
      : `<span class="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-400">Pendiente</span>`;
  }

  function renderTable() {
    const wrap = document.getElementById('egresos-table-wrap');
    document.getElementById('egresos-count').textContent = `${expenses.length} egreso(s)`;
    if (!expenses.length) {
      wrap.innerHTML = `<p class="text-slate-500 text-sm p-4">Sin egresos registrados con estos filtros.</p>`;
      return;
    }
    wrap.innerHTML = `
      <table class="w-full text-sm">
        <thead class="bg-slate-900">
          <tr class="text-left text-slate-500 border-b border-slate-800">
            <th class="py-2.5 px-4">Fecha</th>
            <th class="py-2.5 px-4">Tipo</th>
            <th class="py-2.5 px-4">Categoría</th>
            <th class="py-2.5 px-4">Concepto</th>
            <th class="py-2.5 px-4">Cuenta</th>
            <th class="py-2.5 px-4 text-right">Monto</th>
            <th class="py-2.5 px-4">Estado</th>
            <th class="py-2.5 px-4"></th>
          </tr>
        </thead>
        <tbody>
          ${expenses.map((e) => `
            <tr class="border-b border-slate-800/60 hover:bg-slate-900/60 cursor-pointer" onclick="Egresos.openDetail(${e.id})">
              <td class="py-2 px-4 text-slate-400 whitespace-nowrap">${_fmtDate(e.expense_date)}</td>
              <td class="py-2 px-4 whitespace-nowrap">${TYPE_LABEL[e.type] || e.type}</td>
              <td class="py-2 px-4 text-slate-400">${_esc(e.category || '—')}</td>
              <td class="py-2 px-4 max-w-[280px] truncate">${_esc(e.concept)}</td>
              <td class="py-2 px-4 text-slate-400">${_esc(e.account || '—')}</td>
              <td class="py-2 px-4 text-right font-semibold whitespace-nowrap">${_money(e.amount, e.currency)}</td>
              <td class="py-2 px-4">${_statusBadge(e)}</td>
              <td class="py-2 px-4 text-right text-slate-500 whitespace-nowrap">${e.attachment_count ? `📎 ${e.attachment_count}` : ''}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  }

  function bindFilters() {
    ['f-date-from', 'f-date-to', 'f-type', 'f-reimbursement'].forEach((id) => {
      document.getElementById(id).addEventListener('change', load);
    });
    let categoryTimer;
    document.getElementById('f-category').addEventListener('input', () => {
      clearTimeout(categoryTimer);
      categoryTimer = setTimeout(load, 400);
    });
    document.getElementById('f-clear').addEventListener('click', () => {
      ['f-date-from', 'f-date-to', 'f-type', 'f-reimbursement', 'f-category'].forEach((id) => { document.getElementById(id).value = ''; });
      load();
    });
  }

  async function init() {
    bindFilters();
    await load();
  }

  // ── Crear / editar ───────────────────────────────────────────────────────

  function _memberNameOptions() {
    try {
      const names = Object.values(Storage.getAllMemberNames());
      return Array.from(new Set(names)).map((n) => `<option value="${_esc(n)}">`).join('');
    } catch (_) {
      return '';
    }
  }

  function openForm(editId = null) {
    const editing = editId ? expenses.find((e) => e.id === editId) : null;
    pendingFiles = [];

    document.body.insertAdjacentHTML('beforeend', `
      <div id="expense-form-overlay" onclick="Egresos._overlayClose(event, 'expense-form-overlay')" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-700 flex items-center justify-between flex-shrink-0">
            <h2 class="font-bold text-slate-100 text-lg">${editing ? 'Editar egreso' : 'Registrar egreso'}</h2>
            <button onclick="Egresos._closeForm()" class="text-slate-400 hover:text-slate-100 text-2xl leading-none">&times;</button>
          </div>
          <form id="expense-form" class="overflow-y-auto flex-1 px-6 py-4 space-y-3">
            <div class="grid grid-cols-2 gap-3">
              <label class="text-xs text-slate-400">Fecha
                <input type="date" id="ef-date" required value="${_esc(editing ? editing.expense_date : _todayISO())}"
                  class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
              </label>
              <label class="text-xs text-slate-400">Tipo
                <select id="ef-type" onchange="Egresos._toggleLoanFields()" class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
                  <option value="gasto" ${editing && editing.type === 'gasto' ? 'selected' : ''}>Gasto</option>
                  <option value="prestamo" ${editing && editing.type === 'prestamo' ? 'selected' : ''}>Préstamo (repone alguien del equipo)</option>
                </select>
              </label>
            </div>
            <label class="text-xs text-slate-400 block">Concepto
              <input type="text" id="ef-concept" required placeholder="¿Qué se compró/pagó?" value="${_esc(editing ? editing.concept : '')}"
                class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="text-xs text-slate-400">Categoría
                <input type="text" id="ef-category" list="egresos-category-suggestions" value="${_esc(editing ? editing.category : '')}"
                  class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
              </label>
              <label class="text-xs text-slate-400">Cuenta
                <select id="ef-account" required class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
                  <option value="" disabled ${editing && editing.account ? '' : 'selected'}>Selecciona...</option>
                  ${ACCOUNTS.map((a) => `<option value="${_esc(a)}" ${editing && editing.account === a ? 'selected' : ''}>${_esc(a)}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="text-xs text-slate-400 block">Monto (COP)
              <input type="number" id="ef-amount" required min="1" step="1" value="${editing ? editing.amount : ''}"
                class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
            </label>
            <div id="ef-loan-fields" class="grid grid-cols-2 gap-3" style="display:${editing && editing.type === 'prestamo' ? '' : 'none'}">
              <label class="text-xs text-slate-400">¿Quién puso el dinero?
                <input type="text" id="ef-paid-by" list="egresos-member-suggestions" value="${_esc(editing ? editing.paid_by_name : '')}"
                  class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
                <datalist id="egresos-member-suggestions">${_memberNameOptions()}</datalist>
              </label>
              <label class="text-xs text-slate-400">Estado
                <select id="ef-reimbursement" class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm">
                  <option value="pendiente" ${!editing || editing.reimbursement_status === 'pendiente' ? 'selected' : ''}>Pendiente</option>
                  <option value="reembolsado" ${editing && editing.reimbursement_status === 'reembolsado' ? 'selected' : ''}>Reembolsado</option>
                </select>
              </label>
            </div>
            <label class="text-xs text-slate-400 block">Notas
              <textarea id="ef-notes" rows="2" class="mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm resize-y">${_esc(editing ? editing.notes : '')}</textarea>
            </label>
            ${editing ? '' : `
            <div>
              <p class="text-xs text-slate-400 mb-1.5">Fotos del recibo/factura (opcional, varias)</p>
              <input type="file" id="ef-files" accept="image/png,image/jpeg,image/webp" multiple
                class="text-xs text-slate-400 file:mr-2 file:bg-slate-800 file:border file:border-slate-700 file:text-slate-200 file:rounded-lg file:px-3 file:py-1.5 file:text-xs file:font-semibold file:cursor-pointer">
              <div id="ef-file-previews" class="flex flex-wrap gap-2 mt-2"></div>
            </div>`}
            <p id="expense-form-error" style="display:none" class="text-sm text-red-400 bg-red-950/40 border border-red-800/50 rounded-lg px-3 py-2"></p>
          </form>
          <div class="px-6 py-4 border-t border-slate-700 flex-shrink-0 flex justify-end gap-2">
            <button onclick="Egresos._closeForm()" class="px-4 py-2 rounded-lg text-sm font-semibold text-slate-300 hover:bg-slate-800">Cancelar</button>
            <button id="expense-form-submit" onclick="Egresos._submitForm(${editing ? editing.id : 'null'})" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold">${editing ? 'Guardar cambios' : 'Registrar'}</button>
          </div>
        </div>
      </div>`);

    if (!editing) {
      document.getElementById('ef-files').addEventListener('change', _onFilesSelected);
    }
  }

  function _toggleLoanFields() {
    const type = document.getElementById('ef-type').value;
    document.getElementById('ef-loan-fields').style.display = type === 'prestamo' ? '' : 'none';
  }

  function _onFilesSelected(e) {
    const MAX_FILES = 10;
    const MAX_MB = 20;
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    picked.forEach((file) => {
      if (pendingFiles.length >= MAX_FILES) return;
      if (file.size > MAX_MB * 1024 * 1024) {
        Utils.showToast(`"${file.name}" pesa más de ${MAX_MB} MB — no se adjuntó`, 'warning');
        return;
      }
      pendingFiles.push(file);
    });
    _renderFilePreviews();
  }

  function _renderFilePreviews() {
    const wrap = document.getElementById('ef-file-previews');
    if (!wrap) return;
    wrap.innerHTML = pendingFiles.map((file, i) => `
      <div class="relative w-16 h-16 rounded-lg overflow-hidden border border-slate-700">
        <img src="${URL.createObjectURL(file)}" class="w-full h-full object-cover">
        <button type="button" onclick="Egresos._removePendingFile(${i})" class="absolute top-0 right-0 bg-black/70 text-white text-xs w-5 h-5 flex items-center justify-center">✕</button>
      </div>`).join('');
  }

  function _removePendingFile(i) {
    pendingFiles.splice(i, 1);
    _renderFilePreviews();
  }

  function _closeForm() {
    document.getElementById('expense-form-overlay')?.remove();
    pendingFiles = [];
  }

  function _overlayClose(e, overlayId) {
    if (e.target.id === overlayId) document.getElementById(overlayId)?.remove();
  }

  async function _submitForm(editId) {
    const errEl = document.getElementById('expense-form-error');
    errEl.style.display = 'none';
    const btn = document.getElementById('expense-form-submit');

    const type = document.getElementById('ef-type').value;
    const payload = {
      expense_date: document.getElementById('ef-date').value,
      type,
      concept: document.getElementById('ef-concept').value.trim(),
      category: document.getElementById('ef-category').value.trim(),
      account: document.getElementById('ef-account').value.trim(),
      amount: document.getElementById('ef-amount').value,
      notes: document.getElementById('ef-notes').value.trim(),
    };
    if (type === 'prestamo') {
      payload.paid_by_name = document.getElementById('ef-paid-by').value.trim();
      payload.reimbursement_status = document.getElementById('ef-reimbursement').value;
    }

    if (!payload.expense_date || !payload.concept || !payload.amount) {
      errEl.textContent = 'Completa fecha, concepto y monto.';
      errEl.style.display = '';
      return;
    }

    btn.disabled = true;
    btn.textContent = editId ? 'Guardando…' : 'Registrando…';
    try {
      if (editId) {
        await Session.apiFetch('api/expenses.php', { method: 'PUT', body: JSON.stringify(Object.assign({ id: editId }, payload)) });
        Utils.showToast('Egreso actualizado', 'success');
      } else {
        const formData = new FormData();
        Object.keys(payload).forEach((k) => formData.append(k, payload[k]));
        pendingFiles.forEach((file) => formData.append('files[]', file, file.name));
        await apiMultipart('api/expenses.php', formData);
        Utils.showToast('Egreso registrado', 'success');
      }
      _closeForm();
      await load();
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = '';
      btn.disabled = false;
      btn.textContent = editId ? 'Guardar cambios' : 'Registrar';
    }
  }

  // ── Detalle / adjuntos ───────────────────────────────────────────────────

  async function openDetail(id) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="expense-detail-overlay" onclick="Egresos._overlayClose(event, 'expense-detail-overlay')" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-700 flex items-center justify-between flex-shrink-0">
            <h2 class="font-bold text-slate-100 text-lg">Detalle del egreso</h2>
            <button onclick="document.getElementById('expense-detail-overlay').remove()" class="text-slate-400 hover:text-slate-100 text-2xl leading-none">&times;</button>
          </div>
          <div id="expense-detail-body" class="overflow-y-auto flex-1 px-6 py-4">
            <p class="text-slate-500 text-sm">Cargando…</p>
          </div>
        </div>
      </div>`);
    await _refreshDetail(id);
  }

  async function _refreshDetail(id) {
    const body = document.getElementById('expense-detail-body');
    try {
      const data = await Session.apiFetch(`api/expenses.php?id=${id}&detail=1`);
      body.innerHTML = _renderDetail(data.expense, data.attachments || []);
    } catch (e) {
      body.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  function _renderDetail(e, attachments) {
    const isLoanPending = e.type === 'prestamo' && e.reimbursement_status === 'pendiente';
    return `
      <div class="flex items-center justify-between mb-1">
        <h3 class="font-bold text-slate-100 text-lg">${_esc(e.concept)}</h3>
        ${_statusBadge(e)}
      </div>
      <p class="text-xs text-slate-500 mb-4">${_fmtDate(e.expense_date)} · ${TYPE_LABEL[e.type] || e.type}${e.category ? ' · ' + _esc(e.category) : ''}</p>

      <div class="grid grid-cols-2 gap-3 text-sm mb-4">
        <div><p class="text-xs text-slate-500">Monto</p><p class="font-semibold text-slate-100">${_money(e.amount, e.currency)}</p></div>
        <div><p class="text-xs text-slate-500">Cuenta</p><p class="text-slate-200">${_esc(e.account || '—')}</p></div>
        ${e.type === 'prestamo' ? `
        <div><p class="text-xs text-slate-500">Quién pagó</p><p class="text-slate-200">${_esc(e.paid_by_name || '—')}</p></div>
        <div><p class="text-xs text-slate-500">Reembolsado</p><p class="text-slate-200">${e.reimbursed_at ? _fmtDateTime(e.reimbursed_at) : '—'}</p></div>` : ''}
      </div>

      ${e.notes ? `<div class="mb-4"><p class="text-xs text-slate-500 mb-0.5">Notas</p><p class="text-sm text-slate-300 whitespace-pre-wrap">${_esc(e.notes)}</p></div>` : ''}

      <div class="mb-4">
        <div class="flex items-center justify-between mb-2">
          <p class="text-xs text-slate-500">Fotos (${attachments.length})</p>
          <button onclick="Egresos._triggerAddAttachments(${e.id})" class="text-xs font-semibold text-indigo-400 hover:text-indigo-300">+ Agregar fotos</button>
          <input type="file" id="detail-file-input" accept="image/png,image/jpeg,image/webp" multiple style="display:none" onchange="Egresos._addAttachments(${e.id}, event)">
        </div>
        <div class="grid grid-cols-4 gap-2">
          ${attachments.map((a) => `
            <div class="relative group">
              <img src="${API}/api/expense_attachment.php?id=${a.id}" onclick="Egresos._openLightbox(${a.id})"
                class="w-full aspect-square object-cover rounded-lg border border-slate-700 cursor-pointer">
              <button onclick="Egresos._deleteAttachment(${e.id}, ${a.id})" title="Quitar"
                class="absolute top-1 right-1 bg-black/70 text-white text-xs w-5 h-5 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">✕</button>
            </div>`).join('') || '<p class="text-slate-600 text-xs col-span-4">Sin fotos adjuntas.</p>'}
        </div>
      </div>

      <div class="flex flex-wrap gap-2 pt-2 border-t border-slate-800">
        ${isLoanPending ? `<button onclick="Egresos._markReimbursed(${e.id})" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold">✅ Marcar como reembolsado</button>` : ''}
        <button onclick="document.getElementById('expense-detail-overlay').remove(); Egresos.openForm(${e.id})" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-semibold">✏️ Editar</button>
        <button onclick="Egresos._deleteExpense(${e.id})" class="bg-slate-800 hover:bg-red-900/40 border border-red-700/50 text-red-400 px-3 py-1.5 rounded-lg text-xs font-semibold">🗑️ Eliminar</button>
      </div>`;
  }

  function _triggerAddAttachments() {
    document.getElementById('detail-file-input').click();
  }

  async function _addAttachments(expenseId, e) {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const formData = new FormData();
    formData.append('expense_id', expenseId);
    files.forEach((file) => formData.append('files[]', file, file.name));
    try {
      await apiMultipart('api/expense_attachments.php', formData);
      Utils.showToast('Fotos agregadas', 'success');
      await _refreshDetail(expenseId);
      await load();
    } catch (err) {
      Utils.showToast(err.message, 'danger');
    }
  }

  async function _deleteAttachment(expenseId, attachmentId) {
    if (!confirm('¿Quitar esta foto?')) return;
    try {
      await Session.apiFetch(`api/expense_attachments.php?id=${attachmentId}&expense_id=${expenseId}`, { method: 'DELETE' });
      await _refreshDetail(expenseId);
      await load();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  function _openLightbox(attachmentId) {
    document.body.insertAdjacentHTML('beforeend', `
      <div id="expense-lightbox" onclick="document.getElementById('expense-lightbox').remove()"
        class="fixed inset-0 bg-black/90 z-[60] flex items-center justify-center p-6 cursor-zoom-out">
        <img src="${API}/api/expense_attachment.php?id=${attachmentId}" class="max-w-full max-h-full rounded-lg">
      </div>`);
  }

  async function _markReimbursed(id) {
    try {
      await Session.apiFetch('api/expenses.php', { method: 'PUT', body: JSON.stringify({ id, reimbursement_status: 'reembolsado' }) });
      Utils.showToast('Marcado como reembolsado', 'success');
      await _refreshDetail(id);
      await load();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function _deleteExpense(id) {
    if (!confirm('¿Eliminar este egreso? Esta acción no se puede deshacer.')) return;
    try {
      await Session.apiFetch(`api/expenses.php?id=${id}`, { method: 'DELETE' });
      document.getElementById('expense-detail-overlay')?.remove();
      Utils.showToast('Egreso eliminado', 'success');
      await load();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  return {
    init, load, openForm, openDetail,
    _toggleLoanFields, _removePendingFile, _closeForm, _overlayClose, _submitForm,
    _triggerAddAttachments, _addAttachments, _deleteAttachment, _openLightbox,
    _markReimbursed, _deleteExpense,
  };
})();

window.Egresos = Egresos;
