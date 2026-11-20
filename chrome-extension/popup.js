const FIELDS = ['token', 'selfName', 'server'];
const CHECKS = ['autoRecord', 'autoCaptions', 'hideCaptions', 'showOverlay'];
const DEFAULT_SERVER = 'https://marketingdigitalideaz.com/dashboard/backend';

const $ = (id) => document.getElementById(id);

function showStatus(ok, text) {
  const el = $('status');
  el.className = ok ? 'ok' : 'err';
  el.textContent = text;
}

function dashboardUrl(server) {
  return (server || DEFAULT_SERVER).replace(/\/+$/, '').replace(/\/backend$/, '') + '/reuniones.html';
}

async function load() {
  const s = await chrome.storage.local.get(null);
  $('token').value = s.token || '';
  $('selfName').value = s.selfName || s.operatorName || '';
  $('server').value = s.server || DEFAULT_SERVER;
  $('autoRecord').checked = s.autoRecord !== false;
  $('autoCaptions').checked = s.autoCaptions !== false;
  $('hideCaptions').checked = !!s.hideCaptions;
  $('showOverlay').checked = s.showOverlay !== false;
  $('openDashboard').href = dashboardUrl($('server').value);
}

async function save() {
  const data = {};
  FIELDS.forEach((f) => { data[f] = $(f).value.trim(); });
  if (!data.server) data.server = DEFAULT_SERVER;
  if (!/^https:\/\//i.test(data.server)) {
    showStatus(false, 'La URL del backend debe empezar con https://');
    return;
  }
  CHECKS.forEach((c) => { data[c] = $(c).checked; });
  await chrome.storage.local.set(data);
  $('openDashboard').href = dashboardUrl(data.server);

  if (!data.token) {
    showStatus(false, 'Guardado, pero falta la llave: sin ella no se envía nada.');
    return;
  }
  $('save').disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'ping' });
  $('save').disabled = false;
  if (res && res.ok) {
    const name = (res.data.operator && res.data.operator.name) || '';
    if (!data.selfName && name) {
      $('selfName').value = name;
      await chrome.storage.local.set({ selfName: name });
    }
    showStatus(true, `Conectado como ${name || 'usuario'}. Las reuniones aparecerán en el módulo Reuniones.`);
  } else {
    showStatus(false, (res && res.error) || 'No se pudo conectar con el servidor.');
  }
}

$('save').addEventListener('click', save);
CHECKS.forEach((c) => $(c).addEventListener('change', () => chrome.storage.local.set({ [c]: $(c).checked })));
load();
