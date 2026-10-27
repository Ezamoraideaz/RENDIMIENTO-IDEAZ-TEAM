// Asistente "Configurar cliente": un solo lugar, en orden, con verificación de cada paso.
// Backend: backend/api/client_setup.php (estado + verificaciones en vivo + reglas Telegram + pauta);
// los campos simples se guardan ahí mismo (save_fields). Logo: backend/api/client_logo_upload.php.
const ClienteSetup = (() => {
  let clients = [];
  let activeId = null;
  let state = null;           // respuesta de GET client_setup.php
  let liveResults = {};       // key -> {ok, message, partial}
  let openStep = null;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const api = (path, options) => Session.apiFetch(path, options);
  const post = (body) => api('api/client_setup.php', { method: 'POST', body: JSON.stringify(body) });
  const toast = (m, t = 'info') => Utils.showToast(m, t);

  // Pasos en el orden en que deben hacerse. `items` = claves del checklist que cubre cada paso.
  const STEPS = [
    { id: 'datos',    title: 'Datos de la marca',            hint: 'Logo y contexto para la IA',                   items: ['logo', 'ai_context'] },
    { id: 'trello',   title: 'Tablero de Trello',            hint: 'Vínculo, listas del protocolo y tarifas del equipo', items: ['trello', 'trello_lists', 'trello_members'] },
    { id: 'proyecto', title: 'Datos del proyecto',           hint: 'Tipo, presupuesto, ingreso y horas para costos y rentabilidad', items: ['project'] },
    { id: 'sheet',    title: 'Cronograma (Google Sheet)',    hint: 'Una pestaña por mes; lo lee la tanda y el revisor', items: ['sheet'] },
    { id: 'drive',    title: 'Carpetas de Drive',            hint: '«Para aprobación» y ARTES, ambas como Editor',  items: ['approval_folder', 'artes_folder'] },
    { id: 'telegram', title: 'Telegram (revisor de piezas)', hint: 'Grupo de la marca + quién es CM y PM',          items: ['telegram_group', 'telegram_roles'] },
    { id: 'meta',     title: 'Facebook e Instagram',         hint: 'Conectar la cuenta para mensajes y leads',      items: ['meta_facebook', 'meta_instagram'] },
    { id: 'flujos',   title: 'Flujos, leads y brief',        hint: 'Respuestas automáticas, aviso de leads y brief del cliente', items: ['flows', 'lead_emails', 'lead_portal', 'brief'] },
    { id: 'pauta',    title: 'Pauta (inversión publicitaria)', hint: 'Cuenta publicitaria para leer gasto y reportes', items: ['pauta'] },
  ];

  const STATUS_UI = {
    ok:      { dot: 'bg-emerald-400', text: 'text-emerald-400', label: 'Listo' },
    warn:    { dot: 'bg-amber-400',   text: 'text-amber-400',   label: 'Revisar' },
    missing: { dot: 'bg-rose-400',    text: 'text-rose-400',    label: 'Falta' },
  };

  function item(key) { return (state?.items || []).find((i) => i.key === key); }
  function activeClient() { return clients.find((c) => c.id === activeId); }

  // Estado efectivo de un item: la verificación en vivo (si ya corrió) manda sobre el guardado en BD.
  function effective(key) {
    const it = item(key);
    if (!it) return 'missing';
    const live = liveResults[key];
    if (it.live) return it.status === 'missing' ? 'missing' : (live && live.ok ? 'ok' : 'warn'); // solo vale lo verificado
    if (it.status === 'ok' && live) return live.ok ? 'ok' : 'warn';
    return it.status;
  }

  function stepStatus(step) {
    if (step.items.some((k) => item(k)?.required && effective(k) === 'missing')) return 'missing';
    return step.items.some((k) => effective(k) !== 'ok') ? 'warn' : 'ok';
  }

  // ───────────────────────── carga

  async function init() {
    Icons.hydrate(document.body);
    $('cs-client-select').addEventListener('change', (e) => selectClient(Number(e.target.value) || null));
    $('cs-new-client').addEventListener('click', newClient);
    $('cs-refresh').addEventListener('click', () => activeId && reload(true));
    await loadClients();
    const params = new URLSearchParams(location.search);
    const fromUrl = Number(params.get('client_id')) || null;
    if (fromUrl && clients.some((c) => c.id === fromUrl)) {
      $('cs-client-select').value = String(fromUrl);
      await selectClient(fromUrl);
      if (params.has('oauth_select_page') || params.has('oauth_error')) { openStep = 'meta'; render(); }
      if (params.get('oauth_select_page')) showPagePicker();
    }
    if (params.get('oauth_error')) toast('Error al conectar: ' + params.get('oauth_error'), 'danger');
    if (params.has('oauth_select_page') || params.has('oauth_error') || params.has('client_id')) {
      history.replaceState({}, '', 'configurar-cliente.html');
    }
  }

  // Al volver de Facebook: si la cuenta administra varias Páginas, se elige cuál es de este cliente.
  async function showPagePicker() {
    try {
      const data = await api('api/oauth_pages.php');
      if (!data.pages.length) return toast('No hay páginas pendientes de selección', 'danger');
      const rows = data.pages.map((p) => `
        <button type="button" data-page="${esc(p.id)}" class="w-full text-left bg-slate-800/60 border border-slate-700/60 hover:border-indigo-500 rounded-lg px-4 py-3">
          <span class="block text-sm font-semibold text-slate-100">${esc(p.name)}</span>
          <span class="block text-xs text-slate-500">${p.has_instagram ? 'Instagram @' + esc(p.instagram_username || '') + ' vinculado' : 'Sin cuenta de Instagram vinculada'}</span>
        </button>`).join('');
      document.body.insertAdjacentHTML('beforeend', `
        <div id="cs-page-picker" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6">
            <h3 class="font-bold text-lg mb-1">Elige la Página de este cliente</h3>
            <p class="text-xs text-slate-500 mb-4">Tu cuenta de Facebook administra varias Páginas.</p>
            <div class="flex flex-col gap-2 max-h-96 overflow-y-auto">${rows}</div>
          </div>
        </div>`);
      $('cs-page-picker').addEventListener('click', async (e) => {
        const b = e.target.closest('[data-page]');
        if (!b) return;
        try {
          const res = await api('api/oauth_pages.php', { method: 'POST', body: JSON.stringify({ page_id: b.dataset.page }) });
          $('cs-page-picker').remove();
          toast(res.webhook_warning || 'Cuenta conectada correctamente', res.webhook_warning ? 'danger' : 'success');
          await reload(false);
        } catch (err) {
          toast(err.message, 'danger');
        }
      });
    } catch (e) {
      toast(e.message, 'danger');
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
    sel.innerHTML = '<option value="">Elige un cliente…</option>' +
      clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (activeId) sel.value = String(activeId);
  }

  async function newClient() {
    const name = (prompt('Nombre de la marca / cliente nuevo:') || '').trim();
    if (!name) return;
    try {
      const res = await post({ action: 'create_client', name });
      await loadClients();
      $('cs-client-select').value = String(res.id);
      await selectClient(res.id);
      toast(`Cliente «${name}» creado — sigue los pasos en orden`, 'success');
    } catch (e) {
      toast(e.message, 'danger');
    }
  }

  async function selectClient(id) {
    activeId = id;
    liveResults = {};
    state = null;
    openStep = null;
    if (!id) {
      $('cs-steps').innerHTML = '';
      $('cs-summary').classList.add('hidden');
      $('cs-empty').classList.remove('hidden');
      return;
    }
    $('cs-empty').classList.add('hidden');
    await reload(true);
  }

  async function reload(runLive) {
    try {
      state = await api(`api/client_setup.php?client_id=${activeId}`);
    } catch (e) {
      toast(e.message, 'danger');
      return;
    }
    // Primer paso incompleto = el que se abre solo.
    if (!openStep) {
      const next = STEPS.find((s) => stepStatus(s) !== 'ok');
      openStep = next ? next.id : null;
    }
    render();
    if (runLive) runLiveChecks();
  }

  // Verificaciones contra Google (no bloquean el render del resto).
  async function runLiveChecks() {
    const keys = [];
    if (item('trello')?.status === 'ok') keys.push('trello_lists', 'trello_members');
    if (item('sheet')?.status === 'ok') keys.push('sheet');
    if (item('approval_folder')?.status === 'ok') keys.push('approval_folder');
    if (item('artes_folder')?.status === 'ok') keys.push('artes_folder');
    await Promise.all(keys.map(runCheck));
  }

  async function runCheck(key) {
    liveResults[key] = { pending: true };
    render();
    try {
      liveResults[key] = await api(`api/client_setup.php?client_id=${activeId}&check=${key}`);
    } catch (e) {
      liveResults[key] = { ok: false, message: e.message };
    }
    render();
  }

  // ───────────────────────── render

  function render() {
    if (!state) return;
    const total = state.items.filter((i) => i.required).length;
    const done = state.items.filter((i) => i.required && effective(i.key) === 'ok').length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const pending = state.items.filter((i) => i.required && effective(i.key) !== 'ok');
    const c = state.client;

    const sum = $('cs-summary');
    sum.classList.remove('hidden');
    sum.innerHTML = `
      <div class="flex items-center gap-3 mb-2">
        ${c.logo_url ? `<img src="${esc(c.logo_url)}" class="w-10 h-10 rounded-lg object-cover bg-slate-800" alt="">` : ''}
        <div class="flex-1 min-w-0">
          <div class="font-bold text-slate-100 truncate">${esc(c.name)}</div>
          <div class="text-xs text-slate-400">${done} de ${total} obligatorios listos${pending.length ? '' : ' — ¡todo en orden!'}</div>
        </div>
        <div class="text-2xl font-extrabold ${pct === 100 ? 'text-emerald-400' : 'text-slate-200'}">${pct}%</div>
      </div>
      <div class="h-2 bg-slate-800 rounded-full overflow-hidden"><div class="h-2 ${pct === 100 ? 'bg-emerald-500' : 'bg-indigo-500'} rounded-full transition-all" style="width:${pct}%"></div></div>
      ${pending.length ? `<p class="text-xs text-slate-400 mt-3">Falta: ${pending.map((i) => `<span class="text-rose-300">${esc(i.label)}</span>`).join(' · ')}</p>` : ''}`;

    $('cs-steps').innerHTML = STEPS.map((s, idx) => {
      const st = stepStatus(s);
      const ui = STATUS_UI[st];
      const isOpen = openStep === s.id;
      return `
      <section class="bg-slate-900 border ${isOpen ? 'border-indigo-500/60' : 'border-slate-700'} rounded-2xl" data-step="${s.id}">
        <button type="button" data-toggle="${s.id}" class="w-full flex items-center gap-3 p-4 text-left">
          <span class="w-7 h-7 rounded-full bg-slate-800 text-slate-300 text-sm font-bold flex items-center justify-center flex-shrink-0">${idx + 1}</span>
          <span class="flex-1 min-w-0">
            <span class="block font-semibold text-slate-100">${esc(s.title)}</span>
            <span class="block text-xs text-slate-400">${esc(s.hint)}</span>
          </span>
          <span class="flex items-center gap-1.5 text-xs font-semibold ${ui.text}"><span class="w-2 h-2 rounded-full ${ui.dot}"></span>${ui.label}</span>
        </button>
        ${isOpen ? `<div class="px-4 pb-4 pt-0 border-t border-slate-800"><div class="pt-4 space-y-4">${renderStep(s)}</div></div>` : ''}
      </section>`;
    }).join('');

    Icons.hydrate($('cs-steps'));
    bindStep();
  }

  function badge(key) {
    const it = item(key);
    if (!it) return '';
    const live = liveResults[key];
    const st = effective(key);
    const ui = STATUS_UI[st];
    let msg = '';
    if (live?.pending) msg = '<span class="text-slate-400">Verificando…</span>';
    else if (live) msg = `<span class="${live.ok ? 'text-emerald-400' : 'text-amber-300'}">${esc(live.message)}</span>`;
    else if (it.detail && st === 'ok') msg = `<span class="text-slate-400">${esc(it.detail)}</span>`;
    else if (it.detail) msg = `<span class="text-slate-400">${esc(it.detail)}</span>`;
    return `<div class="flex items-start gap-2 text-xs"><span class="w-2 h-2 rounded-full ${ui.dot} mt-1 flex-shrink-0"></span><span><b class="${ui.text}">${esc(it.label)}${it.required ? '' : ' (opcional)'}:</b> ${msg}</span></div>`;
  }

  const inputCls = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500';
  const btnCls = 'bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold px-4 py-2 rounded-lg disabled:opacity-50';
  const btn2Cls = 'bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold px-4 py-2 rounded-lg';

  function shareNote() {
    return state.service_email
      ? `<p class="text-xs text-slate-400">Comparte con esta cuenta de servicio: <code class="bg-slate-800 px-1.5 py-0.5 rounded select-all">${esc(state.service_email)}</code></p>`
      : '<p class="text-xs text-amber-300">No hay cuenta de servicio de Google configurada en el servidor (GOOGLE_SERVICE_ACCOUNT_JSON).</p>';
  }

  function renderStep(s) {
    const c = state.client;
    const checks = s.items.map(badge).join('');
    const status = `<div class="space-y-1.5">${checks}</div>`;
    switch (s.id) {
      case 'datos': return `${status}
        <div>
          <label class="text-xs text-slate-400 block mb-1">Logo (PNG, JPG, WEBP o SVG, máx. 5 MB)</label>
          <input type="file" id="cs-logo-file" accept=".png,.jpg,.jpeg,.webp,.svg" class="text-sm text-slate-300">
        </div>
        <div>
          <label class="text-xs text-slate-400 block mb-1">Contexto de la marca para la IA</label>
          <textarea id="cs-ai" rows="6" class="${inputCls}" placeholder="Qué vende, horarios, precios, ciudad, qué NO se hace…">${esc(c.ai_context || '')}</textarea>
        </div>
        <button data-act="save-datos" class="${btnCls}">Guardar contexto</button>`;
      case 'trello': return `${status}
        <div class="flex gap-2">
          <select id="cs-board" class="${inputCls}"><option value="">Cargando tableros de Trello…</option></select>
          <button data-act="save-board" class="${btnCls}">Vincular</button>
        </div>
        <p class="text-xs text-slate-500">Si la lista no carga, revisa las credenciales de Trello en Configuración.</p>
        ${liveResults.trello_lists && !liveResults.trello_lists.ok && liveResults.trello_lists.can_create ? `
          <div class="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3">
            <p class="text-xs text-amber-200 mb-2">El protocolo usa estas listas: Tareas → En Proceso → Enviado → Cambios → Aprobado (+ Montado en Drive, Publicado). Puedo crear las que faltan al final del tablero.</p>
            <button data-act="create-lists" class="${btnCls}">Crear listas faltantes</button>
          </div>` : ''}
        ${item('trello_members')?.status !== 'missing' && liveResults.trello_members && !liveResults.trello_members.ok ? `<a href="configuracion.html" class="text-indigo-400 text-xs underline">Ir a Configuración para poner las tarifas por hora</a>` : ''}`;
      case 'proyecto': {
        if (!c.trello_board_id) return `${status}<p class="text-sm text-amber-300">Primero vincula el tablero de Trello (paso 2).</p>`;
        if (!state.can_edit_project) return `${status}<p class="text-sm text-amber-300">Estos datos (presupuesto e ingreso) los completa la PM o un administrador.</p>`;
        const pr = state.project || {};
        return `${status}
        <div class="grid sm:grid-cols-2 gap-3">
          <div><label class="text-xs text-slate-400 block mb-1">Nombre en el dashboard (alias)</label><input id="cs-pj-alias" class="${inputCls}" value="${esc(pr.alias || c.name)}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Tipo de proyecto</label>
            <select id="cs-pj-type" class="${inputCls}"><option value="retencion" ${pr.project_type !== 'unico' ? 'selected' : ''}>Retención mensual</option><option value="unico" ${pr.project_type === 'unico' ? 'selected' : ''}>Proyecto único</option></select></div>
          <div><label class="text-xs text-slate-400 block mb-1">Presupuesto (costo máx.)</label><input id="cs-pj-budget" type="number" min="0" step="100" class="${inputCls}" value="${pr.budget || ''}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Ingreso mensual</label><input id="cs-pj-revenue" type="number" min="0" step="100" class="${inputCls}" value="${pr.revenue || ''}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Horas estimadas</label><input id="cs-pj-hours" type="number" min="0" step="1" class="${inputCls}" value="${pr.hours_estimated || ''}"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Moneda</label><input id="cs-pj-currency" class="${inputCls}" value="${esc(pr.currency || 'COP')}"></div>
        </div>
        <button data-act="save-project" class="${btnCls}">Guardar datos del proyecto</button>`;
      }
      case 'sheet': return `${status}
        ${shareNote()}
        <div class="flex gap-2">
          <input id="cs-sheet" class="${inputCls}" value="${esc(c.sheet_id || '')}" placeholder="Pega la URL del Google Sheet (o su ID)">
          <button data-act="save-sheet" class="${btnCls}">Guardar y verificar</button>
        </div>
        <p class="text-xs text-slate-500">Debe tener una pestaña por mes (ENERO, FEBRERO…) con A=post, C=día, D=indicaciones, E=mensaje de arte, F=copy. Compártelo como Lector.</p>`;
      case 'drive': return `${status}
        ${shareNote()}
        <p class="text-xs text-amber-300">Ambas carpetas deben compartirse como <b>Editor</b> (el sistema mueve y crea carpetas).</p>
        <div>
          <label class="text-xs text-slate-400 block mb-1">Carpeta «Para aprobación» de la marca</label>
          <input id="cs-appr" class="${inputCls}" value="${esc(c.drive_approval_folder_id || '')}" placeholder="URL de la carpeta en Drive (o su ID)">
        </div>
        <div>
          <label class="text-xs text-slate-400 block mb-1">Carpeta ARTES del tablero</label>
          <input id="cs-artes" class="${inputCls}" value="${esc(state.artes_folder_id || '')}" placeholder="URL de la carpeta ARTES (o su ID)" ${c.trello_board_id ? '' : 'disabled'}>
          ${c.trello_board_id ? '' : '<p class="text-xs text-amber-300 mt-1">Primero vincula el tablero de Trello (paso 2).</p>'}
        </div>
        <button data-act="save-drive" class="${btnCls}">Guardar y verificar</button>`;
      case 'telegram': {
        const g = (arr) => (arr || []).join(', ');
        return `${status}
        <ol class="text-sm text-slate-300 list-decimal ml-5 space-y-1">
          <li>Crea (o usa) el grupo de Telegram de la marca y agrega el bot como <b>administrador</b>.</li>
          <li>En el grupo escribe: <code class="bg-slate-800 px-1.5 py-0.5 rounded select-all">/vincular ${esc(c.slug)}</code> <button data-act="copy-vincular" class="text-indigo-400 text-xs underline ml-1">copiar</button></li>
          <li>El bot responde «Grupo vinculado a…». Marca la casilla.</li>
        </ol>
        <label class="flex items-center gap-2 text-sm text-slate-200 cursor-pointer">
          <input type="checkbox" id="cs-tg-done" class="w-4 h-4 accent-indigo-500" ${Number(c.telegram_setup_done) || state.telegram_group_linked ? 'checked' : ''} ${state.telegram_group_linked ? 'disabled' : ''}>
          Ya agregué el bot al grupo y lo vinculé con /vincular${state.telegram_group_linked ? ' <span class="text-emerald-400 text-xs">(el bot ya lo detectó)</span>' : ''}
        </label>
        <div class="grid sm:grid-cols-2 gap-3">
          <div>
            <label class="text-xs text-slate-400 block mb-1">CM de esta marca <span class="text-slate-600">(texto del @usuario o nombre en Telegram, separados por coma)</span></label>
            <input id="cs-cm" class="${inputCls}" value="${esc(g(state.roles.cm))}" placeholder="ej. zharick">
            ${state.roles.global_cm.length ? `<p class="text-[11px] text-slate-500 mt-1">Ya reconocidos en todas las marcas: ${esc(g(state.roles.global_cm))}</p>` : ''}
          </div>
          <div>
            <label class="text-xs text-slate-400 block mb-1">PM de esta marca</label>
            <input id="cs-pm" class="${inputCls}" value="${esc(g(state.roles.pm))}" placeholder="ej. andrea">
            ${state.roles.global_pm.length ? `<p class="text-[11px] text-slate-500 mt-1">Ya reconocidos en todas las marcas: ${esc(g(state.roles.global_pm))}</p>` : ''}
          </div>
        </div>
        <button data-act="save-roles" class="${btnCls}">Guardar CM / PM</button>`;
      }
      case 'meta': return `${status}
        <p class="text-sm text-slate-300">Inicia sesión con la cuenta de Facebook que administra la Página. Al volver, elige la Página y quedará conectada junto con su Instagram.</p>
        <div class="flex gap-2 flex-wrap">
          <a href="backend/oauth/facebook_connect.php?client_id=${c.id}&return=asistente" class="${btnCls} inline-block">Conectar Facebook / Instagram</a>
        </div>
        <p class="text-xs text-slate-500">Al terminar volverás a este asistente. Si tu cuenta administra varias Páginas, elegirás la de este cliente.</p>`;
      case 'flujos': return `${status}
        <div class="flex gap-2 flex-wrap">
          <a href="atencion-cliente.html" class="${btnCls} inline-block">Crear flujos en Atención al Cliente</a>
          <a href="atencion-cliente.html" class="${btn2Cls} inline-block">Correos de leads</a>
        </div>`;
      case 'pauta': {
        const p = state.pauta;
        const val = (k, f) => esc(((p?.platforms || []).find((x) => x.platform === k) || {})[f] || '');
        if (!state.can_edit_pauta) {
          return `${status}<p class="text-sm text-amber-300">Este paso lo completa un administrador (maneja presupuestos de pauta).</p>`;
        }
        return `${status}
        <p class="text-xs text-slate-400">Déjalo vacío si la marca no pauta en esa plataforma. Varias cuentas se separan con coma. El presupuesto mensual se carga después en Pauta.</p>
        <div class="grid sm:grid-cols-3 gap-3">
          <div><label class="text-xs text-slate-400 block mb-1">Meta · Ad Account ID</label><input id="cs-p-meta" class="${inputCls}" value="${val('meta', 'account_id')}" placeholder="act_123456789"></div>
          <div><label class="text-xs text-slate-400 block mb-1">Google · Customer ID</label><input id="cs-p-google" class="${inputCls}" value="${val('google', 'customer_id')}" placeholder="123-456-7890"></div>
          <div><label class="text-xs text-slate-400 block mb-1">TikTok · Advertiser ID</label><input id="cs-p-tiktok" class="${inputCls}" value="${val('tiktok', 'advertiser_id')}"></div>
        </div>
        <button data-act="save-pauta" class="${btnCls}">Guardar y vincular con Pauta</button>`;
      }
      default: return status;
    }
  }

  // ───────────────────────── acciones

  function bindStep() {
    document.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
      openStep = openStep === b.dataset.toggle ? null : b.dataset.toggle;
      render();
    }));
    document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, b)));
    const logo = $('cs-logo-file');
    if (logo) logo.addEventListener('change', uploadLogo);
    const tg = $('cs-tg-done');
    if (tg) tg.addEventListener('change', async () => {
      if (await saveFields({ telegram_setup_done: tg.checked }, tg.checked ? 'Telegram marcado como configurado' : 'Telegram desmarcado')) await reload(false);
    });
    if (openStep === 'trello') loadBoards();
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

  async function act(name, btnEl) {
    btnEl.disabled = true;
    try {
      if (name === 'save-datos') {
        if (await saveFields({ ai_context: $('cs-ai').value }, 'Contexto guardado')) await reload(false);
      } else if (name === 'save-board') {
        const id = $('cs-board').value;
        if (!id) return toast('Elige un tablero', 'danger');
        if (await saveFields({ trello_board_id: id }, 'Tablero vinculado')) {
          liveResults = {};
          await reload(true);
        }
      } else if (name === 'create-lists') {
        const res = await post({ action: 'create_trello_lists', client_id: activeId });
        toast(`Listas creadas: ${res.created.join(', ') || 'ninguna'}`, 'success');
        await runCheck('trello_lists');
      } else if (name === 'save-project') {
        await post({
          action: 'save_project', client_id: activeId,
          alias: $('cs-pj-alias').value, project_type: $('cs-pj-type').value, budget: $('cs-pj-budget').value,
          revenue: $('cs-pj-revenue').value, hours_estimated: $('cs-pj-hours').value, currency: $('cs-pj-currency').value,
        });
        toast('Datos del proyecto guardados', 'success');
        await reload(false);
      } else if (name === 'save-sheet') {
        if (await saveFields({ sheet_id: $('cs-sheet').value }, 'Sheet guardado')) {
          await reload(false);
          await runCheck('sheet');
        }
      } else if (name === 'save-drive') {
        const fields = { drive_approval_folder_id: $('cs-appr').value };
        if (!$('cs-artes').disabled) fields.artes_folder_id = $('cs-artes').value;
        if (await saveFields(fields, 'Carpetas guardadas')) {
          await reload(false);
          await Promise.all(['approval_folder', 'artes_folder'].filter((k) => item(k)?.status === 'ok').map(runCheck));
        }
      } else if (name === 'save-roles') {
        const split = (id) => $(id).value.split(',').map((t) => t.trim()).filter(Boolean);
        await post({ action: 'save_roles', client_id: activeId, cm: split('cs-cm'), pm: split('cs-pm') });
        toast('CM y PM guardados', 'success');
        await reload(false);
      } else if (name === 'save-pauta') {
        await post({
          action: 'save_pauta', client_id: activeId,
          platforms: { meta: $('cs-p-meta').value, google: $('cs-p-google').value, tiktok: $('cs-p-tiktok').value },
        });
        toast('Pauta vinculada', 'success');
        await reload(false);
      } else if (name === 'copy-vincular') {
        await navigator.clipboard.writeText(`/vincular ${state.client.slug}`);
        toast('Comando copiado', 'success');
      }
    } catch (e) {
      toast(e.message, 'danger');
    } finally {
      btnEl.disabled = false;
    }
  }

  async function loadBoards() {
    const sel = $('cs-board');
    if (!sel) return;
    try {
      const { key, token } = Storage.getCredentials();
      if (!key || !token) throw new Error('Faltan las credenciales de Trello — configúralas en Configuración');
      const boards = await new TrelloAPI(key, token).getBoards();
      const linked = state.client.trello_board_id;
      sel.innerHTML = '<option value="">Elige el tablero de esta marca…</option>' +
        boards.map((b) => `<option value="${esc(b.id)}" ${b.id === linked ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
    } catch (e) {
      sel.innerHTML = `<option value="">${esc(e.message)}</option>`;
    }
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
      await loadClients();
      await reload(false);
    } catch (err) {
      toast(err.message, 'danger');
    }
  }

  return { init };
})();

window.ClienteSetup = ClienteSetup;
