const PautaMonitor = (() => {

  const LS_KEY   = 'pauta_clients';
  const API_PATH = 'api/spend.php';

  const PLATFORMS = [
    { key: 'meta',   label: 'Meta Ads',    icon: '📘', color: 'blue'   },
    { key: 'google', label: 'Google Ads',  icon: '🔴', color: 'red'    },
    { key: 'tiktok', label: 'TikTok Ads',  icon: '🎵', color: 'purple' },
  ];

  let _clients  = [];
  let _spend    = {};   // { 'clientId:platform:accountId': { total_spend, daily_data, currency, error } }
  let _loading  = false;

  // ── Storage ────────────────────────────────────────────────────────────────

  function _load() {
    try { _clients = JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
    catch { _clients = []; }
  }

  function _save() {
    localStorage.setItem(LS_KEY, JSON.stringify(_clients));
  }

  function _uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // ── Date helpers ───────────────────────────────────────────────────────────

  function _monthKey(dateStr) {
    return dateStr.slice(0, 7); // 'YYYY-MM'
  }

  function _daysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function _dateRange() {
    const from = document.getElementById('p-from')?.value;
    const to   = document.getElementById('p-to')?.value;
    return { from, to };
  }

  // Returns pro-rated budget for a date range across one or multiple months
  function _budgetForRange(budgetsObj, dateFrom, dateTo) {
    let total = 0;
    const start = new Date(dateFrom + 'T00:00:00');
    const end   = new Date(dateTo   + 'T00:00:00');
    let cursor  = new Date(start.getFullYear(), start.getMonth(), 1);

    while (cursor <= end) {
      const y  = cursor.getFullYear();
      const m  = cursor.getMonth() + 1;
      const mk = `${y}-${String(m).padStart(2, '0')}`;
      const monthlyBudget = Number(budgetsObj?.[mk] || 0);
      const daysInM = _daysInMonth(y, m);

      const mStart = new Date(y, m - 1, 1);
      const mEnd   = new Date(y, m, 0);
      const rStart = start > mStart ? start : mStart;
      const rEnd   = end   < mEnd   ? end   : mEnd;
      const days   = Math.round((rEnd - rStart) / 86400000) + 1;

      total += (monthlyBudget / daysInM) * days;
      cursor = new Date(y, m, 1); // first of next month
    }
    return Math.round(total * 100) / 100;
  }

  // Daily budget = monthly / days_in_month (for the month of dateFrom)
  function _dailyBudget(budgetsObj, dateFrom) {
    const mk = _monthKey(dateFrom);
    const [y, m] = mk.split('-').map(Number);
    const monthly = Number(budgetsObj?.[mk] || 0);
    return monthly / _daysInMonth(y, m);
  }

  // Days elapsed in range (inclusive)
  function _daysInRange(dateFrom, dateTo) {
    const a = new Date(dateFrom + 'T00:00:00');
    const b = new Date(dateTo   + 'T00:00:00');
    return Math.round((b - a) / 86400000) + 1;
  }

  // ── Alert level ────────────────────────────────────────────────────────────
  // Returns: 'ok' | 'warn' | 'over'

  function _budgetAlert(spend, budget) {
    if (budget <= 0) return 'ok';
    const pct = spend / budget;
    if (pct >= 1.0)  return 'over';
    if (pct >= 0.85) return 'warn';
    return 'ok';
  }

  function _paceAlert(actualDaily, budgetDaily) {
    if (budgetDaily <= 0) return 'ok';
    const ratio = actualDaily / budgetDaily;
    if (ratio > 1.20) return 'over';
    if (ratio > 1.05) return 'warn';
    return 'ok';
  }

  const _alertColors = {
    ok:   { bar: 'bg-emerald-500', badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', text: 'text-emerald-400' },
    warn: { bar: 'bg-yellow-500',  badge: 'bg-yellow-500/20  text-yellow-400  border-yellow-500/30',  text: 'text-yellow-400'  },
    over: { bar: 'bg-red-500',     badge: 'bg-red-500/20     text-red-400     border-red-500/30',     text: 'text-red-400'     },
  };

  // ── API fetch ──────────────────────────────────────────────────────────────

  async function _fetchSpend(platform, accountId, from, to) {
    const key = `${platform}:${accountId}`;
    const url = `${API_PATH}?platform=${encodeURIComponent(platform)}&account_id=${encodeURIComponent(accountId)}&from=${from}&to=${to}`;
    try {
      const res  = await fetch(url);
      const data = await res.json();
      _spend[key] = data;
    } catch (e) {
      _spend[key] = { error: 'No se pudo conectar al servidor', platform };
    }
  }

  async function loadData() {
    if (_loading) return;
    _loading = true;
    _setLoadingState(true);

    const { from, to } = _dateRange();
    if (!from || !to) { _loading = false; _setLoadingState(false); return; }

    const calls = [];
    for (const client of _clients) {
      for (const plat of (client.platforms || [])) {
        if (!plat.enabled) continue;
        const accountId = plat.account_id || plat.customer_id || plat.advertiser_id || '';
        if (!accountId) continue;
        calls.push(_fetchSpend(plat.platform, accountId, from, to));
      }
    }

    await Promise.all(calls);
    _loading = false;
    _setLoadingState(false);
    render();
  }

  function _setLoadingState(on) {
    const btn = document.getElementById('p-refresh');
    if (btn) btn.disabled = on;
    const spinner = document.getElementById('p-spinner');
    if (spinner) spinner.style.display = on ? 'inline-block' : 'none';
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function _sparkline(dailyArr, color) {
    if (!dailyArr || dailyArr.length < 2) return '';
    const values = dailyArr.map(d => d.spend);
    const max    = Math.max(...values, 0.01);
    const H = 28, gap = 1;
    const barW   = Math.max(2, Math.floor((300 - gap * (dailyArr.length - 1)) / dailyArr.length));
    const totalW = dailyArr.length * (barW + gap) - gap;
    const bars   = values.map((v, i) => {
      const h = Math.max(2, Math.round((v / max) * H));
      return `<rect x="${i * (barW + gap)}" y="${H - h}" width="${barW}" height="${h}" rx="1" fill="${color}" opacity="0.75">
        <title>${dailyArr[i].date}  $${_fmt(v)}</title></rect>`;
    }).join('');
    return `<svg viewBox="0 0 ${totalW} ${H}" width="100%" height="28" preserveAspectRatio="none">${bars}</svg>`;
  }

  function _insightsHtml(spend, budget, dailyAvg, days, from, to) {
    if (budget <= 0 || spend <= 0 || days <= 0) return '';
    const now      = new Date();
    const todayStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    if (to !== todayStr) return '';
    const year = parseInt(to.slice(0, 4)), month = parseInt(to.slice(5, 7));
    const remainingDays = _daysInMonth(year, month) - now.getDate();
    if (remainingDays <= 0) return '';

    const projected  = spend + dailyAvg * remainingDays;
    const projPct    = (projected / budget * 100);
    const projColor  = projected > budget ? 'text-red-400' : projPct >= 85 ? 'text-yellow-400' : 'text-emerald-400';

    let runsOutStr = '';
    if (projected > budget && dailyAvg > 0) {
      const daysLeft  = Math.floor(Math.max(0, budget - spend) / dailyAvg);
      const runsOut   = new Date(now);
      runsOut.setDate(now.getDate() + daysLeft);
      runsOutStr = ` · se agota el día ${runsOut.getDate()}`;
    }

    const reqDaily   = Math.max(0, budget - spend) / remainingDays;
    const paceRatio  = reqDaily > 0 ? dailyAvg / reqDaily : 1;
    const reqColor   = paceRatio > 1.1 ? 'text-red-400' : paceRatio < 0.9 ? 'text-yellow-400' : 'text-emerald-400';
    const reqLabel   = paceRatio > 1.1 ? 'reducir a' : paceRatio < 0.9 ? 'aumentar a' : 'mantener';

    return `
    <div class="flex flex-col gap-1.5 border-t border-slate-800 pt-3 text-xs">
      <div class="flex items-center justify-between">
        <span class="text-slate-500">Proyección fin de mes</span>
        <span class="${projColor} font-semibold">$${_fmt(projected)}
          <span class="opacity-60 font-normal">${projPct.toFixed(1)}%${runsOutStr}</span>
        </span>
      </div>
      <div class="flex items-center justify-between">
        <span class="text-slate-500">Ritmo requerido <span class="text-slate-600">(${remainingDays}d restantes)</span></span>
        <span class="${reqColor} font-semibold">${reqLabel} $${_fmt(reqDaily)}/día
          <span class="opacity-60 font-normal">· actual $${_fmt(dailyAvg)}/día</span>
        </span>
      </div>
    </div>`;
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    const container = document.getElementById('pauta-cards');
    if (!container) return;

    if (_clients.length === 0) {
      container.innerHTML = `
        <div class="col-span-full flex flex-col items-center justify-center py-24 text-slate-500 gap-3">
          <div class="text-5xl">💰</div>
          <p class="text-sm">No hay clientes configurados.</p>
          <button onclick="PautaMonitor.openClientModal()" class="mt-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
            + Agregar primer cliente
          </button>
        </div>`;
      return;
    }

    container.innerHTML = _clients.map(c => _renderCard(c)).join('');
  }

  function _renderCard(client) {
    const { from, to } = _dateRange();
    const days = _daysInRange(from, to);

    // Global budget for range
    const globalBudget = _budgetForRange(client.budgets, from, to);
    const globalDaily  = _dailyBudget(client.budgets, from);

    // Sum spend across enabled platforms and aggregate daily data
    let globalSpend = 0;
    const globalDailyMap = {};
    const platformRows = (client.platforms || []).map(plat => {
      if (!plat.enabled) return null;
      const accountId = plat.account_id || plat.customer_id || plat.advertiser_id || '';
      const key       = `${plat.platform}:${accountId}`;
      const result    = _spend[key];
      const budget    = _budgetForRange(plat.budgets, from, to);
      const dailyB    = _dailyBudget(plat.budgets, from);

      if (!result) return _renderPlatformRow(plat, 0, budget, dailyB, days, 'loading');
      if (result.error) return _renderPlatformRow(plat, 0, budget, dailyB, days, 'error', result.error);

      const spend     = result.total_spend || 0;
      globalSpend    += spend;
      (result.daily_data || []).forEach(d => {
        globalDailyMap[d.date] = (globalDailyMap[d.date] || 0) + d.spend;
      });
      return _renderPlatformRow(plat, spend, budget, dailyB, days, 'ok', null, result.daily_data || []);
    }).filter(Boolean).join('');

    const globalDailyArr    = Object.entries(globalDailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, spend]) => ({ date, spend }));
    const globalActualDaily = days > 0 ? globalSpend / days : 0;
    const budgetAlert = _budgetAlert(globalSpend, globalBudget);
    const paceAlert   = _paceAlert(globalActualDaily, globalDaily);
    const overallAlert = (budgetAlert === 'over' || paceAlert === 'over') ? 'over'
                       : (budgetAlert === 'warn' || paceAlert === 'warn') ? 'warn' : 'ok';

    const ac     = _alertColors[overallAlert];
    const pct    = globalBudget > 0 ? Math.min((globalSpend / globalBudget) * 100, 100) : 0;
    const pctNum = globalBudget > 0 ? (globalSpend / globalBudget * 100).toFixed(1)    : '—';
    const dailyPaceHtml = globalDaily > 0 ? `
      <span class="text-xs ${_alertColors[paceAlert].text} border ${_alertColors[paceAlert].badge} rounded px-1.5 py-0.5 ml-2">
        ${paceAlert === 'ok' ? '✓' : paceAlert === 'warn' ? '⚡' : '🔴'}
        $${_fmt(globalActualDaily)}/día vs $${_fmt(globalDaily)}/día meta
      </span>` : '';

    const sparkHexColors = { ok: '#10b981', warn: '#eab308', over: '#ef4444' };
    const globalSparkHtml = globalDailyArr.length > 1 ? `
      <div class="border-t border-slate-800 pt-3">
        <div class="text-xs text-slate-500 mb-1.5">Gasto diario</div>
        ${_sparkline(globalDailyArr, sparkHexColors[overallAlert])}
      </div>` : '';

    return `
    <div class="bg-slate-900 border border-slate-700 rounded-2xl p-5 flex flex-col gap-4">
      <!-- Client header -->
      <div class="flex items-start justify-between gap-2">
        <div>
          <h2 class="text-base font-bold text-slate-100">${_esc(client.name)}</h2>
          <div class="flex items-center flex-wrap gap-1 mt-1">
            <span class="text-xs text-slate-400">Presupuesto: <strong class="text-slate-200">$${_fmt(globalBudget)}</strong></span>
            ${dailyPaceHtml}
          </div>
        </div>
        <button onclick="PautaMonitor.openClientModal('${client.id}')" title="Editar cliente"
          class="text-slate-500 hover:text-slate-300 text-lg leading-none flex-shrink-0 transition-colors">⚙</button>
      </div>

      <!-- Global progress -->
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-slate-400">Gastado <strong class="${ac.text}">$${_fmt(globalSpend)}</strong></span>
          <span class="${ac.text} font-bold">${pctNum}%</span>
        </div>
        <div class="w-full bg-slate-800 rounded-full h-3 overflow-hidden">
          <div class="${ac.bar} h-3 rounded-full transition-all duration-500" style="width:${pct}%"></div>
        </div>
        <div class="flex justify-between text-xs mt-1 text-slate-500">
          <span>$0</span>
          <span>Disponible: $${_fmt(Math.max(0, globalBudget - globalSpend))}</span>
        </div>
      </div>

      <!-- Proyección + ritmo requerido (solo mes en curso) -->
      ${_insightsHtml(globalSpend, globalBudget, globalActualDaily, days, from, to)}

      <!-- Gráfica de gasto diario -->
      ${globalSparkHtml}

      <!-- Platform breakdown -->
      ${platformRows ? `<div class="flex flex-col gap-3 border-t border-slate-800 pt-3">${platformRows}</div>` : ''}
    </div>`;
  }

  function _renderPlatformRow(plat, spend, budget, dailyB, days, status, errMsg, dailyArr = []) {
    const meta  = PLATFORMS.find(p => p.key === plat.platform) || { label: plat.platform, icon: '📡' };
    const accountId = plat.account_id || plat.customer_id || plat.advertiser_id || '—';

    if (status === 'loading') {
      return `<div class="flex items-center gap-2 text-xs text-slate-500">
        <span>${meta.icon} ${meta.label}</span>
        <span class="animate-pulse">cargando…</span>
      </div>`;
    }
    if (status === 'error') {
      return `<div class="flex items-center gap-2 text-xs">
        <span>${meta.icon} ${meta.label}</span>
        <span class="text-red-400 border border-red-500/30 bg-red-500/10 rounded px-1.5 py-0.5">⚠ ${_esc(errMsg)}</span>
      </div>`;
    }

    const actualDaily  = days > 0 ? spend / days : 0;
    const budgetAlert  = _budgetAlert(spend, budget);
    const paceAlert    = _paceAlert(actualDaily, dailyB);
    const alert        = (budgetAlert === 'over' || paceAlert === 'over') ? 'over'
                       : (budgetAlert === 'warn' || paceAlert === 'warn') ? 'warn' : 'ok';
    const ac           = _alertColors[alert];
    const pct          = budget > 0 ? Math.min((spend / budget) * 100, 100) : 0;
    const pctLbl       = budget > 0 ? (spend / budget * 100).toFixed(1) + '%' : '—';

    const paceTag = dailyB > 0 ? `
      <span class="border ${ac.badge} rounded px-1 py-0.5 ml-1">
        ${paceAlert === 'ok' ? '✓' : paceAlert === 'warn' ? '⚡' : '🔴'} $${_fmt(actualDaily)}/d
      </span>` : '';

    const sparkHexColors = { ok: '#10b981', warn: '#eab308', over: '#ef4444' };
    const sparkHtml = dailyArr.length > 1
      ? `<div class="mt-2">${_sparkline(dailyArr, sparkHexColors[alert])}</div>`
      : '';

    return `
    <div>
      <div class="flex justify-between items-center text-xs mb-1">
        <span class="text-slate-300 font-medium">${meta.icon} ${meta.label}
          <span class="text-slate-500 font-normal">(${accountId})</span>${paceTag}
        </span>
        <span class="${ac.text} font-bold">${pctLbl}</span>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex-1 bg-slate-800 rounded-full h-2 overflow-hidden">
          <div class="${ac.bar} h-2 rounded-full transition-all duration-500" style="width:${pct}%"></div>
        </div>
        <span class="text-xs text-slate-400 w-28 text-right">$${_fmt(spend)} / $${_fmt(budget)}</span>
      </div>
      ${sparkHtml}
    </div>`;
  }

  // ── Modal: add / edit client ────────────────────────────────────────────────

  function openClientModal(clientId) {
    const client = clientId ? _clients.find(c => c.id === clientId) : null;
    const { from } = _dateRange();
    const monthKey  = _monthKey(from || new Date().toISOString());

    const platformFields = PLATFORMS.map(p => {
      const existing  = client?.platforms?.find(pl => pl.platform === p.key) || {};
      const enabled   = existing.enabled ?? false;
      const accountId = existing.account_id || existing.customer_id || existing.advertiser_id || '';
      const budget    = existing.budgets?.[monthKey] || '';
      const fieldId   = `platform_${p.key}`;
      const accLabel  = p.key === 'google' ? 'Customer ID' : p.key === 'tiktok' ? 'Advertiser ID' : 'Ad Account ID';
      return `
        <div class="bg-slate-800 rounded-xl p-4 border border-slate-700" id="plat-block-${p.key}">
          <label class="flex items-center gap-2 cursor-pointer mb-3">
            <input type="checkbox" id="plat-enabled-${p.key}" ${enabled ? 'checked' : ''}
              onchange="PautaMonitor._togglePlatBlock('${p.key}')"
              class="w-4 h-4 accent-indigo-500">
            <span class="font-semibold text-slate-200 text-sm">${p.icon} ${p.label}</span>
          </label>
          <div id="plat-fields-${p.key}" style="${enabled ? '' : 'display:none'}">
            <div class="mb-2">
              <label class="text-xs text-slate-400 block mb-1">${accLabel}</label>
              <input type="text" id="plat-account-${p.key}" value="${_esc(accountId)}" placeholder="ej. act_123456789"
                class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
            </div>
            <div>
              <label class="text-xs text-slate-400 block mb-1">Presupuesto ${monthKey} ($)</label>
              <input type="number" id="plat-budget-${p.key}" value="${budget}" min="0" step="0.01" placeholder="0.00"
                class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
            </div>
          </div>
        </div>`;
    }).join('');

    const globalBudget = client?.budgets?.[monthKey] || '';

    const html = `
    <div id="pauta-modal-overlay" onclick="PautaMonitor._overlayClose(event)"
      class="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto shadow-2xl">
        <div class="p-5 border-b border-slate-700 flex items-center justify-between sticky top-0 bg-slate-900 z-10">
          <h2 class="font-bold text-slate-100">${client ? 'Editar cliente' : 'Nuevo cliente'}</h2>
          <button onclick="PautaMonitor.closeModal()" class="text-slate-400 hover:text-slate-100 text-xl leading-none">×</button>
        </div>
        <div class="p-5 flex flex-col gap-4">
          <div>
            <label class="text-xs text-slate-400 block mb-1">Nombre del cliente *</label>
            <input type="text" id="modal-client-name" value="${_esc(client?.name || '')}" placeholder="ej. Cliente ABC"
              class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="text-xs text-slate-400 block mb-1">Presupuesto global ${monthKey} ($)</label>
            <input type="number" id="modal-global-budget" value="${globalBudget}" min="0" step="0.01" placeholder="0.00"
              class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
          </div>
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Plataformas</div>
          ${platformFields}
        </div>
        <div class="p-5 border-t border-slate-700 flex items-center justify-between gap-3 sticky bottom-0 bg-slate-900">
          ${client ? `<button onclick="PautaMonitor.deleteClient('${client.id}')"
            class="text-red-400 hover:text-red-300 text-sm font-semibold transition-colors">Eliminar cliente</button>` : '<span></span>'}
          <div class="flex gap-2">
            <button onclick="PautaMonitor.closeModal()"
              class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-300 text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
              Cancelar
            </button>
            <button onclick="PautaMonitor.saveClient('${client?.id || ''}')"
              class="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">
              Guardar
            </button>
          </div>
        </div>
      </div>
    </div>`;

    document.body.insertAdjacentHTML('beforeend', html);
  }

  function _togglePlatBlock(platformKey) {
    const checked = document.getElementById(`plat-enabled-${platformKey}`)?.checked;
    const fields  = document.getElementById(`plat-fields-${platformKey}`);
    if (fields) fields.style.display = checked ? '' : 'none';
  }

  function _overlayClose(e) {
    if (e.target.id === 'pauta-modal-overlay') closeModal();
  }

  function closeModal() {
    document.getElementById('pauta-modal-overlay')?.remove();
  }

  function saveClient(existingId) {
    const name          = document.getElementById('modal-client-name')?.value.trim();
    const globalBudget  = parseFloat(document.getElementById('modal-global-budget')?.value || '0') || 0;
    const { from }      = _dateRange();
    const monthKey      = _monthKey(from || new Date().toISOString());

    if (!name) { alert('El nombre del cliente es requerido.'); return; }

    const platforms = PLATFORMS.map(p => {
      const enabled   = document.getElementById(`plat-enabled-${p.key}`)?.checked || false;
      const rawAcct   = document.getElementById(`plat-account-${p.key}`)?.value.trim() || '';
      const budget    = parseFloat(document.getElementById(`plat-budget-${p.key}`)?.value || '0') || 0;
      const platData  = { platform: p.key, enabled };
      if (p.key === 'google') platData.customer_id  = rawAcct;
      else if (p.key === 'tiktok') platData.advertiser_id = rawAcct;
      else platData.account_id = rawAcct;
      // Preserve existing budgets, update current month
      const existing = existingId
        ? (_clients.find(c => c.id === existingId)?.platforms?.find(pl => pl.platform === p.key)?.budgets || {})
        : {};
      platData.budgets = { ...existing, [monthKey]: budget };
      return platData;
    });

    if (existingId) {
      const idx = _clients.findIndex(c => c.id === existingId);
      if (idx !== -1) {
        const existBudgets = _clients[idx].budgets || {};
        _clients[idx] = { ..._clients[idx], name, platforms, budgets: { ...existBudgets, [monthKey]: globalBudget } };
      }
    } else {
      _clients.push({ id: _uid(), name, platforms, budgets: { [monthKey]: globalBudget } });
    }

    _save();
    closeModal();
    render();
  }

  function deleteClient(clientId) {
    if (!confirm('¿Eliminar este cliente y todos sus datos?')) return;
    _clients = _clients.filter(c => c.id !== clientId);
    _save();
    closeModal();
    render();
  }

  // ── Quick date buttons ─────────────────────────────────────────────────────

  function setThisMonth() {
    const now   = new Date();
    const y     = now.getFullYear();
    const m     = String(now.getMonth() + 1).padStart(2, '0');
    const today = now.toISOString().slice(0, 10);
    document.getElementById('p-from').value = `${y}-${m}-01`;
    document.getElementById('p-to').value   = today;
    _markQuick('this');
  }

  function setLastMonth() {
    const now  = new Date();
    const d    = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y    = d.getFullYear();
    const m    = d.getMonth() + 1;
    const last = _daysInMonth(y, m);
    document.getElementById('p-from').value = `${y}-${String(m).padStart(2,'0')}-01`;
    document.getElementById('p-to').value   = `${y}-${String(m).padStart(2,'0')}-${last}`;
    _markQuick('last');
  }

  function _markQuick(which) {
    ['btn-this','btn-last'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('bg-indigo-600', id === `btn-${which}`);
      el.classList.toggle('text-white',    id === `btn-${which}`);
      el.classList.toggle('bg-slate-800',  id !== `btn-${which}`);
      el.classList.toggle('text-slate-300',id !== `btn-${which}`);
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  function _fmt(n) {
    return Number(n || 0).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function _esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Init ───────────────────────────────────────────────────────────────────

  function init() {
    _load();
    setThisMonth();
    loadData();
  }

  return {
    init,
    loadData,
    render,
    openClientModal,
    closeModal,
    saveClient,
    deleteClient,
    setThisMonth,
    setLastMonth,
    _markQuick,
    _togglePlatBlock,
    _overlayClose,
  };
})();
