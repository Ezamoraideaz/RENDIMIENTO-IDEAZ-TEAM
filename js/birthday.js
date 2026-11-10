// Popup animado de cumpleaños. Lo carga js/session.js en cada página (menos el login)
// una vez lista la sesión. Felicita al usuario cuyo miembro de Trello (users.trello_member_id)
// cumple años hoy (día y mes configurados en Configuración → Equipo), la PRIMERA vez que
// abre el sitio ese día: la marca "ya felicitado" se guarda en localStorage por miembro y fecha.
// La frase cambia según el rol del miembro (Equipo) y según el año.
// Para probarlo desde la consola:  Birthday.preview('Camila', 'diseñador')
const Birthday = (() => {
  const COLORS = ['#f472b6', '#facc15', '#38bdf8', '#34d399', '#a78bfa', '#fb923c', '#f87171', '#ffffff'];
  const KEY = 'ideaz_bday_seen_';

  // Frases por rol (rol del miembro en Equipo). Se elige una según miembro + año.
  const MESSAGES = {
    'diseñador': [
      'Que este año te regale lienzos en blanco infinitos, paletas de color perfectas y cero «hazlo más grande». ¡Hoy tu obra maestra eres tú!',
      'Feliz cumpleaños al que convierte ideas en piezas que enamoran. Que todo lo que sueñes salga a la primera… y sin cambios del cliente. 😉',
      'Tu talento le pone color a cada marca. Hoy el que merece un fondo de pantalla de celebración eres tú. ¡A disfrutar!',
      'Que tus archivos nunca se corrompan, tus fuentes siempre estén instaladas y tu año venga en alta resolución. ¡Felicidades!',
    ],
    'cm': [
      'Que hoy el algoritmo te quiera tanto como te queremos en el equipo. ¡Que tu año sea viral, con muchos likes y cero crisis de comunidad!',
      'Quien le da voz a las marcas se merece un día lleno de comentarios bonitos. ¡Que este año tengas más alcance que nunca y los mejores mensajes directos!',
      'Hoy no hay que programar nada: ¡solo celebrar! Que tu nuevo año traiga engagement, buena vibra y clientes que responden a la primera.',
      'Mientras tú haces que las comunidades hablen, hoy la comunidad IDEAZ entera te manda un abrazo. ¡Feliz cumpleaños!',
    ],
    'pm': [
      'Que este año tus cronogramas se cumplan, las entregas lleguen a tiempo y las reuniones terminen en 15 minutos. ¡Feliz cumpleaños, capitán del equipo!',
      'Quien mantiene todo en orden hoy se merece un día sin pendientes. Que tu año sea tan bien planeado como tus tableros… ¡y con más celebraciones!',
      'Hoy la única fecha límite es disfrutar. Gracias por mantener el rumbo del equipo; que tu nuevo año llegue sin retrasos ni cambios de último minuto.',
      'Que todas tus tarjetas pasen a «Aprobado» a la primera. ¡Felicidades, y que este año el cronograma salga a tu favor!',
    ],
    'admin': [
      'Gracias por guiar este equipo con visión y buena energía. Que tu nuevo año venga con grandes resultados, mejores números y mucha celebración. ¡Feliz cumpleaños!',
      'Detrás de cada gran equipo hay alguien que cree en él. Que este año los resultados te sorprendan tanto como tú nos inspiras. ¡Felicidades!',
    ],
    'default': [
      'Gracias por poner tu talento y tu energía en cada proyecto. ¡Hoy te toca a ti brillar!',
      'Que este nuevo año de vida venga lleno de ideas geniales, buena vibra y muchos logros. ¡El equipo está feliz de tenerte!',
      'El equipo IDEAZ te manda un abrazo gigante. ¡A celebrar como se debe!',
      'Un equipo se hace de personas como tú. Que hoy te sobren las sonrisas y el pastel. ¡Feliz cumpleaños!',
    ],
  };

  let raf = null, pieces = [], canvas = null, ctx = null, overlay = null;

  // ── fecha de hoy en Bogotá (mismo reloj que el resto del sistema)
  function todayBogota() {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const [y, m, d] = parts.split('-').map(Number);
    return { y, m, d, iso: parts };
  }

  function isBirthdayToday(bday, t) {
    if (!bday) return false;
    if (bday.month === t.m && bday.day === t.d) return true;
    // 29 de febrero: en años no bisiestos se celebra el 28
    const leap = (t.y % 4 === 0 && t.y % 100 !== 0) || t.y % 400 === 0;
    return bday.month === 2 && bday.day === 29 && !leap && t.m === 2 && t.d === 28;
  }

  function hash(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return h;
  }

  function pickMessage(roleKey, seed) {
    const pool = MESSAGES[roleKey] || MESSAGES.default;
    return pool[hash(seed) % pool.length];
  }

  function roleKeyFor(memberRole, siteRole) {
    if (MESSAGES[memberRole]) return memberRole;
    if (siteRole === 'admin' || siteRole === 'superadmin') return 'admin';
    return 'default';
  }

  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  function injectStyles() {
    if (document.getElementById('bday-styles')) return;
    const st = document.createElement('style');
    st.id = 'bday-styles';
    st.textContent = `
      #bday-confetti { position:fixed; inset:0; width:100%; height:100%; pointer-events:none; z-index:9998; }
      #bday-overlay { position:fixed; inset:0; z-index:9999; display:flex; align-items:center; justify-content:center; padding:1rem;
        background:radial-gradient(ellipse at center, rgba(79,70,229,.35), rgba(2,6,23,.85)); backdrop-filter:blur(3px);
        animation:bdayFade .35s ease-out both; }
      #bday-overlay.closing { animation:bdayFadeOut .3s ease-in both; }
      @keyframes bdayFade { from{opacity:0} to{opacity:1} }
      @keyframes bdayFadeOut { to{opacity:0} }
      .bday-card { position:relative; width:100%; max-width:30rem; text-align:center; padding:2.5rem 1.75rem 2rem;
        border-radius:1.75rem; border:1px solid rgba(165,180,252,.35); color:#f1f5f9; font-family:Inter,system-ui,sans-serif;
        background:linear-gradient(160deg, rgba(30,27,75,.96), rgba(15,23,42,.96));
        box-shadow:0 0 0 1px rgba(255,255,255,.04), 0 30px 80px rgba(79,70,229,.45), inset 0 1px 0 rgba(255,255,255,.08);
        animation:bdayPop .7s cubic-bezier(.2,1.4,.4,1) both; overflow:hidden; }
      @keyframes bdayPop { from{opacity:0; transform:scale(.6) translateY(40px) rotate(-3deg)} to{opacity:1; transform:none} }
      .bday-card::before { content:""; position:absolute; inset:-60%; z-index:0;
        background:conic-gradient(from 0deg, transparent, rgba(244,114,182,.25), transparent 30%, rgba(250,204,21,.22), transparent 60%, rgba(56,189,248,.22), transparent);
        animation:bdaySpin 9s linear infinite; }
      @keyframes bdaySpin { to{transform:rotate(360deg)} }
      .bday-card > * { position:relative; z-index:1; }
      .bday-cake { font-size:4.5rem; line-height:1; display:inline-block; animation:bdayBounce 1.6s ease-in-out infinite; filter:drop-shadow(0 8px 14px rgba(0,0,0,.45)); }
      @keyframes bdayBounce { 0%,100%{transform:translateY(0) rotate(-4deg)} 50%{transform:translateY(-14px) rotate(4deg)} }
      .bday-title { font-size:2.1rem; font-weight:900; line-height:1.1; margin-top:.75rem;
        background:linear-gradient(90deg,#f472b6,#facc15,#38bdf8,#f472b6); background-size:300% 100%;
        -webkit-background-clip:text; background-clip:text; color:transparent; animation:bdayShine 4s linear infinite; }
      @keyframes bdayShine { to{background-position:300% 0} }
      .bday-name { font-size:1.6rem; font-weight:800; color:#fff; margin-top:.35rem; }
      .bday-msg { color:#c7d2fe; font-size:.95rem; line-height:1.55; margin:1rem auto 0; max-width:24rem; }
      .bday-sign { color:#a5b4fc; font-size:.8rem; margin-top:.85rem; font-weight:600; letter-spacing:.03em; }
      .bday-btn { margin-top:1.5rem; background:linear-gradient(90deg,#6366f1,#a855f7); color:#fff; font-weight:700; font-size:.95rem;
        padding:.75rem 1.75rem; border-radius:999px; border:0; cursor:pointer; transition:transform .15s, box-shadow .15s;
        box-shadow:0 10px 30px rgba(99,102,241,.5); }
      .bday-btn:hover { transform:translateY(-2px) scale(1.03); box-shadow:0 14px 36px rgba(168,85,247,.6); }
      .bday-x { position:absolute; top:.6rem; right:.8rem; z-index:2; color:#94a3b8; font-size:1.5rem; background:none; border:0; cursor:pointer; line-height:1; padding:.25rem .5rem; }
      .bday-x:hover { color:#fff; }
      .bday-balloon { position:absolute; bottom:-60px; font-size:2.2rem; opacity:0; animation:bdayRise linear infinite; z-index:0; }
      @keyframes bdayRise { 0%{transform:translateY(0) rotate(-8deg); opacity:0} 10%{opacity:.9} 100%{transform:translateY(-420px) rotate(8deg); opacity:0} }
      @media (prefers-reduced-motion: reduce) {
        .bday-card, .bday-cake, .bday-title, .bday-card::before, .bday-balloon { animation:none !important; }
      }`;
    document.head.appendChild(st);
  }

  // ── confeti sobre toda la pantalla, cae sin parar hasta que se cierre el popup
  function makePiece(w, h, fromTop) {
    const size = 6 + Math.random() * 8;
    return {
      x: Math.random() * w, y: fromTop ? -20 - Math.random() * h : Math.random() * h,
      w: size, h: size * (0.5 + Math.random() * 0.9),
      vy: 1.4 + Math.random() * 2.6, vx: -0.8 + Math.random() * 1.6,
      rot: Math.random() * Math.PI * 2, vr: -0.15 + Math.random() * 0.3,
      sway: Math.random() * 2 * Math.PI, swaySpeed: 0.02 + Math.random() * 0.03,
      color: COLORS[(Math.random() * COLORS.length) | 0], round: Math.random() < 0.25,
    };
  }

  function loop() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    pieces.forEach((p, i) => {
      p.y += p.vy; p.sway += p.swaySpeed; p.x += p.vx + Math.sin(p.sway) * 1.1; p.rot += p.vr;
      if (p.y > h + 20) pieces[i] = makePiece(w, h, true);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
      if (p.round) { ctx.beginPath(); ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2); ctx.fill(); }
      else ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    });
    raf = requestAnimationFrame(loop);
  }

  function resize() { if (canvas) { canvas.width = innerWidth; canvas.height = innerHeight; } }

  function startConfetti() {
    canvas = document.createElement('canvas');
    canvas.id = 'bday-confetti';
    document.body.appendChild(canvas);
    ctx = canvas.getContext('2d');
    resize();
    addEventListener('resize', resize);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const n = reduced ? 40 : Math.min(220, Math.round(innerWidth / 7));
    pieces = Array.from({ length: n }, () => makePiece(canvas.width, canvas.height, false));
    loop();
  }

  function stopConfetti() {
    cancelAnimationFrame(raf);
    raf = null;
    removeEventListener('resize', resize);
    if (canvas) canvas.remove();
    canvas = ctx = null;
    pieces = [];
  }

  function onKey(e) { if (e.key === 'Escape') close(); }

  function close() {
    if (!overlay) return;
    removeEventListener('keydown', onKey);
    overlay.classList.add('closing');
    const o = overlay;
    overlay = null;
    setTimeout(() => { o.remove(); stopConfetti(); }, 280);
  }

  // Muestra el popup. opts: { name, role (rol del miembro), siteRole, seed }
  function show(opts = {}) {
    if (overlay) return;
    injectStyles();
    const first = String(opts.name || '').trim().split(/\s+/)[0];
    const msg = pickMessage(roleKeyFor(opts.role, opts.siteRole), opts.seed || (first + todayBogota().y));
    const balloons = ['🎈', '🎈', '🎉', '🎈', '✨', '🎁'].map((e, i) =>
      `<span class="bday-balloon" style="left:${6 + i * 17}%; animation-duration:${6 + (i % 3) * 2}s; animation-delay:${i * 0.9}s">${e}</span>`).join('');
    overlay = document.createElement('div');
    overlay.id = 'bday-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', 'Feliz cumpleaños');
    overlay.innerHTML = `
      <div class="bday-card">
        ${balloons}
        <button class="bday-x" aria-label="Cerrar">×</button>
        <div class="bday-cake">🎂</div>
        <div class="bday-title">¡Feliz cumpleaños!</div>
        <div class="bday-name">${esc(first)}</div>
        <p class="bday-msg">${esc(msg)}</p>
        <p class="bday-sign">— Tu equipo IDEAZ 💜</p>
        <button class="bday-btn">¡Gracias! 🥳</button>
      </div>`;
    document.body.appendChild(overlay);
    startConfetti();
    overlay.querySelector('.bday-x').onclick = close;
    overlay.querySelector('.bday-btn').onclick = close;
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
    addEventListener('keydown', onKey);
  }

  // Revisa si hoy es el cumpleaños del usuario y, si es la primera vez del día, felicita.
  function check() {
    const user = window.Session && Session.user;
    const memberId = user && user.trello_member_id;
    if (!memberId || !window.Storage || typeof Storage.getMemberBirthday !== 'function') return;
    const t = todayBogota();
    if (!isBirthdayToday(Storage.getMemberBirthday(memberId), t)) return;
    const seenKey = KEY + memberId + '_' + t.iso;
    try {
      if (localStorage.getItem(seenKey)) return; // ya se felicitó hoy
      localStorage.setItem(seenKey, '1');
      // Limpia marcas de días anteriores para no acumular basura
      Object.keys(localStorage).filter((k) => k.startsWith(KEY) && k !== seenKey).forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* sin storage: se muestra igual */ }
    show({
      name: Storage.getMemberName(memberId) !== 'Desconocido' ? Storage.getMemberName(memberId) : user.name,
      role: Storage.getMemberRole(memberId),
      siteRole: user.role,
      seed: memberId + t.y,
    });
  }

  return {
    check,
    show,
    close,
    preview: (name = 'Camila', role = '') => show({ name, role }),
  };
})();

window.Birthday = Birthday;
Birthday.check();
