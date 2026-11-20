// Controlador de reuniones.html — transcripciones de Google Meet capturadas por
// la extensión de Chrome (carpeta chrome-extension/). Habla con:
//   backend/api/meetings.php        listado, detalle, edición y borrado
//   backend/api/meeting_tokens.php  llaves personales de la extensión
// Las horas llegan en UTC (ISO con Z) y se muestran en hora de Bogotá, igual que
// el filtro por días del backend.
const Reuniones = (() => {
  const TZ = 'America/Bogota';
  const SERIES = 8; // slots de la paleta categórica (ver <style> de reuniones.html)
  let meetings = [];
  let isAdmin = false;
  let current = null;       // detalle abierto
  let liveTimer = null;
  let transcriptQuery = '';

  // ── Utilidades ─────────────────────────────────────────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const fmt = (iso, opts) => (iso ? new Intl.DateTimeFormat('es-CO', Object.assign({ timeZone: TZ }, opts)).format(new Date(iso)) : '—');
  const fmtTime = (iso) => fmt(iso, { hour: '2-digit', minute: '2-digit', hour12: false });
  const fmtDay = (iso) => fmt(iso, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const dayKey = (iso) => fmt(iso, { year: 'numeric', month: '2-digit', day: '2-digit' }); // dd/mm/aaaa en es-CO

  function bogotaToday(offsetDays = 0) {
    const d = new Date(Date.now() + offsetDays * 86400000);
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    return p; // aaaa-mm-dd
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h) return `${h} h ${String(m).padStart(2, '0')} min`;
    if (m) return `${m} min`;
    return `${sec} s`;
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(s).padStart(2, '0')}`;
  }

  const fmtPct = (p) => (p > 0 && p < 1 ? '<1' : Math.round(p)) + '%';
  const initials = (s) => String(s || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  // El color sigue a la persona (orden de aparición en la reunión), nunca a su
  // posición en el ranking: así no cambia al filtrar. Del 9.º en adelante: "Otros".
  function colorMap(order) {
    const map = {};
    order.forEach((name, i) => { map[name] = i < SERIES ? `var(--series-${i + 1})` : 'var(--series-other)'; });
    return map;
  }

  // ── Tooltip único ──────────────────────────────────────────────────────────
  const tip = () => document.getElementById('rn-tip');
  function showTip(html, x, y) {
    const t = tip();
    t.innerHTML = html;
    t.style.left = Math.min(innerWidth - 90, Math.max(90, x)) + 'px';
    t.style.top = y + 'px';
    t.style.opacity = 1;
  }
  function hideTip() { tip().style.opacity = 0; }

  // Aviso breve (sin bloquear como alert)
  function flash(text) {
    const t = tip();
    t.textContent = text;
    t.style.left = '50%';
    t.style.top = (innerHeight - 40) + 'px';
    t.style.opacity = 1;
    setTimeout(hideTip, 1800);
  }

  // ── Listado ────────────────────────────────────────────────────────────────
  function filters() {
    return {
      date_from: document.getElementById('f-from').value,
      date_to: document.getElementById('f-to').value,
      q: document.getElementById('f-q').value.trim(),
      operator_id: document.getElementById('f-operator').value,
    };
  }

  const qs = (f) => {
    const parts = Object.keys(f).filter((k) => f[k]).map((k) => `${k}=${encodeURIComponent(f[k])}`);
    return parts.length ? `?${parts.join('&')}` : '';
  };

  async function load() {
    const wrap = document.getElementById('rn-list');
    wrap.innerHTML = '<p class="text-slate-500 text-sm p-4">Cargando…</p>';
    try {
      const data = await Session.apiFetch(`api/meetings.php${qs(filters())}`);
      meetings = data.meetings || [];
      isAdmin = !!data.is_admin;
      renderStats();
      renderList();
    } catch (e) {
      wrap.innerHTML = `<div class="bento-card"><p class="text-red-400 text-sm">${esc(e.message)}</p>
        <p class="text-slate-500 text-xs mt-2">Si es la primera vez, corre <code>backend/sql/migration_029_meetings.sql</code> en la base de datos.</p></div>`;
    }
  }

  function renderStats() {
    const total = meetings.reduce((s, m) => s + m.duration_seconds, 0);
    const people = new Set();
    meetings.forEach((m) => m.participants.forEach((p) => people.add(p.name.toLowerCase())));
    document.getElementById('st-count').textContent = meetings.length;
    document.getElementById('st-hours').textContent = meetings.length ? fmtDuration(total) : '0 min';
    document.getElementById('st-avg').textContent = meetings.length ? fmtDuration(total / meetings.length) : '—';
    document.getElementById('st-people').textContent = people.size;
  }

  function renderList() {
    const wrap = document.getElementById('rn-list');
    document.getElementById('rn-count').textContent = `${meetings.length} reunión(es)`;
    if (!meetings.length) {
      wrap.innerHTML = `<div class="bento-card text-center py-10">
        <p class="text-slate-300 font-semibold">No hay reuniones con estos filtros.</p>
        <p class="text-slate-500 text-sm mt-1">Instala la extensión con «Conectar extensión» y entra a una llamada de Google Meet.</p></div>`;
      return;
    }
    const groups = [];
    meetings.forEach((m) => {
      const key = dayKey(m.started_at);
      let g = groups[groups.length - 1];
      if (!g || g.key !== key) { g = { key, label: fmtDay(m.started_at), items: [], seconds: 0 }; groups.push(g); }
      g.items.push(m);
      g.seconds += m.duration_seconds;
    });

    wrap.innerHTML = groups.map((g) => `
      <div class="mb-6">
        <div class="flex items-baseline justify-between gap-3 mb-2 px-1">
          <h3 class="text-sm font-extrabold text-slate-200 first-letter:uppercase">${esc(g.label)}</h3>
          <span class="text-xs text-slate-500 font-semibold">${g.items.length} reunión(es) · ${fmtDuration(g.seconds)}</span>
        </div>
        <div class="bento-card !p-0 overflow-hidden divide-y divide-slate-800">
          ${g.items.map(renderRow).join('')}
        </div>
      </div>`).join('');
  }

  function renderRow(m) {
    const order = m.participants.map((p) => p.name); // ya viene por participación; para el listado basta
    const colors = colorMap(order);
    const speaking = m.participants.filter((p) => p.percent > 0);
    const top = speaking.slice(0, 3).map((p) => `${esc(p.name)} ${fmtPct(p.percent)}`).join(' · ');
    return `
      <button type="button" class="w-full text-left p-4 hover:bg-slate-800/40 transition-colors flex flex-col sm:flex-row sm:items-center gap-3" onclick="Reuniones.open(${m.id})">
        <div class="sm:w-32 flex-none">
          <p class="text-sm font-bold text-slate-100 tabular-nums">${fmtTime(m.started_at)} – ${m.is_live ? 'ahora' : fmtTime(m.ended_at)}</p>
          <p class="text-xs text-slate-500">${fmtDuration(m.duration_seconds)}</p>
        </div>
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 min-w-0">
            <p class="font-semibold text-slate-100 truncate">${esc(m.title || 'Reunión sin título')}</p>
            ${m.is_live ? '<span class="rn-live">EN VIVO</span>' : ''}
          </div>
          <p class="text-xs text-slate-500 truncate mt-0.5">
            ${m.meeting_code ? `<span class="font-mono">${esc(m.meeting_code)}</span> · ` : ''}${m.participants.length} participante(s) · ${m.word_count.toLocaleString('es-CO')} palabras${isAdmin || !m.can_edit ? ` · grabó ${esc(m.operator_name || '—')}` : ''}
          </p>
          ${speaking.length ? `
            <div class="rn-stack mt-2 max-w-md" aria-hidden="true">
              ${speaking.map((p) => `<div style="width:${p.percent}%;background:${colors[p.name]}"></div>`).join('')}
            </div>
            <p class="text-[11px] text-slate-400 mt-1 truncate">${top}</p>` : '<p class="text-[11px] text-slate-500 mt-2">Sin transcripción todavía</p>'}
        </div>
        <div class="flex -space-x-2 flex-none">
          ${m.participants.slice(0, 5).map((p) => `<span class="w-7 h-7 rounded-full grid place-items-center text-[10px] font-extrabold text-white ring-2 ring-[var(--s1)]" style="background:${colors[p.name]}" title="${esc(p.name)}">${esc(initials(p.name))}</span>`).join('')}
          ${m.participants.length > 5 ? `<span class="w-7 h-7 rounded-full grid place-items-center text-[10px] font-bold bg-slate-700 text-slate-200 ring-2 ring-[var(--s1)]">+${m.participants.length - 5}</span>` : ''}
        </div>
      </button>`;
  }

  // ── Detalle ────────────────────────────────────────────────────────────────
  async function open(id, { silent = false } = {}) {
    if (!silent) {
      history.replaceState(null, '', `${location.pathname}${location.search}#reunion=${id}`);
      document.getElementById('rn-list-view').classList.add('hidden');
      const view = document.getElementById('rn-detail-view');
      view.classList.remove('hidden');
      view.innerHTML = '<p class="text-slate-500 text-sm p-4">Cargando reunión…</p>';
      window.scrollTo(0, 0);
      transcriptQuery = '';
    }
    try {
      current = await Session.apiFetch(`api/meetings.php?id=${id}`);
      renderDetail(silent);
    } catch (e) {
      if (!silent) document.getElementById('rn-detail-view').innerHTML = `<button class="ui-chip mb-4" onclick="Reuniones.back()"><span data-icon="arrowLeft"></span>Volver</button><p class="text-red-400 text-sm">${esc(e.message)}</p>`;
      Icons.hydrate();
    }
    clearTimeout(liveTimer);
    if (current && current.meeting.is_live) liveTimer = setTimeout(() => open(id, { silent: true }), 15000);
  }

  function back() {
    clearTimeout(liveTimer);
    current = null;
    history.replaceState(null, '', location.pathname + location.search);
    document.getElementById('rn-detail-view').classList.add('hidden');
    document.getElementById('rn-list-view').classList.remove('hidden');
    if (document.getElementById('f-from').value || document.getElementById('f-q').value) load(); else setPreset('30');
  }

  function speakerOrder() {
    // orden de primera aparición en la transcripción, luego los que no hablaron
    const seen = [];
    current.segments.forEach((s) => { if (!seen.includes(s.speaker)) seen.push(s.speaker); });
    current.participation.forEach((p) => { if (!seen.includes(p.name)) seen.push(p.name); });
    return seen;
  }

  function renderDetail(silent) {
    const view = document.getElementById('rn-detail-view');
    const { meeting: m, participation } = current;
    const colors = colorMap(speakerOrder());
    const scrollBox = document.getElementById('rn-transcript');
    const keepScroll = silent && scrollBox ? scrollBox.scrollTop : null;
    const wasAtBottom = silent && scrollBox ? (scrollBox.scrollHeight - scrollBox.scrollTop - scrollBox.clientHeight < 60) : false;

    view.innerHTML = `
      <div class="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <button class="ui-chip" onclick="Reuniones.back()"><span data-icon="arrowLeft"></span>Reuniones</button>
        <div class="flex items-center gap-2 flex-wrap">
          <button class="ui-chip" onclick="Reuniones.copyTranscript()"><span data-icon="copy"></span>Copiar</button>
          <button class="ui-chip" onclick="Reuniones.downloadTranscript()"><span data-icon="download"></span>Descargar .txt</button>
          ${m.can_edit && m.is_live ? '<button class="ui-chip" onclick="Reuniones.markEnded()"><span data-icon="clock"></span>Marcar finalizada</button>' : ''}
          ${m.can_edit ? '<button class="ui-chip hover:!border-rose-500" onclick="Reuniones.remove()"><span data-icon="trash"></span>Eliminar</button>' : ''}
        </div>
      </div>

      <div class="bento-card mb-4">
        <div class="flex items-start gap-3 flex-wrap">
          <div class="flex-1 min-w-[240px]">
            ${m.can_edit
              ? `<input id="rn-title" class="w-full bg-transparent text-xl sm:text-2xl font-extrabold text-slate-100 outline-none border-b border-transparent focus:border-indigo-500" value="${esc(m.title)}" placeholder="Reunión sin título" onchange="Reuniones.saveTitle(this.value)">`
              : `<h1 class="text-xl sm:text-2xl font-extrabold text-slate-100">${esc(m.title || 'Reunión sin título')}</h1>`}
            <p class="text-sm text-slate-400 mt-1 first-letter:uppercase">${esc(fmtDay(m.started_at))}</p>
          </div>
          ${m.is_live ? '<span class="rn-live">EN VIVO</span>' : ''}
        </div>
        <dl class="grid grid-cols-2 md:grid-cols-5 gap-4 mt-4 text-sm">
          <div><dt class="bento-label">Inicio</dt><dd class="font-bold text-slate-100 tabular-nums mt-1">${fmtTime(m.started_at)}</dd></div>
          <div><dt class="bento-label">Fin</dt><dd class="font-bold text-slate-100 tabular-nums mt-1">${m.is_live ? 'En curso' : fmtTime(m.ended_at)}</dd></div>
          <div><dt class="bento-label">Duración</dt><dd class="font-bold text-slate-100 mt-1">${fmtDuration(m.duration_seconds)}</dd></div>
          <div><dt class="bento-label">Código Meet</dt><dd class="font-bold text-slate-100 mt-1 font-mono">${m.meeting_code ? `<a class="hover:text-indigo-500" href="https://meet.google.com/${esc(m.meeting_code)}" target="_blank" rel="noopener">${esc(m.meeting_code)}</a>` : '—'}</dd></div>
          <div class="min-w-0"><dt class="bento-label">Grabada por</dt><dd class="font-bold text-slate-100 mt-1 truncate">${esc(m.operator_name || '—')}</dd>
            ${(m.attendees || []).length ? `<dd class="text-[11px] text-slate-400 mt-0.5 truncate" title="También tenían la extensión en la llamada (en espera, sin duplicar la grabación)">+ ${esc(m.attendees.join(', '))}</dd>` : ''}</div>
        </dl>
      </div>

      <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
        <div class="lg:col-span-2 bento-card !p-0 overflow-hidden">
          <div class="flex items-center justify-between gap-3 p-4 border-b border-slate-800 flex-wrap">
            <p class="bento-label">Transcripción · ${current.segments.length} intervenciones</p>
            <label class="ui-field w-full sm:w-56">
              <span data-icon="search"></span>
              <input type="search" id="rn-tq" class="ui-input" placeholder="Buscar en la transcripción" value="${esc(transcriptQuery)}">
            </label>
          </div>
          <div id="rn-transcript" class="max-h-[70vh] overflow-y-auto p-4 space-y-4"></div>
        </div>

        <div class="flex flex-col gap-4">
          ${renderParticipants(participation, colors, m.duration_seconds)}
          <div class="bento-card">
            <p class="bento-label mb-2">Notas</p>
            ${m.can_edit
              ? `<textarea id="rn-notes" rows="5" class="w-full rounded-xl p-3 text-sm bg-transparent border border-slate-700 focus:border-indigo-500 outline-none text-slate-100" placeholder="Acuerdos, tareas, próximos pasos…">${esc(m.notes || '')}</textarea>
                 <div class="flex justify-end mt-2"><button class="ui-chip ui-chip-primary" onclick="Reuniones.saveNotes()"><span data-icon="save"></span>Guardar notas</button></div>`
              : `<p class="text-sm text-slate-300 whitespace-pre-wrap">${esc(m.notes || 'Sin notas.')}</p>`}
          </div>
        </div>
      </div>`;

    renderTranscript(colors);
    bindParticipantHover(participation);
    document.getElementById('rn-tq').addEventListener('input', (e) => { transcriptQuery = e.target.value; renderTranscript(colors); });
    Icons.hydrate(view);

    const box = document.getElementById('rn-transcript');
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
    else if (keepScroll !== null) box.scrollTop = keepScroll;
  }

  // Dona de participación (estilo de la referencia): tiempo de habla de cada
  // persona sobre el total hablado, con la duración de la reunión al centro.
  function renderParticipants(participation, colors, durationSec) {
    const speaking = participation.filter((p) => p.seconds > 0);
    const total = speaking.reduce((s, p) => s + p.seconds, 0);
    const R = 52, SW = 16, C = 2 * Math.PI * R, GAP = speaking.length > 1 ? 2 : 0;
    let offset = 0;
    const arcs = speaking.map((p, i) => {
      const len = total ? (p.seconds / total) * C : 0;
      const dash = Math.max(0.5, len - GAP);
      const arc = `<circle class="rn-donut-seg" data-i="${i}" cx="70" cy="70" r="${R}" fill="none" stroke="${colors[p.name]}" stroke-width="${SW}"
        stroke-dasharray="${dash} ${C - dash}" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)" style="cursor:pointer"></circle>`;
      offset += len;
      return arc;
    }).join('');
    const minutes = Math.max(0, Math.round(durationSec / 60));

    return `
      <div class="bento-card" id="rn-participants">
        <button type="button" class="w-full flex items-center justify-between gap-2" onclick="this.parentElement.classList.toggle('is-collapsed')">
          <span class="text-base font-extrabold text-slate-100">Participantes</span>
          <span class="flex items-center gap-2">
            <span class="text-xs font-bold px-2 py-0.5 rounded-md bg-slate-800 text-slate-300">${participation.length}</span>
            <span data-icon="chevron" class="text-slate-400"></span>
          </span>
        </button>
        <div class="rn-part-body">
          <div class="flex justify-center my-4">
            <svg class="rn-donut" viewBox="0 0 140 140" width="168" height="168" role="img" aria-label="Participación por tiempo de habla">
              <circle cx="70" cy="70" r="${R}" fill="none" stroke="var(--s3)" stroke-width="${SW}"></circle>
              ${arcs}
              <text x="70" y="70" text-anchor="middle" font-size="26" font-weight="800" fill="currentColor" class="text-slate-100">${minutes}</text>
              <text x="70" y="90" text-anchor="middle" font-size="11" fill="currentColor" class="text-slate-400">min</text>
            </svg>
          </div>
          ${participation.length ? `
          <ul class="space-y-0.5">
            ${participation.map((p) => {
              const i = speaking.indexOf(p);
              return `
              <li class="rn-part-row flex items-center gap-3 px-2 py-1.5" data-i="${i}">
                <span class="rn-dot" style="background:${p.seconds > 0 ? colors[p.name] : 'var(--s4)'}"></span>
                <span class="text-sm text-slate-200 truncate flex-1 min-w-0" title="${esc(p.name)}">${esc(p.name)}</span>
                <span class="rn-bar w-16 sm:w-20 flex-none"><div style="width:${p.percent}%;background:${colors[p.name]}"></div></span>
                <span class="text-sm font-semibold text-slate-100 tabular-nums w-10 text-right">${fmtPct(p.percent)}</span>
              </li>`;
            }).join('')}
          </ul>
          <p class="text-[11px] text-slate-500 mt-3">Porcentaje del tiempo total hablado (según los subtítulos de Meet). Quien estuvo sin hablar aparece con 0%.</p>`
          : '<p class="text-sm text-slate-500">Aún no hay participantes registrados.</p>'}
        </div>
      </div>
      <style>#rn-participants.is-collapsed .rn-part-body{display:none}#rn-participants.is-collapsed [data-icon], #rn-participants.is-collapsed svg.flex-shrink-0{transform:rotate(-90deg)}</style>`;
  }

  function bindParticipantHover(participation) {
    const card = document.getElementById('rn-participants');
    if (!card) return;
    const speaking = participation.filter((p) => p.seconds > 0);
    const setHot = (i, on) => {
      card.querySelectorAll(`[data-i="${i}"]`).forEach((el) => el.classList.toggle('is-hot', on));
    };
    card.querySelectorAll('[data-i]').forEach((el) => {
      const i = Number(el.dataset.i);
      const p = i >= 0 ? speaking[i] : participation.find((x) => x.name === el.querySelector('[title]')?.title);
      if (!p) return;
      el.addEventListener('mousemove', (e) => {
        setHot(i, true);
        showTip(`<b>${esc(p.name)}</b><br>${fmtPct(p.percent)} · habló ${fmtDuration(p.seconds)}<br>${p.words.toLocaleString('es-CO')} palabras · ${p.segments} intervenciones`, e.clientX, e.clientY);
      });
      el.addEventListener('mouseleave', () => { setHot(i, false); hideTip(); });
    });
  }

  function highlight(text, q) {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp(esc(q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    return safe.replace(re, (m) => `<mark>${m}</mark>`);
  }

  function renderTranscript(colors) {
    const box = document.getElementById('rn-transcript');
    if (!box || !current) return;
    const start = new Date(current.meeting.started_at).getTime();
    const q = transcriptQuery.trim().toLowerCase();
    const segs = q
      ? current.segments.filter((s) => s.text.toLowerCase().includes(q) || s.speaker.toLowerCase().includes(q))
      : current.segments;
    if (!segs.length) {
      box.innerHTML = `<p class="text-sm text-slate-500">${q ? 'Sin coincidencias.' : 'Todavía no hay transcripción. Verifica que los subtítulos de Meet estén activos.'}</p>`;
      return;
    }
    box.innerHTML = segs.map((s) => {
      const t = new Date(s.started_at).getTime();
      return `
        <div class="flex gap-3">
          <span class="w-8 h-8 rounded-full grid place-items-center text-[10px] font-extrabold text-white flex-none mt-0.5" style="background:${colors[s.speaker] || 'var(--series-other)'}">${esc(initials(s.speaker))}</span>
          <div class="min-w-0 flex-1">
            <p class="text-xs"><span class="font-bold text-slate-100">${highlight(s.speaker, q)}</span>
              <span class="text-slate-500 tabular-nums ml-1">${fmtTime(s.started_at)} · ${fmtClock((t - start) / 1000)}</span></p>
            <p class="rn-seg-text text-sm text-slate-300 leading-relaxed mt-0.5">${highlight(s.text, q)}</p>
          </div>
        </div>`;
    }).join('');
  }

  function transcriptText() {
    const m = current.meeting;
    const start = new Date(m.started_at).getTime();
    const head = [
      m.title || 'Reunión sin título',
      `${fmtDay(m.started_at)} · ${fmtTime(m.started_at)} – ${fmtTime(m.ended_at)} (${fmtDuration(m.duration_seconds)})`,
      `Google Meet: ${m.meeting_code || '—'}` + `  ·  Grabada por: ${m.operator_name || '—'}`,
      '',
      'Participación:',
      ...current.participation.map((p) => `  - ${p.name}: ${fmtPct(p.percent)}`),
      '',
      'Transcripción:',
    ];
    const body = current.segments.map((s) => `[${fmtClock((new Date(s.started_at).getTime() - start) / 1000)}] ${s.speaker}: ${s.text}`);
    return head.concat(body).join('\n');
  }

  async function copyTranscript() {
    try {
      await navigator.clipboard.writeText(transcriptText());
      flash('Transcripción copiada');
    } catch (e) {
      alert('No se pudo copiar: ' + e.message);
    }
  }

  function downloadTranscript() {
    const m = current.meeting;
    const blob = new Blob([transcriptText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    const slug = (m.title || m.meeting_code || 'reunion').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    a.href = URL.createObjectURL(blob);
    a.download = `${bogotaDate(m.started_at)}-${slug || 'reunion'}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const bogotaDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

  async function update(fields) {
    await Session.apiFetch('api/meetings.php', { method: 'PUT', body: JSON.stringify(Object.assign({ id: current.meeting.id }, fields)) });
  }

  async function saveTitle(value) {
    try { await update({ title: value }); current.meeting.title = value; } catch (e) { alert(e.message); }
  }

  async function saveNotes() {
    const value = document.getElementById('rn-notes').value;
    try { await update({ notes: value }); current.meeting.notes = value; flash('Notas guardadas'); } catch (e) { alert(e.message); }
  }

  async function markEnded() {
    try { await update({ mark_ended: true }); open(current.meeting.id); } catch (e) { alert(e.message); }
  }

  async function remove() {
    if (!confirm('¿Eliminar esta reunión y toda su transcripción? No se puede deshacer.')) return;
    try {
      await Session.apiFetch(`api/meetings.php?id=${current.meeting.id}`, { method: 'DELETE' });
      back();
    } catch (e) { alert(e.message); }
  }

  // ── Conectar extensión (llaves) ────────────────────────────────────────────
  function openConnect() {
    const modal = document.getElementById('rn-connect');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('rn-new-token').classList.add('hidden');
    loadTokens();
  }

  function closeConnect() {
    const modal = document.getElementById('rn-connect');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.getElementById('rn-new-token-value').textContent = '';
  }

  async function loadTokens() {
    const box = document.getElementById('rn-tokens');
    box.innerHTML = '<p class="text-slate-500">Cargando…</p>';
    try {
      const { tokens } = await Session.apiFetch('api/meeting_tokens.php');
      box.innerHTML = tokens.length ? tokens.map((t) => `
        <div class="flex items-center justify-between gap-3 py-2 border-b border-slate-800 last:border-0">
          <div class="min-w-0">
            <p class="font-semibold text-slate-100 truncate">${esc(t.label)} <span class="font-mono text-xs text-slate-500">…${esc(t.token_hint)}</span></p>
            <p class="text-xs text-slate-500">${t.last_used_at ? 'Último uso: ' + fmt(t.last_used_at, { dateStyle: 'medium', timeStyle: 'short' }) : 'Sin usar todavía'}</p>
          </div>
          <button class="ui-chip" onclick="Reuniones.revokeToken(${t.id})"><span data-icon="trash"></span>Revocar</button>
        </div>`).join('') : '<p class="text-slate-500">Todavía no tienes llaves.</p>';
      Icons.hydrate(box);
    } catch (e) {
      box.innerHTML = `<p class="text-red-400">${esc(e.message)}</p>`;
    }
  }

  async function createToken() {
    const label = document.getElementById('rn-token-label').value.trim();
    try {
      const { token } = await Session.apiFetch('api/meeting_tokens.php', { method: 'POST', body: JSON.stringify({ label }) });
      document.getElementById('rn-new-token-value').textContent = token;
      document.getElementById('rn-new-token').classList.remove('hidden');
      document.getElementById('rn-token-label').value = '';
      loadTokens();
    } catch (e) { alert(e.message); }
  }

  async function copyToken() {
    const value = document.getElementById('rn-new-token-value').textContent;
    try { await navigator.clipboard.writeText(value); flash('Llave copiada. Pégala en la extensión.'); } catch (e) { alert('Cópiala manualmente.'); }
  }

  async function revokeToken(id) {
    if (!confirm('¿Revocar esta llave? La extensión que la use dejará de enviar transcripciones.')) return;
    try { await Session.apiFetch(`api/meeting_tokens.php?id=${id}`, { method: 'DELETE' }); loadTokens(); } catch (e) { alert(e.message); }
  }

  // ── Filtros e inicio ───────────────────────────────────────────────────────
  function setPreset(p) {
    const today = bogotaToday();
    let from = today;
    if (p === '7') from = bogotaToday(-6);
    if (p === '30') from = bogotaToday(-29);
    if (p === 'month') from = today.slice(0, 8) + '01';
    document.getElementById('f-from').value = from;
    document.getElementById('f-to').value = today;
    markPreset(p);
    load();
  }

  function markPreset(p) {
    document.querySelectorAll('#f-presets [data-preset]').forEach((b) => b.classList.toggle('is-on', b.dataset.preset === p));
  }

  async function loadOperators() {
    try {
      const { operators } = await Session.apiFetch('api/meetings.php?operators=1');
      if (!operators.length) return;
      const sel = document.getElementById('f-operator');
      sel.innerHTML = '<option value="">Grabadas por cualquiera</option>' + operators.map((o) => `<option value="${o.id}">${esc(o.name || o.email)}</option>`).join('');
      document.getElementById('f-operator-wrap').classList.remove('hidden');
    } catch (e) { /* sin filtro de usuario */ }
  }

  function bind() {
    document.querySelectorAll('#f-presets [data-preset]').forEach((b) => b.addEventListener('click', () => setPreset(b.dataset.preset)));
    ['f-from', 'f-to', 'f-operator'].forEach((id) => document.getElementById(id).addEventListener('change', () => { markPreset(''); load(); }));
    let t;
    document.getElementById('f-q').addEventListener('input', () => { clearTimeout(t); t = setTimeout(load, 400); });
    document.getElementById('f-clear').addEventListener('click', () => {
      ['f-from', 'f-to', 'f-q', 'f-operator'].forEach((id) => { document.getElementById(id).value = ''; });
      markPreset('');
      load();
    });
    document.getElementById('rn-connect').addEventListener('click', (e) => { if (e.target.id === 'rn-connect') closeConnect(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeConnect(); });
  }

  async function init() {
    bind();
    if (Session.user && ['superadmin', 'admin'].includes(Session.user.role)) loadOperators();
    const m = location.hash.match(/reunion=(\d+)/);
    if (m) { open(Number(m[1])); return; }
    setPreset('30');
  }

  return { init, open, back, openConnect, closeConnect, createToken, copyToken, revokeToken, copyTranscript, downloadTranscript, saveTitle, saveNotes, markEnded, remove };
})();

window.Reuniones = Reuniones;
