const Agenda = {
  cards: [],
  filtered: [],
  cardMap: {},
  ghostMap: {},
  view: 'month',
  date: new Date(),

  MONTHS: ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'],
  DAYS:   ['Lun','Mar','Mié','Jue','Vie','Sáb','Dom'],

  LABEL_COLORS: {
    green:'#61bd4f', yellow:'#f2d600', orange:'#ff9f1a', red:'#eb5a46',
    purple:'#c377e0', blue:'#0079bf', sky:'#00c2e0', lime:'#51e898',
    pink:'#ff78cb', black:'#4d4d4d'
  },

  async load(forceRefresh = false) {
    if (!Storage.hasCredentials()) { setState('auth'); return; }
    setState('loading');
    try {
      const { key, token } = Storage.getCredentials();
      const api = new TrelloAPI(key, token, { forceRefresh });
      const boards = await api.getBoards();
      const details = await Promise.all(boards.map(b => api.getBoardWithDetails(b.id)));

      this.cards = [];
      this.cardMap = {};

      details.forEach(({ board, lists, cards, members }) => {
        const listMap   = Object.fromEntries(lists.map(l => [l.id, l.name]));
        const memberMap = Object.fromEntries(members.map(m => {
          const name = m.fullName || m.username;
          Storage.saveMemberName(m.id, name);
          return [m.id, name];
        }));

        cards.forEach(card => {
          if (card.closed || card.dueComplete || !card.due) return;

          const listName  = listMap[card.idList] || '';
          const stageKey  = TimeCalc.classifyList(listName);
          const stageInfo = TimeCalc.STAGES[stageKey] || {
            label: listName || 'Sin clasificar',
            color: '#64748b',
            bg: 'rgba(100,116,139,0.15)'
          };

          const enriched = {
            id: card.id,
            name: card.name,
            desc: card.desc || '',
            due: new Date(card.due),
            idList: card.idList,
            idMembers: card.idMembers || [],
            labels: card.labels || [],
            boardId: board.id,
            boardName: board.name,
            listName,
            stageKey,
            stageInfo,
            memberNames: (card.idMembers || []).map(
              mid => memberMap[mid] || Storage.getMemberName(mid) || '?'
            )
          };
          this.cards.push(enriched);
          this.cardMap[enriched.id] = enriched;
        });
      });

      this._populateFilters(boards);
      this._applyFilters();
      setState('agenda');

      const t = new Date();
      document.getElementById('last-updated').textContent =
        `Actualizado ${t.toLocaleTimeString('es-MX', { hour:'2-digit', minute:'2-digit' })}`;

    } catch (err) {
      console.error(err);
      document.getElementById('error-msg').textContent = err.message || 'Error desconocido';
      setState('error');
    }
  },

  // --- Task 2: show workspace in board filter ---
  _populateFilters(boards) {
    const boardSel = document.getElementById('board-filter');
    const prevBoard = boardSel.value;
    boardSel.innerHTML = '<option value="">Todos los tableros</option>' +
      boards.map(b => {
        const ws = b.organization?.displayName || b.organization?.name || '';
        const label = ws ? `${b.name} · ${ws}` : b.name;
        return `<option value="${b.id}">${label}</option>`;
      }).join('');
    if (prevBoard) boardSel.value = prevBoard;

    const memberMap = new Map();
    this.cards.forEach(c =>
      c.idMembers.forEach((mid, i) => {
        if (!memberMap.has(mid)) memberMap.set(mid, c.memberNames[i] || mid);
      })
    );
    const memberSel = document.getElementById('member-filter');
    const prevMember = memberSel.value;
    memberSel.innerHTML = '<option value="">Todos los miembros</option>' +
      [...memberMap.entries()]
        .sort((a, b) => a[1].localeCompare(b[1]))
        .map(([id, name]) => `<option value="${id}">${name}</option>`).join('');
    if (prevMember) memberSel.value = prevMember;
  },

  // --- Task 6: ghost history in localStorage ---
  _getGhostHistory() {
    try { return JSON.parse(localStorage.getItem('agenda_ghost_history') || '{}'); }
    catch { return {}; }
  },

  _saveGhostHistory(h) {
    localStorage.setItem('agenda_ghost_history', JSON.stringify(h));
  },

  // Builds ghost card objects for overdue backlog/clientRevision cards
  _buildGhostCards() {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const history = this._getGhostHistory();
    this.ghostMap = {};

    const ghostStages = new Set(['backlog', 'clientRevision']);
    const doneStages  = new Set(['approved', 'drive', 'published']);

    // Update history entries
    Object.keys(history).forEach(cardId => {
      const entry = history[cardId];
      const card  = this.cardMap[cardId];

      // Remove entries for cards no longer loaded
      if (!card && !entry.resolved) { delete history[cardId]; return; }

      if (card && !entry.resolved) {
        // Mark resolved when card moved to a done stage
        if (doneStages.has(card.stageKey)) {
          entry.resolved     = true;
          entry.resolvedDate = new Date().toISOString();
          entry.ghostDate    = today.toISOString(); // last active day = today
        } else {
          // Still active: update ghostDate to today so ghost shows on current day
          entry.ghostDate = today.toISOString();
        }
      }

      // Purge resolved entries older than 30 days
      if (entry.resolved && entry.resolvedDate) {
        const ageDays = (Date.now() - new Date(entry.resolvedDate)) / 86400000;
        if (ageDays > 30) { delete history[cardId]; }
      }
    });

    // Add newly detected ghost candidates
    this.cards.forEach(card => {
      if (!ghostStages.has(card.stageKey)) return;
      const dueDay = new Date(card.due); dueDay.setHours(0, 0, 0, 0);
      if (dueDay >= today) return;
      if (!history[card.id]) {
        history[card.id] = {
          originStatus: card.stageKey,
          ghostDate:    today.toISOString(),
          resolved:     false
        };
      }
    });

    this._saveGhostHistory(history);

    // Build ghost card objects
    const ghosts = [];
    Object.entries(history).forEach(([cardId, entry]) => {
      const card = this.cardMap[cardId];
      if (!card) return;

      const ghostId        = 'ghost_' + cardId;
      const originStage    = TimeCalc.STAGES[entry.originStatus] || TimeCalc.STAGES['backlog'];
      const ghostDay       = new Date(entry.ghostDate); ghostDay.setHours(0, 0, 0, 0);

      const ghost = {
        ...card,
        id:               ghostId,
        originalId:       cardId,
        isGhost:          true,
        ghostResolved:    !!entry.resolved,
        ghostOriginStatus: entry.originStatus,
        due:              new Date(ghostDay),
        stageInfo:        entry.resolved
          ? { ...TimeCalc.STAGES['approved'], label: 'Aprobado ✓' }
          : originStage,
      };
      ghosts.push(ghost);
      this.ghostMap[ghostId] = ghost;
    });

    return ghosts;
  },

  _applyFilters() {
    const boardId  = document.getElementById('board-filter').value;
    const memberId = document.getElementById('member-filter').value;

    const base = this.cards.filter(c => {
      if (boardId  && c.boardId !== boardId) return false;
      if (memberId && !c.idMembers.includes(memberId)) return false;
      return true;
    });

    const ghosts = this._buildGhostCards().filter(g => {
      if (boardId  && g.boardId !== boardId) return false;
      if (memberId && !g.idMembers.includes(memberId)) return false;
      return true;
    });

    this.filtered = [...base, ...ghosts];
    this._render();
  },

  _cardsForDate(date) {
    const y = date.getFullYear(), mo = date.getMonth(), d = date.getDate();
    return this.filtered.filter(c =>
      c.due.getFullYear() === y && c.due.getMonth() === mo && c.due.getDate() === d
    );
  },

  _pill(card, compact) {
    if (card.isGhost) return this._ghostPill(card, compact);
    const { color, bg } = card.stageInfo;
    const maxLen = compact ? 28 : 42;
    const label  = card.name.length > maxLen ? card.name.slice(0, maxLen) + '…' : card.name;
    const textColor = color === '#94a3b8' ? '#cbd5e1' : color;
    return `
      <div data-card-id="${card.id}" class="agenda-card cursor-pointer rounded text-xs px-1.5 py-1 mb-1 hover:brightness-125 transition-all select-none"
           style="background:${bg}; border-left:3px solid ${color};"
           title="${card.name.replace(/"/g,'&quot;')}">
        <div class="font-medium leading-tight truncate" style="color:${textColor}">${label}</div>
        <div class="text-slate-400 truncate mt-0.5 leading-tight" style="font-size:0.65rem">${card.boardName}</div>
      </div>`;
  },

  // --- Task 6: ghost pill rendering ---
  _ghostPill(card, compact) {
    const originStageInfo = TimeCalc.STAGES[card.ghostOriginStatus] || {};
    const color = card.ghostResolved
      ? (TimeCalc.STAGES['approved']?.color || '#10b981')
      : (originStageInfo.color || '#94a3b8');
    const maxLen   = compact ? 26 : 40;
    const label    = card.name.length > maxLen ? card.name.slice(0, maxLen) + '…' : card.name;
    const statusTag = card.ghostResolved
      ? '✓ Aprobado'
      : `👻 ${originStageInfo.label || 'Pendiente'}`;
    const titleText = `${card.name} — Rezagada de ${originStageInfo.label || card.ghostOriginStatus}`;
    return `
      <div data-card-id="${card.id}" class="agenda-card cursor-pointer rounded text-xs px-1.5 py-1 mb-1 hover:brightness-125 transition-all select-none"
           style="opacity:0.65; background:${color}12; border-left:3px dashed ${color}; border-top:1px dashed ${color}30; border-right:1px dashed ${color}30; border-bottom:1px dashed ${color}30;"
           title="${titleText.replace(/"/g,'&quot;')}">
        <div class="font-medium leading-tight truncate" style="color:${color}">${label}</div>
        <div class="flex items-center justify-between gap-1 mt-0.5" style="font-size:0.6rem">
          <span class="text-slate-500 truncate">${card.boardName}</span>
          <span class="font-semibold flex-shrink-0" style="color:${color}">${statusTag}</span>
        </div>
      </div>`;
  },

  _render() {
    if (this.view === 'month') this._renderMonth();
    else this._renderWeek();
  },

  _renderMonth() {
    const year  = this.date.getFullYear();
    const month = this.date.getMonth();
    document.getElementById('cal-title').textContent = `${this.MONTHS[month]} ${year}`;

    const firstDow = (() => { let d = new Date(year,month,1).getDay(); return d === 0 ? 6 : d-1; })();
    const lastDate = new Date(year, month+1, 0).getDate();
    const today    = new Date(); today.setHours(0,0,0,0);

    const totalSlots = Math.ceil((firstDow + lastDate) / 7) * 7;

    let html = `
      <div class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div class="grid grid-cols-7 bg-slate-800/50 border-b border-slate-800">
          ${this.DAYS.map(d => `<div class="text-center text-xs font-semibold text-slate-500 py-3 px-1">${d}</div>`).join('')}
        </div>
        <div class="grid grid-cols-7 divide-x divide-slate-800/60">`;

    for (let slot = 0; slot < totalSlots; slot++) {
      const dayNum   = slot - firstDow + 1;
      const inMonth  = dayNum >= 1 && dayNum <= lastDate;
      const isLastRow = slot >= totalSlots - 7;
      const borderB  = !isLastRow ? 'border-b border-slate-800/60' : '';

      if (!inMonth) {
        html += `<div class="min-h-32 p-1.5 bg-slate-950/50 ${borderB}"></div>`;
        continue;
      }

      const date    = new Date(year, month, dayNum);
      const isToday = date.getTime() === today.getTime();
      const isPast  = date < today;
      const cards   = this._cardsForDate(date);
      const visible = cards.slice(0, 3);
      const extra   = cards.length - 3;

      // --- Task 3: highlighted count badge ---
      const countBadge = cards.length > 0
        ? `<span class="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-bold bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 leading-none">${cards.length}</span>`
        : '';

      html += `
        <div class="min-h-32 p-1.5 ${isToday ? 'bg-indigo-950/30' : ''} ${borderB}">
          <div class="flex items-center justify-between mb-1">
            <span class="text-xs font-bold w-6 h-6 flex items-center justify-center rounded-full flex-shrink-0
              ${isToday ? 'bg-indigo-600 text-white' : isPast ? 'text-slate-700' : 'text-slate-400'}">
              ${dayNum}
            </span>
            ${countBadge}
          </div>
          ${visible.map(c => this._pill(c, true)).join('')}
          ${extra > 0 ? `<div class="text-xs text-indigo-400 font-semibold px-1 cursor-pointer hover:text-indigo-300"
            data-jump="${year}-${month}-${dayNum}">+${extra} más</div>` : ''}
        </div>`;
    }

    html += `</div></div>`;
    document.getElementById('cal-container').innerHTML = html;
    this._bindCalendarEvents();
  },

  _renderWeek() {
    const anchor = new Date(this.date);
    const dow = anchor.getDay();
    anchor.setDate(anchor.getDate() - (dow === 0 ? 6 : dow - 1));
    anchor.setHours(0,0,0,0);

    const days = Array.from({ length:7 }, (_, i) => {
      const d = new Date(anchor); d.setDate(anchor.getDate() + i); return d;
    });

    const [mon, sun] = [days[0], days[6]];
    const title = mon.getMonth() === sun.getMonth()
      ? `${mon.getDate()} – ${sun.getDate()} de ${this.MONTHS[mon.getMonth()]} ${mon.getFullYear()}`
      : `${mon.getDate()} ${this.MONTHS[mon.getMonth()]} – ${sun.getDate()} ${this.MONTHS[sun.getMonth()]} ${sun.getFullYear()}`;
    document.getElementById('cal-title').textContent = title;

    const today = new Date(); today.setHours(0,0,0,0);

    let html = `
      <div class="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div class="grid grid-cols-7 divide-x divide-slate-800/60 bg-slate-800/50 border-b border-slate-800">`;

    days.forEach((day, i) => {
      const isToday = day.getTime() === today.getTime();
      const isPast  = day < today;
      html += `
        <div class="text-center py-3 ${isToday ? 'bg-indigo-950/40' : ''}">
          <div class="text-xs font-semibold text-slate-500 mb-1">${this.DAYS[i]}</div>
          <div class="w-8 h-8 flex items-center justify-center rounded-full mx-auto text-sm font-bold
            ${isToday ? 'bg-indigo-600 text-white' : isPast ? 'text-slate-700' : 'text-slate-200'}">
            ${day.getDate()}
          </div>
          <div class="text-xs text-slate-600 mt-0.5">${this.MONTHS[day.getMonth()].slice(0,3)}</div>
        </div>`;
    });

    html += `</div><div class="grid grid-cols-7 divide-x divide-slate-800/60">`;

    days.forEach((day, i) => {
      const cards   = this._cardsForDate(day);
      const isToday = day.getTime() === today.getTime();
      html += `<div class="min-h-52 p-1.5 ${isToday ? 'bg-indigo-950/15' : ''}">`;
      html += cards.length === 0
        ? `<div class="text-slate-800 text-center pt-6 text-lg">·</div>`
        : cards.map(c => this._pill(c, false)).join('');
      html += `</div>`;
    });

    html += `</div></div>`;
    document.getElementById('cal-container').innerHTML = html;
    this._bindCalendarEvents();
  },

  _bindCalendarEvents() {
    document.getElementById('cal-container').querySelectorAll('[data-card-id]').forEach(el => {
      el.addEventListener('click', () => this.openModal(el.dataset.cardId));
    });
    document.getElementById('cal-container').querySelectorAll('[data-jump]').forEach(el => {
      el.addEventListener('click', () => {
        const [y, m, d] = el.dataset.jump.split('-').map(Number);
        this.date = new Date(y, m, d);
        this.setView('week');
      });
    });
  },

  setView(v) {
    this.view = v;
    const base = 'px-4 py-1.5 rounded-md text-sm font-semibold transition-colors';
    document.getElementById('btn-month').className = base + (v === 'month' ? ' bg-indigo-600 text-white' : ' text-slate-400 hover:text-white');
    document.getElementById('btn-week').className  = base + (v === 'week'  ? ' bg-indigo-600 text-white' : ' text-slate-400 hover:text-white');
    this._render();
  },

  goToday() {
    this.date = new Date();
    this._render();
  },

  navigate(dir) {
    if (this.view === 'month') {
      this.date = new Date(this.date.getFullYear(), this.date.getMonth() + dir, 1);
    } else {
      this.date = new Date(this.date.getTime() + dir * 7 * 86400000);
    }
    this._render();
  },

  // --- Task 6: handle ghost card IDs in modal ---
  openModal(cardId) {
    const isGhost    = cardId.startsWith('ghost_');
    const ghost      = isGhost ? this.ghostMap[cardId] : null;
    const originalId = ghost ? ghost.originalId : cardId;
    const card       = this.cardMap[originalId] || ghost;
    if (!card) return;

    const displayStage = ghost ? ghost.stageInfo : card.stageInfo;

    document.getElementById('modal-board').textContent = isGhost
      ? `${card.boardName} · ${ghost.ghostResolved ? '✓ Resuelta' : '👻 Rezagada'}`
      : card.boardName;
    document.getElementById('modal-title').textContent  = card.name;

    document.getElementById('modal-dot').style.backgroundColor = displayStage.color;
    document.getElementById('modal-status').textContent = displayStage.label;
    document.getElementById('modal-list').textContent   = card.listName;

    const today = new Date(); today.setHours(0,0,0,0);
    const dueDay = new Date(card.due); dueDay.setHours(0,0,0,0);
    const overdue  = dueDay < today;
    const dateStr  = card.due.toLocaleDateString('es-MX', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
    const dueEl    = document.getElementById('modal-due');
    dueEl.textContent = overdue ? `⚠ ${dateStr} (vencida)` : dateStr;
    dueEl.className   = `text-sm font-medium ${overdue ? 'text-red-400' : 'text-slate-300'}`;

    const membersEl = document.getElementById('modal-members');
    membersEl.innerHTML = card.memberNames.map((name) => {
      const color = Utils.avatarColor(name);
      const init  = Utils.initials(name);
      return `
        <div class="flex items-center gap-1.5">
          <span class="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
            style="background:${color}">${init}</span>
          <span class="text-sm text-slate-300">${name}</span>
        </div>`;
    }).join('');

    const labelsEl = document.getElementById('modal-labels');
    if (card.labels.length > 0) {
      labelsEl.innerHTML = card.labels.map(l => {
        const hex = this.LABEL_COLORS[l.color] || '#475569';
        return `<span class="text-xs px-2 py-0.5 rounded-full font-medium"
          style="background:${hex}20; color:${hex}; border:1px solid ${hex}50">${l.name || l.color}</span>`;
      }).join('');
      labelsEl.style.display = 'flex';
    } else {
      labelsEl.style.display = 'none';
    }

    const descWrap = document.getElementById('modal-desc-wrap');
    if (card.desc.trim()) {
      document.getElementById('modal-desc').textContent = card.desc.trim();
      descWrap.style.display = 'block';
    } else {
      descWrap.style.display = 'none';
    }

    const modal = document.getElementById('modal');
    modal.style.display = 'flex';
    modal.offsetHeight;
  },

  closeModal() {
    document.getElementById('modal').style.display = 'none';
  }
};

window.Agenda = Agenda;
