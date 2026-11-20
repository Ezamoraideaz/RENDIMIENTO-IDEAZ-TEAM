// IDEAZ Reuniones — content script de Google Meet.
//
// Cómo funciona (mismo enfoque que Tactiq): no graba audio. Activa los
// subtítulos de Meet y lee del DOM quién habla y qué dice. Cada bloque de
// subtítulos de una persona es un "fragmento" que crece mientras habla; se
// envía al backend cada pocos segundos (upsert por id de fragmento) junto con
// la lista de personas vistas en la llamada.
//
// Meet cambia sus clases CSS con frecuencia. Por eso todo se busca primero por
// atributos accesibles (role/aria-label) y, si no, por clases conocidas o por
// la estructura (avatar + nombre + texto). Si Meet cambia y deja de capturar,
// ajustar las funciones captionRegion / findBlocks / readBlock.
(() => {
  if (window.__ideazMeetLoaded) return;
  window.__ideazMeetLoaded = true;

  // ── Textos de Meet en varios idiomas ──────────────────────────────────────
  const CAPTION_REGION_RE = /subt[ií]tulos|captions|legendas|sous-titres|untertitel|sottotitoli/i;
  const CAPTION_BTN_RE = /subt[ií]tulos|captions|legendas|sous-titres|untertitel|sottotitoli/i;
  const CAPTION_TURN_ON_RE = /activar|turn on|ativar|activer|aktivieren|attiva/i;
  const LEAVE_RE = /salir de la llamada|abandonar la llamada|leave call|sair da chamada|quitter l.appel|anruf verlassen|abbandona la chiamata/i;
  const SELF_LABELS = ['tú', 'tu', 'you', 'vous', 'você', 'du', 'yo'];

  const SYNC_EVERY_MS = 8000;
  const HEARTBEAT_MS = 60000;
  const RESUME_WINDOW_MS = 30 * 60 * 1000; // recargar la pestaña dentro de 30 min continúa la misma reunión

  let settings = {};
  let state = null;          // grabación en curso
  let wasInCall = false;
  let manualStop = false;    // el usuario detuvo la transcripción en esta llamada
  let captionAttempts = 0;
  let lastCaptionAttempt = 0;
  let tickCount = 0;
  const blockIds = new WeakMap();

  const now = () => Date.now();
  const rid = (n = 10) => {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const buf = new Uint8Array(n);
    crypto.getRandomValues(buf);
    return Array.from(buf, (b) => chars[b % chars.length]).join('');
  };

  // ── Comunicación con el service worker ────────────────────────────────────
  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res);
        });
      } catch (e) {
        // "Extension context invalidated": la extensión se actualizó; hay que recargar Meet
        resolve({ ok: false, error: 'La extensión se actualizó. Recarga la pestaña de Meet.' });
      }
    });
  }

  async function loadSettings() {
    try {
      settings = await chrome.storage.local.get(null);
    } catch (e) {
      settings = {};
    }
    settings = Object.assign({ autoRecord: true, autoCaptions: true, hideCaptions: false, showOverlay: true }, settings);
  }

  // ── Lectura de Meet ───────────────────────────────────────────────────────
  function meetingCode() {
    const m = location.pathname.match(/^\/([a-z]{3,4}-[a-z]{3,4}-[a-z]{3,4})(?:$|[/?#])/i);
    return m ? m[1].toLowerCase() : '';
  }

  function meetingTitle() {
    const el = document.querySelector('[data-meeting-title]');
    const t = el && el.getAttribute('data-meeting-title');
    if (t && t.trim()) return t.trim();
    const dt = document.title.replace(/^\s*(google\s+)?meet\s*[-–—:|]\s*/i, '').trim();
    if (dt && !/^(google\s+)?meet$/i.test(dt) && dt.toLowerCase() !== meetingCode()) return dt;
    return '';
  }

  function buttons() {
    return Array.from(document.querySelectorAll('button[aria-label], [role="button"][aria-label]'));
  }

  function inCall() {
    if (!meetingCode()) return false;
    return buttons().some((b) => LEAVE_RE.test(b.getAttribute('aria-label') || ''))
      || !!document.querySelector('button[jsname="CQylAd"]');
  }

  function captionRegion() {
    const regions = Array.from(document.querySelectorAll('[role="region"][aria-label]'));
    return regions.find((r) => CAPTION_REGION_RE.test(r.getAttribute('aria-label') || ''))
      || document.querySelector('div[jsname="dsyhDe"], .a4cQT');
  }

  function ensureCaptions() {
    if (captionRegion()) { captionAttempts = 0; return; }
    if (captionAttempts >= 6 || now() - lastCaptionAttempt < 5000) return;
    const btn = buttons().find((b) => {
      const label = b.getAttribute('aria-label') || '';
      if (!CAPTION_BTN_RE.test(label)) return false;
      const pressed = b.getAttribute('aria-pressed');
      return pressed === 'false' || (pressed === null && CAPTION_TURN_ON_RE.test(label));
    });
    lastCaptionAttempt = now();
    captionAttempts++;
    if (btn) btn.click();
  }

  // Cada bloque = avatar + nombre + texto de una persona.
  function findBlocks(region) {
    const known = region.querySelectorAll('.nMcdL');
    if (known.length) return Array.from(known);
    const out = [];
    region.querySelectorAll('img').forEach((img) => {
      let el = img;
      while (el.parentElement && el.parentElement !== region && el.parentElement.querySelectorAll('img').length === 1) {
        el = el.parentElement;
      }
      if (el !== img && !out.includes(el)) out.push(el);
    });
    return out;
  }

  function readBlock(block) {
    const nameEl = block.querySelector('.NWpY1d, .zs7s8d, .KcIKyf');
    const textEl = block.querySelector('.ygicle, .bh44bd, .iTTPOb, [jsname="tgaKEf"]');
    let speaker = nameEl ? nameEl.textContent.trim() : '';
    let text = textEl ? textEl.textContent : '';
    if (!speaker || !text) {
      const lines = (block.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
      if (!speaker) speaker = lines[0] || '';
      if (!text) text = lines.slice(1).join(' ');
    }
    return { speaker: speaker.replace(/\s+/g, ' ').trim(), text: text.replace(/\s+/g, ' ').trim() };
  }

  function normSpeaker(raw) {
    const s = (raw || '').trim();
    if (SELF_LABELS.includes(s.toLowerCase())) return settings.selfName || settings.operatorName || 'Yo';
    return s;
  }

  function isSelfLabel(name) {
    return SELF_LABELS.includes(String(name || '').trim().toLowerCase());
  }

  function scanParticipants() {
    if (!state) return;
    const add = (name) => {
      name = String(name || '').replace(/\s+/g, ' ').trim();
      // La tarjeta trae el nombre dos veces (visible + accesible): "Ana PérezAna Pérez" → "Ana Pérez"
      const twice = name.match(/^(.{2,}?) ?\1$/);
      if (twice) name = twice[1];
      if (!name || name.length > 80 || isSelfLabel(name) || /\(t[uú]\)|\(you\)/i.test(name)) return;
      state.participants.add(name);
    };
    document.querySelectorAll('[data-participant-id]').forEach((tile) => {
      const el = tile.querySelector('.zWGUib, .XEazBc, .dwSJ2e');
      if (el) add(el.innerText || el.textContent);
    });
    // Panel "Personas" abierto: cada fila trae el nombre en aria-label
    document.querySelectorAll('[role="list"] [role="listitem"][aria-label]').forEach((li) => add(li.getAttribute('aria-label')));
    const me = settings.selfName || settings.operatorName;
    if (me) state.participants.add(me);
  }

  // Une el texto ya capturado de un bloque con su nueva versión. Meet reescribe
  // las últimas palabras mientras reconoce y, en monólogos largos, puede recortar
  // el principio del bloque; la regla mantiene el invariante "merged termina en raw".
  function mergeText(merged, prevRaw, newRaw) {
    const base = merged.slice(0, merged.length - prevRaw.length);
    // 1) Mismo comienzo: el bloque creció o Meet corrigió palabras → reemplazar
    const head = prevRaw.slice(0, Math.min(12, prevRaw.length));
    if (newRaw.startsWith(head)) return base + newRaw;
    // 2) Meet recortó el principio: el inicio del nuevo texto es el final del anterior
    for (let k = Math.min(prevRaw.length, newRaw.length); k >= 8; k--) {
      if (prevRaw.endsWith(newRaw.slice(0, k))) return merged + newRaw.slice(k);
    }
    // 3) Corrección de las primeras palabras: comparten casi todas las palabras → reemplazar
    const words = (s) => s.toLowerCase().split(/\s+/).filter(Boolean);
    const prevWords = words(prevRaw);
    const newSet = new Set(words(newRaw));
    const shared = prevWords.filter((w) => newSet.has(w)).length;
    if (prevWords.length && shared / prevWords.length >= 0.6 && newRaw.length >= prevRaw.length * 0.7) return base + newRaw;
    // 4) Texto distinto: se agrega
    return (merged ? merged + ' ' : '') + newRaw;
  }

  function scanCaptions() {
    if (!state || state.paused) return;
    const region = captionRegion();
    if (!region) return;
    const t = now();
    let changed = false;
    findBlocks(region).forEach((block) => {
      const { speaker, text } = readBlock(block);
      if (!text) return;
      let seg = state.segments.get(blockIds.get(block));
      // Meet a veces reutiliza el mismo nodo para otra persona
      if (seg && speaker && seg.rawSpeaker !== speaker) seg = null;
      if (!seg) {
        const id = `${state.prefix}-${++state.seq}`;
        seg = { id, rawSpeaker: speaker, speaker: normSpeaker(speaker), text: '', raw: '', started_at: t, ended_at: t, version: 0, sent: -1 };
        state.segments.set(id, seg);
        state.order.push(id);
        blockIds.set(block, id);
      }
      if (text !== seg.raw) {
        seg.text = mergeText(seg.text, seg.raw, text);
        seg.raw = text;
        seg.ended_at = t;
        seg.version++;
        changed = true;
      }
      if (seg.speaker) state.participants.add(seg.speaker);
    });
    if (changed) { state.lastActivity = t; renderPanel(); }
  }

  // ── Grabación ─────────────────────────────────────────────────────────────
  async function start() {
    const code = meetingCode();
    const key = `ideaz_session_${code}`;
    let sessionId = '';
    let startedAt = now();
    try {
      const saved = (await chrome.storage.local.get(key))[key];
      if (saved && now() - saved.lastSeen < RESUME_WINDOW_MS) {
        sessionId = saved.sessionId;
        startedAt = saved.startedAt;
      }
    } catch (e) { /* sin almacenamiento: sesión nueva */ }
    if (!sessionId) sessionId = `${code.replace(/-/g, '')}_${rid(16)}`;

    state = {
      sessionId, code, startedAt, key,
      prefix: rid(6), seq: 0,
      segments: new Map(), order: [],
      participants: new Set(),
      paused: false, syncing: false,
      lastSync: 0, lastActivity: now(), error: '',
    };
    captionAttempts = 0;
    send({ type: 'badge', on: true });
    persist();
    renderOverlay();
  }

  async function stop(final = true) {
    if (!state) return;
    await sync(final);
    try { await chrome.storage.local.remove(state.key); } catch (e) {}
    state = null;
    send({ type: 'badge', on: false });
    renderOverlay();
  }

  function persist() {
    if (!state) return;
    try {
      chrome.storage.local.set({ [state.key]: { sessionId: state.sessionId, startedAt: state.startedAt, lastSeen: now() } });
    } catch (e) {}
  }

  async function sync(final = false) {
    if (!state || state.syncing) return;
    const pending = state.order.map((id) => state.segments.get(id)).filter((s) => s.version !== s.sent).slice(0, 400);
    if (!pending.length && !final && now() - state.lastSync < HEARTBEAT_MS) return;
    if (!settings.token) { state.error = 'Falta la llave: abre la extensión IDEAZ y pégala.'; renderOverlay(); return; }

    state.syncing = true;
    const versions = pending.map((s) => s.version);
    const payload = {
      client_session_id: state.sessionId,
      meeting_code: state.code,
      title: meetingTitle(),
      language: document.documentElement.lang || '',
      started_at: state.startedAt,
      last_activity_at: now(),
      segments: pending.map((s) => ({ id: s.id, speaker: s.speaker, text: s.text, started_at: s.started_at, ended_at: s.ended_at })),
      participants: Array.from(state.participants),
    };
    if (final) payload.ended_at = now();
    const current = state;
    const res = await send({ type: 'sync', payload });
    current.syncing = false;
    if (res && res.ok) {
      pending.forEach((s, i) => { s.sent = versions[i]; });
      current.lastSync = now();
      current.error = '';
      current.meetingId = res.data && res.data.meeting_id;
    } else {
      current.error = (res && res.error) || 'No se pudo conectar con el servidor';
    }
    send({ type: 'badge', on: !!state, error: !!current.error });
    persist();
    renderOverlay();
  }

  // ── Ocultar subtítulos en pantalla (siguen activos para poder leerlos) ────
  function applyHideCaptions() {
    const region = captionRegion();
    if (!region) return;
    const hide = !!(state && settings.hideCaptions);
    region.style.opacity = hide ? '0' : '';
    region.style.pointerEvents = hide ? 'none' : '';
  }

  // ── Interfaz flotante (shadow DOM para no chocar con los estilos de Meet) ─
  let host = null;
  let ui = null;
  let panelOpen = false;

  function ensureOverlay() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'ideaz-reuniones-root';
    host.style.cssText = 'position:fixed;top:12px;left:12px;z-index:2147483646;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
        .pill { display:flex; align-items:center; gap:8px; background:#0c0a09; color:#fff; border-radius:999px; padding:6px 8px 6px 12px; font-size:12px; font-weight:600; box-shadow:0 10px 30px -10px rgba(0,0,0,.6); }
        .dot { width:8px; height:8px; border-radius:50%; background:#78716c; flex:none; }
        .dot.rec { background:#ef4444; animation:pulse 1.4s infinite; }
        .dot.err { background:#f59e0b; }
        @keyframes pulse { 50% { opacity:.35; } }
        button { all:unset; cursor:pointer; padding:4px 10px; border-radius:999px; background:#ffffff1f; font-size:11px; font-weight:700; color:#fff; }
        button:hover { background:#ffffff38; }
        button.primary { background:#4f46e5; }
        .panel { margin-top:8px; width:340px; max-height:55vh; overflow:auto; background:#fff; color:#0b0b0b; border-radius:16px; padding:12px; box-shadow:0 20px 40px -12px rgba(0,0,0,.45); font-size:12px; line-height:1.45; }
        .panel h4 { margin:0 0 8px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#52514e; }
        .seg { margin-bottom:8px; }
        .who { font-weight:700; color:#4f46e5; }
        .muted { color:#898781; }
        .err { color:#b45309; margin-top:6px; font-size:11px; max-width:340px; background:#fffbeb; border-radius:10px; padding:6px 10px; }
      </style>
      <div class="pill">
        <span class="dot" id="dot"></span>
        <span id="label">IDEAZ</span>
        <span id="actions" style="display:flex;gap:4px"></span>
      </div>
      <div class="err" id="err" hidden></div>
      <div class="panel" id="panel" hidden><h4>Transcripción en vivo</h4><div id="list"></div></div>`;
    ui = {
      dot: root.getElementById('dot'),
      label: root.getElementById('label'),
      actions: root.getElementById('actions'),
      err: root.getElementById('err'),
      panel: root.getElementById('panel'),
      list: root.getElementById('list'),
    };
    ui.actions.addEventListener('click', (e) => {
      const act = e.target.closest('button') && e.target.closest('button').dataset.act;
      if (act === 'start') { manualStop = false; start(); }
      if (act === 'stop') { manualStop = true; stop(true); }
      if (act === 'pause' && state) { state.paused = !state.paused; renderOverlay(); }
      if (act === 'panel') { panelOpen = !panelOpen; renderOverlay(); renderPanel(); }
    });
    document.documentElement.appendChild(host);
  }

  function renderOverlay() {
    const show = settings.showOverlay !== false && (inCall() || state);
    if (!show) { if (host) host.style.display = 'none'; return; }
    ensureOverlay();
    host.style.display = '';
    const count = state ? state.order.length : 0;
    const error = state ? state.error : (!settings.token ? 'Configura tu llave en la extensión IDEAZ para transcribir.' : '');
    ui.dot.className = 'dot' + (state && !state.paused ? (error ? ' err' : ' rec') : '');
    ui.label.textContent = state
      ? (state.paused ? 'IDEAZ · En pausa' : `IDEAZ · Transcribiendo · ${count}`)
      : 'IDEAZ · Sin transcribir';
    ui.actions.innerHTML = state
      ? `<button data-act="panel">${panelOpen ? 'Ocultar' : 'Ver'}</button>
         <button data-act="pause">${state.paused ? 'Reanudar' : 'Pausar'}</button>
         <button data-act="stop">Detener</button>`
      : (settings.token ? '<button data-act="start" class="primary">Transcribir</button>' : '');
    ui.err.hidden = !error;
    ui.err.textContent = error || '';
    ui.panel.hidden = !(panelOpen && state);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  function renderPanel() {
    if (!ui || !state || !panelOpen) return;
    const last = state.order.slice(-60).map((id) => state.segments.get(id));
    const nearBottom = ui.panel.scrollHeight - ui.panel.scrollTop - ui.panel.clientHeight < 40;
    ui.list.innerHTML = last.length
      ? last.map((s) => `<div class="seg"><span class="who">${esc(s.speaker || '—')}</span> <span class="muted">${new Date(s.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><br>${esc(s.text)}</div>`).join('')
      : '<div class="muted">Esperando subtítulos… Si no aparecen, actívalos con el botón CC de Meet.</div>';
    if (nearBottom) ui.panel.scrollTop = ui.panel.scrollHeight;
  }

  // ── Ciclo principal ───────────────────────────────────────────────────────
  function tick() {
    tickCount++;
    const call = inCall();
    if (call && !wasInCall) manualStop = false; // llamada nueva
    if (call && !state && settings.autoRecord && settings.token && !manualStop) start();
    if (!call && wasInCall && state) stop(true);
    wasInCall = call;

    if (state && !state.paused && settings.autoCaptions) ensureCaptions();
    scanCaptions();
    if (tickCount % 5 === 0) scanParticipants();
    if (tickCount % 30 === 0) persist();
    applyHideCaptions();
    if (tickCount % 2 === 0) renderOverlay();
  }

  async function init() {
    await loadSettings();
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      Object.keys(changes).forEach((k) => { if (!k.startsWith('ideaz_session_')) settings[k] = changes[k].newValue; });
      renderOverlay();
    });
    // Los subtítulos cambian muchas veces por segundo: el observer agrupa y el
    // intervalo cubre los casos en que Meet reemplaza el contenedor completo.
    let pending = false;
    new MutationObserver(() => {
      if (pending || !state) return;
      pending = true;
      setTimeout(() => { pending = false; scanCaptions(); }, 250);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    setInterval(tick, 1000);
    setInterval(() => sync(false), SYNC_EVERY_MS);
    window.addEventListener('pagehide', () => { if (state) sync(true); });
  }

  init();
})();
