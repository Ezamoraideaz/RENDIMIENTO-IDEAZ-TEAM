const TimeCalc = {
  // Pattern matching for each workflow stage
  STAGES: {
    backlog:        { label: 'Tareas',               color: '#64748b', bg: 'rgba(100,116,139,0.15)' },
    inProgress:     { label: 'En Proceso',           color: '#6366f1', bg: 'rgba(99,102,241,0.15)' },
    sentToClient:   { label: 'Enviado',              color: '#f59e0b', bg: 'rgba(245,158,11,0.15)' },
    clientRevision: { label: 'Cambios',              color: '#ef4444', bg: 'rgba(239,68,68,0.15)' },
    done:           { label: 'Aprobado / Drive',     color: '#10b981', bg: 'rgba(16,185,129,0.15)' },
    published:      { label: 'Publicado',            color: '#8b5cf6', bg: 'rgba(139,92,246,0.15)' },
  },

  PATTERNS: {
    backlog:        /^tareas?$|lista.*tarea|tarea|backlog|pendiente|to.?do|por\s*hacer/i,
    inProgress:     /en\s*proceso|in\s*progress|trabajando|en\s*curso/i,
    sentToClient:   /^enviado$|al\s*cliente|sent|esperando\s*cliente|en\s*revisi[oó]n/i,
    clientRevision: /^cambios?$|feedback|correcciones|ajustes|del\s*cliente/i,
    done:           /drive|montado|aprobado|finalizado|done|completado|terminado|entregado|listo/i,
    published:      /^publicado$|publicado|published|posted|ejecutado/i,
  },

  classifyList(name) {
    if (!name) return 'other';
    for (const [stage, pattern] of Object.entries(this.PATTERNS)) {
      if (pattern.test(name)) return stage;
    }
    return 'other';
  },

  // Main: build timelines for all cards from board actions
  buildCardTimelines(boardActions, cards) {
    const byCard = {};
    for (const action of (boardActions || [])) {
      const cardId = action.data?.card?.id;
      if (!cardId) continue;
      if (!byCard[cardId]) byCard[cardId] = [];
      byCard[cardId].push(action);
    }

    const timelines = {};
    for (const card of cards) {
      const actions = (byCard[card.id] || [])
        .sort((a, b) => new Date(a.date) - new Date(b.date));
      timelines[card.id] = this.calcCardTimeline(card, actions);
    }
    return timelines;
  },

  calcCardTimeline(card, sortedActions) {
    const movements = sortedActions.map(a => ({
      date:       new Date(a.date),
      from:       a.data?.listBefore?.name || '',
      to:         a.data?.listAfter?.name  || '',
      fromStage:  this.classifyList(a.data?.listBefore?.name),
      toStage:    this.classifyList(a.data?.listAfter?.name),
      member:     a.memberCreator?.fullName || ''
    }));

    // START = first time card entered "En Proceso"
    const startMove = movements.find(m => m.toStage === 'inProgress');
    const startDate = startMove?.date || null;

    // END = last time card entered Aprobado, Drive or Publicado
    const doneMoves = movements.filter(m => m.toStage === 'done' || m.toStage === 'published');
    const endDate   = doneMoves.length > 0 ? doneMoves[doneMoves.length - 1].date : null;

    // Revisions = times card entered "Cambios del Cliente"
    const revisions = movements.filter(m => m.toStage === 'clientRevision').length;
    const sentCount = movements.filter(m => m.toStage === 'sentToClient').length;

    // Active working hours = time in "En Proceso" + "Cambios"
    // Clock pauses when Enviado (waiting review), stops when Aprobado/Drive/Publicado.
    const ACTIVE_STAGES = new Set(['inProgress', 'clientRevision']);
    let activeWorkingHours = 0;
    let activeSince = null;
    for (const move of movements) {
      const entering = ACTIVE_STAGES.has(move.toStage);
      const leaving  = activeSince !== null && !ACTIVE_STAGES.has(move.toStage);
      if (entering && activeSince === null) {
        activeSince = move.date;
      } else if (leaving) {
        activeWorkingHours += this.calcWorkingHours(activeSince, move.date);
        activeSince = null;
      }
    }
    // Card is currently in an active stage
    if (activeSince !== null) {
      const refNow = card.dateLastActivity ? new Date(card.dateLastActivity) : new Date();
      activeWorkingHours += this.calcWorkingHours(activeSince, refNow);
    }

    // Calendar elapsed hours start→end (for reference display only)
    const refEnd = endDate || (card.dateLastActivity ? new Date(card.dateLastActivity) : new Date());
    const totalHours = startDate ? Math.max(0, (refEnd - startDate) / 3600000) : 0;

    // Build stage-by-stage breakdown for the desglose view
    const periods = movements.map((move, i) => {
      const periodStart = move.date;
      const periodEnd   = i < movements.length - 1
        ? movements[i + 1].date
        : (endDate || (card.dateLastActivity ? new Date(card.dateLastActivity) : new Date()));
      const isActive    = ACTIVE_STAGES.has(move.toStage);
      const calendarMs  = Math.max(0, periodEnd - periodStart);
      return {
        date:         periodStart,
        listName:     move.to,
        fromListName: move.from,
        stage:        move.toStage,
        fromStage:    move.fromStage,
        member:       move.member,
        isActive,
        calendarMs,
        isSameInterval:  calendarMs < 5 * 60 * 1000,
        isOutsideHours:  isActive && this.isOutsideOfficeHours(periodStart),
        workingHours: isActive ? this.calcWorkingHours(periodStart, periodEnd) : 0
      };
    });

    // Current stage from last movement
    const lastMove = movements[movements.length - 1];

    return {
      cardId:       card.id,
      cardName:     card.name,
      idMembers:    card.idMembers || [],
      startDate,
      endDate,
      totalHours,
      workingHours: activeWorkingHours,
      revisions,
      sentCount,
      movements,
      periods,
      currentStage: lastMove?.toStage || 'backlog',
      currentList:  lastMove?.to || '',
      isDone:       !!endDate,
      isStarted:    !!startDate,
      hasOutsideHoursActivity: periods.some(p => p.isActive && p.isOutsideHours)
    };
  },

  // Office hours: Mon-Fri 8:00-12:00 and 13:00-17:00
  // Returns true if the given date falls outside those hours (night, lunch, weekend)
  isOutsideOfficeHours(date) {
    if (!date) return false;
    const d = new Date(date);
    const day = d.getDay();
    if (day === 0 || day === 6) return true;
    const h = d.getHours() + d.getMinutes() / 60;
    return h < 8 || (h >= 12 && h < 13) || h >= 17;
  },

  // Count actual elapsed hours between two timestamps — no time restriction.
  // Remote workers may work at any hour; every minute counts.
  calcWorkingHours(start, end) {
    if (!start || !end || end <= start) return 0;
    return Math.max(0, (end - start) / 3600000);
  },

  calcProjectSummary(timelines) {
    const all      = Object.values(timelines);
    const started  = all.filter(t => t.isStarted);
    const done     = all.filter(t => t.isDone);
    const notStart = all.filter(t => !t.isStarted);

    const totalCalHours = started.reduce((s, t) => s + t.totalHours, 0);
    const totalWorkHours = started.reduce((s, t) => s + t.workingHours, 0);
    const totalRevisions = all.reduce((s, t) => s + t.revisions, 0);
    const avgRevisions   = started.length > 0 ? totalRevisions / started.length : 0;
    const avgCycleTime   = done.length > 0
      ? done.reduce((s, t) => s + t.workingHours, 0) / done.length : 0;

    return {
      totalCalHours,
      totalWorkHours,
      totalRevisions,
      avgRevisions,
      avgCycleTime,
      startedCount:       started.length,
      doneCount:          done.length,
      pendingCount:       notStart.length,
      outsideHoursCount:  all.filter(t => t.hasOutsideHoursActivity).length
    };
  },

  formatDuration(hours) {
    if (!hours || hours <= 0) return '—';
    if (hours < 1) return `${Math.round(hours * 60)}m`;
    const days = Math.floor(hours / 24);
    const h    = Math.round(hours % 24);
    if (days >= 1) return `${days}d ${h > 0 ? h + 'h' : ''}`.trim();
    return `${Math.round(hours)}h`;
  },

  formatDate(date) {
    if (!date) return '—';
    return new Date(date).toLocaleDateString('es-MX', {
      day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit'
    });
  },

  stageLabel(stage) { return this.STAGES[stage]?.label || stage; },
  stageColor(stage) { return this.STAGES[stage]?.color || '#64748b'; },
  stageBg(stage)    { return this.STAGES[stage]?.bg    || 'rgba(100,116,139,0.1)'; },
};

window.TimeCalc = TimeCalc;
