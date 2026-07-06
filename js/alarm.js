const Alarm = (() => {
  const AUDIOS = [
    'https://marketingdigitalideaz.com/audios/audio1.mp3',
    'https://marketingdigitalideaz.com/audios/audio2.mp3',
    'https://marketingdigitalideaz.com/audios/audio3.mp3'
  ];
  const TARGET_HOUR   = 17;
  const TARGET_MINUTE = 0;
  const LS_KEY = 'alarm_last_shown';

  let audioEl = null;

  function _todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  }

  function _isWeekday(d) {
    const day = d.getDay(); // 0=Dom ... 6=Sáb
    return day >= 1 && day <= 5;
  }

  // Lun=audio1, Mar=audio2, Mié=audio3, Jue=audio1, Vie=audio2
  function _audioForToday() {
    const day = new Date().getDay();
    const idx = (day - 1) % AUDIOS.length;
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

  function _buildPopup() {
    if (document.getElementById('alarm-popup')) return;
    const wrap = document.createElement('div');
    wrap.id = 'alarm-popup';
    wrap.className = 'fixed inset-0 bg-black/70 backdrop-blur-sm z-[100] flex items-center justify-center p-4';
    wrap.innerHTML = `
      <div class="bg-slate-900 border border-indigo-600 rounded-xl w-full max-w-md shadow-2xl p-6 text-center">
        <div class="text-4xl mb-3">⏰</div>
        <h3 class="text-lg font-bold text-slate-100 mb-2">¡Son las 5:00 PM!</h3>
        <p class="text-sm text-slate-400 mb-5">Revisa el estado de las tareas en curso antes de terminar el día.</p>
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

  function _startPlayback() {
    const closeBtn = document.getElementById('alarm-close-btn');
    const playBtn  = document.getElementById('alarm-play-btn');
    const msg      = document.getElementById('alarm-autoplay-msg');

    audioEl = new Audio(_audioForToday());
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

  function trigger() {
    _buildPopup();
    document.getElementById('alarm-close-btn').addEventListener('click', _closePopup);
    _startPlayback();
    _markShownToday();
  }

  function _check() {
    const now = new Date();
    if (!_isWeekday(now)) return;
    if (_alreadyShownToday()) return;
    const target = new Date();
    target.setHours(TARGET_HOUR, TARGET_MINUTE, 0, 0);
    if (now >= target) trigger();
  }

  function init() {
    _check(); // por si la pestaña se abre después de las 5pm
    setInterval(_check, 30000);
  }

  return { init };
})();

window.Alarm = Alarm;
