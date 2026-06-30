const PautaMonitor = (() => {

  const LS_KEY   = 'pauta_clients';
  const API_PATH = 'api/spend.php';

  const PLATFORMS = [
    { key: 'meta',   label: 'Meta Ads',    icon: _platIcon('meta'),   color: 'blue'   },
    { key: 'google', label: 'Google Ads',  icon: _platIcon('google'), color: 'red'    },
    { key: 'tiktok', label: 'TikTok Ads',  icon: _platIcon('tiktok'), color: 'purple' },
  ];

  let _clients  = [];
  let _spend    = {};   // { 'clientId:platform:accountId': { total_spend, daily_data, currency, error } }
  let _loading  = false;
  const _filters = { period: false, now: false };

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
    const values  = dailyArr.map(d => d.spend);
    const max     = Math.max(...values, 0.01);
    const W = 300, H = 40, pad = 3;

    const pts = values.map((v, i) => ({
      x: Math.round((i / (values.length - 1)) * W),
      y: Math.round(H - pad - ((v / max) * (H - pad * 2))),
      v, date: dailyArr[i].date
    }));

    // Smooth cubic bezier path
    const linePath = pts.map((p, i) => {
      if (i === 0) return `M ${p.x} ${p.y}`;
      const prev = pts[i - 1];
      const cx   = (prev.x + p.x) / 2;
      return `C ${cx} ${prev.y} ${cx} ${p.y} ${p.x} ${p.y}`;
    }).join(' ');

    const areaPath = `${linePath} L ${pts[pts.length-1].x} ${H} L 0 ${H} Z`;
    const gradId   = 'sg' + color.replace('#', '');
    const dots     = pts.map(p =>
      `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${color}" stroke="#0f172a" stroke-width="1.5">
        <title>${p.date}  $${_fmt(p.v)}</title>
      </circle>`
    ).join('');

    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="40" preserveAspectRatio="none">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#${gradId})"/>
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    </svg>`;
  }

  function _insightsHtml(spend, budget, dailyAvg, days, from, to) {
    if (budget <= 0 || spend <= 0 || days <= 0) return '';
    const now    = new Date();
    const toDate = new Date(to + 'T00:00:00');
    // Mostrar solo si el período consultado es el mes actual (sin importar zona horaria)
    if (toDate.getFullYear() !== now.getFullYear() || toDate.getMonth() !== now.getMonth()) return '';
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

  // ── Filtros ────────────────────────────────────────────────────────────────

  function _clientHasSpendInPeriod(client) {
    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const accountId = plat.account_id || plat.customer_id || plat.advertiser_id || '';
      const result    = _spend[`${plat.platform}:${accountId}`];
      if (result && !result.error && (result.total_spend || 0) > 0) return true;
    }
    return false;
  }

  function _clientIsActiveNow(client) {
    const now    = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 2); // últimos 3 días desde hoy real
    const pad       = n => String(n).padStart(2, '0');
    const cutoffStr = `${cutoff.getFullYear()}-${pad(cutoff.getMonth()+1)}-${pad(cutoff.getDate())}`;
    const todayStr  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;

    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const accountId = plat.account_id || plat.customer_id || plat.advertiser_id || '';
      const result    = _spend[`${plat.platform}:${accountId}`];
      if (!result || result.error) continue;
      if ((result.daily_data || []).some(d => d.date >= cutoffStr && d.date <= todayStr && d.spend > 0)) return true;
    }
    return false;
  }

  function toggleFilter(type) {
    _filters[type] = !_filters[type];
    const label = document.getElementById(`f-${type}-label`);
    const dot   = document.getElementById(`f-${type}-dot`);
    if (_filters[type]) {
      label?.classList.add('border-indigo-600', 'text-indigo-400', 'bg-indigo-950');
      label?.classList.remove('border-slate-700', 'text-slate-400');
      dot?.classList.replace('bg-slate-600', 'bg-indigo-400');
    } else {
      label?.classList.remove('border-indigo-600', 'text-indigo-400', 'bg-indigo-950');
      label?.classList.add('border-slate-700', 'text-slate-400');
      dot?.classList.replace('bg-indigo-400', 'bg-slate-600');
    }
    render();
  }

  function render() {
    const container = document.getElementById('pauta-cards');
    const countEl   = document.getElementById('pauta-count');
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
      if (countEl) countEl.textContent = '';
      return;
    }

    let visible = _clients;
    if (_filters.period) visible = visible.filter(_clientHasSpendInPeriod);
    if (_filters.now)    visible = visible.filter(_clientIsActiveNow);

    if (countEl) {
      countEl.textContent = (_filters.period || _filters.now)
        ? `${visible.length} de ${_clients.length} clientes` : '';
    }

    if (visible.length === 0) {
      container.innerHTML = `
        <div class="col-span-full flex flex-col items-center justify-center py-20 text-slate-500 gap-3">
          <p class="text-sm">Ningún cliente coincide con los filtros activos.</p>
        </div>`;
      return;
    }

    container.innerHTML = visible.map(c => _renderCard(c)).join('');
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
        <div class="flex items-center gap-2 flex-shrink-0">
          <button onclick="PautaMonitor.openBrandModal('${client.id}')" title="Ver detalle de campañas"
            class="text-xs font-semibold text-indigo-400 hover:text-indigo-300 border border-indigo-600/50 hover:border-indigo-400 px-2.5 py-1 rounded-lg transition-colors">
            📊 Detalle
          </button>
          <button onclick="PautaMonitor.openClientModal('${client.id}')" title="Editar cliente"
            class="text-slate-500 hover:text-slate-300 text-lg leading-none transition-colors">⚙</button>
        </div>
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
    const client       = clientId ? _clients.find(c => c.id === clientId) : null;
    const { from }     = _dateRange();
    const monthKey     = _monthKey(from || new Date().toISOString());
    const globalBudget = parseFloat(client?.budgets?.[monthKey] || 0) || 0;

    const platformFields = PLATFORMS.map(p => {
      const existing  = client?.platforms?.find(pl => pl.platform === p.key) || {};
      const enabled   = existing.enabled ?? false;
      const accountId = existing.account_id || existing.customer_id || existing.advertiser_id || '';
      const budget    = parseFloat(existing.budgets?.[monthKey] || 0) || 0;
      const pctVal    = (globalBudget > 0 && budget > 0) ? (budget / globalBudget * 100).toFixed(1) : '';
      const dis       = globalBudget > 0 ? '' : 'disabled';
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
            <div class="mb-3">
              <label class="text-xs text-slate-400 block mb-1">${accLabel}</label>
              <input type="text" id="plat-account-${p.key}" value="${_esc(accountId)}" placeholder="ej. act_123456789"
                class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
            </div>
            <div>
              <label class="text-xs text-slate-400 block mb-1">Presupuesto ${monthKey}</label>
              <div class="flex gap-2">
                <div class="relative flex-1">
                  <span class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">$</span>
                  <input type="number" id="plat-budget-${p.key}" value="${budget || ''}" min="0" step="0.01" placeholder="0.00" ${dis}
                    oninput="PautaMonitor._onPlatBudgetChange('${p.key}','value')"
                    class="w-full bg-slate-900 border border-slate-600 rounded-lg pl-6 pr-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed">
                </div>
                <div class="relative w-24">
                  <input type="number" id="plat-pct-${p.key}" value="${pctVal}" min="0" max="100" step="0.1" placeholder="0" ${dis}
                    oninput="PautaMonitor._onPlatBudgetChange('${p.key}','pct')"
                    class="w-full bg-slate-900 border border-slate-600 rounded-lg pl-3 pr-7 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed">
                  <span class="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs pointer-events-none">%</span>
                </div>
              </div>
            </div>
          </div>
        </div>`;
    }).join('');

    // Resumen inicial de asignación
    const initAssigned = (client?.platforms || []).reduce((sum, pl) => {
      if (!pl.enabled) return sum;
      return sum + (parseFloat(pl.budgets?.[monthKey] || 0) || 0);
    }, 0);
    const initOver      = initAssigned > globalBudget && globalBudget > 0;
    const initRemaining = Math.abs(globalBudget - initAssigned);
    const remColor      = initOver ? 'text-red-400' : 'text-emerald-400';

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
            <input type="number" id="modal-global-budget" value="${globalBudget || ''}" min="0" step="0.01" placeholder="0.00"
              oninput="PautaMonitor._onGlobalBudgetChange()"
              class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
            <p class="text-xs text-slate-600 mt-1">Define el presupuesto global para habilitar la asignación por plataforma.</p>
          </div>
          <div class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Plataformas</div>
          ${platformFields}
          <div id="plat-budget-summary" class="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 text-xs flex items-center justify-between${globalBudget > 0 ? '' : ' hidden'}">
            <span class="text-slate-400">Asignado: <strong id="plat-assigned" class="text-slate-200">$${_fmt(initAssigned)}</strong></span>
            <span id="plat-budget-warn" class="text-red-400 font-semibold${initOver ? '' : ' hidden'}">Excede el global</span>
            <span class="text-slate-400">Disponible: <strong id="plat-remaining" class="${remColor}">$${_fmt(initRemaining)}${initOver ? ' excedido' : ''}</strong></span>
          </div>
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

  function _onGlobalBudgetChange() {
    const globalBudget = parseFloat(document.getElementById('modal-global-budget')?.value || '0') || 0;
    document.getElementById('plat-budget-summary')?.classList.toggle('hidden', globalBudget <= 0);
    for (const p of PLATFORMS) {
      const valueEl = document.getElementById(`plat-budget-${p.key}`);
      const pctEl   = document.getElementById(`plat-pct-${p.key}`);
      if (!valueEl || !pctEl) continue;
      valueEl.disabled = globalBudget <= 0;
      pctEl.disabled   = globalBudget <= 0;
      if (globalBudget > 0) {
        const val = parseFloat(valueEl.value || '0') || 0;
        pctEl.value = val > 0 ? (val / globalBudget * 100).toFixed(1) : '';
      } else {
        valueEl.value = '';
        pctEl.value   = '';
      }
    }
    _updateBudgetSummary(globalBudget);
  }

  function _onPlatBudgetChange(platKey, source) {
    const globalBudget = parseFloat(document.getElementById('modal-global-budget')?.value || '0') || 0;
    if (globalBudget <= 0) return;
    const valueEl = document.getElementById(`plat-budget-${platKey}`);
    const pctEl   = document.getElementById(`plat-pct-${platKey}`);
    if (!valueEl || !pctEl) return;
    if (source === 'value') {
      const val = parseFloat(valueEl.value || '0') || 0;
      pctEl.value = val > 0 ? (val / globalBudget * 100).toFixed(1) : '';
    } else {
      const pct = parseFloat(pctEl.value || '0') || 0;
      valueEl.value = pct > 0 ? (pct / 100 * globalBudget).toFixed(2) : '';
    }
    _updateBudgetSummary(globalBudget);
  }

  function _updateBudgetSummary(globalBudget) {
    let assigned = 0;
    for (const p of PLATFORMS) {
      if (!document.getElementById(`plat-enabled-${p.key}`)?.checked) continue;
      assigned += parseFloat(document.getElementById(`plat-budget-${p.key}`)?.value || '0') || 0;
    }
    const isOver      = globalBudget > 0 && assigned > globalBudget + 0.005;
    const remaining   = Math.abs(globalBudget - assigned);
    const assignedEl  = document.getElementById('plat-assigned');
    const remainingEl = document.getElementById('plat-remaining');
    const warnEl      = document.getElementById('plat-budget-warn');
    if (assignedEl)  assignedEl.textContent = `$${_fmt(assigned)}`;
    if (remainingEl) {
      remainingEl.textContent = `$${_fmt(remaining)}${isOver ? ' excedido' : ''}`;
      remainingEl.className   = isOver ? 'text-red-400' : 'text-emerald-400';
    }
    if (warnEl) warnEl.classList.toggle('hidden', !isOver);
  }

  function _togglePlatBlock(platformKey) {
    const checked = document.getElementById(`plat-enabled-${platformKey}`)?.checked;
    const fields  = document.getElementById(`plat-fields-${platformKey}`);
    if (fields) fields.style.display = checked ? '' : 'none';
    const globalBudget = parseFloat(document.getElementById('modal-global-budget')?.value || '0') || 0;
    if (globalBudget > 0) _updateBudgetSummary(globalBudget);
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

    // Validar que la suma de plataformas no supere el global
    const totalPlat = PLATFORMS.reduce((sum, p) => {
      if (!document.getElementById(`plat-enabled-${p.key}`)?.checked) return sum;
      return sum + (parseFloat(document.getElementById(`plat-budget-${p.key}`)?.value || '0') || 0);
    }, 0);
    if (globalBudget > 0 && totalPlat > globalBudget + 0.005) {
      alert(`La suma de presupuestos por plataforma ($${_fmt(totalPlat)}) supera el presupuesto global ($${_fmt(globalBudget)}).`);
      return;
    }

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

  // ── Platform icons (SVG) ──────────────────────────────────────────────────

  function _platIcon(platform, size = 18) {
    const s = size;
    const st = `display:inline-block;vertical-align:middle;flex-shrink:0`;
    const icons = {
      meta: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}" xmlns="http://www.w3.org/2000/svg">
        <path fill="#1877F2" d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
      </svg>`,
      google: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}" xmlns="http://www.w3.org/2000/svg">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>`,
      tiktok: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}" xmlns="http://www.w3.org/2000/svg">
        <path fill="#ffffff" d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.89-2.89 2.89 2.89 0 0 1 2.89-2.89c.28 0 .54.04.79.1V9.01a6.27 6.27 0 0 0-.79-.05 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.33-6.34V8.69a8.18 8.18 0 0 0 4.84 1.55V6.79a4.85 4.85 0 0 1-1.07-.1z"/>
        <path fill="#69C9D0" opacity="0.7" d="M18.52 6.59a4.83 4.83 0 0 1-2.7-3.15v-.02A4.85 4.85 0 0 0 19.59 6.69a4.85 4.85 0 0 1-1.07-.1z"/>
      </svg>`,
    };
    return icons[platform]
      || `<svg width="${s}" height="${s}" viewBox="0 0 24 24" style="${st}"><circle cx="12" cy="12" r="10" fill="#475569"/></svg>`;
  }

  // ── Brand Detail Modal ─────────────────────────────────────────────────────

  const LS_LEADS = 'pauta_leads';

  function _leadsKey(clientId, from, to) { return `${clientId}:${from}:${to}`; }

  function _loadLeads(clientId, from, to) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_LEADS) || '{}');
      return all[_leadsKey(clientId, from, to)] || { total: 0, qualified: 0 };
    } catch { return { total: 0, qualified: 0 }; }
  }

  function _saveLeads(clientId, from, to, data) {
    try {
      const all = JSON.parse(localStorage.getItem(LS_LEADS) || '{}');
      all[_leadsKey(clientId, from, to)] = data;
      localStorage.setItem(LS_LEADS, JSON.stringify(all));
    } catch {}
  }

  async function openBrandModal(clientId) {
    const client = _clients.find(c => c.id === clientId);
    if (!client) return;
    const { from, to } = _dateRange();
    if (!from || !to) { alert('Selecciona un período primero.'); return; }

    document.body.insertAdjacentHTML('beforeend', `
      <div id="brand-modal-overlay" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl">
          <div class="p-5 border-b border-slate-700 flex items-center justify-between">
            <h2 class="font-bold text-slate-100 text-lg">${_esc(client.name)}</h2>
            <button onclick="PautaMonitor.closeBrandModal()" class="text-slate-400 hover:text-slate-100 text-2xl leading-none">×</button>
          </div>
          <div class="flex items-center justify-center py-20 text-slate-400 gap-3">
            <div class="animate-spin w-7 h-7 border-2 border-indigo-500 border-t-transparent rounded-full"></div>
            <span class="text-sm">Cargando campañas…</span>
          </div>
        </div>
      </div>`);

    const detailData = {};
    const calls = [];
    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const accountId = plat.account_id || plat.customer_id || plat.advertiser_id || '';
      if (!accountId) continue;
      const detailPlat = plat.platform === 'google' ? 'google_detail'
                       : plat.platform === 'meta'   ? 'meta_detail' : null;
      if (!detailPlat) continue;
      const url = `${API_PATH}?platform=${encodeURIComponent(detailPlat)}&account_id=${encodeURIComponent(accountId)}&from=${from}&to=${to}`;
      calls.push(
        fetch(url).then(r => r.json())
          .then(data => { detailData[plat.platform] = data; })
          .catch(() => { detailData[plat.platform] = { error: 'Sin conexión al servidor' }; })
      );
    }
    await Promise.all(calls);

    document.getElementById('brand-modal-overlay')?.remove();
    _renderBrandModal(client, detailData, from, to);
  }

  function _detectStage(name) {
    const n = (name || '').toLowerCase();
    if (/\bf1\b|\[f1\]|-f1-|_f1_|\btof\b/.test(n)) return 'tof';
    if (/\bf2\b|\[f2\]|-f2-|_f2_|\bmof\b/.test(n)) return 'mof';
    if (/\bf3\b|\[f3\]|-f3-|_f3_|\bbof\b/.test(n)) return 'bof';
    return 'other';
  }

  function _groupByStage(detailData) {
    const stages = { tof: [], mof: [], bof: [], other: [] };
    for (const [platform, data] of Object.entries(detailData)) {
      if (data.error || !Array.isArray(data.campaigns)) continue;
      for (const c of data.campaigns) {
        const stage = c.stage || _detectStage(c.name);
        (stages[stage] = stages[stage] || []).push({ ...c, platform });
      }
    }
    return stages;
  }

  function _stageTotals(campaigns) {
    return campaigns.reduce((a, c) => ({
      spend:       a.spend       + (c.spend       || 0),
      impressions: a.impressions + (c.impressions || 0),
      clicks:      a.clicks      + (c.clicks      || 0),
      leads:       a.leads       + (c.leads        || 0),
      count:       a.count       + 1,
    }), { spend: 0, impressions: 0, clicks: 0, leads: 0, count: 0 });
  }

  function _renderBrandModal(client, detailData, from, to) {
    const stages = _groupByStage(detailData);
    const tof = _stageTotals(stages.tof);
    const mof = _stageTotals(stages.mof);
    const bof = _stageTotals(stages.bof);

    const apiLeads  = tof.leads + mof.leads + bof.leads;
    const saved     = _loadLeads(client.id, from, to);
    const totLeads  = saved.total     || apiLeads;
    const qualified = saved.qualified || 0;
    const unqual    = Math.max(0, totLeads - qualified);
    const qualRate  = totLeads > 0 ? qualified / totLeads * 100 : 0;
    const totalSpend = tof.spend + mof.spend + bof.spend;
    const cpql = qualified > 0 ? totalSpend / qualified : 0;
    const cpl  = totLeads  > 0 ? totalSpend / totLeads  : 0;
    const totalImpr  = tof.impressions + mof.impressions + bof.impressions;
    const totalClicks = tof.clicks + mof.clicks + bof.clicks;

    document.body.insertAdjacentHTML('beforeend', `
    <div id="brand-modal-overlay" onclick="PautaMonitor._brandOverlayClose(event)"
      class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto shadow-2xl">

        <div class="p-5 border-b border-slate-700 flex items-center justify-between sticky top-0 bg-slate-900 z-10">
          <div>
            <h2 class="font-bold text-slate-100 text-lg">${_esc(client.name)}</h2>
            <p class="text-xs text-slate-500 mt-0.5">${from} → ${to}</p>
          </div>
          <button onclick="PautaMonitor.closeBrandModal()" class="text-slate-400 hover:text-slate-100 text-2xl leading-none">×</button>
        </div>

        <div class="p-5 flex flex-col gap-6">

          <div>
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Embudo de conversión</p>
            ${_renderFunnel(tof, mof, bof)}
          </div>

          <div>
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">KPIs del Trafficker</p>
            ${_renderKPIs(tof, mof, bof, totalSpend, totLeads, qualified, unqual, totalImpr, totalClicks)}
          </div>

          <div class="bg-slate-800/60 rounded-2xl p-5 border border-slate-700">
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Calidad de Leads</p>
            ${_renderLeadQuality(totLeads, qualified, unqual, qualRate, cpl, cpql, client.id, from, to, apiLeads)}
          </div>

          ${_renderFatigue(detailData)}

          ${_renderCampaignList(stages)}
        </div>
      </div>
    </div>`);
  }

  function _renderFunnel(tof, mof, bof) {
    const tofCPM = tof.impressions > 0 ? tof.spend / tof.impressions * 1000 : 0;
    const tofCTR = tof.impressions > 0 ? tof.clicks / tof.impressions * 100  : 0;
    const mofCPC = mof.clicks > 0      ? mof.spend / mof.clicks              : 0;
    const bofCPL = bof.leads  > 0      ? bof.spend / bof.leads               : 0;

    const row = (label, emoji, colorCls, bgCls, m, kpiVal, kpiDesc, indent) => {
      const empty = m.count === 0;
      return `
      <div style="margin-left:${indent}px; margin-right:${indent}px">
        <div class="border-l-4 ${colorCls} ${empty ? 'border-dashed opacity-50' : ''} bg-slate-800 rounded-xl p-4">
          <div class="flex items-center justify-between mb-${empty ? '0' : '3'}">
            <div class="flex items-center gap-2">
              <span class="text-sm font-black ${bgCls} px-2 py-0.5 rounded-md text-xs">${label}</span>
              ${empty ? '<span class="text-xs text-slate-600">Sin campañas configuradas</span>' : `<span class="text-xs text-slate-500">${emoji} ${m.count} campaña${m.count !== 1 ? 's' : ''}</span>`}
            </div>
            ${empty ? '' : `<span class="text-slate-100 font-bold text-sm">$${_fmt(m.spend)}</span>`}
          </div>
          ${empty ? '' : `
          <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div><span class="text-slate-500 block">Impresiones</span><strong class="text-slate-200">${_fmtNum(m.impressions)}</strong></div>
            <div><span class="text-slate-500 block">Clicks</span><strong class="text-slate-200">${_fmtNum(m.clicks)}</strong></div>
            ${m.leads > 0 ? `<div><span class="text-slate-500 block">Leads API</span><strong class="text-slate-200">${m.leads}</strong></div>` : ''}
            <div><span class="text-slate-500 block">${kpiDesc}</span><strong class="${bgCls}">${kpiVal}</strong></div>
          </div>`}
        </div>
      </div>`;
    };

    const arrow = `<div class="flex justify-center text-slate-700 text-xl py-1">▼</div>`;

    return `
    <div class="flex flex-col gap-0">
      ${row('TOF · F1', '📢', 'border-blue-500',    'text-blue-400 bg-blue-500/10',    tof, tofCPM > 0 ? `CPM $${_fmtShort(tofCPM)}` : '—', 'CPM', 0)}
      ${arrow}
      ${row('MOF · F2', '🎯', 'border-yellow-500',  'text-yellow-400 bg-yellow-500/10', mof, mofCPC > 0 ? `CPC $${_fmtShort(mofCPC)}` : '—', 'CPC', 24)}
      ${arrow}
      ${row('BOF · F3', '💰', 'border-emerald-500', 'text-emerald-400 bg-emerald-500/10', bof, bofCPL > 0 ? `CPL $${_fmtShort(bofCPL)}` : '—', 'CPL', 48)}
    </div>`;
  }

  function _renderKPIs(tof, mof, bof, totalSpend, totLeads, qualified, unqual, totalImpr, totalClicks) {
    const cpm      = totalImpr   > 0 ? totalSpend / totalImpr   * 1000 : 0;
    const ctr      = totalImpr   > 0 ? totalClicks / totalImpr  * 100  : 0;
    const cpc      = totalClicks > 0 ? totalSpend / totalClicks         : 0;
    const cpl      = totLeads    > 0 ? totalSpend / totLeads            : 0;
    const cpql     = qualified   > 0 ? totalSpend / qualified           : 0;
    const qualRate = totLeads    > 0 ? qualified  / totLeads    * 100   : 0;

    const qColor   = qualRate >= 60 ? 'text-emerald-400' : qualRate >= 40 ? 'text-yellow-400' : 'text-red-400';

    const kpi = (icon, label, val, sub, valCls = 'text-slate-100') => `
      <div class="bg-slate-800 rounded-xl p-3 border border-slate-700 flex flex-col gap-1">
        <div class="text-lg">${icon}</div>
        <div class="text-base font-black ${valCls}">${val}</div>
        <div class="text-xs text-slate-500 leading-tight">${label}</div>
        ${sub ? `<div class="text-xs text-slate-600">${sub}</div>` : ''}
      </div>`;

    return `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
      ${kpi('📡', 'CPM', cpm > 0 ? `$${_fmtShort(cpm)}` : '—', 'Costo por mil imp.')}
      ${kpi('🖱️', 'CTR', ctr > 0 ? `${ctr.toFixed(2)}%` : '—', 'Clic ÷ impresiones')}
      ${kpi('💸', 'CPC', cpc > 0 ? `$${_fmtShort(cpc)}` : '—', 'Costo por clic')}
      ${kpi('📋', 'CPL Total', cpl > 0 ? `$${_fmtShort(cpl)}` : '—', 'Costo por lead total')}
      ${kpi('📥', 'Leads', totLeads || '—', 'Del período')}
      ${kpi('✅', 'Calificados', qualified || '—', `${qualRate.toFixed(0)}% tasa`, qualified > 0 ? qColor : 'text-slate-500')}
      ${kpi('❌', 'No calificados', unqual || '—', 'Descartados', unqual > 0 ? 'text-red-400' : 'text-slate-500')}
      ${kpi('🎯', 'CPQL', cpql > 0 ? `$${_fmtShort(cpql)}` : '—', 'Costo por lead calificado', cpql > 0 ? 'text-indigo-300' : 'text-slate-500')}
    </div>`;
  }

  function _renderLeadQuality(total, qualified, unqual, qualRate, cpl, cpql, clientId, from, to, apiLeads) {
    const qColor  = qualRate >= 60 ? 'text-emerald-400' : qualRate >= 40 ? 'text-yellow-400' : 'text-red-400';
    const qBarW   = Math.round(Math.min(qualRate, 100));
    const uBarW   = 100 - qBarW;

    return `
    <div class="flex flex-col gap-4">
      <div class="grid grid-cols-3 gap-3 text-center">
        <div>
          <div class="text-3xl font-black text-slate-100">${total || 0}</div>
          <div class="text-xs text-slate-500 mt-0.5">Leads totales</div>
        </div>
        <div>
          <div class="text-3xl font-black text-emerald-400">${qualified || 0}</div>
          <div class="text-xs text-slate-500 mt-0.5">Calificados</div>
          ${cpql > 0 ? `<div class="text-xs text-slate-600">$${_fmtShort(cpql)} c/u</div>` : ''}
        </div>
        <div>
          <div class="text-3xl font-black text-red-400">${unqual || 0}</div>
          <div class="text-xs text-slate-500 mt-0.5">No calificados</div>
        </div>
      </div>

      ${total > 0 ? `
      <div>
        <div class="flex justify-between text-xs mb-1.5 font-semibold">
          <span class="text-slate-400">Tasa de calificación</span>
          <span class="${qColor}">${qualRate.toFixed(1)}%</span>
        </div>
        <div class="w-full h-3 bg-slate-700 rounded-full overflow-hidden flex">
          <div class="h-full bg-emerald-500 rounded-l-full transition-all" style="width:${qBarW}%"></div>
          <div class="h-full bg-red-500 ${uBarW > 0 ? 'rounded-r-full' : ''}" style="width:${uBarW}%"></div>
        </div>
        <div class="flex justify-between text-xs mt-1 text-slate-600">
          <span>✅ Calificados ${qBarW}%</span>
          <span>❌ No calificados ${uBarW}%</span>
        </div>
      </div>` : ''}

      <div class="border-t border-slate-700 pt-4">
        <p class="text-xs text-slate-500 mb-3 font-semibold">Registrar leads del período
          ${apiLeads > 0 ? `<span class="ml-2 text-slate-600 font-normal">(API detectó ${apiLeads} leads)</span>` : ''}
        </p>
        <div class="grid grid-cols-2 gap-3 mb-3">
          <div>
            <label class="text-xs text-slate-500 block mb-1">Leads totales recibidos</label>
            <input type="number" id="bm-total" value="${total || (apiLeads > 0 ? apiLeads : '')}" min="0" placeholder="0"
              class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
          </div>
          <div>
            <label class="text-xs text-slate-500 block mb-1">¿Cuántos eran calificados?</label>
            <input type="number" id="bm-qualified" value="${qualified || ''}" min="0" placeholder="0"
              class="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
          </div>
        </div>
        <button onclick="PautaMonitor._saveLeadInput('${clientId}','${from}','${to}')"
          class="w-full bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors">
          Guardar registro de leads
        </button>
      </div>
    </div>`;
  }

  function _saveLeadInput(clientId, from, to) {
    const total     = parseInt(document.getElementById('bm-total')?.value     || '0') || 0;
    const qualified = parseInt(document.getElementById('bm-qualified')?.value || '0') || 0;
    if (qualified > total) { alert('Los calificados no pueden superar el total.'); return; }
    _saveLeads(clientId, from, to, { total, qualified });
    closeBrandModal();
    openBrandModal(clientId);
  }

  // ── Detector de Fatiga de Audiencia ───────────────────────────────────────

  function _fatigueThresholds(stage) {
    // Thresholds de frecuencia y CTR por etapa del funnel
    if (stage === 'tof')   return { warn: 2.5, danger: 3.5, ctrWarn: 1.5, ctrDanger: 0.8 };
    if (stage === 'mof')   return { warn: 4.0, danger: 6.0, ctrWarn: 1.0, ctrDanger: 0.5 };
    if (stage === 'bof')   return { warn: 5.0, danger: 8.0, ctrWarn: 0.8, ctrDanger: 0.4 };
    return                        { warn: 3.0, danger: 5.0, ctrWarn: 1.0, ctrDanger: 0.5 };
  }

  function _fatigueLevel(freq, ctr, stage) {
    if (freq <= 0) return 'unknown';
    const t = _fatigueThresholds(stage);
    if (freq >= t.danger && ctr <= t.ctrDanger) return 'critical';
    if (freq >= t.danger || (freq >= t.warn && ctr <= t.ctrWarn)) return 'danger';
    if (freq >= t.warn) return 'warn';
    return 'ok';
  }

  const _fatigueConfig = {
    critical: { label: 'Fatiga crítica',   badge: 'bg-red-500/20 text-red-400 border-red-500/40',    bar: 'bg-red-500',    dot: 'bg-red-500 animate-pulse' },
    danger:   { label: 'Riesgo alto',      badge: 'bg-orange-500/20 text-orange-400 border-orange-500/40', bar: 'bg-orange-500', dot: 'bg-orange-500' },
    warn:     { label: 'Riesgo moderado',  badge: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/40', bar: 'bg-yellow-500', dot: 'bg-yellow-400' },
    ok:       { label: 'Audiencia sana',   badge: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/40', bar: 'bg-emerald-500', dot: 'bg-emerald-500' },
    unknown:  { label: 'Sin datos',        badge: 'bg-slate-700 text-slate-500 border-slate-600',      bar: 'bg-slate-600',  dot: 'bg-slate-600' },
  };

  const _fatigueAdvice = {
    critical: '🚨 Fatiga severa detectada. La audiencia está saturada — rota creativos de inmediato y considera ampliar el público objetivo.',
    danger:   '⚠️ Señales claras de fatiga. Prepara nuevos creativos y revisa la segmentación. El rendimiento seguirá cayendo.',
    warn:     '💡 Frecuencia en zona de alerta. Monitorea el CTR diariamente y ten creativos alternativos listos.',
    ok:       '✅ La audiencia responde bien. Frecuencia y CTR dentro de rangos saludables para esta etapa.',
    unknown:  '—',
  };

  function _renderFatigue(detailData) {
    const metaData = detailData?.meta;
    if (!metaData || metaData.error || !Array.isArray(metaData.campaigns)) return '';

    // Solo campañas Meta con datos de frecuencia o suficientes impresiones para calcularla
    const campaigns = metaData.campaigns
      .filter(c => c.impressions > 0)
      .map(c => {
        const freq = c.frequency > 0 ? c.frequency : (c.reach > 0 ? c.impressions / c.reach : 0);
        const ctr  = c.impressions > 0 ? c.clicks / c.impressions * 100 : 0;
        return { ...c, freq: Math.round(freq * 100) / 100, ctr: Math.round(ctr * 100) / 100 };
      });

    if (campaigns.length === 0) return '';

    const levels  = campaigns.map(c => _fatigueLevel(c.freq, c.ctr, c.stage));
    const worst   = levels.includes('critical') ? 'critical'
                  : levels.includes('danger')   ? 'danger'
                  : levels.includes('warn')      ? 'warn' : 'ok';
    const wCfg    = _fatigueConfig[worst];

    return `
    <div class="rounded-2xl border ${worst === 'ok' ? 'border-slate-700' : 'border-' + (worst === 'critical' ? 'red' : worst === 'danger' ? 'orange' : 'yellow') + '-500/30'} overflow-hidden">
      <div class="px-5 py-4 flex items-center justify-between bg-slate-800/60">
        <div class="flex items-center gap-2.5">
          <div class="w-2 h-2 rounded-full ${wCfg.dot}"></div>
          <p class="text-xs font-semibold text-slate-300 uppercase tracking-wider">Detector de Fatiga · Meta Ads</p>
        </div>
        <span class="text-xs font-bold ${wCfg.badge} border px-2.5 py-1 rounded-full">${wCfg.label}</span>
      </div>
      <div class="divide-y divide-slate-800">
        ${campaigns.map(c => _renderFatigueCampaign(c)).join('')}
      </div>
    </div>`;
  }

  function _renderFatigueCampaign(c) {
    const level  = _fatigueLevel(c.freq, c.ctr, c.stage);
    const cfg    = _fatigueConfig[level];
    const t      = _fatigueThresholds(c.stage);
    const advice = _fatigueAdvice[level];

    // Barra de frecuencia: escala 0–8, marcadores en warn y danger
    const maxFreq   = 8;
    const freqPct   = Math.min(c.freq / maxFreq * 100, 100);
    const warnPct   = t.warn   / maxFreq * 100;
    const dangerPct = t.danger / maxFreq * 100;

    const stageLabel = c.stage === 'tof' ? 'TOF · F1' : c.stage === 'mof' ? 'MOF · F2' : c.stage === 'bof' ? 'BOF · F3' : 'Sin etapa';
    const ctrColor   = c.ctr >= t.ctrWarn ? 'text-emerald-400' : c.ctr >= t.ctrDanger ? 'text-yellow-400' : 'text-red-400';

    return `
    <div class="px-5 py-4 bg-slate-900/60">
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-slate-100 truncate">${_esc(c.name)}</p>
          <p class="text-xs text-slate-500 mt-0.5">${stageLabel} · ${_fmtNum(c.reach || 0)} personas alcanzadas</p>
        </div>
        <span class="text-xs font-bold ${cfg.badge} border px-2 py-0.5 rounded-lg flex-shrink-0">${cfg.label}</span>
      </div>

      <div class="mb-3">
        <div class="flex justify-between text-xs mb-1.5">
          <span class="text-slate-500">Frecuencia promedio</span>
          <span class="font-black text-slate-100">${c.freq > 0 ? c.freq + 'x' : '—'}</span>
        </div>
        <div class="relative w-full h-3 bg-slate-800 rounded-full overflow-hidden">
          ${c.freq > 0 ? `<div class="${cfg.bar} h-3 rounded-full transition-all duration-700" style="width:${freqPct}%"></div>` : ''}
          <div class="absolute top-0 bottom-0 w-px bg-yellow-400/60" style="left:${warnPct}%"></div>
          <div class="absolute top-0 bottom-0 w-px bg-red-500/70"    style="left:${dangerPct}%"></div>
        </div>
        <div class="flex justify-between text-xs mt-1 text-slate-600">
          <span>0</span>
          <span class="text-yellow-600">${t.warn}x alerta</span>
          <span class="text-red-600">${t.danger}x crítico</span>
          <span>${maxFreq}x</span>
        </div>
      </div>

      <div class="flex items-center gap-4 text-xs mb-3">
        <div><span class="text-slate-500">CTR </span><span class="${ctrColor} font-bold">${c.ctr > 0 ? c.ctr + '%' : '—'}</span>
          <span class="text-slate-600 ml-1">(mín. saludable ${t.ctrWarn}%)</span>
        </div>
        <div><span class="text-slate-500">Spend </span><span class="text-slate-300 font-semibold">$${_fmt(c.spend)}</span></div>
      </div>

      ${level !== 'unknown' ? `
      <div class="text-xs text-slate-400 bg-slate-800 rounded-xl px-3 py-2.5 leading-relaxed">
        ${advice}
      </div>` : ''}
    </div>`;
  }

  function _renderCampaignList(stages) {
    const all = [
      ...stages.tof.map(c => ({ ...c, stL: 'TOF · F1', stC: 'text-blue-400',    stB: 'bg-blue-500/10 border-blue-500/30'    })),
      ...stages.mof.map(c => ({ ...c, stL: 'MOF · F2', stC: 'text-yellow-400',  stB: 'bg-yellow-500/10 border-yellow-500/30'  })),
      ...stages.bof.map(c => ({ ...c, stL: 'BOF · F3', stC: 'text-emerald-400', stB: 'bg-emerald-500/10 border-emerald-500/30' })),
      ...stages.other.map(c => ({ ...c, stL: 'Sin etapa', stC: 'text-slate-400', stB: 'bg-slate-700/30 border-slate-600' })),
    ];
    if (all.length === 0) return '';

    return `
    <div>
      <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Desglose por campaña</p>
      <div class="flex flex-col gap-2">
        ${all.map(c => {
          const cpm = c.impressions > 0 ? c.spend / c.impressions * 1000 : 0;
          const cpc = c.clicks > 0      ? c.spend / c.clicks             : 0;
          const cpl = c.leads  > 0      ? c.spend / c.leads              : 0;
          const platIcon = _platIcon(c.platform, 16);
          return `
          <div class="bg-slate-800 rounded-xl p-3.5 border border-slate-700">
            <div class="flex items-start justify-between gap-2 mb-3">
              <span class="text-sm text-slate-200 font-medium leading-snug">${platIcon} ${_esc(c.name)}</span>
              <span class="text-xs font-bold ${c.stC} border ${c.stB} rounded-lg px-2 py-0.5 flex-shrink-0">${c.stL}</span>
            </div>
            <div class="grid grid-cols-3 sm:grid-cols-6 gap-2 text-xs">
              <div><span class="text-slate-500 block">Spend</span><strong class="text-slate-100">$${_fmt(c.spend)}</strong></div>
              <div><span class="text-slate-500 block">Imp.</span><strong class="text-slate-100">${_fmtNum(c.impressions || 0)}</strong></div>
              <div><span class="text-slate-500 block">Clicks</span><strong class="text-slate-100">${_fmtNum(c.clicks || 0)}</strong></div>
              <div><span class="text-slate-500 block">CPM</span><strong class="text-blue-300">${cpm > 0 ? '$' + _fmtShort(cpm) : '—'}</strong></div>
              <div><span class="text-slate-500 block">CPC</span><strong class="text-yellow-300">${cpc > 0 ? '$' + _fmtShort(cpc) : '—'}</strong></div>
              <div><span class="text-slate-500 block">${c.leads > 0 ? 'Leads / CPL' : 'Leads'}</span><strong class="text-emerald-300">${c.leads > 0 ? `${c.leads} / $${_fmtShort(cpl)}` : '—'}</strong></div>
            </div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  function _brandOverlayClose(e) {
    if (e.target.id === 'brand-modal-overlay') closeBrandModal();
  }

  function closeBrandModal() {
    document.getElementById('brand-modal-overlay')?.remove();
  }

  function _fmtNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000)    return (n / 1000).toFixed(1) + 'K';
    return String(Math.round(n || 0));
  }

  function _fmtShort(n) {
    const v = Number(n || 0);
    if (v >= 1000) return (v / 1000).toFixed(1) + 'K';
    return v.toFixed(2);
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
    toggleFilter,
    openClientModal,
    closeModal,
    saveClient,
    deleteClient,
    setThisMonth,
    setLastMonth,
    _markQuick,
    _togglePlatBlock,
    _overlayClose,
    _onGlobalBudgetChange,
    _onPlatBudgetChange,
    openBrandModal,
    closeBrandModal,
    _brandOverlayClose,
    _saveLeadInput,
  };
})();
