// Asistente "Configurar cliente": un solo lugar, en orden, con verificación de cada paso.
// Backend: backend/api/client_setup.php (checklist + verificaciones en vivo + escrituras de cada paso).
// Logo: backend/api/client_logo_upload.php. Facebook: backend/oauth/facebook_connect.php?return=asistente.
const ClienteSetup = (() => {
  let clients = [];
  let activeId = null;
  let state = null;           // respuesta de GET client_setup.php?client_id=
  let live = {};              // item key -> {pending} | {ok, message, ...} (verificaciones en vivo)
  let openStep = null;
  let drafts = {};            // id de input -> valor sin guardar (sobrevive a los repintados)
  let boards = null;          // tableros de Trello (se piden una sola vez)
  let pautaPick = null;       // cliente de Pauta elegido para vincular (o 'new')
  let showNewForm = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (path, options) => Session.apiFetch(path, options);
  const post = (body) => api('api/client_setup.php', { method: 'POST', body: JSON.stringify(body) });
  const toast = (m, t = 'info') => Utils.showToast(m, t);
  const canAtencion = () => Session.canView('atencion-cliente');

  // Pasos en el orden en que deben hacerse. `items` = claves del checklist que cubre cada paso.
  const STEPS = [
    { id: 'datos',    title: 'Datos de la marca',              hint: 'Logo y contexto para la IA',                                items: ['logo', 'ai_context'] },
    { id: 'trello',   title: 'Tablero de Trello',              hint: 'Vínculo, listas del protocolo y tarifas del equipo',        items: ['trello', 'trello_lists', 'trello_members'] },
    { id: 'proyecto', title: 'Datos del proyecto',             hint: 'Tipo, presupuesto, ingreso y horas para costos y rentabilidad', items: ['project'] },
    { id: 'sheet',    title: 'Cronograma (Google Sheet)',      hint: 'Una pestaña por mes; lo leen la tanda automática y el revisor', items: ['sheet'] },
    { id: 'drive',    title: 'Carpetas de Drive',              hint: '«Para aprobación» y ARTES, ambas como Editor',               items: ['approval_folder', 'artes_folder'] },
    { id: 'telegram', title: 'Telegram (revisor de piezas)',   hint: 'Grupo de la marca + quién es CM y PM',                       items: ['telegram_group', 'telegram_roles'] },
    { id: 'meta',     title: 'Facebook e Instagram',           hint: 'Cuenta para mensajes, comentarios y leads',                  items: ['meta_facebook', 'meta_instagram'] },
    { id: 'flujos',   title: 'Flujos, leads y brief',          hint: 'Respuestas automáticas, aviso de leads y brief del cliente', items: ['flows', 'lead_emails', 'lead_portal', 'brief'] },
    { id: 'pauta',    title: 'Pauta (inversión publicitaria)', hint: 'Cuenta publicitaria para leer gasto y generar reportes',     items: ['pauta'] },
  ];
  // Verificación en vivo → item del checklist al que corresponde.
  const LIVE_CHECKS = { trello_lists: 'trello_lists', trello_members: 'trello_members', sheet: 'sheet', approval_folder: 'approval_folder', artes_folder: 'artes_folder', telegram: 'telegram_group' };

  const STATUS_UI = {
    ok:      { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Listo' },
    warn:    { dot: 'bg-amber-400',   text: 'text-amber-400',   label: 'Revisar' },
    missing: { dot: 'bg-rose-400',    text: 'text-rose-400',    label: 'Falta' },
  };

  const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 disabled:opacity-50';
  const btnCls = 'bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50 whitespace-nowrap';
  const btn2Cls = 'bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold px-4 py-2 rounded-lg whitespace-nowrap';

  function item(key) { return (state?.items || []).find((i) => i.key === key); }

  // Estado efectivo: la verificación en vivo (si ya corrió) manda sobre lo guardado en BD.
  function effective(key) {
    const it = item(key);
    if (!it) return 'missing';
    const r = live[key];
    if (it.live) return it.status === 'missing' ? 'missing' : (r && r.ok ? 'ok' : 'warn');
    if (it.status === 'ok' && r && !r.pending) return r.ok ? 'ok' : 'warn';
    return it.status;
  }

  function stepStatus(step) {
    if (step.items.some((k) => item(k)?.required && effective(k) === 'missing')) return 'missing';
    return step.items.some((k) => effective(k) !== 'ok') ? 'warn' : 'ok';
  }
  // Un paso está "completo" si todo lo obligatorio está listo (los opcionales no frenan el avance).
  const stepDone = (step) => step.items.every((k) => !item(k)?.required || effective(k) === 'ok');
  const nextPending = (afterId) => {
    const from = afterId ? STEPS.findIndex((s) => s.id === afterId) + 1 : 0;
    return [...STEPS.slice(from), ...STEPS.slice(0, from)].find((s) => !stepDone(s)) || null;
  };

  // ───────────────────────── carga

  async function init() {
    Icons.hydrate(document.body);
    $('cs-client-select').addEventListener('change', (e) => selectClient(Number(e.target.value) || null));
    $('cs-new-client').addEventListener('click', () => { showNewForm = !showNewForm; if (activeId) selectClient(null); else renderOverview(); });
    $('cs-refresh').addEventListener('click', () => (activeId ? reload({ runLive: true }) : loadOverview()));
    await loadClients();

    const params = new URLSearchParams(location.search);
    const fromUrl = Number(params.get('client_id')) || null;
    const fromOAuth = params.has('oauth_select_page') || params.has('oauth_error');
    if (params.get('oauth_error')) toast('Error al conectar Facebook: ' + params.get('oauth_error'), 'danger');
    if (params.toString()) history.replaceState({}, '', 'configurar-cliente.html');

    if (fromUrl && clients.some((c) => c.id === fromUrl)) {
      await selectClient(fromUrl, fromOAuth ? 'meta' : null);
      if (params.get('oauth_select_page')) showPagePicker();
    } else {
      await loadOverview();
    }
  }

  async function loadClients() {
    try {
      clients = (await api('api/client_setup.php?list=1')).clients;
    } catch (e) {
      toast(e.message, 'danger');
      clients = [];
    }
    const sel = $('cs-client-select');
    sel.innerHTML = '<option value="">Todas las marcas (resumen)</option>' +
      clients.map((c) => `<option value="${c.id}">${esc(c.name)}${c.status === 'archived' ? ' (archivada)' : ''}</option>`).join('');
    sel.value = activeId ? String(activeId) : '';
  }

  // ───────────────────────── resumen de todas las marcas

  let overview = null;

  async function loadOverview() {
    $('cs-steps').innerHTML = '';
    $('cs-summary').classList.add('hidden');
    $('cs-empty').classList.remove('hidden');
    $('cs-empty').innerHTML = '<p class="text-slate-500 text-sm">Cargando marcas…</p>';
    try {
      overview = (await api('api/client_setup.php?overview=1')).clients;
    } catch (e) {
      overview = [];
      toast(e.message, 'danger');
    }
    renderOverview();
  }

  function renderOverview() {
    const box = $('cs-empty');
    box.classList.remove('hidden');
    const list = overview || [];
    const incomplete = list.filter((c) => c.done < c.total).length;
    box.innerHTML = `
      ${showNewForm ? `
        <div class="bg-slate-900 border border-indigo-500/60 rounded-2xl p-4 mb-4">
          <label class="text-xs text-slate-400 block mb-1">Nombre de la marca nueva</label>
          <div class="flex gap-2">
            <input id="cs-new-name" class="${inputCls}" placeholder="Ej. Clínica Dental Sonríe" maxlength="150">
            <button id="cs-new-save" class="${btnCls}">Crear y configurar</button>
          </div>
          <p class="text-xs text-slate-500 mt-2">Si la marca ya existe (aunque esté escrita distinto), el sistema te avisa para no duplicarla.</p>
        </div>` : ''}
      ${list.length ? `
        <p class="text-sm text-slate-400 mb-3">${incomplete ? `<b class="text-amber-300">${incomplete}</b> de ${list.length} marcas tienen configuración pendiente.` : 'Todas las marcas tienen lo obligatorio configurado.'}</p>
        <div class="grid sm:grid-cols-2 gap-3">
          ${list.map((c) => {
            const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
            return `
            <button type="button" data-open-client="${c.id}" class="text-left bg-slate-900 border border-slate-700 hover:border-indigo-500/60 rounded-2xl p-4">
              <span class="flex items-center gap-3">
                ${c.logo_url ? `<img src="${esc(c.logo_url)}" class="w-9 h-9 rounded-lg object-cover bg-slate-800" alt="">` : '<span class="w-9 h-9 rounded-lg bg-slate-800 flex-shrink-0"></span>'}
                <span class="flex-1 min-w-0">
                  <span class="block font-semibold text-slate-100 truncate">${esc(c.name)}</span>
                  <span class="block text-xs ${pct === 100 ? 'text-emerald-400' : 'text-slate-400'}">${pct === 100 ? 'Completa' : `Faltan ${c.total - c.done}`}</span>
                </span>
                <span class="text-lg font-extrabold ${pct === 100 ? 'text-emerald-400' : 'text-slate-200'}">${pct}%</span>
              </span>
              <span class="block h-1.5 bg-slate-800 rounded-full overflow-hidden mt-3"><span class="block h-1.5 ${pct === 100 ? 'bg-emerald-500' : 'bg-indigo-500'} rounded-full" style="width:${pct}%"></span></span>
              ${c.missing.length ? `<span class="block text-[11px] text-slate-500 mt-2 truncate">${esc(c.missing.slice(0, 3).join(' · '))}${c.missing.length > 3 ? '…' : ''}</span>` : ''}
            </button>`;
          }).join('')}
        </div>` : '<p class="text-slate-500 text-sm">Aún no hay marcas. Crea la primera con «Nuevo cliente».</p>'}`;

    box.querySelectorAll('[data-open-client]').forEach((b) => b.addEventListener('click', () => selectClient(Number(b.dataset.openClient))));
    const save = $('cs-new-save');
    if (save) {
      const name = $('cs-new-name');
      name.focus();
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') createClient(); });
      save.addEventListener('click', createClient);
    }
  }

  async function createClient() {
    const name = ($('cs-new-name').value || '').trim();
    if (!name) return toast('Escribe el nombre de la marca', 'danger');
    $('cs-new-save').disabled = true;
    try {
      const res = await post({ action: 'create_client', name });
      showNewForm = false;
      await loadClients();
      await selectClient(res.id);
      toast(`Marca «${name}» creada — sigue los pasos en orden`, 'success');
    } catch (e) {
      toast(e.message, 'danger');
      $('cs-new-save').disabled = false;
    }
  }

  // ───────────────────────── una marca

  async function selectClient(id, step = null) {
    activeId = id;
    live = {};
    state = null;
    drafts = {};
    pautaPick = null;
    openStep = step;
    $('cs-client-select').value = id ? String(id) : '';
    if (!id) return loadOverview();
    $('cs-empty').classList.add('hidden');
    $('cs-steps').innerHTML = '<p class="text-slate-500 text-sm">Cargando…</p>';
    await reload({ runLive: true });
  }

  // opts.runLive: correr verificaciones · opts.fresh: mostrar lo guardado en vez de lo escrito en el paso abierto
  // · opts.saved: fresh + si el paso quedó completo, abrir el siguiente pendiente.
  async function reload(opts = {}) {
    try {
      state = await api(`api/client_setup.php?client_id=${activeId}`);
    } catch (e) {
      toast(e.message, 'danger');
      return;
    }
    if (!openStep) openStep = nextPending(null)?.id || null;
    render({ fresh: !!(opts.saved || opts.fresh) });
    if (opts.runLive) await runLiveChecks();
    if (opts.saved) advanceIfDone();
  }

  // Al volver de Facebook: si la cuenta administra varias Páginas, se elige cuál es de esta marca.
  async function showPagePicker() {
    try {
      const data = await api('api/oauth_pages.php');
      if (!data.pages.length) return toast('No hay páginas pendientes de selección', 'danger');
      const rows = data.pages.map((p) => `
        <button type="button" data-page="${esc(p.id)}" class="w-full text-left bg-slate-800/60 border border-slate-700/60 hover:border-indigo-500 rounded-lg px-4 py-3">
          <span class="block text-sm font-semibold text-slate-100">${esc(p.name)}</span>
          <span class="block text-xs ${p.has_instagram ? 'text-slate-400' : 'text-amber-300'}">${p.has_instagram ? 'Instagram @' + esc(p.instagram_username || '') + ' vinculado' : 'Sin Instagram vinculado a esta Página'}</span>
        </button>`).join('');
      document.body.insertAdjacentHTML('beforeend', `
        <div id="cs-page-picker" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6">
            <h3 class="font-bold text-lg mb-1">¿Cuál es la Página de ${esc(state?.client?.name || 'esta marca')}?</h3>
            <p class="text-xs text-slate-500 mb-4">Tu cuenta de Facebook administra varias Páginas: elige solo la de esta marca.</p>
            <div class="flex flex-col gap-2 max-h-96 overflow-y-auto">${rows}</div>
            <button type="button" id="cs-page-cancel" class="${btn2Cls} mt-4 w-full">Cancelar</button>
          </div>
        </div>`);
      $('cs-page-cancel').addEventListener('click', () => $('cs-page-picker').remove());
      $('cs-page-picker').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-page]');
        if (!b) return;
        b.disabled = true;
        try {
          const res = await api('api/oauth_pages.php', { method: 'POST', body: JSON.stringify({ page_id: b.dataset.page }) });
          $('cs-page-picker').remove();
          toast(res.webhook_warning || 'Cuenta conectada correctamente', res.webhook_warning ? 'danger' : 'success');
          await reload({ saved: true });
        } catch (err) {
          b.disabled = false;
          toast(err.message, 'danger');
        }
      });
    } catch (e) {
      toast(e.message, 'danger');
    }
  }

  function advanceIfDone() {
    const cur = STEPS.find((s) => s.id === openStep);
    if (!cur || !stepDone(cur)) return;
    const next = nextPending(cur.id);
    openStep = next ? next.id : null;
    render();
    if (next) document.querySelector(`[data-step="${next.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else toast('¡Todo lo obligatorio de esta marca está configurado!', 'success');
  }

  async function runLiveChecks(only = null) {
    const keys = only || [
      ...(item('trello')?.status === 'ok' ? ['trello_lists', 'trello_members'] : []),
      ...(item('sheet')?.status === 'ok' ? ['sheet'] : []),
      ...(item('approval_folder')?.status === 'ok' ? ['approval_folder'] : []),
      ...(item('artes_folder')?.status === 'ok' ? ['artes_folder'] : []),
      'telegram',
    ];
    keys.forEach((k) => { live[LIVE_CHECKS[k]] = { pending: true }; });
    render();
    const forClient = activeId;
    await Promise.all(keys.map(async (k) => {
      let res;
      try {
        res = await api(`api/client_setup.php?client_id=${forClient}&check=${k}`);
      } catch (e) {
        res = { ok: false, message: e.message };
      }
      if (activeId === forClient) live[LIVE_CHECKS[k]] = res; // se cambió de marca mientras tanto
    }));
    if (activeId === forClient) render();
  }

  // ───────────────────────── borradores (lo escrito no se pierde al repintar)

  function snapshotDrafts() {
    document.querySelectorAll('#cs-steps input[id], #cs-steps textarea[id], #cs-steps select[id]').forEach((el) => {
      if (el.type === 'file') return;
      drafts[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    });
  }

  function restoreDrafts() {
    Object.entries(drafts).forEach(([id, v]) => {
      const el = $(id);
      if (!el || el.disabled) return;
      if (el.type === 'checkbox') el.checked = v;
      else if (el.tagName !== 'SELECT' || [...el.options].some((o) => o.value === v)) el.value = v;
    });
  }

  function dropOpenStepDrafts() {
    document.querySelectorAll(`[data-step="${openStep}"] [id]`).forEach((el) => { delete drafts[el.id]; });
  }

  // ───────────────────────── render

  function render(opts = {}) {
    if (!state) return;
    const focused = document.activeElement?.closest('#cs-steps') ? document.activeElement : null;
    const focus = focused && !opts.fresh ? { id: focused.id, start: focused.selectionStart, end: focused.selectionEnd } : null;
    snapshotDrafts();
    if (opts.fresh) dropOpenStepDrafts();

    const required = state.items.filter((i) => i.required);
    const done = required.filter((i) => effective(i.key) === 'ok').length;
    const pct = required.length ? Math.round((done / required.length) * 100) : 0;
    const c = state.client;

    // Pendientes en el orden de los pasos; cada uno abre su paso al hacer clic.
    const pending = STEPS.flatMap((s) => s.items.map((k) => ({ step: s.id, it: item(k) })))
      .filter(({ it }) => it && it.required && effective(it.key) !== 'ok');

    $('cs-summary').classList.remove('hidden');
    $('cs-summary').innerHTML = `
      <div class="flex items-center gap-3 mb-2">
        ${c.logo_url ? `<img src="${esc(c.logo_url)}" class="w-10 h-10 rounded-lg object-cover bg-slate-800" alt="">` : ''}
        <div class="flex-1 min-w-0">
          <div class="font-bold text-slate-100 truncate">${esc(c.name)}</div>
          <div class="text-xs text-slate-400">${done} de ${required.length} obligatorios listos${pending.length ? '' : ' — ¡todo en orden!'}</div>
        </div>
        <div class="text-2xl font-extrabold ${pct === 100 ? 'text-emerald-400' : 'text-slate-200'}">${pct}%</div>
      </div>
      <div class="h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-2 ${pct === 100 ? 'bg-emerald-500' : 'bg-indigo-500'} rounded-full transition-all" style="width:${pct}%"></div></div>
      ${pending.length ? `<div class="text-xs text-slate-400 mt-3 flex flex-wrap gap-x-1 gap-y-1">Falta: ${pending.map(({ step, it }) =>
        `<button type="button" data-goto="${step}" class="text-rose-300 hover:underline">${esc(it.label)}</button>`).join('<span class="text-slate-600">·</span>')}</div>` : ''}`;

    $('cs-steps').innerHTML = STEPS.map((s, idx) => {
      const ui = STATUS_UI[stepStatus(s)];
      const isOpen = openStep === s.id;
      return `
      <section class="bg-slate-900 border ${isOpen ? 'border-indigo-500/60' : 'border-slate-700'} rounded-2xl scroll-mt-24" data-step="${s.id}">
        <button type="button" data-toggle="${s.id}" class="w-full flex items-center gap-3 p-4 text-left">
          <span class="w-7 h-7 rounded-full ${stepStatus(s) === 'ok' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-800 text-slate-300'} text-sm font-bold flex items-center justify-center flex-shrink-0">${stepStatus(s) === 'ok' ? '✓' : idx + 1}</span>
          <span class="flex-1 min-w-0">
            <span class="block font-semibold text-slate-100">${esc(s.title)}</span>
            <span class="block text-xs text-slate-400">${esc(s.hint)}</span>
          </span>
          <span class="flex items-center gap-1.5 text-xs font-semibold ${ui.text}"><span class="w-2 h-2 rounded-full ${ui.dot}"></span>${ui.label}</span>
        </button>
        ${isOpen ? `<div class="px-4 pb-4 border-t border-slate-800"><div class="pt-4 space-y-4">${renderStep(s)}</div></div>` : ''}
      </section>`;
    }).join('');

    restoreDrafts();
    if (focus && $(focus.id)) {
      const el = $(focus.id);
      el.focus();
      try { if (focus.start != null) el.setSelectionRange(focus.start, focus.end); } catch (e) { /* select/number no soportan selección */ }
    }
    Icons.hydrate($('cs-steps'));
    bind();
    if (openStep === 'trello' && boards === null) loadBoards();
  }

  function badge(key) {
    const it = item(key);
    if (!it) return '';
    const r = live[key];
    const ui = STATUS_UI[effective(key)];
    let msg = '';
    if (r?.pending) msg = '<span class="text-slate-400">Verificando…</span>';
    else if (r) msg = `<span class="${r.ok ? 'text-emerald-400' : 'text-amber-300'}">${esc(r.message)}</span>`;
    else if (it.detail) msg = `<span class="text-slate-400">${esc(it.detail)}</span>`;
    return `<div class="flex items-start gap-2 text-xs"><span class="w-2 h-2 rounded-full ${ui.dot} mt-1 flex-shrink-0"></span><span><b class="${ui.text}">${esc(it.label)}${it.required ? '' : ' (opcional)'}:</b> ${msg}</span></div>`;
  }

  function shareNote(perm) {
    return state.service_email
      ? `<p class="text-xs text-slate-400">Comparte como <b>${perm}</b> con la cuenta de servicio: <code class="bg-slate-800 px-1.5 py-0.5 rounded select-all">${esc(state.service_email)}</code> <button type="button" data-copy="${esc(state.service_email)}" class="text-indigo-400 underline ml-1">copiar</button></p>`
      : '<p class="text-xs text-amber-300">No hay cuenta de servicio de Google configurada en el servidor (GOOGLE_SERVICE_ACCOUNT_JSON). Avísale al administrador.</p>';
  }

  // Botón hacia una pestaña de Atención al Cliente con la marca ya abierta (si el rol tiene acceso).
  function atencionLink(tab, label, primary = false) {
    if (!canAtencion()) return '';
    return `<a href="atencion-cliente.html?open_client=${state.client.id}&tab=${tab}" class="${primary ? btnCls : btn2Cls} inline-block">${label}</a>`;
  }

  function renderStep(s) {
    const c = state.client;
    const status = `<div class="space-y-1.5">${s.items.map(badge).join('')}</div>`;
    switch (s.id) {
      case 'datos': return `${status}
        <div class="flex items-center gap-3">
          ${c.logo_url ? `<img src="${esc(c.logo_url)}" class="w-16 h-16 rounded-xl object-cover bg-slate-800" alt="Logo">` : '<div class="w-16 h-16 rounded-xl bg-slate-800 flex items-center justify-center text-[10px] text-slate-500">Sin logo</div>'}
          <div>
            <label class="${btn2Cls} inline-block cursor-pointer">${c.logo_url ? 'Cambiar logo' : 'Subir logo'}<input type="file" id="cs-logo-file" accept=".png,.jpg,.jpeg,.webp,.svg" class="hidden"></label>
            <p class="text-[11px] text-slate-500 mt-1">PNG, JPG, WEBP o SVG · máx. 5 MB · ideal cuadrado</p>
          </div>
        </div>
        <div>
          <label class="text-xs text-slate-400 block mb-1">Contexto de la marca para la IA</label>
          <textarea id="cs-ai" rows="7" class="${inputCls}" placeholder="Qué vende, ciudad y dirección, horarios, precios o rangos, medios de pago, si hace domicilios, preguntas frecuentes y lo que NO se hace…">${esc(c.ai_context || '')}</textarea>
        </div>
        <button data-act="save-datos" class="${btnCls}">Guardar contexto</button>`;

      case 'trello': {
        const opts = Array.isArray(boards)
          ? '<option value="">Elige el tablero de esta marca…</option>' + boards.map((b) => `<option value="${esc(b.id)}" ${b.id === c.trello_board_id ? 'selected' : ''}>${esc(b.name)}</option>`).join('')
          : `<option value="">${boards instanceof Error ? esc(boards.message) : 'Cargando tableros de Trello…'}</option>`;
        const lists = live.trello_lists;
        const members = live.trello_members;
        return `${status}
        <div class="flex gap-2">
          <select id="cs-board" class="${inputCls}">${opts}</select>
          <button data-act="save-board" class="${btnCls}">${c.trello_board_id ? 'Cambiar' : 'Vincular'}</button>
        </div>
        ${lists && !lists.pending && lists.can_create ? `
          <div class="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
            <p class="text-xs text-amber-200 mb-2">El protocolo usa: Tareas → En Proceso → Enviado → Cambios → Aprobado (+ Montado en Drive, Publicado). Puedo crear las que faltan al final del tablero; luego ordénalas en Trello si hace falta.</p>
            <button data-act="create-lists" class="${btnCls}">Crear listas faltantes</button>
          </div>` : ''}
        ${members && !members.pending && !members.ok && Session.canView('configuracion') ? '<a href="configuracion.html" class="text-indigo-400 text-xs underline">Poner las tarifas por hora en Configuración → Miembros</a>' : ''}`;
      }

      case 'proyecto': {
        if (!c.trello_board_id) return `${status}<p class="text-sm text-amber-300">Primero vincula el tablero de Trello (paso 2).</p>`;
        if (!state.can_manage) return `${status}<p class="text-sm text-amber-300">Presupuesto e ingreso los completa la PM o un administrador.</p>`;
        const pr = state.project || {};
        const num = (v) => (v ? String(v) : '');
        return `${status}
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="text-xs text-slate-400 block mb-1">Nombre en el dashboard</label><input id="cs-pj-alias" class="${inputCls}" value="${esc(pr.alias || c.name)}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Empresa / categoría (filtro del dashboard)</label><input id="cs-pj-category" class="${inputCls}" value="${esc(pr.category || c.name)}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Tipo de proyecto</label>
            <select id="cs-pj-type" class="${inputCls}"><option value="retencion" ${pr.project_type !== 'unico' ? 'selected' : ''}>Retención mensual</option><option value="unico" ${pr.project_type === 'unico' ? 'selected' : ''}>Proyecto único</option></select></div>
          <div><label class="text-xs text-slate-400 block mb-1">Moneda</label><input id="cs-pj-currency" class="${inputCls}" value="${esc(pr.currency || 'COP')}" maxlength="8"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Presupuesto</label><input id="cs-pj-budget" type="number" min="0" step="1000" class="${inputCls}" value="${num(pr.budget)}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Ingreso mensual</label><input id="cs-pj-revenue" type="number" min="0" step="1000" class="${inputCls}" value="${num(pr.revenue)}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Horas estimadas al mes</label><input id="cs-pj-hours" type="number" min="0" step="1" class="${inputCls}" value="${num(pr.hours_estimated)}"></div>
        </div>
        <button data-act="save-project" class="${btnCls}">Guardar datos del proyecto</button>`;
      }

      case 'sheet': return `${status}
        ${shareNote('Lector')}
        <div class="flex gap-2">
          <input id="cs-sheet" class="${inputCls}" value="${esc(c.sheet_id || '')}" placeholder="Pega el link del Google Sheet">
          <button data-act="save-sheet" class="${btnCls}">Guardar y verificar</button>
        </div>
        <p class="text-xs text-slate-500">Una pestaña por mes con el nombre del mes (OCTUBRE, NOVIEMBRE…). Columnas: A = # post, C = día, D = indicaciones, E = mensaje de arte, F = copy.</p>
        ${c.sheet_id ? `<a href="https://docs.google.com/spreadsheets/d/${esc(c.sheet_id)}/edit" target="_blank" rel="noopener" class="text-indigo-400 text-xs underline">Abrir el Sheet</a>` : ''}`;

      case 'drive': return `${status}
        ${shareNote('Editor')}
        <p class="text-xs text-amber-300">Las dos carpetas deben compartirse como <b>Editor</b>: el sistema mueve el contenido aprobado y crea carpetas.</p>
        <div>
          <label class="text-xs text-slate-400 block mb-1">Carpeta «Para aprobación» de la marca</label>
          <input id="cs-appr" class="${inputCls}" value="${esc(c.drive_approval_folder_id || '')}" placeholder="Pega el link de la carpeta en Drive">
        </div>
        <div>
          <label class="text-xs text-slate-400 block mb-1">Carpeta ARTES del tablero</label>
          <input id="cs-artes" class="${inputCls}" value="${esc(state.artes_folder_id || '')}" placeholder="Pega el link de la carpeta ARTES" ${c.trello_board_id ? '' : 'disabled'}>
          ${c.trello_board_id ? '' : '<p class="text-xs text-amber-300 mt-1">Primero vincula el tablero de Trello (paso 2).</p>'}
        </div>
        <button data-act="save-drive" class="${btnCls}">Guardar y verificar</button>`;

      case 'telegram': {
        const g = (arr) => (arr || []).join(', ');
        const bot = live.telegram_group?.bot;
        const linked = state.telegram_group_linked;
        return `${status}
        <ol class="text-sm text-slate-300 list-decimal ml-5 space-y-1">
          <li>En el grupo de Telegram de la marca, agrega a ${bot ? `<b>${esc(bot)}</b>` : 'el bot revisor'} como <b>administrador</b>.</li>
          <li>Escribe en el grupo: <code class="bg-slate-800 px-1.5 py-0.5 rounded select-all">/vincular ${esc(c.slug)}</code> <button type="button" data-copy="/vincular ${esc(c.slug)}" class="text-indigo-400 text-xs underline ml-1">copiar</button></li>
          <li>Cuando el bot responda «Grupo vinculado a ${esc(c.name)}», marca la casilla.</li>
        </ol>
        <label class="flex items-center gap-2 text-sm text-slate-200 ${linked ? '' : 'cursor-pointer'}">
          <input type="checkbox" id="cs-tg-done" class="w-4 h-4 accent-indigo-500" ${Number(c.telegram_setup_done) || linked ? 'checked' : ''} ${linked ? 'disabled' : ''}>
          Ya agregué el bot al grupo y lo vinculé con /vincular
          ${linked ? '<span class="text-emerald-400 text-xs">(el bot ya registró el grupo)</span>' : ''}
        </label>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-slate-400 block mb-1">CM de esta marca en Telegram</label>
            <input id="cs-cm" class="${inputCls}" value="${esc(g(state.roles.cm))}" placeholder="@usuario o nombre; varios separados por coma">
            ${state.roles.global_cm.length ? `<p class="text-[11px] text-slate-500 mt-1">Ya reconocidas en todas las marcas: ${esc(g(state.roles.global_cm))}</p>` : ''}
          </div>
          <div>
            <label class="text-xs text-slate-400 block mb-1">PM de esta marca en Telegram</label>
            <input id="cs-pm" class="${inputCls}" value="${esc(g(state.roles.pm))}" placeholder="@usuario o nombre">
            ${state.roles.global_pm.length ? `<p class="text-[11px] text-slate-500 mt-1">Ya reconocidas en todas las marcas: ${esc(g(state.roles.global_pm))}</p>` : ''}
          </div>
        </div>
        <p class="text-[11px] text-slate-500">Quien no aparezca aquí (ni en las globales) se trata como diseñador: sus envíos generan revisión.</p>
        <button data-act="save-roles" class="${btnCls}">Guardar CM / PM</button>`;
      }

      case 'meta': {
        const connected = item('meta_facebook')?.status !== 'missing';
        return `${status}
        <p class="text-sm text-slate-300">Inicia sesión con una cuenta de Facebook que <b>administre la Página</b> de la marca. Si la Página tiene su Instagram Business vinculado, se conectan juntos.</p>
        <a href="backend/oauth/facebook_connect.php?client_id=${c.id}&return=asistente" class="${btnCls} inline-block">${connected ? 'Volver a conectar' : 'Conectar Facebook / Instagram'}</a>
        <p class="text-xs text-slate-500">Al terminar vuelves a este asistente; si tu cuenta administra varias Páginas, eliges la de esta marca.</p>`;
      }

      case 'flujos': return `${status}
        <div>
          <label class="text-xs text-slate-400 block mb-1">Correos que reciben el aviso de leads nuevos</label>
          <div class="flex gap-2">
            <input id="cs-lead-emails" class="${inputCls}" value="${esc((state.lead_emails || []).join(', '))}" placeholder="ventas@marca.com, gerente@marca.com">
            <button data-act="save-emails" class="${btnCls}">Guardar</button>
          </div>
        </div>
        ${canAtencion() ? `<div class="flex gap-2 flex-wrap">
          ${atencionLink('flujos', 'Crear / activar flujos', true)}
          ${atencionLink('organicos', 'Portal de leads')}
          ${atencionLink('briefs', 'Enviar brief')}
        </div>` : '<p class="text-xs text-slate-500">Flujos, portal de leads y brief se gestionan en Atención al Cliente (pídele a la CM o a un administrador).</p>'}`;

      case 'pauta': {
        if (!state.can_manage) return `${status}<p class="text-sm text-amber-300">Este paso lo completa la PM o un administrador.</p>`;
        const linked = state.pauta;
        const cands = state.pauta_candidates || [];
        if (pautaPick === null) pautaPick = linked ? linked.id : (state.pauta_suggested || 'new');
        const source = linked || cands.find((p) => p.id === pautaPick) || null;
        const val = (k, f) => esc(((source?.platforms || []).find((x) => x.platform === k) || {})[f] || '');
        return `${status}
        ${!linked && cands.length ? `
          <div>
            <label class="text-xs text-slate-400 block mb-1">¿La marca ya existe en Pauta?</label>
            <select id="cs-pauta-pick" class="${inputCls}">
              <option value="new" ${pautaPick === 'new' ? 'selected' : ''}>No — crear la marca en Pauta</option>
              ${cands.map((p) => `<option value="${esc(p.id)}" ${pautaPick === p.id ? 'selected' : ''}>Sí — vincular con «${esc(p.name)}»${p.id === state.pauta_suggested ? ' (sugerido)' : ''}</option>`).join('')}
            </select>
            ${state.pauta_suggested ? '<p class="text-[11px] text-amber-300 mt-1">Encontré una marca con el mismo nombre en Pauta: vincúlala para no duplicarla.</p>' : ''}
          </div>` : ''}
        <p class="text-xs text-slate-400">Deja vacía la plataforma donde la marca no pauta. Varias cuentas se separan con coma. El presupuesto mensual se carga en Pauta.</p>
        <div class="grid sm:grid-cols-3 gap-3">
          <div><label class="text-xs text-slate-400 block mb-1">Meta · Ad Account ID</label><input id="cs-p-meta" class="${inputCls}" value="${val('meta', 'account_id')}" placeholder="act_123456789"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Google · Customer ID</label><input id="cs-p-google" class="${inputCls}" value="${val('google', 'customer_id')}" placeholder="123-456-7890"></div>
          <div><label class="text-xs text-slate-400 block mb-1">TikTok · Advertiser ID</label><input id="cs-p-tiktok" class="${inputCls}" value="${val('tiktok', 'advertiser_id')}"></div>
        </div>
        <div class="flex gap-2 flex-wrap">
          <button data-act="save-pauta" class="${btnCls}">${linked ? 'Guardar cuentas' : 'Guardar y vincular con Pauta'}</button>
          ${linked && Session.canView('pauta') ? '<a href="pauta.html" class="' + btn2Cls + ' inline-block">Cargar presupuesto en Pauta</a>' : ''}
        </div>`;
      }
      default: return status;
    }
  }

  // ───────────────────────── acciones

  function bind() {
    document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      openStep = openStep === b.dataset.toggle ? null : b.dataset.toggle;
      render();
    }));
    document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => {
      openStep = b.dataset.goto;
      render();
      document.querySelector(`[data-step="${openStep}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
    document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, b)));
    document.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(b.dataset.copy);
        toast('Copiado', 'success');
      } catch (e) {
        toast('No se pudo copiar: selecciónalo y cópialo a mano', 'danger');
      }
    }));
    $('cs-logo-file')?.addEventListener('change', uploadLogo);
    const tg = $('cs-tg-done');
    if (tg) tg.addEventListener('change', async () => {
      delete drafts['cs-tg-done'];
      if (await saveFields({ telegram_setup_done: tg.checked }, tg.checked ? 'Telegram marcado como configurado' : 'Telegram desmarcado')) await reload({ saved: tg.checked });
      else tg.checked = !tg.checked;
    });
    $('cs-pauta-pick')?.addEventListener('change', (e) => {
      pautaPick = e.target.value;
      ['cs-p-meta', 'cs-p-google', 'cs-p-tiktok'].forEach((id) => delete drafts[id]); // mostrar las cuentas del elegido
      drafts['cs-pauta-pick'] = pautaPick;
      render();
    });
  }

  async function saveFields(fields, okMsg) {
    try {
      await post({ action: 'save_fields', client_id: activeId, ...fields });
      toast(okMsg, 'success');
      return true;
    } catch (e) {
      toast(e.message, 'danger');
      return false;
    }
  }

  const val = (id) => ($(id)?.value || '').trim();
  const splitList = (id) => val(id).split(/[,;\n]+/).map((t) => t.trim()).filter(Boolean);

  async function act(name, btnEl) {
    btnEl.disabled = true;
    try {
      switch (name) {
        case 'save-datos':
          if (await saveFields({ ai_context: $('cs-ai').value }, 'Contexto guardado')) await reload({ saved: true });
          break;
        case 'save-board': {
          const id = val('cs-board');
          if (!id) { toast('Elige un tablero', 'danger'); break; }
          if (await saveFields({ trello_board_id: id }, 'Tablero vinculado')) {
            live = {};
            await reload({ saved: true, runLive: true });
          }
          break;
        }
        case 'create-lists': {
          const res = await post({ action: 'create_trello_lists', client_id: activeId });
          toast(res.created.length ? `Listas creadas: ${res.created.join(', ')}` : 'No faltaba ninguna lista', 'success');
          await runLiveChecks(['trello_lists']);
          advanceIfDone();
          break;
        }
        case 'save-project':
          await post({
            action: 'save_project', client_id: activeId,
            alias: val('cs-pj-alias'), category: val('cs-pj-category'), project_type: val('cs-pj-type'), currency: val('cs-pj-currency'),
            budget: val('cs-pj-budget'), revenue: val('cs-pj-revenue'), hours_estimated: val('cs-pj-hours'),
          });
          toast('Datos del proyecto guardados', 'success');
          await reload({ saved: true });
          break;
        case 'save-sheet':
          if (await saveFields({ sheet_id: val('cs-sheet') }, 'Sheet guardado')) {
            await reload({ fresh: true });
            await runLiveChecks(item('sheet')?.status === 'ok' ? ['sheet'] : []);
            advanceIfDone();
          }
          break;
        case 'save-drive': {
          const fields = { drive_approval_folder_id: val('cs-appr') };
          if (!$('cs-artes').disabled) fields.artes_folder_id = val('cs-artes');
          if (await saveFields(fields, 'Carpetas guardadas')) {
            await reload({ fresh: true });
            await runLiveChecks(['approval_folder', 'artes_folder'].filter((k) => item(k)?.status === 'ok'));
            advanceIfDone();
          }
          break;
        }
        case 'save-roles':
          await post({ action: 'save_roles', client_id: activeId, cm: splitList('cs-cm'), pm: splitList('cs-pm') });
          toast('CM y PM guardados', 'success');
          await reload({ saved: true });
          break;
        case 'save-emails': {
          const res = await post({ action: 'save_lead_emails', client_id: activeId, emails: splitList('cs-lead-emails') });
          toast(`${res.count} correo(s) guardado(s)`, 'success');
          await reload({ saved: true });
          break;
        }
        case 'save-pauta': {
          const res = await post({
            action: 'save_pauta', client_id: activeId, pauta_id: state.pauta ? state.pauta.id : pautaPick,
            platforms: { meta: val('cs-p-meta'), google: val('cs-p-google'), tiktok: val('cs-p-tiktok') },
          });
          toast(res.pauta_id ? 'Pauta vinculada' : 'Guardado', 'success');
          pautaPick = null;
          await reload({ saved: true });
          break;
        }
      }
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      if (document.body.contains(btnEl)) btnEl.disabled = false;
    }
  }

  async function loadBoards() {
    boards = 'loading';
    try {
      const { key, token } = Storage.getCredentials();
      if (!key || !token) throw new Error('Faltan las credenciales de Trello (Configuración)');
      boards = (await new TrelloAPI(key, token).getBoards()).sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      boards = e instanceof Error ? e : new Error(String(e));
    }
    render();
  }

  async function uploadLogo(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return toast('El archivo pesa demasiado (máx. 5 MB)', 'danger');
    const form = new FormData();
    form.append('client_id', activeId);
    form.append('file', file);
    try {
      const res = await fetch('backend/api/client_logo_upload.php', {
        method: 'POST',
        credentials: 'include',
        headers: Session.csrf ? { 'X-CSRF-Token': Session.csrf } : {},
        body: form,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      toast('Logo actualizado', 'success');
      await reload({});
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return { init };
})();

window.ClienteSetup = ClienteSetup;
