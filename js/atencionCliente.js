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

  function renderClientCards() {
    const wrap = document.getElementById('client-cards');
    if (!clients.length) {
      wrap.innerHTML = `<p class="text-slate-500 text-sm col-span-full">Todavía no hay clientes. Crea el primero con "+ Cliente".</p>`;
      return;
    }
    wrap.innerHTML = clients.map((c) => `
      <div class="bg-slate-900 border border-slate-700 rounded-xl p-4 hover:border-indigo-500 transition-colors cursor-pointer" onclick="AtencionCliente.openClient(${c.id})">
        <div class="flex items-center justify-between mb-2">
          <h3 class="font-bold text-slate-100 truncate">${_esc(c.name)}</h3>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${c.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : 'bg-slate-700 text-slate-400'}">${_esc(c.status)}</span>
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
    await Promise.all([loadAccountsTab(), loadFlowsTab(), loadConversationsTab(), loadAdLeadFormsTab()]);
  }

  function renderClientModal() {
    const tabs = [
      { key: 'cuentas', label: 'Cuentas conectadas' },
      { key: 'flujos', label: 'Flujos' },
      { key: 'conversaciones', label: 'Conversaciones' },
      { key: 'leads', label: '🧾 Leads de Ads' },
    ];
    const tabBtns = tabs.map((t, i) => `
      <button onclick="AtencionCliente._switchTab('${t.key}')" data-tab="${t.key}"
        class="ac-tab whitespace-nowrap px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${i === 0 ? 'text-indigo-300 border-indigo-500' : 'text-slate-400 border-transparent hover:text-slate-200'}">
        ${t.label}</button>`).join('');

    document.body.insertAdjacentHTML('beforeend', `
      <div id="client-modal-overlay" onclick="AtencionCliente._overlayClose(event)" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-4xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
          <div class="px-6 py-4 border-b border-slate-700 flex items-center justify-between gap-4 flex-shrink-0">
            <h2 class="font-bold text-slate-100 text-lg truncate">${_esc(activeClient.name)}</h2>
            <button onclick="AtencionCliente.closeClientModal()" class="text-slate-400 hover:text-slate-100 text-2xl leading-none">&times;</button>
          </div>
          <div class="px-3 border-b border-slate-700 flex-shrink-0 overflow-x-auto"><div class="flex">${tabBtns}</div></div>
          <div class="overflow-y-auto flex-1 p-6">
            <div id="ac-panel-cuentas" class="ac-panel"></div>
            <div id="ac-panel-flujos" class="ac-panel" style="display:none"></div>
            <div id="ac-panel-conversaciones" class="ac-panel" style="display:none"></div>
            <div id="ac-panel-leads" class="ac-panel" style="display:none"></div>
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
      await api('api/oauth_pages.php', { method: 'POST', body: JSON.stringify({ page_id: pageId }) });
      document.getElementById('page-picker-overlay')?.remove();
      Utils.showToast('Cuenta conectada correctamente', 'success');
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

  return {
    init, openNewClientPrompt, openClient, closeClientModal, _switchTab, _overlayClose,
    createFlow, duplicateFlow, toggleFlowStatus, openBuilder, closeBuilder,
    openConversationThread, resolveFollowup, _closeThread,
    _selectPendingPage,
    loadAdLeadFormsTab, openAdLeadForm, _closeAdLeadForm, deleteAdLeadRule,
  };
})();

window.AtencionCliente = AtencionCliente;
