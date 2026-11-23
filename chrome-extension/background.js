// Service worker de "IDEAZ Reuniones": único punto que habla con el backend del
// dashboard (backend/api/meeting_ingest.php). El content script de Meet le pasa
// los mensajes; como la extensión declara el dominio en host_permissions, estas
// peticiones no dependen del CORS del sitio.

const DEFAULTS = {
  server: 'https://marketingdigitalideaz.com/dashboard/backend',
  token: '',
  selfName: '',
  operatorName: '',
  autoRecord: true,
  autoCaptions: true,
  hideCaptions: false,
  showOverlay: true,
};

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return Object.assign({}, DEFAULTS, stored);
}

async function callBackend(body) {
  const s = await getSettings();
  if (!s.token) throw new Error('Falta la llave de la extensión. Ábrela desde el icono de IDEAZ y pégala.');
  const url = s.server.replace(/\/+$/, '') + '/api/meeting_ingest.php';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Ideaz-Token': s.token },
    body: JSON.stringify(body),
    credentials: 'omit',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status} del servidor`);
  return data;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'ping') {
    callBackend({ action: 'ping', self_name: msg.self_name || '', self_aliases: Array.isArray(msg.self_aliases) ? msg.self_aliases : [] })
      .then(async (data) => {
        if (data.operator) await chrome.storage.local.set({ operatorName: data.operator.name || '' });
        sendResponse({ ok: true, data });
      })
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'sync') {
    callBackend(Object.assign({ action: 'sync' }, msg.payload || {}))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'settings') {
    getSettings().then(sendResponse);
    return true;
  }

  if (msg.type === 'badge' && sender.tab) {
    const tabId = sender.tab.id;
    // REC = esta extensión graba; ESP = en espera (otra extensión ya graba la llamada)
    chrome.action.setBadgeText({ tabId, text: msg.on ? (msg.standby ? 'ESP' : 'REC') : '' });
    chrome.action.setBadgeBackgroundColor({ tabId, color: msg.error ? '#d03b3b' : (msg.standby ? '#78716c' : '#4f46e5') });
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(async () => {
  // Completa los valores por defecto sin pisar lo que el usuario ya configuró
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  const missing = {};
  Object.keys(DEFAULTS).forEach((k) => { if (stored[k] === undefined) missing[k] = DEFAULTS[k]; });
  if (Object.keys(missing).length) await chrome.storage.local.set(missing);
});
