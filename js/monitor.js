const Monitor = (() => {

  const RULES = {
    R07: { code: 'R-07', label: 'Movimiento rápido en "En Proceso"',         short: 'Mov. rápido',       color: '#f59e0b' },
    R08: { code: 'R-08', label: 'Tarjeta olvidada en "En Proceso"',          short: 'Olvidada >2 días',  color: '#ef4444' },
    R11: { code: 'R-11', label: '"Cambios" no retornó a "En Proceso"',       short: 'Bypass Cambios',    color: '#6366f1' },
    R12: { code: 'R-12', label: 'Múltiples movimientos a "Cambios" el mismo día', short: 'Cambios duplicados', color: '#a855f7' },
  };

  const ROLE_LABELS = { diseñador: 'Diseñador', cm: 'CM', pm: 'PM', otro: 'Otro' };
  const ROLE_COLORS = { diseñador: '#6366f1', cm: '#f59e0b', pm: '#10b981', otro: '#94a3b8' };

  let _violations     = [];
  let _members        = {};
  let _selected       = null;
  let _notasMap       = {}; // cardId → { 'R-07': [{ text, date, author }], ... }
  let _lockedMemberId = null;

  function _buildNotasMap(commentActions) {
    for (const a of commentActions) {
      const cardId = a.data?.card?.id;
      const text   = a.data?.text || '';
      if (!cardId) continue;
      const ruleMatch  = text.match(/IDEAZ_NOTA_FALTA:\s*(R-\d+)/);
      if (!ruleMatch) continue;
      const ruleCode   = ruleMatch[1];
      const motivoMatch = text.match(/\nMotivo: (.+)/);
      if (!_notasMap[cardId])            _notasMap[cardId] = {};
      if (!_notasMap[cardId][ruleCode])  _notasMap[cardId][ruleCode] = [];
      _notasMap[cardId][ruleCode].push({
        text:   motivoMatch ? motivoMatch[1].trim() : text,
        date:   new Date(a.date),
        author: a.memberCreator?.fullName || ''
      });
    }
    for (const cardId of Object.keys(_notasMap))
      for (const code of Object.keys(_notasMap[cardId]))
        _notasMap[cardId][code].sort((a, b) => b.date - a.date);
  }

  // ── Violation scanners ────────────────────────────────────────────────────

  function _nameToIdMap() {
    const names = Storage.getAllMemberNames();
    const map = {};
    for (const [id, name] of Object.entries(names)) map[name] = id;
    return map;
  }

  // Returns idMembers filtered by expected role; falls back to all if no roles configured
  function _byRole(idMembers, role, roles) {
    const filtered = (idMembers || []).filter(id => roles[id] === role);
    return filtered.length > 0 ? filtered : (idMembers || []);
  }

  function _violation(memberId, rule, ctx) {
    return { memberId, ...rule, ...ctx };
  }

  function _scanR07(card, tl, projectName, boardId, n2id, roles) {
    return (tl.periods || [])
      .filter(p => p.isSameInterval && p.stage === 'inProgress')
      .flatMap(p => {
        const ids = p.member && n2id[p.member]
          ? [n2id[p.member]]
          : _byRole(card.idMembers, 'diseñador', roles);
        const min = Math.round(p.calendarMs / 60000);
        return ids.map(id => _violation(id, RULES.R07, {
          projectId: boardId, projectName,
          cardId: card.id, cardName: card.name, shortLink: card.shortLink,
          date: p.date,
          detail: `Estuvo ${min} min en "En Proceso" — umbral: 2 min`
        }));
      });
  }

  function _scanR08(card, tl, projectName, boardId, roles) {
    if (tl.currentStage !== 'inProgress' || tl.isDone) return [];
    const lastMove = [...(tl.movements || [])].reverse().find(m => m.toStage === 'inProgress');
    if (!lastMove) return [];
    const hoursStuck = (Date.now() - lastMove.date.getTime()) / 3600000;
    if (hoursStuck <= 48) return [];
    const days = (hoursStuck / 24).toFixed(1);
    return _byRole(card.idMembers, 'diseñador', roles).map(id =>
      _violation(id, RULES.R08, {
        projectId: boardId, projectName,
        cardId: card.id, cardName: card.name, shortLink: card.shortLink,
        date: lastMove.date,
        detail: `Lleva ${days} días en "En Proceso" sin moverse (máx: 2 días)`
      })
    );
  }

  function _scanR11(card, tl, projectName, boardId, n2id) {
    const mvs = tl.movements || [];
    return mvs.flatMap((m, i) => {
      if (m.toStage !== 'clientRevision' || i >= mvs.length - 1) return [];
      const next = mvs[i + 1];
      if (next.toStage === 'inProgress') return [];
      // Atribuir siempre al autor real del movimiento que se saltó "En Proceso"
      const id = next.member && n2id[next.member];
      if (!id) return [];
      return [_violation(id, RULES.R11, {
        projectId: boardId, projectName,
        cardId: card.id, cardName: card.name, shortLink: card.shortLink,
        date: next.date,
        detail: `De "Cambios" pasó directo a "${next.to}" sin volver a "En Proceso"`
      })];
    });
  }

  function _scanR12(card, tl, projectName, boardId, n2id, roles) {
    const cambios = (tl.movements || []).filter(m => m.toStage === 'clientRevision');
    const byDay = {};
    for (const m of cambios) {
      const day = m.date.toDateString();
      (byDay[day] = byDay[day] || []).push(m);
    }
    return Object.values(byDay).flatMap(moves => {
      if (moves.length < 3) return [];
      return moves.slice(2).flatMap(m => {
        const ids = m.member && n2id[m.member]
          ? [n2id[m.member]]
          : _byRole(card.idMembers, 'cm', roles);
        return ids.map(id => _violation(id, RULES.R12, {
          projectId: boardId, projectName,
          cardId: card.id, cardName: card.name, shortLink: card.shortLink,
          date: m.date,
          detail: `${moves.length}° movimiento a "Cambios" el ${m.date.toLocaleDateString('es-MX')} — máximo 2 movimientos por día`
        }));
      });
    });
  }

  function _scan(boards, details) {
    const violations = [];
    const roles = Storage.getAllRoles();

    boards.forEach((board, i) => {
      const detail = details[i];
      if (!detail) return;
      const { cards, members, actions } = detail;
      for (const m of members) Storage.saveMemberName(m.id, m.fullName);

      const n2id = _nameToIdMap();
      const openCards = cards.filter(c => !c.closed);
      const timelines = TimeCalc.buildCardTimelines(actions || [], openCards);

      for (const card of openCards) {
        const tl = timelines[card.id];
        if (!tl) continue;
        violations.push(
          ..._scanR07(card, tl, board.name, board.id, n2id, roles),
          ..._scanR08(card, tl, board.name, board.id, roles),
          ..._scanR11(card, tl, board.name, board.id, n2id),
          ..._scanR12(card, tl, board.name, board.id, n2id, roles)
        );
      }
    });

    return violations;
  }

  // ── Filters ───────────────────────────────────────────────────────────────

  function _filtered() {
    const month = document.getElementById('f-month')?.value;
    const from  = document.getElementById('f-date-from')?.value;
    const to    = document.getElementById('f-date-to')?.value;
    return _violations.filter(v => {
      if (_lockedMemberId && v.memberId !== _lockedMemberId) return false;
      if (from || to) {
        const d = v.date.toISOString().slice(0, 10);
        if (from && d < from) return false;
        if (to   && d > to)   return false;
        return true;
      }
      if (month) return v.date.toISOString().slice(0, 7) === month;
      return true;
    });
  }

  function _isLastWeek(date) {
    return date.getTime() >= Date.now() - 7 * 24 * 60 * 60 * 1000;
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function _renderLegend(filtered) {
    const counts = {};
    for (const v of filtered) counts[v.code] = (counts[v.code] || 0) + 1;
    document.getElementById('monitor-legend').innerHTML = Object.values(RULES).map(r => `
      <div class="bg-slate-900 border border-slate-700 rounded-xl px-4 py-3 flex items-center gap-3">
        <span class="text-2xl font-black" style="color:${r.color}">${counts[r.code] || 0}</span>
        <div>
          <div class="text-xs font-bold" style="color:${r.color}">${r.code}</div>
          <div class="text-xs text-slate-400 leading-tight">${r.short}</div>
        </div>
      </div>`).join('');
  }

  function _renderGrid(filtered) {
    const roles = Storage.getAllRoles();
    const counts = {};
    const lastWeekCounts = {};
    for (const v of filtered) {
      counts[v.memberId] = (counts[v.memberId] || 0) + 1;
      if (_isLastWeek(v.date)) lastWeekCounts[v.memberId] = (lastWeekCounts[v.memberId] || 0) + 1;
    }

    const roledMembers = _lockedMemberId
      ? Object.values(_members).filter(m => m.id === _lockedMemberId)
      : Object.values(_members).filter(m => roles[m.id]).sort((a, b) => (counts[b.id] || 0) - (counts[a.id] || 0));

    const grid = document.getElementById('monitor-grid');

    if (roledMembers.length === 0) {
      grid.innerHTML = `<div class="col-span-full text-center py-10 text-slate-400">
        ${_lockedMemberId ? 'No se encontraron datos para tu usuario.' : 'Sin roles configurados. <a href="configuracion.html" class="text-indigo-400 hover:underline ml-1">Asigna roles en Configuración →</a>'}
      </div>`;
      return;
    }

    grid.innerHTML = roledMembers.map(m => {
      const role     = roles[m.id];
      const count    = counts[m.id] || 0;
      const lastWeek = lastWeekCounts[m.id] || 0;
      const rc       = ROLE_COLORS[role] || '#94a3b8';
      const active   = _selected === m.id;
      const border   = active ? '#6366f1' : count > 0 ? '#ef444466' : '#1e293b';
      return `
        <div class="bg-slate-900 rounded-2xl p-6 cursor-pointer transition-all hover:-translate-y-0.5 hover:shadow-xl"
             style="border:2px solid ${border};${active ? 'box-shadow:0 0 0 2px #6366f1' : ''}"
             onclick="Monitor.select('${m.id}')">
          <div class="flex items-center gap-3 mb-5">
            <div class="w-11 h-11 rounded-full flex items-center justify-center font-black text-white flex-shrink-0"
                 style="background:${Utils.avatarColor(m.id)};font-size:0.85rem">
              ${Utils.initials(m.name)}
            </div>
            <div class="min-w-0">
              <div class="font-bold text-slate-100 text-sm truncate">${m.name}</div>
              <span class="text-xs font-semibold px-2 py-0.5 rounded-full"
                    style="background:${rc}20;color:${rc}">${ROLE_LABELS[role] || role}</span>
            </div>
          </div>
          <div class="flex items-baseline gap-2">
            <div class="text-5xl font-black leading-none ${count > 0 ? 'text-red-400' : 'text-slate-700'}">${count}</div>
            ${lastWeek > 0 ? `<span class="text-xs font-bold px-2 py-1 rounded-full bg-amber-500/15 text-amber-400 whitespace-nowrap">+${lastWeek} últ. semana</span>` : ''}
          </div>
          <div class="text-xs text-slate-500 mt-1.5">${count === 1 ? 'falta detectada' : 'faltas detectadas'}</div>
        </div>`;
    }).join('');
  }

  function _renderDetail(filtered) {
    const panel = document.getElementById('monitor-detail');
    if (!_selected) { panel.style.display = 'none'; return; }

    const mv = filtered.filter(v => v.memberId === _selected)
                       .sort((a, b) => b.date - a.date);
    const m  = _members[_selected];
    const lastWeekCount = mv.filter(v => _isLastWeek(v.date)).length;
    panel.style.display = 'block';

    if (mv.length === 0) {
      panel.innerHTML = `<div class="bg-slate-900 border border-slate-700 rounded-2xl p-6 mt-6 text-sm text-slate-400">
        <strong class="text-slate-200">${m?.name}</strong> — sin faltas en el período seleccionado.
      </div>`;
      return;
    }

    panel.innerHTML = `
      <div class="bg-slate-900 border border-slate-700 rounded-2xl mt-6 overflow-hidden">
        <div class="px-6 py-4 border-b border-slate-700 flex items-center justify-between">
          <div>
            <span class="font-bold text-slate-100">${m?.name}</span>
            <span class="text-slate-400 text-sm ml-2">— ${mv.length} falta${mv.length !== 1 ? 's' : ''} en el período</span>
            ${lastWeekCount > 0 ? `<span class="ml-2 text-xs font-bold px-2 py-1 rounded-full bg-amber-500/15 text-amber-400">${lastWeekCount} en la última semana</span>` : ''}
          </div>
          <button onclick="Monitor.select('${_selected}')"
                  class="text-slate-500 hover:text-slate-300 transition-colors text-lg leading-none">✕</button>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-slate-700 bg-slate-800/50">
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider" style="width:12%">Regla</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider" style="width:18%">Proyecto</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider" style="width:22%">Tarjeta</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider" style="width:16%">Fecha y hora</th>
                <th class="px-4 py-3 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider" style="width:32%">Detalle</th>
              </tr>
            </thead>
            <tbody>
              ${mv.map(v => {
                const isLastWeek = _isLastWeek(v.date);
                const notas      = (_notasMap[v.cardId] || {})[v.code] || [];
                const panelId    = `np-${v.cardId}-${v.code.replace('-','')}`;

                const notasListHtml = notas.map(n => `
                  <div style="padding:7px 10px;background:#0f172a;border-radius:6px;margin-bottom:5px">
                    <div style="font-size:0.78rem;color:#e2e8f0">${n.text}</div>
                    <div style="font-size:0.65rem;color:#64748b;margin-top:3px">${n.author} · ${n.date.toLocaleDateString('es-CO', { dateStyle: 'medium' })}</div>
                  </div>`).join('');

                const notasPanel = `
                  <tr id="${panelId}" data-card-id="${v.cardId}" data-board-id="${v.projectId}" data-rule-code="${v.code}" style="display:none;border-top:none">
                    <td colspan="5" style="padding:0;border-top:none">
                      <div style="margin:0 0 4px 0;background:#1e293b;border:1px solid #334155;border-top:none;border-radius:0 0 10px 10px;padding:12px 16px">
                        ${notas.length > 0 ? `<div style="margin-bottom:10px">${notasListHtml}</div>` : ''}
                        <div style="font-size:0.72rem;font-weight:600;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em">${notas.length > 0 ? '+ Agregar otra nota' : 'Agregar nota'}</div>
                        <textarea placeholder="Explica por qué se generó esta falta o el contexto del error..."
                          style="width:100%;box-sizing:border-box;background:#0f172a;border:1px solid #475569;border-radius:6px;padding:8px 10px;color:#f1f5f9;font-size:0.8rem;resize:vertical;outline:none;font-family:inherit;min-height:64px"
                          onfocus="this.style.borderColor='#6366f1'" onblur="this.style.borderColor='#475569'"></textarea>
                        <div style="display:flex;justify-content:flex-end;margin-top:8px">
                          <button class="nota-save-btn" onclick="Monitor.addNota('${panelId}')"
                            style="padding:6px 16px;border-radius:6px;font-size:0.8rem;font-weight:600;color:#fff;background:#6366f1;border:none;cursor:pointer">
                            Guardar en Trello
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>`;

                const notaBtn = `<button onclick="Monitor.toggleNotas('${panelId}')"
                  style="margin-top:6px;display:inline-flex;align-items:center;gap:3px;padding:2px 8px;border-radius:4px;font-size:0.68rem;font-weight:600;cursor:pointer;border:1px solid rgba(99,102,241,0.4);background:rgba(99,102,241,0.1);color:#a5b4fc">
                  📝 ${notas.length > 0 ? notas.length + ' nota' + (notas.length > 1 ? 's' : '') : '+ Nota'}
                </button>`;

                return `
                <tr class="hover:bg-slate-800/30 transition-colors ${isLastWeek ? 'bg-amber-500/5' : ''}" style="border-top:1px solid rgba(51,65,85,0.5)">
                  <td class="px-4 py-3">
                    <span class="inline-flex items-center px-2 py-0.5 rounded text-xs font-bold"
                          style="background:${v.color}20;color:${v.color}">${v.code}</span>
                    <div class="text-xs text-slate-500 mt-0.5">${v.short}</div>
                  </td>
                  <td class="px-4 py-3 text-xs text-slate-300">${v.projectName}</td>
                  <td class="px-4 py-3">
                    <div class="text-xs text-slate-200 font-medium">${v.cardName}</div>
                    ${v.shortLink ? `<a href="https://trello.com/c/${v.shortLink}" target="_blank"
                        class="text-xs text-blue-400 hover:underline">Ver en Trello →</a>` : ''}
                  </td>
                  <td class="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">
                    ${v.date.toLocaleString('es-MX', { day:'2-digit', month:'short', year:'2-digit', hour:'2-digit', minute:'2-digit' })}
                    ${isLastWeek ? '<span class="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-400 whitespace-nowrap">Últ. semana</span>' : ''}
                  </td>
                  <td class="px-4 py-3 text-xs text-slate-300">
                    ${v.detail}
                    ${notaBtn}
                  </td>
                </tr>${notasPanel}`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>`;
  }

  function _render() {
    const f = _filtered();
    _renderLegend(f);
    _renderGrid(f);
    _renderDetail(f);
  }

  // ── Public API ────────────────────────────────────────────────────────────

  function select(memberId) {
    _selected = _selected === memberId ? null : memberId;
    _render();
    if (_selected) document.getElementById('monitor-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function applyFilters() {
    if (document.getElementById('f-month').value) {
      document.getElementById('f-date-from').value = '';
      document.getElementById('f-date-to').value   = '';
    }
    _selected = null;
    _render();
  }

  function applyDateRange() {
    const from = document.getElementById('f-date-from');
    const to   = document.getElementById('f-date-to');
    // Si "desde" queda después de "hasta", ajusta "hasta" para mantener el rango válido
    if (from.value && to.value && from.value > to.value) to.value = from.value;
    if (from.value || to.value) document.getElementById('f-month').value = '';
    _selected = null;
    _render();
  }

  function clearDateRange() {
    document.getElementById('f-date-from').value = '';
    document.getElementById('f-date-to').value   = '';
    _selected = null;
    _render();
  }

  async function load(forceRefresh = false, lockedMemberId = null) {
    _lockedMemberId = lockedMemberId;
    document.getElementById('state-loading').style.display  = 'flex';
    document.getElementById('state-main').style.display     = 'none';
    document.getElementById('state-error').style.display    = 'none';

    try {
      const creds = Storage.getCredentials();
      const api   = new TrelloAPI(creds.key, creds.token, { forceRefresh });
      const boards = await api.getBoards();
      const [details, commentArrays] = await Promise.all([
        Promise.all(boards.map(b => api.getBoardWithDetails(b.id).catch(() => null))),
        Promise.all(boards.map(b => api.getBoardCommentActions(b.id).catch(() => [])))
      ]);

      _notasMap = {};
      commentArrays.forEach(ca => _buildNotasMap(ca || []));

      // Build member map from all boards
      _members = {};
      for (const d of details) {
        if (!d) continue;
        for (const m of d.members) {
          _members[m.id] = { id: m.id, name: m.fullName };
          Storage.saveMemberName(m.id, m.fullName);
        }
      }

      _violations = _scan(boards, details);

      // Populate month filter
      const months = [...new Set(_violations.map(v => v.date.toISOString().slice(0, 7)))].sort().reverse();
      const mSel = document.getElementById('f-month');
      mSel.innerHTML = '<option value="">Todos los períodos</option>' +
        months.map(m => `<option value="${m}">${Utils.formatPeriod(m)}</option>`).join('');
      const cur = new Date().toISOString().slice(0, 7);
      if (months.includes(cur)) mSel.value = cur;

      _selected = _lockedMemberId || null;
      _render();

      document.getElementById('state-loading').style.display = 'none';
      document.getElementById('state-main').style.display    = 'block';
      document.getElementById('last-updated').textContent    = 'Actualizado: ' + new Date().toLocaleTimeString('es-MX');
    } catch (e) {
      document.getElementById('state-loading').style.display = 'none';
      document.getElementById('state-error').style.display   = 'block';
      document.getElementById('error-msg').textContent       = e.message;
    }
  }

  function refresh() {
    return load(true, _lockedMemberId);
  }

  function toggleNotas(panelId) {
    const row = document.getElementById(panelId);
    if (!row) return;
    row.style.display = row.style.display === 'none' ? 'table-row' : 'none';
  }

  async function addNota(panelId) {
    const row      = document.getElementById(panelId);
    const cardId   = row.dataset.cardId;
    const boardId  = row.dataset.boardId;
    const ruleCode = row.dataset.ruleCode;
    const textarea = row.querySelector('textarea');
    const text     = textarea.value.trim();
    if (!text) { Utils.showToast('Escribe el motivo antes de guardar', 'error'); return; }

    const saveBtn = row.querySelector('.nota-save-btn');
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Guardando…';

    const { key, token } = Storage.getCredentials();
    const api   = new TrelloAPI(key, token);
    const fecha = new Date().toLocaleDateString('es-CO', { dateStyle: 'long' });
    const trelloText =
      `📝 [NOTA DE FALTA — ${ruleCode} — ${fecha}]\n` +
      `IDEAZ_NOTA_FALTA: ${ruleCode}\n\n` +
      `Motivo: ${text}`;

    try {
      await api.postComment(cardId, trelloText);
      TrelloCache.invalidate(`comments_${boardId}`);
      if (!_notasMap[cardId])           _notasMap[cardId] = {};
      if (!_notasMap[cardId][ruleCode]) _notasMap[cardId][ruleCode] = [];
      _notasMap[cardId][ruleCode].unshift({ text, date: new Date(), author: 'Tú' });
      Utils.showToast('Nota guardada en Trello ✓', 'success');
      _render();
    } catch (e) {
      Utils.showToast('Error al guardar nota: ' + e.message, 'error');
      saveBtn.disabled    = false;
      saveBtn.textContent = 'Guardar en Trello';
    }
  }

  return { load, refresh, select, applyFilters, applyDateRange, clearDateRange, toggleNotas, addNota };
})();

window.Monitor = Monitor;
