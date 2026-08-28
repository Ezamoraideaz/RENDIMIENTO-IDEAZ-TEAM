// Controlador de atencion-cliente.html. A diferencia del resto del dashboard (que usa
// credenciales de Trello en localStorage), este módulo habla con un backend propio
// (backend/) con login por sesión PHP, porque maneja tokens reales de Página/IG y
// puede enviar mensajes en nombre del negocio de un cliente.
const AtencionCliente = (() => {
  const API = 'backend';
  let csrfToken = '';
  let clients = [];
  let activeClient = null;

  function _esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // ── Íconos oficiales de plataforma (SVG, mismo criterio que _platIcon en js/pauta.js) ──
  let _iconSeq = 0;
  function _platformIcon(platform, size = 16) {
    const s = size;
    const st = 'display:inline-block;vertical-align:middle;flex-shrink:0';
    if (platform === 'instagram_business' || platform === 'instagram') {
      const gid = `ig-grad-${_iconSeq++}`;
      return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}" xmlns="http://www.w3.org/2000/svg">
        <defs><radialGradient id="${gid}" cx="30%" cy="107%" r="150%">
          <stop offset="0%" stop-color="#fdf497"/><stop offset="5%" stop-color="#fdf497"/>
          <stop offset="45%" stop-color="#fd5949"/><stop offset="60%" stop-color="#d6249f"/>
          <stop offset="90%" stop-color="#285AEB"/>
        </radialGradient></defs>
        <path fill="url(#${gid})" d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.012-3.584.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.332.014 7.052.072c-4.354.2-6.782 2.618-6.979 6.98C.014 8.332 0 8.741 0 12s.014 3.668.072 4.948c.2 4.358 2.618 6.78 6.98 6.98C8.332 23.986 8.741 24 12 24s3.668-.014 4.948-.072c4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.668-.072-4.948-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z"/>
      </svg>`;
    }
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}" xmlns="http://www.w3.org/2000/svg">
      <path fill="#1877F2" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
    </svg>`;
  }

  async function api(path, options = {}) {
    const opts = Object.assign({ credentials: 'include', headers: {} }, options);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers);
    if (options.method && options.method !== 'GET' && csrfToken) {
      opts.headers['X-CSRF-Token'] = csrfToken;
    }
    const res = await fetch(`${API}/${path}`, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Error ${res.status}`);
    }
    return data;
  }

  function setState(name) {
    ['login', 'loading', 'clients', 'builder'].forEach((s) => {
      const el = document.getElementById('state-' + s);
      if (el) el.style.display = (name === s) ? '' : 'none';
    });
  }

  async function init() {
    setState('loading');
    document.getElementById('login-form').addEventListener('submit', onLoginSubmit);
    try {
      const me = await api('auth/me.php');
      if (me.operator) {
        csrfToken = me.csrf_token;
        await afterLogin();
      } else {
        setState('login');
      }
    } catch (e) {
      setState('login');
    }
  }

  async function onLoginSubmit(e) {
    e.preventDefault();
    const email = document.getElementById('login-email').value.trim();
    const password = document.getElementById('login-password').value;
    const errEl = document.getElementById('login-error');
    errEl.style.display = 'none';
    try {
      const data = await api('auth/login.php', { method: 'POST', body: JSON.stringify({ email, password }) });
      csrfToken = data.csrf_token;
      await afterLogin();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.style.display = '';
    }
  }

  async function afterLogin() {
    setState('clients');
    await loadClients();
    handleOAuthRedirectParams();
  }

  async function loadClients() {
    const data = await api('api/clients.php');
    clients = data.clients;
    renderClientCards();
  }

  function _clientAvatar(c, size = 36) {
    const st = `width:${size}px;height:${size}px;border-radius:50%;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;background:linear-gradient(135deg,#caa06a,#7a5230)`;
    if (c.logo_url) {
      return `<div style="${st}"><img src="${_esc(c.logo_url)}" alt="" style="width:100%;height:100%;object-fit:cover"></div>`;
    }
    return `<div style="${st}">${_esc((c.name || '?').trim().charAt(0).toUpperCase() || '?')}</div>`;
  }

  function renderClientCards() {
    const wrap = document.getElementById('client-cards');
    if (!clients.length) {
      wrap.innerHTML = `<p class="text-slate-500 text-sm col-span-full">Todavía no hay clientes. Crea el primero con "+ Cliente".</p>`;
      return;
    }
    wrap.innerHTML = clients.map((c) => `
      <div class="bg-slate-900 border border-slate-700 rounded-xl p-4 hover:border-indigo-500 transition-colors cursor-pointer" onclick="AtencionCliente.openClient(${c.id})">
        <div class="flex items-center gap-3 mb-2">
          ${_clientAvatar(c)}
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <h3 class="font-bold text-slate-100 truncate">${_esc(c.name)}</h3>
              <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${c.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-700 text-slate-400'}">${_esc(c.status)}</span>
            </div>
          </div>
        </div>
        <p class="text-xs text-slate-500">${c.connected_accounts} cuenta${c.connected_accounts !== 1 ? 's' : ''} conectada${c.connected_accounts !== 1 ? 's' : ''}</p>
      </div>`).join('');
  }

  async function openNewClientPrompt() {
    const name = prompt('Nombre del cliente/marca:');
    if (!name) return;
    try {
      await api('api/clients.php', { method: 'POST', body: JSON.stringify({ name }) });
      Utils.showToast('Cliente creado', 'success');
      await loadClients();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // ── Modal de cliente (cuentas / flujos / conversaciones) ────────────────

  async function openClient(clientId) {
    activeClient = clients.find((c) => c.id === clientId);
    if (!activeClient) return;
    renderClientModal();
    await Promise.all([loadAccountsTab(), loadFlowsTab(), loadConversationsTab(), loadAdLeadFormsTab(), loadOrganicLeadsTab(), loadContextoTab()]);
  }

  function renderClientModal() {
    const tabs = [
      { key: 'cuentas', label: 'Cuentas conectadas' },
      { key: 'flujos', label: 'Flujos' },
      { key: 'conversaciones', label: 'Conversaciones' },
      { key: 'leads', label: '🧾 Leads de Ads' },
      { key: 'organicos', label: '📋 Leads Orgánicos' },
      { key: 'contexto', label: '🧠 Contexto IA' },
    ];
    const tabBtns = tabs.map((t, i) => `
      <button onclick="AtencionCliente._switchTab('${t.key}')" data-tab="${t.key}"
        class="ac-tab whitespace-nowrap px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${i === 0 ? 'text-indigo-300 border-indigo-500' : 'text-slate-400 border-transparent hover:text-slate-200'}">
        ${t.label}</button>`).join('');

    document.body.insertAdjacentHTML('beforeend', `
      <div id="client-modal-overlay" onclick="AtencionCliente._overlayClose(event)" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-700 flex items-center justify-between gap-4 flex-shrink-0">
            <div class="flex items-center gap-3 min-w-0">
              <button onclick="AtencionCliente.editClientLogo()" title="Cambiar logo" id="client-modal-logo" class="p-0 border-0 bg-transparent cursor-pointer flex-shrink-0 hover:opacity-80 transition-opacity">${_clientAvatar(activeClient, 40)}</button>
              <h2 class="font-bold text-slate-100 text-lg truncate">${_esc(activeClient.name)}</h2>
            </div>
            <button onclick="AtencionCliente.closeClientModal()" class="text-slate-400 hover:text-slate-100 text-2xl leading-none">&times;</button>
          </div>
          <div class="px-3 border-b border-slate-700 flex-shrink-0 overflow-x-auto"><div class="flex">${tabBtns}</div></div>
          <div class="overflow-y-auto flex-1 p-6">
            <div id="ac-panel-cuentas" class="ac-panel"></div>
            <div id="ac-panel-flujos" class="ac-panel" style="display:none"></div>
            <div id="ac-panel-conversaciones" class="ac-panel" style="display:none"></div>
            <div id="ac-panel-leads" class="ac-panel" style="display:none"></div>
            <div id="ac-panel-organicos" class="ac-panel" style="display:none"></div>
            <div id="ac-panel-contexto" class="ac-panel" style="display:none"></div>
          </div>
        </div>
      </div>`);
  }

  function _switchTab(key) {
    document.querySelectorAll('#client-modal-overlay .ac-panel').forEach((el) => {
      el.style.display = (el.id === 'ac-panel-' + key) ? '' : 'none';
    });
    document.querySelectorAll('#client-modal-overlay .ac-tab').forEach((el) => {
      const active = el.dataset.tab === key;
      el.classList.toggle('text-indigo-300', active);
      el.classList.toggle('border-indigo-500', active);
      el.classList.toggle('text-slate-400', !active);
      el.classList.toggle('border-transparent', !active);
    });
  }

  function _overlayClose(e) {
    if (e.target.id === 'client-modal-overlay') closeClientModal();
  }

  function closeClientModal() {
    document.getElementById('client-modal-overlay')?.remove();
  }

  // Logo de la marca: se muestra como avatar en la tarjeta del cliente y como
  // fondo del splash del portal de revisión (revisar.html) — hasta ahora la
  // columna logo_url existía en la BD/API pero no había forma de cargarla
  // desde ningún lado de la interfaz.
  async function editClientLogo() {
    const current = activeClient.logo_url || '';
    const url = prompt('URL del logo del cliente (imagen pública, ej. link directo de Drive/Imgur):', current);
    if (url === null) return;
    const logo_url = url.trim();
    try {
      await api('api/clients.php', { method: 'PUT', body: JSON.stringify({ id: activeClient.id, logo_url }) });
      activeClient.logo_url = logo_url;
      const inClients = clients.find((c) => c.id === activeClient.id);
      if (inClients) inClients.logo_url = logo_url;
      document.getElementById('client-modal-logo').innerHTML = _clientAvatar(activeClient, 40);
      renderClientCards();
      Utils.showToast('Logo actualizado', 'success');
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function loadAccountsTab() {
    const panel = document.getElementById('ac-panel-cuentas');
    panel.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;
    try {
      const data = await api(`api/accounts.php?client_id=${activeClient.id}`);
      const fb = data.accounts.find((a) => a.platform === 'facebook_page');
      const ig = data.accounts.find((a) => a.platform === 'instagram_business');
      panel.innerHTML = `
        <div class="flex flex-col gap-3">
          ${renderAccountRow('Facebook', _platformIcon('facebook_page', 18), fb)}
          ${renderAccountRow('Instagram', _platformIcon('instagram_business', 18), ig)}
        </div>
        <a href="${API}/oauth/facebook_connect.php?client_id=${activeClient.id}" class="inline-block mt-4 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors">
          Conectar Facebook / Instagram
        </a>
        <p class="text-xs text-slate-500 mt-2">Conectar vincula ambas plataformas a la vez si la Página de Facebook tiene una cuenta de Instagram Business asociada.</p>`;
    } catch (e) {
      panel.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  // ── Contexto de negocio para IA (nodo "ai" y respuesta con IA a comentarios) ──

  async function loadContextoTab() {
    const panel = document.getElementById('ac-panel-contexto');
    panel.innerHTML = `
      <p class="text-sm text-slate-400 mb-3">
        Contá acá lo básico del negocio de este cliente (servicios, horarios, precios, tono
        de voz). Lo usa cualquier nodo "🤖 Respuesta IA" de sus flujos y la opción "Responder
        con IA" del disparador de comentarios, para que la IA responda con información real
        en vez de inventar datos.
      </p>
      <textarea id="ac-ai-context" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm" rows="10" placeholder="Ej: Somos una peluquería en Barranquilla, abierto lunes a sábado de 9am a 7pm. Servicios: corte, color, alisado. Precios desde $30.000. No hacemos servicios a domicilio.">${_esc(activeClient.ai_context || '')}</textarea>
      <button id="ac-ai-context-save" class="mt-3 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors">Guardar contexto</button>`;
    document.getElementById('ac-ai-context-save').onclick = async () => {
      const ai_context = document.getElementById('ac-ai-context').value;
      try {
        await api('api/clients.php', { method: 'PUT', body: JSON.stringify({ id: activeClient.id, ai_context }) });
        activeClient.ai_context = ai_context;
        Utils.showToast('Contexto guardado', 'success');
      } catch (e) {
        Utils.showToast(e.message, 'danger');
      }
    };
  }

  function renderAccountRow(label, icon, account) {
    if (!account) {
      return `<div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3">
        <span class="text-sm text-slate-400">${icon} ${label} — no conectado</span>
      </div>`;
    }
    const name = account.platform === 'instagram_business' ? ('@' + (account.ig_username || account.page_name)) : account.page_name;
    const statusCls = account.status === 'active' ? 'text-emerald-400' : 'text-slate-500';
    return `<div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3">
      <span class="text-sm">${icon} ${_esc(name)}</span>
      <span class="text-xs font-semibold ${statusCls}">${_esc(account.status)}</span>
    </div>`;
  }

  let _flows = [];

  async function loadFlowsTab() {
    const panel = document.getElementById('ac-panel-flujos');
    panel.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;
    try {
      const data = await api(`api/flows.php?client_id=${activeClient.id}`);
      _flows = data.flows;
      const rows = data.flows.map((f) => `
        <div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3 cursor-pointer hover:border-indigo-500" onclick="AtencionCliente.openBuilder(${f.id})">
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">${_esc(f.name)}</p>
            <p class="text-xs text-slate-500">v${f.version} · actualizado ${new Date(f.updated_at).toLocaleString('es-MX')}</p>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${f.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : f.status === 'paused' ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-700 text-slate-400'}">${_esc(f.status)}</span>
            <button onclick="event.stopPropagation(); AtencionCliente.toggleFlowStatus(${f.id}, '${f.status}')" title="${f.status === 'active' ? 'Pausar' : 'Activar'}" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 px-2 py-1 rounded-lg text-xs transition-colors">${f.status === 'active' ? '⏸' : '▶'}</button>
            <button onclick="event.stopPropagation(); AtencionCliente.duplicateFlow(${f.id})" title="Duplicar como borrador" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 px-2 py-1 rounded-lg text-xs transition-colors">📋</button>
          </div>
        </div>`).join('');
      panel.innerHTML = `
        <div class="flex flex-col gap-2 mb-4">${rows || '<p class="text-slate-500 text-sm">Todavía no hay flujos.</p>'}</div>
        <button onclick="AtencionCliente.createFlow()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors">+ Flujo</button>`;
    } catch (e) {
      panel.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  async function createFlow() {
    const name = prompt('Nombre del flujo:');
    if (!name) return;
    try {
      const data = await api('api/flows.php', { method: 'POST', body: JSON.stringify({ client_id: activeClient.id, name }) });
      await openBuilder(data.id);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // Pausar desactiva los disparadores de ese flujo sin borrar su diseño; activar
  // (desde borrador o pausado) lo publica igual que el botón "Publicar" del builder.
  async function toggleFlowStatus(id, currentStatus) {
    const nextStatus = currentStatus === 'active' ? 'paused' : 'active';
    try {
      await api('api/flows.php', { method: 'PUT', body: JSON.stringify({ id, status: nextStatus }) });
      Utils.showToast(nextStatus === 'active' ? 'Flujo activado ✓' : 'Flujo pausado ✓', 'success');
      await loadFlowsTab();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function duplicateFlow(id) {
    const source = _flows.find((f) => Number(f.id) === Number(id));
    const defaultName = source ? `${source.name} (copia)` : 'Copia del flujo';
    const name = prompt('Nombre del flujo duplicado:', defaultName);
    if (!name) return;
    try {
      const data = await api('api/flows.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: activeClient.id, name, duplicate_of: id }),
      });
      Utils.showToast('Flujo duplicado como borrador ✓', 'success');
      await openBuilder(data.id);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // ── Inbox de conversaciones ──────────────────────────────────────────────

  function windowBadge(conv) {
    if (conv.status === 'handed_off') {
      return { label: '🙋 Con humano', cls: 'bg-sky-500/15 text-sky-400' };
    }
    if ((conv.pending_followups || 0) > 0) {
      return { label: 'Requiere seguimiento manual', cls: 'bg-amber-500/15 text-amber-400' };
    }
    const now = Date.now();
    if (conv.window_expires_at && now < new Date(conv.window_expires_at).getTime()) {
      return { label: 'Ventana abierta (24h)', cls: 'bg-emerald-500/15 text-emerald-400' };
    }
    if (conv.human_agent_tag_until && now < new Date(conv.human_agent_tag_until).getTime()) {
      return { label: 'Solo agente humano (7 días)', cls: 'bg-sky-500/15 text-sky-400' };
    }
    return { label: 'Ventana cerrada', cls: 'bg-slate-700 text-slate-400' };
  }

  async function loadConversationsTab() {
    const panel = document.getElementById('ac-panel-conversaciones');
    panel.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;
    try {
      const data = await api(`api/conversations.php?client_id=${activeClient.id}`);
      if (!data.conversations.length) {
        panel.innerHTML = `<p class="text-slate-500 text-sm">Todavía no hay conversaciones.</p>`;
        return;
      }
      panel.innerHTML = `<div id="ac-conversation-list" class="flex flex-col gap-2"></div><div id="ac-conversation-thread"></div>`;
      const list = document.getElementById('ac-conversation-list');
      list.innerHTML = data.conversations.map((conv) => {
        const badge = windowBadge(conv);
        const icon = _platformIcon(conv.platform, 14);
        let tags = [];
        try { tags = JSON.parse(conv.state_vars || '{}').tags || []; } catch (_) { /* ignorar */ }
        const tagsHtml = tags.length
          ? `<div class="flex flex-wrap gap-1 mt-1">${tags.map((t) => `<span class="text-[9px] font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-1.5 py-0.5 rounded-full">🏷️ ${_esc(String(t))}</span>`).join('')}</div>`
          : '';
        return `<div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3 cursor-pointer hover:border-indigo-500" onclick="AtencionCliente.openConversationThread(${conv.id})">
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">${icon} ${_esc(conv.contact_name || 'Contacto')}</p>
            <p class="text-xs text-slate-500 truncate max-w-md">${_esc(conv.last_message || '')}</p>
            ${tagsHtml}
          </div>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${badge.cls}">${badge.label}</span>
        </div>`;
      }).join('');
    } catch (e) {
      panel.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  async function openConversationThread(conversationId) {
    const thread = document.getElementById('ac-conversation-thread');
    const list = document.getElementById('ac-conversation-list');
    if (!thread) return;
    list.style.display = 'none';
    thread.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;

    try {
      const data = await api(`api/conversations.php?id=${conversationId}`);
      const badge = windowBadge({ ...data.conversation, pending_followups: data.pending_followups.length });
      const platformIcon = _platformIcon(data.conversation.platform, 16);

      // Origen del mensaje: DM normal vs. comentario/postback — para no confundir
      // una respuesta pública/privada de comentario con un mensaje directo.
      const MSG_TYPE_LABEL = {
        comment_reply: '💭 Comentario',
        private_reply: '💭 Respuesta a comentario',
        postback: '👆 Botón',
      };
      const bubbles = data.messages.map((m) => {
        const mine = m.direction === 'out';
        const typeLabel = MSG_TYPE_LABEL[m.message_type] || '';
        return `<div class="flex ${mine ? 'justify-end' : 'justify-start'}">
          <div class="max-w-[75%] rounded-lg px-3 py-2 text-sm ${mine ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'}">
            ${typeLabel ? `<div class="text-[10px] opacity-70 mb-1">${typeLabel}</div>` : ''}
            ${_esc(m.content || '')}
            ${m.tag === 'HUMAN_AGENT' ? '<div class="text-[10px] opacity-70 mt-1">Enviado por agente humano</div>' : ''}
          </div>
        </div>`;
      }).join('');

      const followups = data.pending_followups.map((f) => `
        <div class="bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-xs text-amber-300 flex items-center justify-between gap-2 mb-2">
          <span>Mensaje programado sin enviar (ventana cerrada) — nodo ${_esc(f.node_id)}</span>
          <button onclick="AtencionCliente.resolveFollowup(${conversationId}, ${f.id})" class="text-amber-200 underline flex-shrink-0">Marcar resuelto</button>
        </div>`).join('');

      // Datos de lead capturados por el flujo (nodos "Pregunta") + ficha del contacto.
      // Las etiquetas del flujo van aparte (tagsHtml), más visibles, justo bajo el título.
      const leadChips = [];
      if (data.conversation.contact_email) leadChips.push(`✉️ ${_esc(data.conversation.contact_email)}`);
      if (data.conversation.contact_phone) leadChips.push(`📞 ${_esc(data.conversation.contact_phone)}`);
      let tags = [];
      let csat = null;
      try {
        const vars = JSON.parse(data.conversation.state_vars || '{}');
        Object.entries(vars.fields || {}).forEach(([k, v]) => {
          if (k !== 'email' && k !== 'telefono') leadChips.push(`${_esc(k)}: ${_esc(String(v))}`);
        });
        tags = vars.tags || [];
        csat = vars.csat || null;
      } catch (_) { /* state_vars malformado: se ignora */ }
      const leadHtml = leadChips.length
        ? `<div class="flex flex-wrap gap-1.5 mb-2">${leadChips.map((c) => `<span class="text-[10px] font-semibold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 px-2 py-0.5 rounded-full">${c}</span>`).join('')}</div>`
        : '';
      const tagsHtml = tags.length
        ? `<div class="flex flex-wrap gap-1.5 mb-2">${tags.map((t) => `<span class="text-[11px] font-semibold bg-indigo-500/15 border border-indigo-500/40 text-indigo-300 px-2 py-0.5 rounded-full">🏷️ ${_esc(String(t))}</span>`).join('')}${csat ? `<span class="text-[11px] font-semibold bg-amber-500/15 border border-amber-500/40 text-amber-300 px-2 py-0.5 rounded-full">⭐ CSAT ${csat}/5</span>` : ''}</div>`
        : (csat ? `<div class="mb-2"><span class="text-[11px] font-semibold bg-amber-500/15 border border-amber-500/40 text-amber-300 px-2 py-0.5 rounded-full">⭐ CSAT ${csat}/5</span></div>` : '');
      const handoffBanner = data.conversation.status === 'handed_off'
        ? `<div class="bg-sky-500/10 border border-sky-500/30 rounded-lg px-3 py-2 text-xs text-sky-300 mb-2">🙋 Conversación transferida a humano — el bot está pausado aquí; responde tú desde abajo.</div>`
        : '';

      thread.innerHTML = `
        <button onclick="AtencionCliente._closeThread()" class="text-slate-400 hover:text-slate-100 text-xs font-semibold mb-3">← Volver a la lista</button>
        <div class="flex items-center justify-between mb-2">
          <div class="flex items-center gap-2 min-w-0">
            ${data.conversation.profile_pic_url ? `<img src="${_esc(data.conversation.profile_pic_url)}" class="w-6 h-6 rounded-full flex-shrink-0" alt="">` : ''}
            <p class="text-sm font-semibold truncate">${platformIcon} ${_esc(data.conversation.contact_name || 'Contacto')}</p>
          </div>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${badge.cls}">${badge.label}</span>
        </div>
        ${tagsHtml}
        ${leadHtml}
        ${handoffBanner}
        ${followups}
        <div class="flex flex-col gap-2 bg-slate-950 border border-slate-800 rounded-lg p-3 max-h-80 overflow-y-auto mb-3">${bubbles || '<p class="text-slate-600 text-xs">Sin mensajes todavía.</p>'}</div>
        <form id="ac-reply-form" class="flex gap-2">
          <input id="ac-reply-text" placeholder="Escribe una respuesta…" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-indigo-500">
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors">Enviar</button>
        </form>`;

      document.getElementById('ac-reply-form').addEventListener('submit', (e) => {
        e.preventDefault();
        sendManualReply(conversationId);
      });
    } catch (e) {
      thread.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  async function sendManualReply(conversationId) {
    const input = document.getElementById('ac-reply-text');
    const text = input.value.trim();
    if (!text) return;
    try {
      await api('api/messages.php', { method: 'POST', body: JSON.stringify({ conversation_id: conversationId, text }) });
      input.value = '';
      await openConversationThread(conversationId);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function resolveFollowup(conversationId, scheduledActionId) {
    const text = prompt('Texto del mensaje pendiente a enviar ahora:');
    if (!text) return;
    try {
      await api('api/messages.php', { method: 'POST', body: JSON.stringify({ conversation_id: conversationId, text, scheduled_action_id: scheduledActionId }) });
      await openConversationThread(conversationId);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  function _closeThread() {
    const list = document.getElementById('ac-conversation-list');
    const thread = document.getElementById('ac-conversation-thread');
    if (thread) thread.innerHTML = '';
    if (list) list.style.display = '';
  }

  // ── Constructor de flujos ────────────────────────────────────────────────

  async function openBuilder(flowId) {
    closeClientModal();
    setState('builder');
    await FlowBuilder.load(flowId, { api });
  }

  function closeBuilder() {
    FlowBuilder.destroy();
    setState('clients');
    loadClients();
  }

  // ── Redirect de vuelta desde backend/oauth/facebook_callback.php ────────

  function handleOAuthRedirectParams() {
    const params = new URLSearchParams(window.location.search);
    if (params.get('oauth_select_page')) {
      const clientId = parseInt(params.get('client_id'), 10);
      window.history.replaceState({}, '', 'atencion-cliente.html');
      if (clientId) showPagePicker(clientId);
    } else if (params.get('oauth_success')) {
      Utils.showToast('Cuenta conectada correctamente', 'success');
      const clientId = parseInt(params.get('client_id'), 10);
      window.history.replaceState({}, '', 'atencion-cliente.html');
      if (clientId) openClient(clientId);
    } else if (params.get('oauth_error')) {
      Utils.showToast('Error al conectar: ' + params.get('oauth_error'), 'danger');
      window.history.replaceState({}, '', 'atencion-cliente.html');
    }
  }

  // ── Selector de Página (cuando la cuenta de Facebook administra varias) ─

  async function showPagePicker(clientId) {
    try {
      const data = await api('api/oauth_pages.php');
      if (!data.pages.length) {
        Utils.showToast('No hay páginas pendientes de selección', 'danger');
        return;
      }
      const rows = data.pages.map((p) => `
        <button onclick="AtencionCliente._selectPendingPage('${p.id}', ${clientId})"
          class="w-full text-left flex items-center justify-between bg-slate-800/60 border border-slate-700/60 hover:border-indigo-500 rounded-lg px-4 py-3 transition-colors">
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">${_platformIcon('facebook_page', 14)} ${_esc(p.name)}</p>
            ${p.has_instagram
              ? `<p class="text-xs text-slate-500">${_platformIcon('instagram_business', 12)} @${_esc(p.instagram_username || '')} vinculada</p>`
              : '<p class="text-xs text-slate-600">Sin cuenta de Instagram vinculada</p>'}
          </div>
        </button>`).join('');

      document.body.insertAdjacentHTML('beforeend', `
        <div id="page-picker-overlay" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
          <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md p-6">
            <h3 class="font-bold text-lg mb-1">Elige la Página a conectar</h3>
            <p class="text-xs text-slate-500 mb-4">Tu cuenta de Facebook administra varias Páginas — elige cuál corresponde a este cliente.</p>
            <div class="flex flex-col gap-2 max-h-96 overflow-y-auto">${rows}</div>
          </div>
        </div>`);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function _selectPendingPage(pageId, clientId) {
    try {
      const result = await api('api/oauth_pages.php', { method: 'POST', body: JSON.stringify({ page_id: pageId }) });
      document.getElementById('page-picker-overlay')?.remove();
      if (result.webhook_warning) {
        Utils.showToast(result.webhook_warning, 'danger');
      } else {
        Utils.showToast('Cuenta conectada correctamente', 'success');
      }
      await loadClients();
      openClient(clientId);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // ── Leads de Ads (formularios instantáneos de Meta Ads) ─────────────────

  let _adLeadForms = [];

  async function loadAdLeadFormsTab() {
    const panel = document.getElementById('ac-panel-leads');
    panel.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;
    try {
      const data = await api(`api/ad_leads.php?client_id=${activeClient.id}`);
      _adLeadForms = data.forms;
      if (!data.forms.length) {
        panel.innerHTML = `<p class="text-slate-500 text-sm">Todavía no hay formularios de leads detectados. Reconecta la página de Facebook (para otorgar el permiso de leads) y verifica que tengas al menos un formulario instantáneo publicado.</p>`;
        return;
      }
      panel.innerHTML = `<div id="ad-lead-forms-list" class="flex flex-col gap-2"></div><div id="ad-lead-form-detail"></div>`;
      document.getElementById('ad-lead-forms-list').innerHTML = data.forms.map((f) => `
        <div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3 cursor-pointer hover:border-indigo-500"
          onclick="AtencionCliente.openAdLeadForm('${f.form_id}')">
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">${_platformIcon('facebook_page', 14)} ${_esc(f.form_name)}</p>
            <p class="text-xs text-slate-500 truncate">${_esc(f.page_name)}${f.status ? ' · ' + _esc(f.status) : ''}</p>
          </div>
          <div class="text-right flex-shrink-0">
            <p class="text-sm font-bold text-indigo-400">${f.leads_count}</p>
            <p class="text-[10px] text-slate-500">${f.last_lead_at ? new Date(f.last_lead_at).toLocaleDateString('es-MX') : 'sin leads'}</p>
          </div>
        </div>`).join('');
    } catch (e) {
      panel.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  async function renderAdLeadRuleSection(form) {
    let rules = [];
    try {
      const data = await api(`api/ad_lead_rules.php?social_account_id=${form.social_account_id}`);
      rules = (data.rules || []).filter((r) => r.form_id === form.form_id || !r.form_id);
    } catch (_) { /* si falla, se muestra igual el formulario para crear una nueva */ }

    const rulesHtml = rules.map((r) => `
      <div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-2 text-xs">
        <span class="text-slate-300">${r.campaign_name ? 'Campaña contiene "' + _esc(r.campaign_name) + '"' : 'Cualquier campaña'}${r.tag ? ' · 🏷️ ' + _esc(r.tag) : ''}${r.notify_email ? ' · ✉️ ' + _esc(r.notify_email) : ''}</span>
        <button onclick="AtencionCliente.deleteAdLeadRule(${r.id}, '${form.form_id}')" class="text-red-400 hover:text-red-300">✕</button>
      </div>`).join('');

    return `
      <div class="bg-slate-900 border border-slate-700 rounded-lg p-3 mb-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">Notificación / etiqueta para este formulario</p>
        <div class="flex flex-col gap-1.5 mb-2">${rulesHtml || '<p class="text-xs text-slate-600">Sin reglas todavía — el lead se respalda igual, solo sin notificar a nadie.</p>'}</div>
        <form id="ad-lead-rule-form" class="flex flex-wrap gap-2 items-end">
          <div><label class="text-[10px] text-slate-500 block">Campaña contiene (opcional)</label>
            <input id="rule-campaign" class="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs w-36"></div>
          <div><label class="text-[10px] text-slate-500 block">Etiqueta (opcional)</label>
            <input id="rule-tag" class="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs w-28"></div>
          <div><label class="text-[10px] text-slate-500 block">Notificar a (opcional)</label>
            <input id="rule-email" type="email" class="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs w-44"></div>
          <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded text-xs font-semibold">+ Agregar regla</button>
        </form>
      </div>`;
  }

  function bindAdLeadRuleForm(form) {
    const el = document.getElementById('ad-lead-rule-form');
    if (!el) return;
    el.addEventListener('submit', async (e) => {
      e.preventDefault();
      const campaign_name = document.getElementById('rule-campaign').value.trim();
      const tag = document.getElementById('rule-tag').value.trim();
      const notify_email = document.getElementById('rule-email').value.trim();
      if (!tag && !notify_email) { Utils.showToast('Define al menos una etiqueta o un correo', 'warning'); return; }
      try {
        await api('api/ad_lead_rules.php', {
          method: 'POST',
          body: JSON.stringify({ social_account_id: form.social_account_id, form_id: form.form_id, campaign_name, tag, notify_email }),
        });
        Utils.showToast('Regla guardada ✓', 'success');
        openAdLeadForm(form.form_id);
      } catch (err) {
        Utils.showToast(err.message, 'danger');
      }
    });
  }

  async function deleteAdLeadRule(id, formId) {
    try {
      await api(`api/ad_lead_rules.php?id=${id}`, { method: 'DELETE' });
      Utils.showToast('Regla eliminada', 'success');
      openAdLeadForm(formId);
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function openAdLeadForm(formId) {
    const form = _adLeadForms.find((f) => f.form_id === formId);
    const listEl = document.getElementById('ad-lead-forms-list');
    const detailEl = document.getElementById('ad-lead-form-detail');
    if (!detailEl || !form) return;
    listEl.style.display = 'none';
    detailEl.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;

    try {
      const [data, rulesHtml] = await Promise.all([
        api(`api/ad_leads.php?client_id=${activeClient.id}&form_id=${encodeURIComponent(formId)}`),
        renderAdLeadRuleSection(form),
      ]);

      const leadsHtml = data.leads.map((lead) => {
        let fields = [];
        try { fields = JSON.parse(lead.field_data || '[]'); } catch (_) { /* ignorar */ }
        const chips = fields.map((f) => `<span class="text-[10px] bg-slate-800 border border-slate-700 text-slate-300 px-2 py-0.5 rounded-full">${_esc(f.name)}: ${_esc((f.values || []).join(', '))}</span>`).join('');
        return `
          <div class="bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3">
            <div class="flex items-center justify-between mb-1">
              <p class="text-sm font-semibold">${_esc(lead.name || 'Sin nombre')}</p>
              <span class="text-[10px] text-slate-500">${lead.lead_created_at ? new Date(lead.lead_created_at).toLocaleString('es-MX') : ''}</span>
            </div>
            <p class="text-xs text-slate-400 mb-2">${lead.email ? '✉️ ' + _esc(lead.email) + '  ' : ''}${lead.phone ? '📞 ' + _esc(lead.phone) : ''}</p>
            ${lead.tag ? `<span class="text-[10px] font-semibold bg-indigo-500/15 border border-indigo-500/40 text-indigo-300 px-2 py-0.5 rounded-full inline-block mb-2">🏷️ ${_esc(lead.tag)}</span>` : ''}
            <div class="flex flex-wrap gap-1.5 mt-1">${chips}</div>
          </div>`;
      }).join('');

      detailEl.innerHTML = `
        <button onclick="AtencionCliente._closeAdLeadForm()" class="text-slate-400 hover:text-slate-100 text-xs font-semibold mb-3">← Volver a formularios</button>
        <h3 class="text-sm font-bold text-slate-100 mb-1">${_esc(form.form_name)}</h3>
        <p class="text-xs text-slate-500 mb-4">${data.leads.length} lead(s) respaldado(s) — Meta solo los conserva ~90 días, aquí quedan para siempre.</p>
        ${rulesHtml}
        <div class="flex flex-col gap-2 mt-4">${leadsHtml || '<p class="text-slate-500 text-sm">Sin leads todavía.</p>'}</div>`;
      bindAdLeadRuleForm(form);
    } catch (e) {
      detailEl.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  function _closeAdLeadForm() {
    document.getElementById('ad-lead-form-detail').innerHTML = '';
    const listEl = document.getElementById('ad-lead-forms-list');
    if (listEl) listEl.style.display = '';
  }

  // ── Leads Orgánicos (base propia por cliente, importada desde Excel/CSV) ──
  // Importar / Notificar / Link público van en <details> colapsables (cerrados
  // por defecto) para no mostrar las 3 áreas de administración a la vez — la
  // tabla de leads es lo único que queda siempre visible. Cada acción (agregar
  // correo, generar link, borrar un lead) actualiza solo su propio bloque en
  // vez de recargar toda la pestaña, así los <details> abiertos no se cierran solos.

  const ORGANIC_LEADS_HELP_HTML = `
    <div class="space-y-2">
      <p><strong class="text-slate-300">Formatos:</strong> .xlsx o .csv, máx. 5 MB. La primera fila debe ser encabezados, y de un .xlsx solo se lee la primera hoja.</p>
      <p><strong class="text-slate-300">Encabezados que reconoce</strong> (sin importar mayúsculas/tildes):</p>
      <ul class="list-disc list-inside space-y-0.5">
        <li><strong class="text-slate-300">Fecha:</strong> fecha, fecha de contacto, fecha del lead, fecha de registro, date</li>
        <li><strong class="text-slate-300">Nombre:</strong> nombre, nombre completo, name, full name, cliente, contacto</li>
        <li><strong class="text-slate-300">Correo:</strong> correo, correo electronico, email, e-mail, mail</li>
        <li><strong class="text-slate-300">Teléfono:</strong> telefono, celular, whatsapp, phone, phone number, numero</li>
        <li><strong class="text-slate-300">Fuente:</strong> fuente, origen, plataforma, canal, medio, como nos conociste, source</li>
        <li><strong class="text-slate-300">Motivo:</strong> motivo, servicio, producto, interes, mensaje, comentarios, observaciones, detalle, notas</li>
      </ul>
      <p>La fecha acepta formatos como 31/12/2025, 2025-12-31 o la fecha nativa de Excel; si no se reconoce, el lead se guarda igual pero sin fecha.</p>
      <p>El resto de columnas (no reconocidas) se guarda igual — sale en el CSV exportado aunque no se muestre en esta tabla.</p>
      <p>Reimportar el mismo archivo duplica los leads — no hay detección automática de duplicados.</p>
    </div>`;

  let _organicLeadManualRowSeq = 0;
  let _organicLeadsDateFrom = '';
  let _organicLeadsDateTo = '';

  async function loadOrganicLeadsTab() {
    const panel = document.getElementById('ac-panel-organicos');
    panel.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;
    _organicLeadManualRowSeq = 0;
    _organicLeadsDateFrom = '';
    _organicLeadsDateTo = '';
    try {
      const [leadsData, notifyData, shareData] = await Promise.all([
        api(`api/organic_leads.php?client_id=${activeClient.id}`),
        api(`api/organic_lead_notify_emails.php?client_id=${activeClient.id}`),
        api(`api/organic_lead_share.php?client_id=${activeClient.id}`),
      ]);
      panel.innerHTML = renderOrganicLeadsPanel(leadsData, notifyData, shareData);
      bindOrganicLeadsPanel();
    } catch (e) {
      panel.innerHTML = `<p class="text-red-400 text-sm">${_esc(e.message)}</p>`;
    }
  }

  function renderOrganicLeadsPanel(leadsData, notifyData, shareData) {
    const emails = notifyData.emails || [];
    return `
      <details class="bg-slate-900 border border-slate-700 rounded-lg mb-3 overflow-hidden">
        <summary class="px-4 py-3 cursor-pointer select-none text-sm font-semibold text-slate-200 hover:bg-slate-800/60">📥 Importar leads</summary>
        <div class="px-4 pb-4 pt-1">
          <div class="flex items-center justify-between gap-2 mb-2">
            <p class="text-xs text-slate-500">Sube un Excel (.xlsx) o CSV para sumar leads a este cliente.</p>
            <button type="button" id="organic-leads-help-btn" class="text-slate-400 hover:text-slate-200 text-xs font-semibold flex-shrink-0">❓ Ayuda con el formato</button>
          </div>
          <div id="organic-leads-help" style="display:none" class="mb-3 bg-slate-800/60 border border-slate-700/60 rounded-lg p-3 text-xs text-slate-400">${ORGANIC_LEADS_HELP_HTML}</div>
          <form id="organic-leads-import-form" class="flex flex-wrap items-center gap-2">
            <input type="file" id="organic-leads-file" accept=".xlsx,.csv" required
              class="text-xs text-slate-400 file:mr-2 file:bg-slate-800 file:border file:border-slate-700 file:text-slate-200 file:rounded-lg file:px-3 file:py-1.5 file:text-xs file:font-semibold file:cursor-pointer">
            <button type="submit" id="organic-leads-import-btn" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-colors">Importar</button>
          </form>
        </div>
      </details>

      <details class="bg-slate-900 border border-slate-700 rounded-lg mb-3 overflow-hidden">
        <summary class="px-4 py-3 cursor-pointer select-none text-sm font-semibold text-slate-200 hover:bg-slate-800/60">✍️ Agregar leads a mano</summary>
        <div class="px-4 pb-4 pt-1">
          <p class="text-xs text-slate-500 mb-2">Cargá uno o varios leads a mano — usá "+ Fila" para agregar varios de una vez y "Guardar" al terminar.</p>
          <datalist id="organic-leads-source-suggestions">${ORGANIC_LEAD_SOURCE_SUGGESTIONS.map((s) => `<option value="${_esc(s)}">`).join('')}</datalist>
          <div id="organic-leads-manual-rows" class="flex flex-col gap-2 mb-3">${[0, 1].map(() => renderOrganicLeadManualRow(_organicLeadManualRowSeq++)).join('')}</div>
          <div class="flex items-center gap-2">
            <button type="button" id="organic-leads-manual-add-row" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">+ Fila</button>
            <button type="button" id="organic-leads-manual-save" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg text-xs font-semibold transition-colors">Guardar leads</button>
          </div>
        </div>
      </details>

      <details class="bg-slate-900 border border-slate-700 rounded-lg mb-3 overflow-hidden">
        <summary class="px-4 py-3 cursor-pointer select-none text-sm font-semibold text-slate-200 hover:bg-slate-800/60">✉️ Notificar por correo <span id="organic-leads-notify-count" class="text-slate-500 font-normal">(${emails.length})</span></summary>
        <div class="px-4 pb-4 pt-1">
          <div id="organic-leads-notify-list" class="flex flex-col gap-1.5 mb-2">${renderOrganicLeadsNotifyList(emails)}</div>
          <form id="organic-leads-notify-form" class="flex gap-2">
            <input id="organic-leads-notify-email" type="email" required placeholder="correo@ejemplo.com" class="bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs flex-1">
            <button type="submit" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded text-xs font-semibold">+ Agregar</button>
          </form>
        </div>
      </details>

      <details class="bg-slate-900 border border-slate-700 rounded-lg mb-4 overflow-hidden">
        <summary class="px-4 py-3 cursor-pointer select-none text-sm font-semibold text-slate-200 hover:bg-slate-800/60">🔗 Link público de solo lectura <span id="organic-leads-share-status" class="text-slate-500 font-normal">${shareData.link_generated ? '· activo' : ''}</span></summary>
        <div class="px-4 pb-4 pt-1">
          <div id="organic-leads-share-box">${renderOrganicLeadsShareBox(shareData.link_generated)}</div>
        </div>
      </details>

      <div id="organic-leads-table-section">${renderOrganicLeadsTableSection(leadsData)}</div>`;
  }

  function renderOrganicLeadsNotifyList(emails) {
    return emails.map((e) => `
      <div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-3 py-1.5 text-xs">
        <span class="text-slate-300">✉️ ${_esc(e.email)}</span>
        <button onclick="AtencionCliente.removeOrganicLeadNotifyEmail(${e.id})" class="text-red-400 hover:text-red-300">✕</button>
      </div>`).join('') || '<p class="text-xs text-slate-600">Sin correos todavía — el import se guarda igual, solo sin avisar a nadie.</p>';
  }

  function renderOrganicLeadsShareBox(linkGenerated) {
    return linkGenerated
      ? `<p class="text-xs text-slate-400 mb-2">Ya hay un link activo para este cliente. Si lo perdiste, regenera uno nuevo (el anterior deja de funcionar).</p>
         <div class="flex gap-2">
           <button onclick="AtencionCliente.generateOrganicLeadShareLink()" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">Regenerar</button>
           <button onclick="AtencionCliente.revokeOrganicLeadShareLink()" class="bg-slate-800 hover:bg-red-900/40 border border-red-700/50 text-red-400 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">Revocar</button>
         </div>`
      : `<p class="text-xs text-slate-500 mb-2">Todavía no hay link generado para este cliente.</p>
         <button onclick="AtencionCliente.generateOrganicLeadShareLink()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">Generar link</button>`;
  }

  // Se muestra una sola vez, justo al generar/regenerar — el backend nunca
  // vuelve a devolver el token crudo (solo guarda su hash).
  function renderOrganicLeadsShareReveal(url) {
    return `
      <div class="bg-slate-800 border border-slate-700 rounded-lg p-3 mb-3">
        <p class="text-xs text-slate-400 mb-2">Cópialo ahora y compártelo con el equipo comercial — no se puede volver a ver:</p>
        <div class="flex gap-2">
          <input type="text" id="organic-leads-share-url" readonly value="${_esc(url)}" onclick="this.select()"
            class="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-300">
          <button type="button" id="organic-leads-copy-link-btn" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded text-xs font-semibold flex-shrink-0">📋 Copiar</button>
        </div>
      </div>
      ${renderOrganicLeadsShareBox(true)}`;
  }

  function _organicLeadsFilterQS() {
    let qs = '';
    if (_organicLeadsDateFrom) qs += `&date_from=${_organicLeadsDateFrom}`;
    if (_organicLeadsDateTo) qs += `&date_to=${_organicLeadsDateTo}`;
    return qs;
  }

  function renderOrganicLeadsTableSection(leadsData) {
    const leads = leadsData.leads || [];
    const filterHtml = `
      <div class="flex flex-wrap items-center gap-2 mb-2">
        <label class="text-xs text-slate-500 flex items-center gap-1">Desde
          <input type="date" id="organic-leads-filter-from" value="${_organicLeadsDateFrom}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs">
        </label>
        <label class="text-xs text-slate-500 flex items-center gap-1">Hasta
          <input type="date" id="organic-leads-filter-to" value="${_organicLeadsDateTo}" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs">
        </label>
        ${(_organicLeadsDateFrom || _organicLeadsDateTo)
          ? `<button type="button" id="organic-leads-filter-clear" class="text-xs text-slate-400 hover:text-slate-200">✕ Limpiar filtro</button>`
          : ''}
      </div>`;

    const tableHtml = leads.length ? `
      <div class="max-h-96 overflow-y-auto border border-slate-800 rounded-lg">
        <table class="w-full text-xs">
          <thead class="sticky top-0 bg-slate-900">
            <tr class="text-left text-slate-500 border-b border-slate-700">
              <th class="py-2 px-3">Fecha</th><th class="py-2 px-3">Nombre</th><th class="py-2 px-3">Correo</th><th class="py-2 px-3">Teléfono</th><th class="py-2 px-3">Fuente</th><th class="py-2 px-3">Motivo</th><th></th>
            </tr>
          </thead>
          <tbody>
            ${leads.map((l) => `
              <tr class="border-b border-slate-800/60">
                <td class="py-1.5 px-3 text-slate-500 whitespace-nowrap">${l.lead_date ? new Date(l.lead_date + 'T00:00:00').toLocaleDateString('es-MX') : '—'}</td>
                <td class="py-1.5 px-3">${_esc(l.name || '—')}</td>
                <td class="py-1.5 px-3">${_esc(l.email || '—')}</td>
                <td class="py-1.5 px-3">${_esc(l.phone || '—')}</td>
                <td class="py-1.5 px-3 text-slate-400 whitespace-nowrap">${_esc(l.source || '—')}</td>
                <td class="py-1.5 px-3 max-w-[240px]">${l.reason
                  ? `<span class="line-clamp-2 cursor-pointer hover:text-slate-100" title="Click para expandir/contraer" onclick="this.classList.toggle('line-clamp-2')">${_esc(l.reason)}</span>`
                  : '—'}</td>
                <td class="py-1.5 px-3 text-right"><button onclick="AtencionCliente.deleteOrganicLead(${l.id})" class="text-red-400 hover:text-red-300">✕</button></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>` : `<p class="text-slate-500 text-sm">Todavía no hay leads importados.</p>`;

    return `
      ${filterHtml}
      <div class="flex items-center justify-between mb-2">
        <p class="text-sm font-semibold text-slate-200">${leads.length} de ${leadsData.total ?? leads.length} lead(s)</p>
        <a href="${API}/api/organic_leads.php?client_id=${activeClient.id}&export=csv${_organicLeadsFilterQS()}" class="text-xs font-semibold text-indigo-400 hover:text-indigo-300">⬇️ Exportar CSV</a>
      </div>
      ${tableHtml}`;
  }

  async function refreshOrganicLeadsTable() {
    const section = document.getElementById('organic-leads-table-section');
    if (!section) return;
    const data = await api(`api/organic_leads.php?client_id=${activeClient.id}${_organicLeadsFilterQS()}`);
    section.innerHTML = renderOrganicLeadsTableSection(data);
    bindOrganicLeadsFilterInputs();
  }

  function bindOrganicLeadsFilterInputs() {
    const fromInput = document.getElementById('organic-leads-filter-from');
    const toInput = document.getElementById('organic-leads-filter-to');
    const clearBtn = document.getElementById('organic-leads-filter-clear');
    if (fromInput) fromInput.addEventListener('change', () => {
      _organicLeadsDateFrom = fromInput.value;
      refreshOrganicLeadsTable();
    });
    if (toInput) toInput.addEventListener('change', () => {
      _organicLeadsDateTo = toInput.value;
      refreshOrganicLeadsTable();
    });
    if (clearBtn) clearBtn.addEventListener('click', () => {
      _organicLeadsDateFrom = '';
      _organicLeadsDateTo = '';
      refreshOrganicLeadsTable();
    });
  }

  const ORGANIC_LEAD_SOURCE_SUGGESTIONS = ['Facebook', 'Instagram', 'WhatsApp', 'Referido', 'Sitio web', 'Google', 'TikTok', 'Llamada', 'Otro'];

  // Una fila = un lead a mano. Cada una tiene su propio data-row-id para poder
  // quitarla sin afectar a las demás; los primeros 5 campos van en una fila
  // (12 columnas), Motivo se envuelve solo a la siguiente por ser más largo.
  function renderOrganicLeadManualRow(rowId) {
    return `
      <div class="grid grid-cols-2 sm:grid-cols-12 gap-2 items-start bg-slate-800/40 border border-slate-700/40 rounded-lg p-2" data-row-id="${rowId}">
        <input type="date" class="ol-manual-date sm:col-span-2 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs">
        <input type="text" placeholder="Nombre" class="ol-manual-name sm:col-span-2 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs">
        <input type="email" placeholder="Correo" class="ol-manual-email sm:col-span-3 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs">
        <input type="text" placeholder="Teléfono" class="ol-manual-phone sm:col-span-2 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs">
        <input type="text" placeholder="Fuente" list="organic-leads-source-suggestions" class="ol-manual-source sm:col-span-3 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs">
        <textarea placeholder="Motivo" rows="1" class="ol-manual-reason col-span-2 sm:col-span-11 bg-slate-800 border border-slate-700 rounded px-2 py-1.5 text-xs resize-y"></textarea>
        <button type="button" onclick="AtencionCliente.removeOrganicLeadManualRow(${rowId})" title="Quitar fila" class="sm:col-span-1 text-red-400 hover:text-red-300 text-xs justify-self-end">✕</button>
      </div>`;
  }

  function addOrganicLeadManualRow() {
    document.getElementById('organic-leads-manual-rows')
      .insertAdjacentHTML('beforeend', renderOrganicLeadManualRow(_organicLeadManualRowSeq++));
  }

  function removeOrganicLeadManualRow(rowId) {
    document.querySelector(`#organic-leads-manual-rows [data-row-id="${rowId}"]`)?.remove();
  }

  async function saveOrganicLeadManualRows() {
    const rows = Array.from(document.querySelectorAll('#organic-leads-manual-rows [data-row-id]'));
    const leads = rows.map((row) => ({
      lead_date: row.querySelector('.ol-manual-date').value.trim(),
      name: row.querySelector('.ol-manual-name').value.trim(),
      email: row.querySelector('.ol-manual-email').value.trim(),
      phone: row.querySelector('.ol-manual-phone').value.trim(),
      source: row.querySelector('.ol-manual-source').value.trim(),
      reason: row.querySelector('.ol-manual-reason').value.trim(),
    })).filter((l) => l.name || l.email || l.phone || l.source || l.reason);

    if (!leads.length) {
      Utils.showToast('Completa al menos un campo en alguna fila', 'warning');
      return;
    }

    const btn = document.getElementById('organic-leads-manual-save');
    btn.disabled = true;
    try {
      const data = await api('api/organic_lead_manual.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: activeClient.id, leads }),
      });
      Utils.showToast(`${data.row_count} lead(s) agregado(s) ✓`, 'success');
      _organicLeadManualRowSeq = 0;
      document.getElementById('organic-leads-manual-rows').innerHTML =
        [0, 1].map(() => renderOrganicLeadManualRow(_organicLeadManualRowSeq++)).join('');
      await refreshOrganicLeadsTable();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    } finally {
      btn.disabled = false;
    }
  }

  function bindOrganicLeadsPanel() {
    const importForm = document.getElementById('organic-leads-import-form');
    if (importForm) importForm.addEventListener('submit', importOrganicLeadsFile);
    const notifyForm = document.getElementById('organic-leads-notify-form');
    if (notifyForm) notifyForm.addEventListener('submit', addOrganicLeadNotifyEmail);
    const helpBtn = document.getElementById('organic-leads-help-btn');
    if (helpBtn) helpBtn.addEventListener('click', () => {
      const box = document.getElementById('organic-leads-help');
      box.style.display = box.style.display === 'none' ? '' : 'none';
    });
    const manualAddBtn = document.getElementById('organic-leads-manual-add-row');
    if (manualAddBtn) manualAddBtn.addEventListener('click', addOrganicLeadManualRow);
    const manualSaveBtn = document.getElementById('organic-leads-manual-save');
    if (manualSaveBtn) manualSaveBtn.addEventListener('click', saveOrganicLeadManualRows);
    bindOrganicLeadsFilterInputs();
  }

  function bindOrganicLeadsCopyButton() {
    const btn = document.getElementById('organic-leads-copy-link-btn');
    const input = document.getElementById('organic-leads-share-url');
    if (!btn || !input) return;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(input.value);
        Utils.showToast('Link copiado ✓', 'success');
      } catch (_) {
        input.select();
        Utils.showToast('No se pudo copiar solo — selecciónalo y usa Ctrl+C', 'warning');
      }
    });
  }

  // Multipart: no puede pasar por api() (fuerza Content-Type: application/json),
  // así que arma su propio fetch — pero igual manda X-CSRF-Token a mano.
  async function importOrganicLeadsFile(e) {
    e.preventDefault();
    const fileInput = document.getElementById('organic-leads-file');
    const file = fileInput.files[0];
    if (!file) return;
    const btn = document.getElementById('organic-leads-import-btn');
    btn.disabled = true;
    btn.textContent = 'Importando…';
    try {
      const formData = new FormData();
      formData.append('client_id', activeClient.id);
      formData.append('file', file);
      const res = await fetch(`${API}/api/organic_lead_import.php`, {
        method: 'POST',
        credentials: 'include',
        headers: csrfToken ? { 'X-CSRF-Token': csrfToken } : {},
        body: formData,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
      Utils.showToast(`${data.row_count} lead(s) importado(s) ✓`, 'success');
      fileInput.value = '';
      await refreshOrganicLeadsTable();
    } catch (err) {
      Utils.showToast(err.message, 'danger');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Importar';
    }
  }

  async function deleteOrganicLead(id) {
    if (!confirm('¿Eliminar este lead?')) return;
    try {
      await api(`api/organic_leads.php?id=${id}`, { method: 'DELETE' });
      await refreshOrganicLeadsTable();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function addOrganicLeadNotifyEmail(e) {
    e.preventDefault();
    const input = document.getElementById('organic-leads-notify-email');
    const email = input.value.trim();
    if (!email) return;
    try {
      await api('api/organic_lead_notify_emails.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: activeClient.id, email }),
      });
      input.value = '';
      const data = await api(`api/organic_lead_notify_emails.php?client_id=${activeClient.id}`);
      document.getElementById('organic-leads-notify-list').innerHTML = renderOrganicLeadsNotifyList(data.emails || []);
      document.getElementById('organic-leads-notify-count').textContent = `(${(data.emails || []).length})`;
    } catch (err) {
      Utils.showToast(err.message, 'danger');
    }
  }

  async function removeOrganicLeadNotifyEmail(id) {
    try {
      await api(`api/organic_lead_notify_emails.php?id=${id}`, { method: 'DELETE' });
      const data = await api(`api/organic_lead_notify_emails.php?client_id=${activeClient.id}`);
      document.getElementById('organic-leads-notify-list').innerHTML = renderOrganicLeadsNotifyList(data.emails || []);
      document.getElementById('organic-leads-notify-count').textContent = `(${(data.emails || []).length})`;
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function generateOrganicLeadShareLink() {
    try {
      const data = await api('api/organic_lead_share.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: activeClient.id, action: 'generate_link' }),
      });
      const base = location.origin + location.pathname.replace(/[^/]*$/, '');
      const url = `${base}leads-cliente.html?t=${data.token}`;
      document.getElementById('organic-leads-share-box').innerHTML = renderOrganicLeadsShareReveal(url);
      document.getElementById('organic-leads-share-status').textContent = '· activo';
      bindOrganicLeadsCopyButton();
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function revokeOrganicLeadShareLink() {
    if (!confirm('¿Revocar el link público? El equipo comercial dejará de poder acceder a los registros.')) return;
    try {
      await api('api/organic_lead_share.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: activeClient.id, action: 'revoke_link' }),
      });
      Utils.showToast('Link revocado', 'success');
      document.getElementById('organic-leads-share-box').innerHTML = renderOrganicLeadsShareBox(false);
      document.getElementById('organic-leads-share-status').textContent = '';
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  return {
    init, openNewClientPrompt, openClient, closeClientModal, editClientLogo, _switchTab, _overlayClose,
    createFlow, duplicateFlow, toggleFlowStatus, openBuilder, closeBuilder,
    openConversationThread, resolveFollowup, _closeThread,
    _selectPendingPage,
    loadAdLeadFormsTab, openAdLeadForm, _closeAdLeadForm, deleteAdLeadRule,
    loadOrganicLeadsTab, deleteOrganicLead, addOrganicLeadNotifyEmail, removeOrganicLeadNotifyEmail,
    generateOrganicLeadShareLink, revokeOrganicLeadShareLink, removeOrganicLeadManualRow,
  };
})();

window.AtencionCliente = AtencionCliente;
