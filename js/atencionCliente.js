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
    await Promise.all([loadAccountsTab(), loadFlowsTab(), loadConversationsTab()]);
  }

  function renderClientModal() {
    const tabs = [
      { key: 'cuentas', label: 'Cuentas conectadas' },
      { key: 'flujos', label: 'Flujos' },
      { key: 'conversaciones', label: 'Conversaciones' },
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
          ${renderAccountRow('Facebook', '📘', fb)}
          ${renderAccountRow('Instagram', '📷', ig)}
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

  async function loadFlowsTab() {
    const panel = document.getElementById('ac-panel-flujos');
    panel.innerHTML = `<p class="text-slate-500 text-sm">Cargando…</p>`;
    try {
      const data = await api(`api/flows.php?client_id=${activeClient.id}`);
      const rows = data.flows.map((f) => `
        <div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3 cursor-pointer hover:border-indigo-500" onclick="AtencionCliente.openBuilder(${f.id})">
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">${_esc(f.name)}</p>
            <p class="text-xs text-slate-500">v${f.version} · actualizado ${new Date(f.updated_at).toLocaleString('es-MX')}</p>
          </div>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${f.status === 'active' ? 'bg-emerald-500/15 text-emerald-400' : f.status === 'paused' ? 'bg-amber-500/15 text-amber-400' : 'bg-slate-700 text-slate-400'}">${_esc(f.status)}</span>
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

  // ── Inbox de conversaciones ──────────────────────────────────────────────

  function windowBadge(conv) {
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
        const icon = conv.platform === 'instagram_business' ? '📷' : '📘';
        return `<div class="flex items-center justify-between bg-slate-800/60 border border-slate-700/60 rounded-lg px-4 py-3 cursor-pointer hover:border-indigo-500" onclick="AtencionCliente.openConversationThread(${conv.id})">
          <div class="min-w-0">
            <p class="text-sm font-semibold truncate">${icon} ${_esc(conv.contact_name || 'Contacto')}</p>
            <p class="text-xs text-slate-500 truncate max-w-md">${_esc(conv.last_message || '')}</p>
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
      const bubbles = data.messages.map((m) => {
        const mine = m.direction === 'out';
        return `<div class="flex ${mine ? 'justify-end' : 'justify-start'}">
          <div class="max-w-[75%] rounded-lg px-3 py-2 text-sm ${mine ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-200'}">
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

      thread.innerHTML = `
        <button onclick="AtencionCliente._closeThread()" class="text-slate-400 hover:text-slate-100 text-xs font-semibold mb-3">← Volver a la lista</button>
        <div class="flex items-center justify-between mb-3">
          <p class="text-sm font-semibold">${_esc(data.conversation.contact_name || 'Contacto')}</p>
          <span class="text-[10px] font-semibold px-2 py-0.5 rounded-full ${badge.cls}">${badge.label}</span>
        </div>
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
            <p class="text-sm font-semibold truncate">📘 ${_esc(p.name)}</p>
            ${p.has_instagram
              ? `<p class="text-xs text-slate-500">📷 @${_esc(p.instagram_username || '')} vinculada</p>`
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

  return {
    init, openNewClientPrompt, openClient, closeClientModal, _switchTab, _overlayClose,
    createFlow, openBuilder, closeBuilder,
    openConversationThread, resolveFollowup, _closeThread,
    _selectPendingPage,
  };
})();

window.AtencionCliente = AtencionCliente;
