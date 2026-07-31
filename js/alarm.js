const Alarm = (() => {
  const AUDIOS = [
    'https://marketingdigitalideaz.com/audios/audio1.mpeg',
    'https://marketingdigitalideaz.com/audios/audio2.mpeg',
    'https://marketingdigitalideaz.com/audios/audio3.mpeg'
  ];
  const TARGET_HOUR   = 17;
  const TARGET_MINUTE = 0;
  const LS_KEY = 'alarm_last_shown';
  const LS_LAST_AUDIO = 'alarm_last_audio';
  // Rotación de audio de la alarma manual, separada de la del recordatorio
  // diario — así el admin puede tocar el botón varias veces seguidas sin
  // que se repita el mismo clip, sin afectar la rotación de las 5pm.
  const LS_LAST_BROADCAST_AUDIO = 'alarm_last_broadcast_audio';
  // Último id de alarma manual (botón de admin) ya mostrado en este
  // navegador — independiente del recordatorio diario de las 5pm.
  const LS_BROADCAST_ID = 'alarm_broadcast_seen_id';

  let audioEl = null;

  function _todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function _isWeekday(d) {
    const day = d.getDay(); // 0=Dom ... 6=Sáb
    return day >= 1 && day <= 5;
  }

  // Aleatorio, sin repetir el audio del día anterior. La primera vez que
  // corre en un navegador (sin historial guardado) suena audio1.
  function _audioForToday() {
    const lastIdx = localStorage.getItem(LS_LAST_AUDIO);
    let idx = 0;
    if (lastIdx !== null) {
      const excluded = Number(lastIdx);
      const choices = AUDIOS.map((_, i) => i).filter(i => i !== excluded);
      idx = choices[Math.floor(Math.random() * choices.length)];
    }
    localStorage.setItem(LS_LAST_AUDIO, idx);
    return AUDIOS[idx];
  }

  // Igual de aleatorio pero con su propia rotación (LS_LAST_BROADCAST_AUDIO):
  // nunca repite el clip inmediatamente anterior de la alarma MANUAL, sin
  // importar cuál sonó ese día en el recordatorio automático de las 5pm.
  function _audioForBroadcast() {
    const lastIdx = localStorage.getItem(LS_LAST_BROADCAST_AUDIO);
    const excluded = lastIdx !== null ? Number(lastIdx) : null;
    const choices = AUDIOS.map((_, i) => i).filter(i => i !== excluded);
    const idx = choices[Math.floor(Math.random() * choices.length)];
    localStorage.setItem(LS_LAST_BROADCAST_AUDIO, idx);
    return AUDIOS[idx];
  }

  function _alreadyShownToday() {
    return localStorage.getItem(LS_KEY) === _todayKey();
  }

  function _markShownToday() {
    localStorage.setItem(LS_KEY, _todayKey());
  }

  function _enableClose(btn) {
    btn.disabled = false;
    btn.textContent = 'Cerrar';
    btn.classList.remove('bg-slate-700', 'text-slate-500', 'cursor-not-allowed');
    btn.classList.add('bg-indigo-600', 'hover:bg-indigo-700', 'text-white', 'cursor-pointer');
  }

  function _buildPopup(title, message) {
    if (document.getElementById('alarm-popup')) return;
    const wrap = document.createElement('div');
    wrap.id = 'alarm-popup';
    wrap.className = 'fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] flex items-center justify-center p-4';
    wrap.innerHTML = `
      <div class="bg-slate-900 border border-indigo-600 rounded-xl w-full max-w-md shadow-2xl p-6 text-center">
        <div class="text-4xl mb-3">⏰</div>
        <h3 class="text-lg font-bold text-slate-100 mb-2">${title}</h3>
        <p class="text-sm text-slate-400 mb-5">${message}</p>
        <p id="alarm-autoplay-msg" class="text-xs text-amber-400 mb-3" style="display:none">
          El navegador bloqueó la reproducción automática. Presiona reproducir para continuar.
        </p>
        <div class="flex items-center justify-center gap-2">
          <button id="alarm-play-btn" style="display:none"
            class="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-lg font-semibold text-sm transition-colors">
            ▶ Reproducir alarma
          </button>
          <button id="alarm-close-btn" disabled
            class="bg-slate-700 text-slate-500 px-6 py-2.5 rounded-lg font-semibold text-sm cursor-not-allowed transition-colors">
            Esperando audio…
          </button>
        </div>
      </div>`;
    document.body.appendChild(wrap);
  }

  function _startPlayback(audioUrl) {
    const closeBtn = document.getElementById('alarm-close-btn');
    const playBtn  = document.getElementById('alarm-play-btn');
    const msg      = document.getElementById('alarm-autoplay-msg');

    audioEl = new Audio(audioUrl);
    let playedOnce = false;

    audioEl.addEventListener('ended', () => {
      if (!playedOnce) {
        playedOnce = true;
        _enableClose(closeBtn);
      }
      // Repetir mientras el popup siga abierto
      if (document.getElementById('alarm-popup')) {
        audioEl.currentTime = 0;
        audioEl.play().catch(() => {});
      }
    });

    audioEl.play().catch(() => {
      // Autoplay bloqueado por el navegador: requiere gesto del usuario
      msg.style.display = 'block';
      playBtn.style.display = 'inline-flex';
      playBtn.addEventListener('click', () => {
        audioEl.play();
        msg.style.display = 'none';
        playBtn.style.display = 'none';
      }, { once: true });
    });
  }

  function _closePopup() {
    const btn = document.getElementById('alarm-close-btn');
    if (btn && btn.disabled) return; // no se puede cerrar antes de completar el audio una vez
    if (audioEl) { audioEl.pause(); audioEl = null; }
    document.getElementById('alarm-popup')?.remove();
  }

  // opts.daily marca el recordatorio automático de las 5pm (solo ese usa el
  // localStorage de "ya sonó hoy"); la alarma manual del admin no lo toca,
  // así puede sonar varias veces el mismo día sin quedar bloqueada.
  function trigger(opts) {
    opts = opts || {};
    _buildPopup(
      opts.title || '¡Son las 5:00 PM!',
      opts.message || 'Revisa el estado de las tareas en curso antes de terminar el día.'
    );
    document.getElementById('alarm-close-btn').addEventListener('click', _closePopup);
    _startPlayback(opts.daily ? _audioForToday() : _audioForBroadcast());
    if (opts.daily) _markShownToday();
  }

  function _check() {
    const now = new Date();
    if (!_isWeekday(now)) return;
    if (_alreadyShownToday()) return;
    const target = new Date();
    target.setHours(TARGET_HOUR, TARGET_MINUTE, 0, 0);
    if (now >= target) trigger({ daily: true });
  }

  // Además del recordatorio diario por reloj, un admin puede disparar una
  // alarma manual (botón en configuracion.html) para todo el que esté
  // logueado ahora mismo — se detecta con polling contra el último id
  // guardado en la BD (backend/api/alarm_broadcast.php), no hay websockets
  // en este hosting compartido.
  async function _checkBroadcast() {
    if (!window.Session || typeof Session.apiFetch !== 'function') return;
    let data;
    try {
      data = await Session.apiFetch('api/alarm_broadcast.php');
    } catch (e) {
      return; // sin sesión lista todavía, o backend no disponible — se reintenta en el próximo tick
    }
    const latest = data && data.latest;
    if (!latest) return;
    const stored = localStorage.getItem(LS_BROADCAST_ID);
    if (stored === null) {
      // Primera consulta de este navegador: toma el id actual como línea
      // base sin sonar, para no "revivir" una alarma vieja a quien recién entra.
      localStorage.setItem(LS_BROADCAST_ID, String(latest.id));
      return;
    }
    if (latest.id > Number(stored)) {
      localStorage.setItem(LS_BROADCAST_ID, String(latest.id));
      trigger({
        title: '🔔 ¡Atención!',
        message: 'Un administrador envió una alarma para todo el equipo.',
      });
    }
  }

  // Botón de admin (configuracion.html) — dispara la alarma para todos los
  // que estén logueados en este momento (los que no lo estén no la reciben
  // retroactivamente al entrar después, solo lo que pase de acá en más).
  async function sendBroadcast() {
    const res = await Session.apiFetch('api/alarm_broadcast.php', { method: 'POST' });
    // Evita que el propio admin se dispare la alarma a sí mismo en el
    // próximo polling — ya sabe que la mandó, no hace falta que le suene.
    if (res && res.id) localStorage.setItem(LS_BROADCAST_ID, String(res.id));
    return res;
  }

  function init() {
    _check(); // por si la pestaña se abre después de las 5pm
    _checkBroadcast();
    setInterval(() => { _check(); _checkBroadcast(); }, 30000);
  }

  return { init, sendBroadcast };
})();

window.Alarm = Alarm;
