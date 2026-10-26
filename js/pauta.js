const PautaMonitor = (() => {

  const API_PATH = 'api/spend.php';

  const PLATFORMS = [
    { key: 'meta',   label: 'Meta Ads',    icon: _platIcon('meta'),   color: 'blue'   },
    { key: 'google', label: 'Google Ads',  icon: _platIcon('google'), color: 'red'    },
    { key: 'tiktok', label: 'TikTok Ads',  icon: _platIcon('tiktok'), color: 'purple' },
  ];

  let _clients  = [];
  let _spend    = {};   // { 'clientId:platform:accountId': { total_spend, daily_data, currency, error } }
  let _loading  = false;
  let _simState = null; // estado del simulador de presupuesto
  const _filters = { period: false, now: false, pay: false };
  let _status = {};   // { 'platform:accountId': { state, reason, billing_url, ... } } — estado de la cuenta publicitaria

  // ── Storage (BD compartida — backend/api/pauta_clients.php + pauta_leads.php) ──
  // Antes vivía en localStorage: cada usuario veía su propia lista de clientes.
  // Ahora todos comparten la misma configuración vía MySQL.

  let _leads = {}; // { clientId: { 'YYYY-MM': { total, qualified } } }

  async function _load() {
    try {
      const [clientsRes, leadsRes] = await Promise.all([
        Session.apiFetch('api/pauta_clients.php'),
        Session.apiFetch('api/pauta_leads.php'),
      ]);
      _clients = clientsRes.clients || [];
      _leads   = leadsRes.leads || {};
    } catch (e) {
      _clients = [];
      _leads   = {};
      if (window.Utils && Utils.showToast) Utils.showToast('No se pudo cargar la configuración de pauta: ' + e.message, 'error');
    }
  }

  async function _saveClientToDb(client) {
    await Session.apiFetch('api/pauta_clients.php', {
      method: 'POST',
      body: JSON.stringify({ id: client.id, name: client.name, budgets: client.budgets, platforms: client.platforms }),
    });
  }

  async function _deleteClientFromDb(clientId) {
    await Session.apiFetch(`api/pauta_clients.php?id=${encodeURIComponent(clientId)}`, { method: 'DELETE' });
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

  function _accountIdOf(plat) {
    return plat.account_id || plat.customer_id || plat.advertiser_id || '';
  }

  // La clave incluye el rango: sin él, cambiar de período mostraba datos del rango
  // anterior como si fueran del actual mientras cargaba el nuevo.
  function _spendKey(platform, accountId, from, to) {
    return `${platform}:${accountId}:${from}:${to}`;
  }

  function _splitIds(accountId) {
    return String(accountId || '').split(',').map(s => s.trim()).filter(Boolean);
  }

  async function _fetchOneSpend(platform, id, from, to, fresh) {
    const url = `${API_PATH}?platform=${encodeURIComponent(platform)}&account_id=${encodeURIComponent(id)}&from=${from}&to=${to}${fresh ? '&fresh=1' : ''}`;
    try {
      const res  = await fetch(url);
      const data = await res.json();
      if (!res.ok && !data.error) data.error = `Error ${res.status} del servidor`;
      return data;
    } catch (e) {
      return { error: 'No se pudo conectar al servidor', platform };
    }
  }

  // El campo de cuenta admite varios IDs separados por coma (ej. varias cuentas
  // publicitarias de Meta para el mismo cliente): se piden por separado y se
  // suman como si fuera una sola cuenta.
  async function _fetchSpend(platform, accountId, from, to, fresh) {
    const key = _spendKey(platform, accountId, from, to);
    const ids = _splitIds(accountId);

    if (ids.length <= 1) {
      _spend[key] = await _fetchOneSpend(platform, ids[0] || accountId, from, to, fresh);
      return;
    }

    const results = await Promise.all(ids.map(id => _fetchOneSpend(platform, id, from, to, fresh)));
    const ok = results.filter(r => !r.error);
    if (ok.length === 0) {
      _spend[key] = { error: results.map(r => r.error).join(' · '), platform };
      return;
    }

    const dailyMap = {}, leadsMap = {};
    let total = 0, currency = '';
    for (const r of ok) {
      total += r.total_spend || 0;
      if (!currency) currency = r.currency || '';
      for (const d of (r.daily_data || [])) {
        dailyMap[d.date] = (dailyMap[d.date] || 0) + d.spend;
        leadsMap[d.date] = (leadsMap[d.date] || 0) + (d.leads || 0);
      }
    }
    const failed = results.filter(r => r.error);
    if (failed.length) console.warn(`Pauta: ${failed.length}/${ids.length} cuentas de ${platform} fallaron para ${accountId}:`, failed.map(r => r.error));

    _spend[key] = {
      platform,
      account_id: accountId,
      total_spend: Math.round(total * 100) / 100,
      currency,
      daily_data: Object.entries(dailyMap).sort((a, b) => a[0].localeCompare(b[0])).map(([date, spend]) => ({ date, spend, leads: leadsMap[date] || 0 })),
      date_from: from,
      date_to: to,
    };
  }

  // fresh = true (botón "Actualizar") salta el caché de 10 min del servidor.
  async function loadData(fresh = false) {
    if (_loading) return;
    _loading = true;
    _setLoadingState(true);

    const { from, to } = _dateRange();
    if (!from || !to) { _loading = false; _setLoadingState(false); return; }

    const calls = [];
    for (const client of _clients) {
      for (const plat of (client.platforms || [])) {
        if (!plat.enabled) continue;
        const accountId = _accountIdOf(plat);
        if (!accountId) continue;
        calls.push(_fetchSpend(plat.platform, accountId, from, to, fresh));
        if (plat.platform === 'meta' || plat.platform === 'google') {
          _splitIds(accountId).forEach(id => calls.push(_fetchStatus(plat.platform, id, fresh)));
        }
      }
    }

    await Promise.all(calls);
    _loading = false;
    _setLoadingState(false);

    const lastEl = document.getElementById('last-updated');
    if (lastEl) lastEl.textContent = 'Actualizado: ' + new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });

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
      `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${color}" style="stroke:var(--s1)" stroke-width="1.5"/>`
    ).join('');

    // Datos para el imán (ver _initSparkHover): fecha, gasto y altura relativa de cada punto.
    // El contenedor tiene 8px de margen invisible arriba y abajo para que sea fácil apuntar.
    const sparkData = _esc(JSON.stringify({ c: color, p: pts.map(p => [p.date, p.v, +(p.y / H).toFixed(4)]) }));

    return `<div class="spark" data-spark="${sparkData}" style="position:relative;padding:8px 0;margin:-8px 0;cursor:crosshair"><svg viewBox="0 0 ${W} ${H}" width="100%" height="40" preserveAspectRatio="none" style="display:block">
      <defs>
        <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="${color}" stop-opacity="0.25"/>
          <stop offset="100%" stop-color="${color}" stop-opacity="0.02"/>
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#${gradId})"/>
      <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      ${dots}
    </svg></div>`;
  }

  // Barras de leads por día (tarjeta de cada cliente), con el mismo hover "imán" que el gasto diario.
  // Los leads son los que reporta la plataforma (formularios + píxel + conversaciones en Meta,
  // conversiones en Google) — no los que se capturan a mano en la pestaña Leads del detalle.
  function _leadsBarChart(dailyArr, spend) {
    const total = dailyArr.reduce((a, d) => a + d.leads, 0);
    if (!dailyArr.length || total <= 0) return '';
    const max  = Math.max(...dailyArr.map(d => d.leads), 1);
    const best = dailyArr.reduce((a, d) => d.leads > a.leads ? d : a, dailyArr[0]);
    const avg  = total / dailyArr.length;
    const cpl  = spend > 0 ? spend / total : 0;
    const W = 300, H = 48, n = dailyArr.length;
    const slot = W / n, bw = Math.max(1.5, slot * (n > 40 ? 0.85 : 0.7));
    const pts = [];
    const bars = dailyArr.map((d, i) => {
      const h = d.leads > 0 ? Math.max(3, d.leads / max * (H - 4)) : 1.5;
      const x = i * slot + (slot - bw) / 2;
      pts.push([d.date, Math.round(d.leads), +((H - h) / H).toFixed(4)]);
      return `<rect x="${x.toFixed(1)}" y="${(H - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${d.date === best.date ? '#10b981' : d.leads > 0 ? '#6366f1' : '#475569'}"/>`;
    }).join('');
    const bestLabel = new Date(best.date + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
    const sparkData = _esc(JSON.stringify({ c: '#6366f1', b: 1, h: H, u: 'leads', p: pts }));
    const stat = (label, value, cls = 'text-slate-200') => `<span class="text-slate-500">${label} <strong class="${cls}">${value}</strong></span>`;
    return `
      <div class="border-t border-slate-800 pt-3">
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <span class="text-xs text-slate-500">Leads por día</span>
          <span class="text-xs font-bold text-slate-100">${Math.round(total)} leads</span>
        </div>
        <div class="spark" data-spark="${sparkData}" style="position:relative;padding:8px 0;margin:-8px 0;cursor:crosshair">
          <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block">${bars}</svg>
        </div>
        <div class="flex items-center gap-x-3 gap-y-1 flex-wrap text-[11px] mt-1.5">
          ${stat('Prom.', avg.toFixed(1) + '/día')}
          ${stat('Mejor día', `${bestLabel} · ${Math.round(best.leads)}`, 'text-emerald-400')}
          ${cpl > 0 ? stat('CPL', '$' + _fmt(cpl), 'text-indigo-300') : ''}
        </div>
      </div>`;
  }

  // ── Imán en las gráficas de gasto diario ──────────────────────────────────
  // Al pasar el mouse (o el dedo) por cualquier parte de la gráfica se "pega" al día más cercano:
  // guía vertical, punto resaltado y un tooltip con la fecha y el gasto. Un solo manejador para
  // todas las gráficas de la página (delegación de eventos).
  function _initSparkHover() {
    if (window.__sparkHoverReady) return;
    window.__sparkHoverReady = true;

    const tip = document.createElement('div');
    tip.id = 'spark-tip';
    tip.style.cssText = 'position:fixed;z-index:70;pointer-events:none;opacity:0;transform:translate(-50%,-100%);background:#0c0a09;color:#fff;font-size:11px;font-weight:600;padding:5px 10px;border-radius:9px;white-space:nowrap;box-shadow:0 6px 18px rgba(0,0,0,.35);transition:opacity .1s';
    document.body.appendChild(tip);

    let active = null;
    const hide = () => {
      tip.style.opacity = 0;
      if (active) { active._guide.style.display = 'none'; active._dot.style.display = 'none'; active = null; }
    };
    const fmtDate = (iso) => {
      const d = new Date(iso + 'T00:00:00');
      return isNaN(d) ? iso : d.toLocaleDateString('es-CO', { weekday: 'short', day: 'numeric', month: 'short' });
    };
    const ensureMarkers = (el) => {
      if (el._guide) return;
      el._guide = document.createElement('div');
      el._guide.style.cssText = 'position:absolute;top:0;bottom:0;width:0;border-left:1px dashed var(--line3);pointer-events:none;display:none';
      el._dot = document.createElement('div');
      el._dot.style.cssText = `position:absolute;width:11px;height:11px;margin:-5.5px 0 0 -5.5px;border-radius:50%;background:${el._sp.c};border:2px solid var(--s1);box-shadow:0 0 0 3px ${el._sp.c}40;pointer-events:none;display:none`;
      el.appendChild(el._guide); el.appendChild(el._dot);
    };

    const onMove = (e) => {
      const el = e.target && e.target.closest ? e.target.closest('.spark') : null;
      if (!el) { if (active) hide(); return; }
      if (!el._sp) { try { el._sp = JSON.parse(el.dataset.spark); } catch (err) { return; } }
      ensureMarkers(el);
      if (active && active !== el) hide();
      active = el;

      const r = el.getBoundingClientRect();
      const pts = el._sp.p;
      const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      // Línea (gasto): puntos en los extremos de cada tramo. Barras (leads): el centro de cada barra.
      const bar = !!el._sp.b, n = pts.length;
      const i = bar ? Math.min(n - 1, Math.floor(t * n)) : Math.round(t * (n - 1));   // el día más cercano (imán)
      const [date, val, yRel] = pts[i];
      const x = bar ? (i + 0.5) / n * r.width : (i / (n - 1)) * r.width;
      const y = 8 + yRel * (el._sp.h || 40);                    // 8px de margen + altura del SVG

      el._guide.style.display = el._dot.style.display = '';
      el._guide.style.left = x + 'px';
      el._dot.style.left = x + 'px';
      el._dot.style.top = y + 'px';

      tip.innerHTML = `<span style="opacity:.7">${fmtDate(date)}</span>&nbsp; ${el._sp.u === 'leads' ? `${val} lead${val === 1 ? '' : 's'}` : '$' + _fmt(val)}`;
      tip.style.left = Math.min(innerWidth - 70, Math.max(70, r.left + x)) + 'px';
      tip.style.top = (r.top + y - 12) + 'px';
      tip.style.opacity = 1;
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerdown', onMove);
    document.addEventListener('scroll', hide, true);
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
    const { from, to } = _dateRange();
    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const result = _spend[_spendKey(plat.platform, _accountIdOf(plat), from, to)];
      if (result && !result.error && (result.total_spend || 0) > 0) return true;
    }
    return false;
  }

  function _clientIsActiveNow(client) {
    const { from, to } = _dateRange();
    const now    = new Date();
    const cutoff = new Date(now);
    cutoff.setDate(cutoff.getDate() - 2); // últimos 3 días desde hoy real
    const pad       = n => String(n).padStart(2, '0');
    const cutoffStr = `${cutoff.getFullYear()}-${pad(cutoff.getMonth()+1)}-${pad(cutoff.getDate())}`;
    const todayStr  = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;

    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const result = _spend[_spendKey(plat.platform, _accountIdOf(plat), from, to)];
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

  // ── Marcas que requieren atención (pausa por pago / presupuesto) ─────────
  // Fuentes: el estado de la cuenta publicitaria que informa Meta / Google (api/spend.php
  // ?platform=meta_status|google_status) y, para cualquier plataforma, una regla: si hubo
  // gasto en el período y los 2 últimos días quedó en $0, es una posible pausa.

  async function _fetchStatus(platform, id, fresh) {
    const url = `${API_PATH}?platform=${encodeURIComponent(platform + '_status')}&account_id=${encodeURIComponent(id)}${fresh ? '&fresh=1' : ''}`;
    try {
      const res = await fetch(url);
      _status[`${platform}:${id}`] = await res.json();
    } catch (e) {
      _status[`${platform}:${id}`] = { error: 'No se pudo consultar el estado de la cuenta' };
    }
  }

  const _ATTN_DANGER = new Set(['payment', 'budget', 'disabled']);

  // Gasto en $0 los últimos 2 días completos (ayer y anteayer), solo si el rango llega a hoy
  function _looksPaused(dailyArr, from, to) {
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    const y1 = new Date(today); y1.setDate(today.getDate() - 1);
    const y2 = new Date(today); y2.setDate(today.getDate() - 2);
    if (to < iso(y1) || from > iso(y2)) return false;            // el rango no cubre los últimos días
    const byDate = Object.fromEntries((dailyArr || []).map(d => [d.date, Number(d.spend) || 0]));
    const before = (dailyArr || []).some(d => d.date < iso(y2) && Number(d.spend) > 0);
    return before && !(byDate[iso(y1)] > 0) && !(byDate[iso(y2)] > 0);
  }

  function _clientAttention(client) {
    const { from, to } = _dateRange();
    const out = [];
    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const accountId = _accountIdOf(plat);
      if (!accountId) continue;
      const meta = PLATFORMS.find(p => p.key === plat.platform) || { label: plat.platform };
      let flagged = false;
      for (const id of _splitIds(accountId)) {
        const st = _status[`${plat.platform}:${id}`];
        if (st && st.state && st.state !== 'ok') {
          out.push({ level: _ATTN_DANGER.has(st.state) ? 'danger' : 'warn', label: meta.label, reason: st.reason, url: st.billing_url });
          flagged = true;
        }
      }
      if (flagged) continue;
      const sp = _spend[_spendKey(plat.platform, accountId, from, to)];
      if (sp && !sp.error && _looksPaused(sp.daily_data, from, to)) {
        out.push({ level: 'warn', label: meta.label, reason: 'Sin gasto en los últimos 2 días: revisa si la pauta se detuvo por pago o presupuesto.' });
      }
    }
    return out;
  }

  function _attentionHtml(client) {
    const items = _clientAttention(client);
    if (!items.length) return '';
    const danger = items.some(i => i.level === 'danger');
    const box = danger ? 'border-red-500/40 bg-red-500/10' : 'border-amber-500/40 bg-amber-500/10';
    const title = danger ? 'text-red-400' : 'text-amber-400';
    return `
      <div class="rounded-xl border ${box} px-3 py-2.5">
        <div class="flex items-center gap-1.5 text-xs font-bold ${title}">
          ${Icons.svg('alert', 'w-3.5 h-3.5')}${danger ? 'Requiere atención — pago o presupuesto' : 'Revisar — posible pausa'}
        </div>
        <ul class="mt-1.5 space-y-1">
          ${items.map(i => `
            <li class="text-xs text-slate-300 leading-snug">
              <strong class="${i.level === 'danger' ? 'text-red-400' : 'text-amber-400'}">${_esc(i.label)}:</strong> ${_esc(i.reason || '')}
              ${i.url ? `<a href="${i.url}" target="_blank" rel="noopener" class="ml-1 font-semibold text-indigo-400 hover:text-indigo-300 whitespace-nowrap">Ir a facturación ↗</a>` : ''}
            </li>`).join('')}
        </ul>
      </div>`;
  }

  function _renderPayCount() {
    const el = document.getElementById('f-pay-count');
    if (!el) return;
    const n = _clients.filter(c => _clientAttention(c).length > 0).length;
    el.textContent = n;
    el.style.display = n ? '' : 'none';
  }

  // ── Conexión con Google Ads ───────────────────────────────────────────────
  async function _loadGoogleAdsStatus() {
    const btn = document.getElementById('g-ads-btn');
    if (!btn) return;
    try {
      const st = await Session.apiFetch('api/google_ads_status.php?check=1');
      const ok = st.connected && st.valid !== false;
      btn.style.display = '';
      btn.title = ok
        ? 'Conexión con Google Ads activa' + (st.updated_at ? ` (conectada el ${st.updated_at})` : '')
        : (st.error || 'Conecta la cuenta de Google Ads para ver el gasto');
      btn.className = 'ui-chip' + (ok ? '' : ' ui-chip-primary');
      btn.style.textDecoration = 'none';
      btn.innerHTML = ok
        ? `<span class="w-2 h-2 rounded-full bg-emerald-500"></span>Google Ads conectado`
        : `${Icons.svg('link', 'w-4 h-4')}${st.connected ? 'Reconectar Google Ads' : 'Conectar Google Ads'}`;
    } catch (e) {
      btn.style.display = 'none'; // sin permisos o backend no disponible
    }
  }

  // Ventana "Conectar Google Ads": 1) abrir Google, 2) pegar la dirección a la que te lleva.
  // Se hace así porque el hosting bloquea (ModSecurity) la vuelta directa de Google a nuestro
  // servidor. Ver backend/api/google_ads_exchange.php.
  function openGoogleAdsModal() {
    if (document.getElementById('gads-modal')) return;
    document.body.insertAdjacentHTML('beforeend', `
      <div id="gads-modal" class="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60" onclick="if(event.target===this)PautaMonitor.closeGoogleAdsModal()">
        <div class="bento-card w-full max-w-lg" style="padding:1.5rem">
          <div class="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 class="text-lg font-extrabold text-slate-100">Conectar Google Ads</h2>
              <p class="text-xs text-slate-400 mt-1">Son dos pasos y dura menos de un minuto.</p>
            </div>
            <button type="button" onclick="PautaMonitor.closeGoogleAdsModal()" class="text-slate-400 hover:text-slate-100" aria-label="Cerrar">${Icons.svg('x', 'w-5 h-5')}</button>
          </div>
          <ol class="space-y-4 text-sm text-slate-300">
            <li>
              <b class="text-slate-100">1. Autoriza en Google.</b>
              <p class="text-xs text-slate-400 mt-1">Se abre en otra pestaña. Elige la cuenta que administra Google Ads y acepta el permiso. Si dice "Google no verificó esta app", pulsa Configuración avanzada → Continuar.</p>
              <button type="button" class="ui-chip ui-chip-primary mt-2" onclick="window.open('backend/oauth/google_ads_connect.php?mode=paste','_blank')">${Icons.svg('link', 'w-4 h-4')}Abrir Google</button>
            </li>
            <li>
              <b class="text-slate-100">2. Pega la dirección.</b>
              <p class="text-xs text-slate-400 mt-1">Google te lleva a una página de <i>OAuth 2.0 Playground</i> (puede verse vacía o con avisos: es normal). Copia la dirección completa de esa pestaña (la barra de arriba) y pégala aquí.</p>
              <textarea id="gads-paste" rows="3" class="w-full mt-2 rounded-xl border px-3 py-2 text-xs" style="border-color:var(--line2);background:var(--s1);color:var(--ink)" placeholder="https://developers.google.com/oauthplayground/?code=4/0A…"></textarea>
              <p id="gads-msg" class="text-xs mt-2" style="display:none"></p>
              <div class="flex justify-end gap-2 mt-3">
                <button type="button" class="ui-chip" onclick="PautaMonitor.closeGoogleAdsModal()">Cancelar</button>
                <button type="button" id="gads-submit" class="ui-chip ui-chip-primary" onclick="PautaMonitor.submitGoogleAdsCode()">Conectar</button>
              </div>
            </li>
          </ol>
        </div>
      </div>`);
  }

  function closeGoogleAdsModal() {
    document.getElementById('gads-modal')?.remove();
  }

  // Del texto pegado se saca solo el código (la dirección completa trae https:// y el firewall
  // del hosting la bloquearía al enviarla)
  function _extractGoogleCode(text) {
    const t = String(text || '').trim();
    if (!t) return '';
    try { const c = new URL(t).searchParams.get('code'); if (c) return c; } catch (e) { /* no es una URL */ }
    const m = t.match(/[?&#]code=([^&\s#]+)/);
    if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } }
    return /^[A-Za-z0-9_\-/.]{10,600}$/.test(t) ? t : '';
  }

  async function submitGoogleAdsCode() {
    const msg = document.getElementById('gads-msg');
    const show = (text, ok) => {
      msg.style.display = '';
      msg.className = 'text-xs mt-2 ' + (ok ? 'text-emerald-400' : 'text-red-400');
      msg.textContent = text;
    };
    const code = _extractGoogleCode(document.getElementById('gads-paste').value);
    if (!code) { show('No encontré el código en lo que pegaste. Copia la dirección completa de la pestaña a la que te llevó Google.', false); return; }
    const btn = document.getElementById('gads-submit');
    btn.disabled = true;
    try {
      await Session.apiFetch('api/google_ads_exchange.php', { method: 'POST', body: JSON.stringify({ code }) });
      show('Google Ads conectado. Cargando el gasto…', true);
      _loadGoogleAdsStatus();
      setTimeout(() => { closeGoogleAdsModal(); loadData(true); }, 900);
    } catch (e) {
      show(e.message || 'No se pudo conectar', false);
      btn.disabled = false;
    }
  }

  // Resultado de volver de Google (?google_ads=ok|error&msg=...)
  function _showGoogleAdsResult() {
    const params = new URLSearchParams(location.search);
    const result = params.get('google_ads');
    if (!result) return;
    const box = document.getElementById('pauta-notice');
    if (box) {
      const ok = result === 'ok';
      box.style.display = '';
      box.innerHTML = `<div class="rounded-xl border px-4 py-3 text-sm ${ok ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-red-500/40 bg-red-500/10 text-red-400'}">
        ${ok ? 'Google Ads conectado. El gasto se vuelve a cargar con la nueva conexión.' : 'No se pudo conectar Google Ads: ' + _esc(params.get('msg') || 'error desconocido')}
      </div>`;
    }
    history.replaceState(null, '', location.pathname); // no repetir el aviso al recargar
  }

  function render() {
    const container = document.getElementById('pauta-cards');
    const countEl   = document.getElementById('pauta-count');
    if (!container) return;

    if (_clients.length === 0) {
      container.innerHTML = `
        <div class="col-span-full flex flex-col items-center justify-center py-24 text-slate-500 gap-3">
          <div class="w-14 h-14 rounded-2xl bg-indigo-500/15 text-indigo-400 grid place-items-center">${Icons.svg('wallet', 'w-7 h-7')}</div>
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
    if (_filters.pay)    visible = visible.filter(c => _clientAttention(c).length > 0);
    // Las marcas que requieren atención (pago/presupuesto) van primero
    const rank = c => { const a = _clientAttention(c); return a.some(x => x.level === 'danger') ? 0 : a.length ? 1 : 2; };
    visible = [...visible].sort((a, b) => rank(a) - rank(b));
    _renderPayCount();

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
    const leadsDailyMap = {};
    const currencies = new Set();
    const platformRows = (client.platforms || []).map(plat => {
      if (!plat.enabled) return null;
      const accountId = _accountIdOf(plat);
      const result    = _spend[_spendKey(plat.platform, accountId, from, to)];
      const budget    = _budgetForRange(plat.budgets, from, to);
      const dailyB    = _dailyBudget(plat.budgets, from);

      if (!result) return _renderPlatformRow(plat, 0, budget, dailyB, days, 'loading');
      if (result.error) return _renderPlatformRow(plat, 0, budget, dailyB, days, 'error', result.error);

      const spend     = result.total_spend || 0;
      globalSpend    += spend;
      if (result.currency) currencies.add(result.currency);
      (result.daily_data || []).forEach(d => {
        globalDailyMap[d.date] = (globalDailyMap[d.date] || 0) + d.spend;
        leadsDailyMap[d.date] = (leadsDailyMap[d.date] || 0) + (d.leads || 0);
      });
      return _renderPlatformRow(plat, spend, budget, dailyB, days, 'ok', null, result.daily_data || [], result.currency || '');
    }).filter(Boolean).join('');

    // Moneda: si todas las cuentas comparten una, se muestra; si hay varias, el
    // total global suma monedas distintas sin convertir — se advierte visiblemente.
    const currency        = currencies.size === 1 ? [...currencies][0] : '';
    const mixedCurrencies = currencies.size > 1;
    const currencyWarning = mixedCurrencies ? `
      <div class="text-xs text-red-400 border border-red-500/30 bg-red-500/10 rounded-lg px-2.5 py-1.5">
        ⚠ Este cliente mezcla monedas (${_esc([...currencies].join(', '))}): el total global no es comparable — revisa cada plataforma por separado.
      </div>` : '';

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
        ${paceAlert === 'ok' ? '✓' : paceAlert === 'warn' ? `${Icons.svg('zap', 'w-3 h-3 inline -mt-0.5')}` : '<span class="inline-block w-2 h-2 rounded-full bg-red-500 align-middle"></span>'}
        $${_fmt(globalActualDaily)}/día vs $${_fmt(globalDaily)}/día meta
      </span>` : '';

    const leadsDailyArr = Object.entries(leadsDailyMap)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, leads]) => ({ date, leads }));
    const leadsChartHtml = _leadsBarChart(leadsDailyArr, globalSpend);

    const sparkHexColors = { ok: '#10b981', warn: '#eab308', over: '#ef4444' };
    const globalSparkHtml = globalDailyArr.length > 1 ? `
      <div class="border-t border-slate-800 pt-3">
        <div class="text-xs text-slate-500 mb-1.5">Gasto diario</div>
        ${_sparkline(globalDailyArr, sparkHexColors[overallAlert])}
      </div>` : '';

    return `
    <div class="bento-card flex flex-col gap-4">
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
            class="inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-400 hover:text-indigo-300 border border-indigo-600/50 hover:border-indigo-400 px-2.5 py-1 rounded-full transition-colors">
            ${Icons.svg('chart', 'w-3.5 h-3.5')}Detalle
          </button>
          <button onclick="PautaMonitor.openClientModal('${client.id}')" title="Editar cliente"
            class="text-slate-500 hover:text-slate-300 transition-colors">${Icons.svg('settings', 'w-5 h-5')}</button>
        </div>
      </div>

      ${_attentionHtml(client)}

      ${currencyWarning}

      <!-- Global progress -->
      <div>
        <div class="flex justify-between text-xs mb-1">
          <span class="text-slate-400">Gastado <strong class="${ac.text}">$${_fmt(globalSpend)}${currency ? ` <span class="font-normal text-slate-500">${_esc(currency)}</span>` : ''}</strong></span>
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

      <!-- Leads que ingresan por día -->
      ${leadsChartHtml}

      <!-- Platform breakdown -->
      ${platformRows ? `<div class="flex flex-col gap-3 border-t border-slate-800 pt-3">${platformRows}</div>` : ''}
    </div>`;
  }

  function _renderPlatformRow(plat, spend, budget, dailyB, days, status, errMsg, dailyArr = [], currency = '') {
    const meta  = PLATFORMS.find(p => p.key === plat.platform) || { label: plat.platform, icon: Icons.svg('pulse', 'w-4 h-4 inline') };
    const accountId = _accountIdOf(plat) || '—';

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
        ${plat.platform === 'google' && /reconéctala|no está conectado/i.test(errMsg || '') ? `<button type="button" onclick="PautaMonitor.openGoogleAdsModal()" class="font-semibold text-indigo-400 hover:text-indigo-300 whitespace-nowrap">Reconectar</button>` : ''}
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
        ${paceAlert === 'ok' ? '✓' : paceAlert === 'warn' ? `${Icons.svg('zap', 'w-3 h-3 inline -mt-0.5')}` : '<span class="inline-block w-2 h-2 rounded-full bg-red-500 align-middle"></span>'} $${_fmt(actualDaily)}/d
      </span>` : '';

    const sparkHexColors = { ok: '#10b981', warn: '#eab308', over: '#ef4444' };
    const sparkHtml = dailyArr.length > 1
      ? `<div class="mt-2">${_sparkline(dailyArr, sparkHexColors[alert])}</div>`
      : '';

    return `
    <div>
      <div class="flex justify-between items-center text-xs mb-1">
        <span class="text-slate-300 font-medium">${meta.icon} ${meta.label}
          <span class="text-slate-500 font-normal">(${_esc(accountId)})</span>${paceTag}
        </span>
        <span class="${ac.text} font-bold">${pctLbl}</span>
      </div>
      <div class="flex items-center gap-2">
        <div class="flex-1 bg-slate-800 rounded-full h-2 overflow-hidden">
          <div class="${ac.bar} h-2 rounded-full transition-all duration-500" style="width:${pct}%"></div>
        </div>
        <span class="text-xs text-slate-400 w-28 text-right">$${_fmt(spend)} / $${_fmt(budget)}${currency ? ` <span class="text-slate-600">${_esc(currency)}</span>` : ''}</span>
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
              <label class="text-xs text-slate-400 block mb-1">${accLabel} <span class="text-slate-600 font-normal">(varias, separadas por coma)</span></label>
              <input type="text" id="plat-account-${p.key}" value="${_esc(accountId)}" placeholder="ej. act_123456789, act_987654321"
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

  async function saveClient(existingId) {
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

    const existBudgets = existingId ? (_clients.find(c => c.id === existingId)?.budgets || {}) : {};
    const client = {
      id: existingId || _uid(),
      name,
      platforms,
      budgets: { ...existBudgets, [monthKey]: globalBudget },
    };

    try {
      await _saveClientToDb(client);
    } catch (e) {
      alert('No se pudo guardar en el servidor: ' + e.message);
      return;
    }

    const idx = _clients.findIndex(c => c.id === client.id);
    if (idx !== -1) _clients[idx] = client;
    else _clients.push(client);

    closeModal();
    render();
  }

  async function deleteClient(clientId) {
    if (!confirm('¿Eliminar este cliente y todos sus datos?')) return;
    try {
      await _deleteClientFromDb(clientId);
    } catch (e) {
      alert('No se pudo eliminar en el servidor: ' + e.message);
      return;
    }
    _clients = _clients.filter(c => c.id !== clientId);
    closeModal();
    render();
  }

  // ── Quick date buttons ─────────────────────────────────────────────────────

  function setThisMonth() {
    // Fecha LOCAL, no toISOString() (UTC): de noche en UTC-5 el día UTC ya es "mañana"
    // y descuadraría el rango contra el resto de cálculos, que usan hora local.
    const now   = new Date();
    const y     = now.getFullYear();
    const m     = String(now.getMonth() + 1).padStart(2, '0');
    const today = `${y}-${m}-${String(now.getDate()).padStart(2, '0')}`;
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
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
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

  // Clave por MES, no por rango exacto: con "Este mes" el `to` cambia cada día y los
  // leads capturados ayer quedaban huérfanos (parecían perderse a diario).
  // _leads se precarga en _load() desde backend/api/pauta_leads.php.

  function _loadLeads(clientId, from) {
    return (_leads[clientId] || {})[_monthKey(from)] || { total: 0, qualified: 0 };
  }

  async function _saveLeads(clientId, from, data) {
    const monthKey = _monthKey(from);
    await Session.apiFetch('api/pauta_leads.php', {
      method: 'POST',
      body: JSON.stringify({ client_id: clientId, month_key: monthKey, total: data.total, qualified: data.qualified }),
    });
    if (!_leads[clientId]) _leads[clientId] = {};
    _leads[clientId][monthKey] = data;
  }

  // Igual que _fetchSpend: el campo de cuenta puede traer varios IDs separados
  // por coma — se pide el detalle de cada uno y se juntan las campañas.
  async function _fetchDetailMerged(detailPlat, accountId, from, to) {
    const ids = _splitIds(accountId);
    const results = await Promise.all(ids.map(id => {
      const url = `${API_PATH}?platform=${encodeURIComponent(detailPlat)}&account_id=${encodeURIComponent(id)}&from=${from}&to=${to}`;
      return fetch(url).then(r => r.json()).catch(() => ({ error: 'Sin conexión al servidor' }));
    }));

    // Cada campaña recuerda su cuenta: se necesita para armar el enlace al administrador de anuncios.
    results.forEach((r, i) => (r.campaigns || []).forEach(c => { c.account_id = ids[i]; }));

    if (ids.length <= 1) return results[0] || { error: 'Sin conexión al servidor' };

    const ok = results.filter(r => !r.error);
    if (ok.length === 0) return { error: results.map(r => r.error).join(' · ') };

    const failed = results.filter(r => r.error);
    if (failed.length) console.warn(`Pauta: ${failed.length}/${ids.length} cuentas de ${detailPlat} fallaron para ${accountId}:`, failed.map(r => r.error));

    return {
      platform: detailPlat,
      campaigns: ok.flatMap(r => r.campaigns || []),
      currency: ok.find(r => r.currency)?.currency || 'USD',
    };
  }

  async function openBrandModal(clientId) {
    const client = _clients.find(c => c.id === clientId);
    if (!client) return;
    const { from, to } = _dateRange();
    if (!from || !to) { alert('Selecciona un período primero.'); return; }

    document.body.insertAdjacentHTML('beforeend', `
      <div id="brand-modal-overlay" class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
        <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-5xl max-h-[92vh] overflow-hidden shadow-2xl">
          <div class="px-6 py-4 border-b border-slate-700 flex items-center justify-between">
            <h2 class="font-bold text-slate-100 text-lg">${_esc(client.name)}</h2>
            <button onclick="PautaMonitor.closeBrandModal()" class="text-slate-400 hover:text-slate-100 text-2xl leading-none">×</button>
          </div>
          <div class="flex flex-col items-center justify-center py-28 text-slate-400 gap-4">
            <div class="animate-spin w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full"></div>
            <span class="text-sm">Cargando campañas…</span>
          </div>
        </div>
      </div>`);

    const detailData = {};
    const calls = [];
    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const accountId = _accountIdOf(plat);
      if (!accountId) continue;
      const detailPlat = plat.platform === 'google' ? 'google_detail'
                       : plat.platform === 'meta'   ? 'meta_detail' : null;
      if (!detailPlat) continue;
      calls.push(
        _fetchDetailMerged(detailPlat, accountId, from, to)
          .then(data => { detailData[plat.platform] = data; })
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
    const saved     = _loadLeads(client.id, from);
    const totLeads  = saved.total     || apiLeads;
    const qualified = saved.qualified || 0;
    const unqual    = Math.max(0, totLeads - qualified);
    const qualRate  = totLeads > 0 ? qualified / totLeads * 100 : 0;
    const totalSpend = tof.spend + mof.spend + bof.spend;
    const cpql = qualified > 0 ? totalSpend / qualified : 0;
    const cpl  = totLeads  > 0 ? totalSpend / totLeads  : 0;
    const totalImpr  = tof.impressions + mof.impressions + bof.impressions;
    const totalClicks = tof.clicks + mof.clicks + bof.clicks;
    const campCount  = tof.count + mof.count + bof.count + stages.other.length;

    // Indicador de salud global (cruza calidad de leads + fatiga)
    const fatigue = _fatigueAnalyze(detailData);
    const health  = _overallHealth(qualRate, fatigue ? fatigue.worst : null, totLeads);

    // Estado de plataformas + errores
    const platEntries = Object.entries(detailData);
    const platBadges  = platEntries.map(([p, d]) => {
      const ok = !d.error;
      return `<span title="${ok ? p : _esc(d.error)}"
        class="inline-flex items-center gap-1 text-xs px-2 py-1 rounded-lg border ${ok ? 'border-slate-700 text-slate-300 bg-slate-800/60' : 'border-red-500/40 text-red-400 bg-red-500/10'}">
        ${_platIcon(p, 13)}${ok ? '' : '<span>⚠</span>'}</span>`;
    }).join('');
    const errors = platEntries.filter(([, d]) => d.error);
    const errorBanner = errors.length ? `
      <div class="mb-5 bg-red-500/10 border border-red-500/30 rounded-xl px-4 py-3 text-xs text-red-300 flex flex-col gap-1">
        ${errors.map(([p, d]) => `<div>⚠ <strong class="uppercase">${_esc(p)}</strong>: ${_esc(d.error)}</div>`).join('')}
      </div>` : '';

    // Contenido de paneles (con estados vacíos amigables)
    const daily       = _clientDaily(client, from, to);
    const quickHtml   = _renderQuickMonitor(detailData, daily);
    const fatigueHtml = _renderFatigue(detailData) || (quickHtml
      ? '<p class="text-xs text-slate-500">Detector de fatiga: sin datos de frecuencia de Meta Ads en este período.</p>'
      : _emptyPanel('No hay campañas con actividad en este período para diagnosticar.'));
    const simHtml     = _renderSimulator(stages, totalSpend, totLeads, qualified) || _emptyPanel('Se necesita inversión registrada en el período para simular la redistribución de presupuesto.');
    const campHtml    = _renderCampaignList(stages) || _emptyPanel('No se encontraron campañas activas en este período.');

    const heroCard = (label, value, sub, valCls = 'text-slate-100') => `
      <div class="bg-slate-800/60 border border-slate-700/60 rounded-xl px-4 py-3">
        <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">${label}</div>
        <div class="text-xl font-black ${valCls} mt-1.5 leading-none">${value}</div>
        ${sub ? `<div class="text-[11px] text-slate-500 mt-1.5">${sub}</div>` : ''}
      </div>`;

    const tabs = [
      { key: 'resumen',     label: 'Resumen' },
      { key: 'leads',       label: 'Leads' },
      { key: 'diagnostico', label: 'Diagnóstico' },
      { key: 'simulador',   label: 'Simulador' },
      { key: 'campanas',    label: 'Campañas' },
      { key: 'reporte',     label: 'Reporte cliente' },
    ];
    const tabBtns = tabs.map((t, i) => `
      <button onclick="PautaMonitor._switchBrandTab('${t.key}')" data-tab="${t.key}"
        class="bm-tab whitespace-nowrap px-4 py-3 text-sm font-semibold border-b-2 transition-colors ${i === 0 ? 'text-indigo-300 border-indigo-500' : 'text-slate-400 border-transparent hover:text-slate-200'}">
        ${t.label}</button>`).join('');

    document.body.insertAdjacentHTML('beforeend', `
    <div id="brand-modal-overlay" onclick="PautaMonitor._brandOverlayClose(event)"
      class="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4">
      <div class="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-5xl max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">

        <!-- Header -->
        <div class="px-6 py-4 border-b border-slate-700 flex items-start justify-between gap-4 flex-shrink-0">
          <div class="min-w-0">
            <div class="flex items-center gap-3 flex-wrap">
              <h2 class="font-bold text-slate-100 text-lg truncate">${_esc(client.name)}</h2>
              <span class="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-full border ${health.cls} flex-shrink-0">
                <span class="w-1.5 h-1.5 rounded-full ${health.dot}"></span>${health.label}
              </span>
            </div>
            <p class="text-xs text-slate-500 mt-1">${from} → ${to}</p>
          </div>
          <div class="flex items-center gap-2 flex-shrink-0">
            ${platBadges}
            <button onclick="PautaMonitor.closeBrandModal()" class="ml-1 text-slate-400 hover:text-slate-100 text-2xl leading-none">×</button>
          </div>
        </div>

        <!-- Métricas hero -->
        <div class="px-6 py-4 border-b border-slate-700 bg-slate-900/40 flex-shrink-0 grid grid-cols-2 sm:grid-cols-4 gap-3">
          ${heroCard('Inversión total', '$' + _fmt(totalSpend), `${campCount} campaña${campCount !== 1 ? 's' : ''}`)}
          ${heroCard('Leads', totLeads || '—', qualified > 0 ? `${qualified} calificados` : 'sin registrar')}
          ${heroCard('CPQL', cpql > 0 ? '$' + _fmtShort(cpql) : '—', 'costo / lead calificado', 'text-indigo-300')}
          ${heroCard('Tasa calificación', totLeads > 0 ? qualRate.toFixed(0) + '%' : '—', 'calificados / total',
            totLeads > 0 ? (qualRate >= 60 ? 'text-emerald-400' : qualRate >= 40 ? 'text-yellow-400' : 'text-red-400') : 'text-slate-100')}
        </div>

        <!-- Pestañas -->
        <div class="px-3 border-b border-slate-700 flex-shrink-0 overflow-x-auto">
          <div class="flex">${tabBtns}</div>
        </div>

        <!-- Paneles -->
        <div id="bm-scroll" class="overflow-y-auto flex-1 p-6">
          ${errorBanner}

          <div id="bm-panel-resumen" class="bm-panel flex flex-col gap-6">
            <div>
              <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">Embudo de conversión</p>
              ${_renderFunnel(tof, mof, bof)}
            </div>
            <div>
              <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">KPIs del Trafficker</p>
              ${_renderKPIs(tof, mof, bof, totalSpend, totLeads, qualified, unqual, totalImpr, totalClicks)}
            </div>
          </div>

          <div id="bm-panel-leads" class="bm-panel flex flex-col gap-4" style="display:none">
            ${_renderLeadsTrend(daily)}
            <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mt-2">Calidad de leads</p>
            ${_renderLeadQuality(totLeads, qualified, unqual, qualRate, cpl, cpql, client.id, from, to, apiLeads)}
          </div>

          <div id="bm-panel-diagnostico" class="bm-panel flex flex-col gap-6" style="display:none">
            ${quickHtml}
            ${fatigueHtml}
          </div>

          <div id="bm-panel-simulador" class="bm-panel" style="display:none">
            ${simHtml}
          </div>

          <div id="bm-panel-campanas" class="bm-panel" style="display:none">
            ${campHtml}
          </div>

          <div id="bm-panel-reporte" class="bm-panel" style="display:none">
            ${_renderReportPanel(client, from, to)}
          </div>
        </div>
      </div>
    </div>`);
  }

  function _switchBrandTab(key) {
    document.querySelectorAll('#brand-modal-overlay .bm-panel').forEach(el => {
      el.style.display = (el.id === 'bm-panel-' + key) ? '' : 'none';
    });
    document.querySelectorAll('#brand-modal-overlay .bm-tab').forEach(el => {
      const active = el.dataset.tab === key;
      el.classList.toggle('text-indigo-300', active);
      el.classList.toggle('border-indigo-500', active);
      el.classList.toggle('text-slate-400', !active);
      el.classList.toggle('border-transparent', !active);
    });
    const scroll = document.getElementById('bm-scroll');
    if (scroll) scroll.scrollTop = 0;
    if (key === 'reporte') _loadReportLinks(_reportClientId);
  }

  // ── Reporte privado para el cliente (reporte-pauta.html?t=<token>) ─────────
  // Cada link es un token independiente: 'live' muestra siempre el período en curso (el cliente
  // puede alternar mes / 30 días / mes anterior); 'range' congela un período cerrado.
  // El backend guarda el token cifrado (migration_024) para poder copiarlo/reenviarlo cuando sea;
  // los links creados antes de esa migración solo se pueden revocar y recrear.
  let _reportClientId   = null;
  let _reportClientName = '';
  let _reportLinks      = [];
  let _reportNewId      = null;

  function _reportUrl(token) {
    return location.origin + location.pathname.replace(/[^/]*$/, '') + 'reporte-pauta.html?t=' + token;
  }

  function _isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function _renderReportPanel(client, from, to) {
    _reportClientId   = client.id;
    _reportClientName = client.name;
    _reportNewId      = null;
    const field = 'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500';
    const modeCard = (mode, checked, icon, title, desc) => `
      <label id="rp-opt-${mode}" class="flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-colors ${checked ? 'border-indigo-500 bg-indigo-500/10' : 'border-slate-700 hover:border-slate-500'}">
        <input type="radio" name="rp-mode" value="${mode}" ${checked ? 'checked' : ''} class="sr-only" onchange="PautaMonitor._reportModeChange()">
        <span class="text-xl leading-none mt-0.5">${icon}</span>
        <span><strong class="text-sm text-slate-100">${title}</strong><span class="block text-xs text-slate-400 mt-0.5 leading-snug">${desc}</span></span>
      </label>`;
    const chip = (label, key) => `<button type="button" onclick="PautaMonitor._reportQuickRange('${key}')" class="text-xs font-semibold text-slate-300 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-full px-3 py-1 transition-colors">${label}</button>`;

    return `
    <div class="grid lg:grid-cols-5 gap-6">
      <div class="lg:col-span-3 rounded-2xl border border-slate-700 bg-slate-800/40 p-5 flex flex-col gap-4">
        <div>
          <p class="text-sm font-bold text-slate-100">Nuevo reporte para ${_esc(client.name)}</p>
          <p class="text-xs text-slate-400 mt-1 leading-relaxed">Página visual tipo historia: inversión, objetivos cumplidos, leads por día, comparación con el período anterior y campañas destacadas. El cliente puede descargarla en PDF. No muestra IDs de cuenta ni datos de otros clientes.</p>
        </div>

        <div class="grid sm:grid-cols-2 gap-2">
          ${modeCard('live', true, '🟢', 'En tiempo real', 'Un solo link que siempre está al día. El cliente alterna entre este mes, últimos 30 días y mes anterior.')}
          ${modeCard('range', false, '📅', 'Rango de fechas', 'Reporte cerrado de un período fijo: cierre de mes, de campaña o de trimestre.')}
        </div>

        <div id="rp-range" style="display:none" class="flex flex-col gap-2">
          <div class="flex flex-wrap gap-1.5">${chip('Mes anterior', 'prev')}${chip('Este mes', 'this')}${chip('Período del monitor', 'monitor')}</div>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-xs text-slate-400">Desde<input type="date" id="rp-from" value="${from}" data-monitor="${from}" class="${field} mt-1"></label>
            <label class="text-xs text-slate-400">Hasta<input type="date" id="rp-to" value="${to}" data-monitor="${to}" class="${field} mt-1"></label>
          </div>
        </div>

        <div class="grid sm:grid-cols-3 gap-3">
          <label class="text-xs text-slate-400 sm:col-span-2">Título <span class="text-slate-600">(opcional)</span><input type="text" id="rp-title" maxlength="190" placeholder="Así le fue a ${_esc(client.name)} este mes" class="${field} mt-1"></label>
          <label class="text-xs text-slate-400">Meta de leads <span class="text-slate-600">(opcional)</span><input type="number" min="0" step="1" id="rp-goal" placeholder="Ej. 120" class="${field} mt-1"></label>
        </div>
        <label class="text-xs text-slate-400 block">Mensaje para el cliente <span class="text-slate-600">(opcional, aparece al inicio del reporte)</span><textarea id="rp-msg" rows="2" maxlength="1000" placeholder="Hola, te comparto cómo nos fue este período…" class="${field} mt-1 resize-y"></textarea></label>
        <p class="text-[11px] text-slate-500 -mt-2">Con meta de leads, el reporte muestra el avance como objetivo cumplido o por cumplir.</p>

        <div class="flex items-center gap-3">
          <button onclick="PautaMonitor._createReportLink()" id="rp-create" class="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-60 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors">Generar link</button>
          <span id="rp-hint" class="text-xs text-slate-500"></span>
        </div>
      </div>

      <div class="lg:col-span-2 flex flex-col gap-3">
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider">Links de este cliente</p>
        <div id="rp-list" class="flex flex-col gap-2"><p class="text-xs text-slate-500">Cargando…</p></div>
      </div>
    </div>`;
  }

  function _reportModeChange() {
    const mode = document.querySelector('input[name="rp-mode"]:checked')?.value;
    document.getElementById('rp-range').style.display = mode === 'range' ? '' : 'none';
    for (const m of ['live', 'range']) {
      const el = document.getElementById('rp-opt-' + m), active = m === mode;
      el.classList.toggle('border-indigo-500', active);
      el.classList.toggle('bg-indigo-500/10', active);
      el.classList.toggle('border-slate-700', !active);
    }
  }

  function _reportQuickRange(key) {
    const f = document.getElementById('rp-from'), t = document.getElementById('rp-to');
    const now = new Date();
    if (key === 'prev') {
      f.value = _isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      t.value = _isoDate(new Date(now.getFullYear(), now.getMonth(), 0));
    } else if (key === 'this') {
      f.value = _isoDate(new Date(now.getFullYear(), now.getMonth(), 1));
      t.value = _isoDate(now);
    } else {
      f.value = f.dataset.monitor;
      t.value = t.dataset.monitor;
    }
  }

  function _fmtDay(iso) {
    return new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function _renderReportLinks() {
    const box = document.getElementById('rp-list');
    if (!box) return;
    if (!_reportLinks.length) {
      box.innerHTML = `
        <div class="rounded-xl border border-dashed border-slate-700 px-4 py-8 text-center">
          <p class="text-sm text-slate-400">Aún no hay links</p>
          <p class="text-xs text-slate-500 mt-1">Crea uno en tiempo real para compartirlo una sola vez con el cliente.</p>
        </div>`;
      return;
    }
    const btn = 'text-xs font-semibold rounded-lg px-2.5 py-1.5 transition-colors';
    box.innerHTML = _reportLinks.map(l => {
      const isNew = l.id === _reportNewId;
      const period = l.mode === 'live' ? 'Siempre al día' : `${_fmtDay(l.date_from)} → ${_fmtDay(l.date_to)}`;
      return `
      <div class="rounded-xl border ${isNew ? 'border-emerald-500/60 bg-emerald-500/10' : 'border-slate-700 bg-slate-800'} px-4 py-3">
        <div class="flex items-start justify-between gap-2">
          <div class="min-w-0">
            <p class="text-sm font-semibold text-slate-100 truncate">${l.title ? _esc(l.title) : (l.mode === 'live' ? 'Reporte en tiempo real' : 'Reporte por período')}</p>
            <p class="text-xs text-slate-400 mt-0.5">${l.mode === 'live' ? '🟢' : '📅'} ${period}${l.lead_goal ? ` · meta ${l.lead_goal} leads` : ''}</p>
          </div>
          ${isNew ? '<span class="text-[10px] font-bold uppercase tracking-wider text-emerald-300 flex-shrink-0">Nuevo</span>' : ''}
        </div>
        <div class="flex items-center gap-1.5 mt-2.5 flex-wrap">
          ${l.token ? `
            <button onclick="PautaMonitor._reportAction('copy', ${l.id}, this)" class="${btn} bg-indigo-600 hover:bg-indigo-500 text-white">Copiar link</button>
            <button onclick="PautaMonitor._reportAction('whatsapp', ${l.id})" class="${btn} bg-emerald-600/90 hover:bg-emerald-500 text-white">WhatsApp</button>
            <button onclick="PautaMonitor._reportAction('open', ${l.id})" class="${btn} bg-slate-700 hover:bg-slate-600 text-slate-100">Ver ↗</button>`
          : '<span class="text-[11px] text-slate-500">Creado antes de guardar links: revócalo y crea uno nuevo para copiarlo.</span>'}
          <button onclick="PautaMonitor._reportAction('revoke', ${l.id}, this)" class="${btn} ml-auto text-red-400 hover:text-red-300 hover:bg-red-500/10">Revocar</button>
        </div>
        <p class="text-[10px] text-slate-600 mt-2">Creado ${_fmtDay(l.created_at)}</p>
      </div>`;
    }).join('');
  }

  async function _loadReportLinks(clientId) {
    const box = document.getElementById('rp-list');
    if (!box) return;
    try {
      const { links } = await Session.apiFetch(`api/pauta_report_links.php?client_id=${encodeURIComponent(clientId)}`);
      _reportLinks = links || [];
      _renderReportLinks();
    } catch (e) {
      box.innerHTML = `<p class="text-xs text-red-400">No se pudieron cargar los links: ${_esc(e.message)}</p>`;
    }
  }

  async function _createReportLink() {
    const btn  = document.getElementById('rp-create');
    const hint = document.getElementById('rp-hint');
    const mode = document.querySelector('input[name="rp-mode"]:checked')?.value || 'live';
    const from = document.getElementById('rp-from').value, to = document.getElementById('rp-to').value;
    if (mode === 'range' && (!from || !to || from > to)) {
      hint.innerHTML = '<span class="text-red-400">Revisa las fechas: "desde" debe ser anterior o igual a "hasta".</span>';
      return;
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin"></span>Generando…';
    hint.textContent = '';
    try {
      const data = await Session.apiFetch('api/pauta_report_links.php', {
        method: 'POST',
        body: JSON.stringify({
          action: 'create', client_id: _reportClientId, mode, date_from: from, date_to: to,
          title: document.getElementById('rp-title').value, message: document.getElementById('rp-msg').value,
          lead_goal: Math.max(0, Math.round(Number(document.getElementById('rp-goal').value) || 0)),
        }),
      });
      _reportNewId = data.id;
      await _loadReportLinks(_reportClientId);
      // Si el listado no trae el token (migration_024 pendiente), se usa el recién devuelto para este link.
      const created = _reportLinks.find(l => l.id === data.id);
      if (created && !created.token) { created.token = data.token; _renderReportLinks(); }
      await _copyText(_reportUrl(data.token));
      hint.innerHTML = '<span class="text-emerald-400">✓ Link creado y copiado al portapapeles</span>';
      ['rp-title', 'rp-msg', 'rp-goal'].forEach(id => { document.getElementById(id).value = ''; });
    } catch (e) {
      hint.innerHTML = `<span class="text-red-400">${_esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generar link';
    }
  }

  async function _copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const ta = Object.assign(document.createElement('textarea'), { value: text });
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  async function _reportAction(action, id, el) {
    const link = _reportLinks.find(l => l.id === id);
    if (!link) return;
    const url = link.token ? _reportUrl(link.token) : '';

    if (action === 'copy') {
      await _copyText(url);
      el.textContent = '¡Copiado!';
      setTimeout(() => { el.textContent = 'Copiar link'; }, 1800);
    } else if (action === 'open') {
      window.open(url, '_blank', 'noopener');
    } else if (action === 'whatsapp') {
      const text = `Hola 👋 Te comparto el reporte de resultados de la pauta de ${_reportClientName}${link.mode === 'live' ? ' (se actualiza en tiempo real)' : ''}: ${url}`;
      window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank', 'noopener');
    } else if (action === 'revoke') {
      // Confirmación en el mismo botón (sin diálogos del navegador): segundo clic en 4 s revoca.
      if (el.dataset.armed !== '1') {
        el.dataset.armed = '1';
        el.textContent = '¿Seguro? Revocar';
        el.classList.add('bg-red-500/15');
        setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; el.textContent = 'Revocar'; el.classList.remove('bg-red-500/15'); } }, 4000);
        return;
      }
      el.disabled = true;
      try {
        await Session.apiFetch('api/pauta_report_links.php', { method: 'POST', body: JSON.stringify({ action: 'revoke', id }) });
        _reportLinks = _reportLinks.filter(l => l.id !== id);
        _renderReportLinks();
      } catch (e) {
        el.disabled = false;
        const hint = document.getElementById('rp-hint');
        if (hint) hint.innerHTML = `<span class="text-red-400">No se pudo revocar: ${_esc(e.message)}</span>`;
      }
    }
  }

  // ── Leads por día del cliente (pestaña Leads + Diagnóstico) ───────────────
  // Reutiliza el gasto diario que ya cargó la vista general (_spend): no hace llamadas nuevas.
  // Rellena con 0 los días del rango sin datos (hasta hoy) para que los huecos se vean.
  function _clientDaily(client, from, to) {
    const map = {};
    for (const plat of (client.platforms || [])) {
      if (!plat.enabled) continue;
      const accountId = _accountIdOf(plat);
      if (!accountId) continue;
      const r = _spend[_spendKey(plat.platform, accountId, from, to)];
      if (!r || r.error) continue;
      for (const d of (r.daily_data || [])) {
        const e = map[d.date] || (map[d.date] = { date: d.date, spend: 0, leads: 0, by: {} });
        e.spend += Number(d.spend) || 0;
        e.leads += Number(d.leads) || 0;
        e.by[plat.platform] = (e.by[plat.platform] || 0) + (Number(d.leads) || 0);
      }
    }
    const today = _isoDate(new Date()), end = to < today ? to : today, out = [];
    for (const d = new Date(from + 'T12:00:00'); _isoDate(d) <= end; d.setDate(d.getDate() + 1)) {
      const k = _isoDate(d);
      out.push(map[k] || { date: k, spend: 0, leads: 0, by: {} });
    }
    return out;
  }

  const _leadPlatColors = { meta: '#6366f1', google: '#f59e0b' };

  // Comportamiento de adquisición: barras apiladas por plataforma, línea de acumulado,
  // promedio, y lectura rápida (mejor día, días sin leads, últimos 7 vs. 7 anteriores).
  function _renderLeadsTrend(daily) {
    const total = daily.reduce((a, d) => a + d.leads, 0);
    if (!daily.length || total <= 0) {
      return `<div class="rounded-xl border border-dashed border-slate-700 px-4 py-6 text-center text-xs text-slate-500">
        Las plataformas no reportan leads en este período (o la vista general aún no termina de cargar).</div>`;
    }
    const n = daily.length, W = 600, H = 150, top = 8;
    const max   = Math.max(...daily.map(d => d.leads), 1);
    const slot  = W / n, bw = Math.max(2, slot * (n > 40 ? 0.8 : 0.66));
    const plats = [...new Set(daily.flatMap(d => Object.keys(d.by).filter(p => d.by[p] > 0)))];
    const best  = daily.reduce((a, d) => d.leads > a.leads ? d : a, daily[0]);
    const avg   = total / n;
    const spend = daily.reduce((a, d) => a + d.spend, 0);
    const yOf   = v => H - v / max * (H - top);

    let cum = 0;
    const pts = [], line = [];
    const bars = daily.map((d, i) => {
      const x = i * slot + (slot - bw) / 2;
      cum += d.leads;
      line.push(`${i ? 'L' : 'M'}${(x + bw / 2).toFixed(1)} ${(H - 2 - cum / total * (H - top - 2)).toFixed(1)}`);
      pts.push([d.date, Math.round(d.leads * 10) / 10, +(yOf(d.leads) / H).toFixed(4)]);
      if (d.leads <= 0) return `<rect x="${x.toFixed(1)}" y="${H - 1.5}" width="${bw.toFixed(1)}" height="1.5" fill="#334155"/>`;
      let y = H, s = '';
      const parts = plats.length ? plats.map(p => [p, d.by[p] || 0]) : [['otro', d.leads]];
      for (const [p, v] of parts) {
        if (v <= 0) continue;
        const h = v / max * (H - top);
        y -= h;
        s += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${_leadPlatColors[p] || '#94a3b8'}"${d.date === best.date ? ' stroke="#10b981" stroke-width="2" vector-effect="non-scaling-stroke"' : ''}/>`;
      }
      return s;
    }).join('');

    const every  = Math.max(1, Math.ceil(n / 8));
    const dayLbl = iso => new Date(iso + 'T12:00:00').toLocaleDateString('es-CO', { day: 'numeric', month: 'short' });
    const labels = daily.map((d, i) => `<span class="flex-1 text-center text-[10px] text-slate-500 whitespace-nowrap overflow-visible">${i % every === 0 ? dayLbl(d.date) : ''}</span>`).join('');
    const sparkData = _esc(JSON.stringify({ c: '#6366f1', b: 1, h: H, u: 'leads', p: pts }));

    // Lectura rápida. Hoy va incompleto: las comparaciones de ritmo usan solo días cerrados.
    const today  = _isoDate(new Date());
    const closed = daily[n - 1].date === today ? daily.slice(0, -1) : daily;
    const sum = arr => arr.reduce((a, d) => a + d.leads, 0);
    let wow = null;
    if (closed.length >= 14) {
      const last7 = sum(closed.slice(-7)), prev7 = sum(closed.slice(-14, -7));
      wow = prev7 > 0 ? (last7 - prev7) / prev7 * 100 : null;
    }
    const zeroDays = closed.filter(d => d.leads <= 0).length;
    let streak = 0;
    for (let i = closed.length - 1; i >= 0 && closed[i].leads <= 0; i--) streak++;

    const stat = (label, value, sub = '', cls = 'text-slate-100') => `
      <div class="bg-slate-800/60 border border-slate-700/60 rounded-xl px-3 py-2.5">
        <div class="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">${label}</div>
        <div class="text-base font-black ${cls} mt-1 leading-none">${value}</div>
        ${sub ? `<div class="text-[11px] text-slate-400 mt-1">${sub}</div>` : ''}
      </div>`;
    const legend = plats.map(p => `<span class="inline-flex items-center gap-1.5"><span class="w-2.5 h-2.5 rounded-sm" style="background:${_leadPlatColors[p] || '#94a3b8'}"></span>${p === 'meta' ? 'Meta' : p === 'google' ? 'Google' : _esc(p)}</span>`).join('');

    return `
    <div class="rounded-2xl border border-slate-700 bg-slate-800/30 p-4 sm:p-5">
      <div class="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div>
          <p class="text-xs font-semibold text-slate-300 uppercase tracking-wider">Comportamiento de adquisición</p>
          <p class="text-[11px] text-slate-500 mt-0.5">Leads por día según las plataformas (formularios, píxel y conversaciones en Meta; conversiones en Google)</p>
        </div>
        <div class="flex items-center gap-3 text-[11px] text-slate-400">
          ${legend}
          <span class="inline-flex items-center gap-1.5"><span class="w-3 border-t-2 border-emerald-400"></span>Acumulado</span>
          <span class="inline-flex items-center gap-1.5"><span class="w-3 border-t border-dashed border-slate-400"></span>Promedio</span>
        </div>
      </div>
      <div class="spark" data-spark="${sparkData}" style="position:relative;padding:8px 0;margin:-8px 0;cursor:crosshair">
        <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="none" style="display:block">
          ${bars}
          <line x1="0" x2="${W}" y1="${yOf(avg).toFixed(1)}" y2="${yOf(avg).toFixed(1)}" stroke="#94a3b8" stroke-dasharray="4 4" stroke-width="1" vector-effect="non-scaling-stroke" opacity=".7"/>
          <path d="${line.join(' ')}" fill="none" stroke="#34d399" stroke-width="2" vector-effect="non-scaling-stroke" opacity=".9"/>
        </svg>
      </div>
      <div class="flex mt-1.5">${labels}</div>
      <div class="grid grid-cols-2 sm:grid-cols-5 gap-2 mt-4">
        ${stat('Leads plataforma', _fmtNum(total), `${(avg).toFixed(1)}/día en promedio`)}
        ${stat('Mejor día', dayLbl(best.date), `${Math.round(best.leads)} leads`, 'text-emerald-400')}
        ${stat('CPL plataforma', spend > 0 ? '$' + _fmtShort(spend / total) : '—', 'inversión / leads', 'text-indigo-300')}
        ${stat('Días sin leads', zeroDays, streak >= 2 ? `⚠ ${streak} días seguidos al cierre` : `de ${closed.length} días cerrados`, streak >= 2 ? 'text-red-400' : zeroDays > 0 ? 'text-yellow-400' : 'text-slate-100')}
        ${stat('Últimos 7 días', wow == null ? '—' : `${wow > 0 ? '▲' : '▼'} ${Math.abs(wow).toFixed(0)}%`, wow == null ? 'necesita 14 días cerrados' : 'vs. 7 días anteriores', wow == null ? 'text-slate-400' : wow >= 0 ? 'text-emerald-400' : wow <= -20 ? 'text-red-400' : 'text-yellow-400')}
      </div>
    </div>`;
  }

  // ── Monitoreo rápido (pestaña Diagnóstico) ────────────────────────────────
  // Cinco chequeos sobre el período del monitor, ordenados por urgencia. Las campañas TOF
  // (alcance/reconocimiento) no se juzgan por leads: su objetivo no es convertir.
  function _renderQuickMonitor(detailData, daily) {
    const camps = Object.entries(detailData)
      .filter(([, d]) => !d.error && Array.isArray(d.campaigns))
      .flatMap(([platform, d]) => d.campaigns.map(c => ({ ...c, platform, stage: c.stage || _detectStage(c.name) })))
      .filter(c => (c.spend || 0) > 0 || (c.impressions || 0) > 0);
    if (!camps.length) return '';

    const totSpend = camps.reduce((a, c) => a + (c.spend || 0), 0);
    const totLeads = camps.reduce((a, c) => a + (c.leads || 0), 0);
    const acctCpl  = totLeads > 0 ? totSpend / totLeads : 0;
    const convCamps = camps.filter(c => c.stage !== 'tof');
    const money = v => '$' + _fmtShort(v);
    const item = (c, right, rightCls = 'text-slate-300') => `
      <li class="flex items-center justify-between gap-3 text-xs py-1">
        ${_campaignTitle(c, 'truncate text-slate-200 min-w-0')}
        <span class="flex-shrink-0 font-semibold ${rightCls}">${right}</span>
      </li>`;
    const checks = [];

    // 1. Gasto sin resultados
    const minSpend = acctCpl > 0 ? acctCpl : totSpend * 0.1;
    const noLeads = convCamps.filter(c => (c.leads || 0) <= 0 && (c.spend || 0) >= minSpend).sort((a, b) => b.spend - a.spend);
    const wasted = noLeads.reduce((a, c) => a + c.spend, 0);
    checks.push({
      icon: '🕳️', title: 'Gasto sin resultados',
      level: noLeads.length ? (wasted >= totSpend * 0.2 ? 'bad' : 'warn') : 'ok',
      headline: noLeads.length ? `${money(wasted)} sin leads (${(wasted / Math.max(totSpend, 1) * 100).toFixed(0)}% de la inversión)` : 'Toda campaña de conversión con gasto relevante trae leads',
      items: noLeads.slice(0, 3).map(c => item(c, money(c.spend), 'text-red-400')),
      action: noLeads.length ? `Gastaron más de un CPL (${money(minSpend)}) sin leads: revisa formulario, píxel o segmentación, o pausa.` : '',
    });

    // 2. CPL por campaña vs. promedio de la cuenta
    const withCpl = convCamps.filter(c => (c.leads || 0) > 0 && (c.spend || 0) > 0).map(c => ({ ...c, cpl: c.spend / c.leads, ratio: c.spend / c.leads / acctCpl }));
    const expensive = withCpl.filter(c => c.ratio >= 1.5).sort((a, b) => b.ratio - a.ratio);
    const cheap     = withCpl.filter(c => c.ratio <= 0.7 && c.leads >= 3).sort((a, b) => a.ratio - b.ratio);
    checks.push({
      icon: '⚖️', title: 'CPL vs. promedio',
      level: !acctCpl ? 'na' : expensive.length ? (expensive[0].ratio >= 2.5 ? 'bad' : 'warn') : 'ok',
      headline: !acctCpl ? 'Sin leads en el período para comparar' : `CPL de la cuenta ${money(acctCpl)}${expensive.length ? ` · ${expensive.length} campaña${expensive.length > 1 ? 's' : ''} muy por encima` : ' · ninguna campaña se dispara'}`,
      items: [
        ...expensive.slice(0, 2).map(c => item(c, `${money(c.cpl)} · ${c.ratio.toFixed(1)}×`, 'text-red-400')),
        ...cheap.slice(0, 1).map(c => item(c, `${money(c.cpl)} · escalar`, 'text-emerald-400')),
      ],
      action: expensive.length ? 'Más de 1,5× el CPL promedio: baja presupuesto o rota creativos.' + (cheap.length ? ' La campaña en verde es candidata a recibir más presupuesto.' : '') : cheap.length ? 'La campaña en verde convierte barato: candidata a escalar.' : '',
    });

    // 3. Caída de leads (días cerrados: hoy va incompleto)
    const today  = _isoDate(new Date());
    const closed = daily.length && daily[daily.length - 1].date === today ? daily.slice(0, -1) : daily;
    const dropCheck = { icon: '📉', title: 'Caída de leads', level: 'na', headline: 'Se necesitan al menos 7 días cerrados', items: [], action: '' };
    if (closed.length >= 7 && closed.some(d => d.leads > 0)) {
      const last3 = closed.slice(-3), base = closed.slice(-10, -3);
      const avgLast = last3.reduce((a, d) => a + d.leads, 0) / last3.length;
      const avgBase = base.length ? base.reduce((a, d) => a + d.leads, 0) / base.length : 0;
      const last2Zero = closed.slice(-2).every(d => d.leads <= 0) && closed.slice(-2).some(d => d.spend > 0);
      const drop = avgBase > 0 ? (avgBase - avgLast) / avgBase * 100 : 0;
      dropCheck.level = last2Zero || drop >= 40 ? 'bad' : drop >= 20 ? 'warn' : 'ok';
      dropCheck.headline = last2Zero ? 'Los 2 últimos días cerrados sin leads, con gasto activo'
        : `Últimos 3 días: ${avgLast.toFixed(1)}/día vs. ${avgBase.toFixed(1)}/día los 7 anteriores${drop >= 1 ? ` (▼ ${drop.toFixed(0)}%)` : drop <= -1 ? ` (▲ ${(-drop).toFixed(0)}%)` : ''}`;
      dropCheck.action = dropCheck.level === 'ok' ? '' : 'Revisa si algo cambió: anuncios rechazados, formulario caído, presupuesto agotado o temporada.';
    }
    checks.push(dropCheck);

    // 4. Anuncios que no enganchan (CTR bajo con volumen suficiente). En TOF (alcance) un CTR
    //    menor es normal: el umbral baja a 0,5%.
    const ctrMin = c => c.stage === 'tof' ? 0.5 : 0.8;
    const lowCtr = camps.filter(c => (c.impressions || 0) >= 2000)
      .map(c => ({ ...c, ctrv: c.clicks / c.impressions * 100 }))
      .filter(c => c.ctrv < ctrMin(c)).sort((a, b) => a.ctrv / ctrMin(a) - b.ctrv / ctrMin(b));
    checks.push({
      icon: '🎨', title: 'Anuncios que no enganchan',
      level: lowCtr.length ? (lowCtr.some(c => c.ctrv < ctrMin(c) / 2) ? 'bad' : 'warn') : 'ok',
      headline: lowCtr.length ? `${lowCtr.length} campaña${lowCtr.length > 1 ? 's' : ''} con CTR bajo (mín. 0,8%; 0,5% en TOF)` : 'Ninguna campaña con volumen tiene CTR bajo',
      items: lowCtr.slice(0, 3).map(c => item(c, `CTR ${c.ctrv.toFixed(2)}%`, c.ctrv < ctrMin(c) / 2 ? 'text-red-400' : 'text-yellow-400')),
      action: lowCtr.length ? 'Cambia el gancho de los primeros segundos, el texto principal o la audiencia.' : '',
    });

    // 5. Reparto de la inversión: campañas que se llevan mucho presupuesto y aportan pocos leads
    const unbalanced = totLeads > 0 ? convCamps.map(c => ({ ...c, sShare: c.spend / totSpend * 100, lShare: (c.leads || 0) / totLeads * 100 }))
      .filter(c => c.sShare >= 20 && c.lShare < c.sShare / 2).sort((a, b) => (b.sShare - b.lShare) - (a.sShare - a.lShare)) : [];
    const topLead = totLeads > 0 ? [...camps].sort((a, b) => (b.leads || 0) - (a.leads || 0))[0] : null;
    const topShare = topLead ? (topLead.leads || 0) / totLeads * 100 : 0;
    const dependent = camps.length > 1 && topShare >= 70;
    checks.push({
      icon: '🧩', title: 'Reparto de la inversión',
      level: totLeads <= 0 ? 'na' : unbalanced.length ? 'warn' : dependent ? 'warn' : 'ok',
      headline: totLeads <= 0 ? 'Sin leads en el período para comparar'
        : unbalanced.length ? `${unbalanced.length} campaña${unbalanced.length > 1 ? 's' : ''} con mucha inversión y pocos leads`
        : dependent ? `${topShare.toFixed(0)}% de los leads depende de una sola campaña` : 'La inversión está alineada con los resultados',
      items: unbalanced.length
        ? unbalanced.slice(0, 3).map(c => item(c, `${c.sShare.toFixed(0)}% gasto · ${c.lShare.toFixed(0)}% leads`, 'text-yellow-400'))
        : dependent ? [item(topLead, `${topShare.toFixed(0)}% de los leads`, 'text-yellow-400')] : [],
      action: unbalanced.length ? 'Mueve presupuesto hacia las campañas que convierten mejor (usa el Simulador).'
        : dependent ? 'Si esa campaña se fatiga o la rechazan, caen todos los leads: prepara una alternativa.' : '',
    });

    const cfg = {
      bad:  { pill: 'Revisar',   cls: 'bg-red-500/15 text-red-300 border-red-500/40',          card: 'border-red-500/40' },
      warn: { pill: 'Atención',  cls: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/40', card: 'border-yellow-500/30' },
      ok:   { pill: 'OK',        cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40', card: 'border-slate-700' },
      na:   { pill: 'Sin datos', cls: 'bg-slate-700/40 text-slate-400 border-slate-600',        card: 'border-slate-700' },
    };
    const order = { bad: 0, warn: 1, ok: 2, na: 3 };
    checks.sort((a, b) => order[a.level] - order[b.level]);
    const greens = checks.filter(c => c.level === 'ok').length;
    const alerts = checks.filter(c => c.level === 'bad' || c.level === 'warn').length;

    return `
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <p class="text-xs font-semibold text-slate-300 uppercase tracking-wider">Monitoreo rápido</p>
        <div class="flex items-center gap-1.5">
          ${checks.map(c => `<span title="${_esc(c.title)}" class="w-2.5 h-2.5 rounded-full ${c.level === 'bad' ? 'bg-red-500' : c.level === 'warn' ? 'bg-yellow-400' : c.level === 'ok' ? 'bg-emerald-500' : 'bg-slate-600'}"></span>`).join('')}
          <span class="text-xs text-slate-400 ml-1.5">${alerts ? `${alerts} alerta${alerts > 1 ? 's' : ''} · ` : ''}${greens} de ${checks.length} en verde</span>
        </div>
      </div>
      <div class="grid md:grid-cols-2 gap-3">
        ${checks.map((c, i) => `
        <div class="rounded-xl border ${cfg[c.level].card} bg-slate-800/40 p-4 ${i === 0 && c.level === 'bad' ? 'md:col-span-2' : ''}">
          <div class="flex items-center justify-between gap-2">
            <p class="text-sm font-bold text-slate-100"><span class="mr-1.5">${c.icon}</span>${c.title}</p>
            <span class="text-[11px] font-bold border rounded-full px-2 py-0.5 ${cfg[c.level].cls}">${cfg[c.level].pill}</span>
          </div>
          <p class="text-xs text-slate-300 mt-2 leading-snug">${c.headline}</p>
          ${c.items.length ? `<ul class="mt-2 divide-y divide-slate-700/60">${c.items.join('')}</ul>` : ''}
          ${c.action ? `<p class="text-[11px] text-slate-400 mt-2 leading-snug">→ ${c.action}</p>` : ''}
        </div>`).join('')}
      </div>
    </div>`;
  }

  function _emptyPanel(msg) {
    return `<div class="flex flex-col items-center justify-center py-16 text-center text-slate-500 gap-3">
      <div class="w-12 h-12 rounded-full border-2 border-dashed border-slate-700 flex items-center justify-center text-slate-600 text-xl">∅</div>
      <p class="text-sm max-w-sm leading-relaxed">${msg}</p>
    </div>`;
  }

  function _overallHealth(qualRate, fatigueWorst, totLeads) {
    let level = 'ok';
    if (totLeads > 0) {
      if (qualRate < 40)      level = 'bad';
      else if (qualRate < 60) level = 'warn';
    } else {
      level = 'neutral';
    }
    if (fatigueWorst === 'critical')                       level = 'bad';
    else if (fatigueWorst === 'danger' && level === 'ok')  level = 'warn';

    const map = {
      ok:      { label: 'Saludable', cls: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30', dot: 'bg-emerald-500' },
      warn:    { label: 'Atención',  cls: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',     dot: 'bg-yellow-400' },
      bad:     { label: 'Crítico',   cls: 'bg-red-500/15 text-red-400 border-red-500/30',              dot: 'bg-red-500 animate-pulse' },
      neutral: { label: 'Sin leads', cls: 'bg-slate-700/40 text-slate-400 border-slate-600',           dot: 'bg-slate-500' },
    };
    return map[level];
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
      ${row('TOF · F1', Icons.svg('megaphone', 'w-3.5 h-3.5 inline -mt-0.5'), 'border-blue-500',    'text-blue-400 bg-blue-500/10',    tof, tofCPM > 0 ? `CPM $${_fmtShort(tofCPM)}` : '—', 'CPM', 0)}
      ${arrow}
      ${row('MOF · F2', Icons.svg('target', 'w-3.5 h-3.5 inline -mt-0.5'), 'border-yellow-500',  'text-yellow-400 bg-yellow-500/10', mof, mofCPC > 0 ? `CPC $${_fmtShort(mofCPC)}` : '—', 'CPC', 24)}
      ${arrow}
      ${row('BOF · F3', Icons.svg('wallet', 'w-3.5 h-3.5 inline -mt-0.5'), 'border-emerald-500', 'text-emerald-400 bg-emerald-500/10', bof, bofCPL > 0 ? `CPL $${_fmtShort(bofCPL)}` : '—', 'CPL', 48)}
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

    const kpi = (label, val, sub, valCls = 'text-slate-100', accent = 'border-slate-700/60') => `
      <div class="bg-slate-800/60 rounded-xl p-3.5 border ${accent}">
        <div class="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">${label}</div>
        <div class="text-lg font-black ${valCls} mt-1.5 leading-none">${val}</div>
        <div class="text-[11px] text-slate-500 mt-1.5 leading-tight">${sub}</div>
      </div>`;

    return `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
      ${kpi('CPM', cpm > 0 ? `$${_fmtShort(cpm)}` : '—', 'costo / mil imp.')}
      ${kpi('CTR', ctr > 0 ? `${ctr.toFixed(2)}%` : '—', 'clics / impresiones')}
      ${kpi('CPC', cpc > 0 ? `$${_fmtShort(cpc)}` : '—', 'costo / clic')}
      ${kpi('CPL', cpl > 0 ? `$${_fmtShort(cpl)}` : '—', 'costo / lead total')}
      ${kpi('Leads', totLeads || '—', 'recibidos en el período')}
      ${kpi('Calificados', qualified || '—', `${qualRate.toFixed(0)}% tasa de calificación`, qualified > 0 ? qColor : 'text-slate-500')}
      ${kpi('No calificados', unqual || '—', 'descartados', unqual > 0 ? 'text-red-400' : 'text-slate-500')}
      ${kpi('CPQL', cpql > 0 ? `$${_fmtShort(cpql)}` : '—', 'costo / lead calificado', cpql > 0 ? 'text-indigo-300' : 'text-slate-500', cpql > 0 ? 'border-indigo-500/30' : 'border-slate-700/60')}
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
          <span>Calificados ${qBarW}%</span>
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

  async function _saveLeadInput(clientId, from, to) {
    const total     = parseInt(document.getElementById('bm-total')?.value     || '0') || 0;
    const qualified = parseInt(document.getElementById('bm-qualified')?.value || '0') || 0;
    if (qualified > total) { alert('Los calificados no pueden superar el total.'); return; }
    try {
      await _saveLeads(clientId, from, { total, qualified });
    } catch (e) {
      alert('No se pudo guardar el registro de leads: ' + e.message);
      return;
    }
    closeBrandModal();
    await openBrandModal(clientId);
    _switchBrandTab('leads');
  }

  // ── Simulador de Redistribución de Presupuesto ────────────────────────────

  function _cascadeModifier(oldTofRatio, newTofRatio) {
    // Más TOF = audiencia más caliente = BOF más eficiente (y viceversa)
    // Cada 10% de aumento en ratio TOF mejora BOF ~4%; cada 10% de reducción lo penaliza ~7%
    const delta = newTofRatio - oldTofRatio;
    const mod   = delta >= 0 ? 1 + delta * 0.40 : 1 + delta * 0.70;
    return Math.min(Math.max(mod, 0.40), 1.60); // clamped 40%–160%
  }

  function _renderSimulator(stages, totalSpend, totLeads, qualified) {
    if (totalSpend <= 0) return '';

    const tof = _stageTotals(stages.tof);
    const mof = _stageTotals(stages.mof);
    const bof = _stageTotals(stages.bof);

    const tofPct = Math.round(tof.spend / totalSpend * 100);
    const mofPct = Math.round(mof.spend / totalSpend * 100);
    const bofPct = Math.round(bof.spend / totalSpend * 100);
    const qualRate = totLeads > 0 ? qualified / totLeads : 0;

    // Guardar estado base para _updateSimulation
    _simState = {
      total:    totalSpend,
      qualRate,
      currentLeads:     totLeads,
      currentQualified: qualified,
      currentCPQL:      qualified > 0 ? totalSpend / qualified : 0,
      tof: {
        pct: tofPct, spend: tof.spend,
        cpm: tof.impressions > 0 ? tof.spend / tof.impressions * 1000 : 0,
        ctr: tof.impressions > 0 ? tof.clicks / tof.impressions       : 0,
        impressions: tof.impressions,
      },
      mof: {
        pct: mofPct, spend: mof.spend,
        cpl: mof.leads > 0 ? mof.spend / mof.leads : 0,
        leads: mof.leads,
      },
      bof: {
        pct: bofPct, spend: bof.spend,
        cpl: bof.leads > 0 ? bof.spend / bof.leads : 0,
        leads: bof.leads,
      },
    };

    const hasBofData = bof.leads > 0;
    const hasMofData = mof.leads > 0;

    const sliderRow = (id, label, colorCls, trackCls, pct, budget, hasData) => `
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <div class="flex items-center gap-2">
            <span class="text-xs font-bold ${colorCls} w-16">${label}</span>
            ${!hasData ? '<span class="text-xs text-slate-600">sin datos históricos</span>' : ''}
          </div>
          <div class="flex items-center gap-3">
            <span id="${id}-budget" class="text-xs text-slate-300 font-semibold w-20 text-right">$${_fmt(budget)}</span>
            <span id="${id}-pct-label" class="text-xs text-slate-500 w-10 text-right">${pct}%</span>
          </div>
        </div>
        <input type="range" id="${id}" min="0" max="100" step="1" value="${pct}"
          oninput="PautaMonitor._updateSimulation()"
          class="w-full h-2 rounded-full appearance-none cursor-pointer ${trackCls} accent-current ${colorCls}">
      </div>`;

    return `
    <div class="rounded-2xl border border-indigo-500/30 overflow-hidden">
      <div class="px-5 py-4 bg-indigo-950/40 flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <span class="text-amber-400">${Icons.svg('zap', 'w-4 h-4')}</span>
          <p class="text-xs font-semibold text-slate-300 uppercase tracking-wider">Simulador de Presupuesto</p>
        </div>
        <span class="text-xs text-slate-400">Total fijo: <strong class="text-slate-200">$${_fmt(totalSpend)}</strong></span>
      </div>

      <div class="p-5 flex flex-col gap-5 bg-slate-900/60">

        <!-- Sliders -->
        <div class="flex flex-col gap-4">
          ${sliderRow('sim-tof', 'TOF · F1', 'text-blue-400',    'bg-slate-700', tofPct, tof.spend, true)}
          ${sliderRow('sim-mof', 'MOF · F2', 'text-yellow-400',  'bg-slate-700', mofPct, mof.spend, hasMofData)}
          ${sliderRow('sim-bof', 'BOF · F3', 'text-emerald-400', 'bg-slate-700', bofPct, bof.spend, hasBofData)}
          <div class="flex justify-between items-center pt-1 border-t border-slate-800 text-xs">
            <span class="text-slate-500">Presupuesto sin asignar</span>
            <span id="sim-remaining" class="font-black text-lg text-emerald-400">0%</span>
          </div>
        </div>

        <!-- Nota cascada -->
        <div id="sim-cascade-note" class="hidden text-xs px-3 py-2 rounded-xl"></div>

        <!-- Comparación actual vs proyectado -->
        <div>
          <p class="text-xs text-slate-500 uppercase tracking-wider font-semibold mb-1">Proyección de resultados</p>
          <p class="text-xs text-slate-600 mb-3">⚠ Estimación orientativa: asume que los CPM/CPL del período se mantienen y aplica un factor heurístico de embudo — no es una predicción de la plataforma.</p>
          <div class="bg-slate-800 rounded-xl overflow-hidden">
            <div class="grid grid-cols-3 text-xs font-semibold text-slate-500 px-4 py-2 border-b border-slate-700">
              <span>Métrica</span>
              <span class="text-center">Actual</span>
              <span class="text-center">Proyectado</span>
            </div>
            <div id="sim-rows" class="divide-y divide-slate-700/60">
              ${_buildSimRows(_simState)}
            </div>
          </div>
        </div>

        ${!hasBofData ? '<p class="text-xs text-slate-600 text-center">Agrega leads en "Calidad de Leads" para activar la proyección de BOF.</p>' : ''}
      </div>
    </div>`;
  }

  function _buildSimRows(s, newTofPct, newMofPct, newBofPct) {
    const tofPct = newTofPct ?? s.tof.pct;
    const mofPct = newMofPct ?? s.mof.pct;
    const bofPct = newBofPct ?? s.bof.pct;

    const tofBudget = s.total * tofPct / 100;
    const mofBudget = s.total * mofPct / 100;
    const bofBudget = s.total * bofPct / 100;

    const cascMod     = _cascadeModifier(s.tof.pct / 100, tofPct / 100);
    const tofImprNew  = s.tof.cpm  > 0 ? tofBudget / s.tof.cpm * 1000 : 0;
    const bofLeadsNew = s.bof.cpl  > 0 ? bofBudget / s.bof.cpl * cascMod : 0;
    const mofLeadsNew = s.mof.cpl  > 0 ? mofBudget / s.mof.cpl : 0;
    const totalLeads  = Math.round(bofLeadsNew + mofLeadsNew);
    const qualifiedNew = Math.round(totalLeads * s.qualRate);
    const cpqlNew     = qualifiedNew > 0 ? s.total / qualifiedNew : 0;

    const row = (label, cur, proj, higherGood, isInt, prefix = '') => {
      const isBase   = newTofPct === undefined;
      const curFmt   = isInt ? _fmtNum(Math.round(cur))   : `${prefix}${_fmtShort(cur)}`;
      const projFmt  = isInt ? _fmtNum(Math.round(proj))  : `${prefix}${_fmtShort(proj)}`;
      const delta    = cur > 0 ? (proj - cur) / cur * 100 : 0;
      const isGood   = higherGood ? delta >= 0 : delta <= 0;
      const sign     = delta >= 0 ? '+' : '';
      const dColor   = isBase ? 'text-slate-600' : (isGood ? 'text-emerald-400' : 'text-red-400');
      const arrow    = isBase ? '' : (delta >= 0 ? '↑' : '↓');
      return `
      <div class="grid grid-cols-3 items-center px-4 py-2.5 text-xs">
        <span class="text-slate-400">${label}</span>
        <span class="text-center font-semibold text-slate-300">${curFmt}</span>
        <div class="text-center">
          <span class="font-bold ${isBase ? 'text-slate-300' : (isGood ? 'text-emerald-300' : 'text-red-300')}">${projFmt}</span>
          ${!isBase && Math.abs(delta) >= 0.5 ? `<span class="${dColor} ml-1">${arrow}${sign}${Math.abs(delta).toFixed(0)}%</span>` : ''}
        </div>
      </div>`;
    };

    return [
      row('Imp. TOF',          s.tof.impressions, tofImprNew,   true,  true),
      row('Leads totales',     s.currentLeads,    totalLeads,   true,  true),
      row('Calificados',       s.currentQualified, qualifiedNew, true,  true),
      row('CPQL',              s.currentCPQL,     cpqlNew,      false, false, '$'),
    ].join('');
  }

  function _updateSimulation() {
    if (!_simState) return;
    const s = _simState;

    const tofPct = parseFloat(document.getElementById('sim-tof')?.value || 0);
    const mofPct = parseFloat(document.getElementById('sim-mof')?.value || 0);
    const bofPct = parseFloat(document.getElementById('sim-bof')?.value || 0);
    const used   = tofPct + mofPct + bofPct;
    const rem    = 100 - used;

    // Actualizar etiquetas de % y presupuesto
    [['sim-tof', tofPct], ['sim-mof', mofPct], ['sim-bof', bofPct]].forEach(([id, pct]) => {
      const budget = s.total * pct / 100;
      const lbl = document.getElementById(`${id}-pct-label`);
      const bEl = document.getElementById(`${id}-budget`);
      if (lbl) lbl.textContent = `${Math.round(pct)}%`;
      if (bEl) bEl.textContent = `$${_fmt(budget)}`;
    });

    // Remaining
    const remEl = document.getElementById('sim-remaining');
    if (remEl) {
      remEl.textContent = `${rem.toFixed(0)}%`;
      remEl.className = `font-black text-lg ${Math.abs(rem) < 1 ? 'text-emerald-400' : rem < 0 ? 'text-red-400' : 'text-yellow-400'}`;
    }

    // Nota de cascada
    const cascMod  = _cascadeModifier(s.tof.pct / 100, tofPct / 100);
    const cascDiff = Math.round((cascMod - 1) * 100);
    const noteEl   = document.getElementById('sim-cascade-note');
    if (noteEl) {
      if (Math.abs(cascDiff) >= 2) {
        noteEl.textContent = `Efecto cascada: ${cascDiff > 0 ? '+' : ''}${cascDiff}% en eficiencia BOF por cambio de ratio TOF`;
        noteEl.className   = `text-xs px-3 py-2 rounded-xl ${cascDiff > 0 ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`;
        noteEl.classList.remove('hidden');
      } else {
        noteEl.classList.add('hidden');
      }
    }

    // Actualizar filas de comparación
    const rowsEl = document.getElementById('sim-rows');
    if (rowsEl) rowsEl.innerHTML = _buildSimRows(s, tofPct, mofPct, bofPct);
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
    critical: 'Fatiga severa detectada. La audiencia está saturada — rota creativos de inmediato y considera ampliar el público objetivo.',
    danger:   'Señales claras de fatiga. Prepara nuevos creativos y revisa la segmentación. El rendimiento seguirá cayendo.',
    warn:     'Frecuencia en zona de alerta. Monitorea el CTR diariamente y ten creativos alternativos listos.',
    ok:       'La audiencia responde bien. Frecuencia y CTR dentro de rangos saludables para esta etapa.',
    unknown:  '—',
  };

  function _fatigueAnalyze(detailData) {
    const metaData = detailData?.meta;
    if (!metaData || metaData.error || !Array.isArray(metaData.campaigns)) return null;

    // Solo campañas Meta con datos de frecuencia o suficientes impresiones para calcularla
    const campaigns = metaData.campaigns
      .filter(c => c.impressions > 0)
      .map(c => {
        const freq = c.frequency > 0 ? c.frequency : (c.reach > 0 ? c.impressions / c.reach : 0);
        const ctr  = c.impressions > 0 ? c.clicks / c.impressions * 100 : 0;
        return { ...c, platform: 'meta', freq: Math.round(freq * 100) / 100, ctr: Math.round(ctr * 100) / 100 };
      });

    if (campaigns.length === 0) return null;

    const levels = campaigns.map(c => _fatigueLevel(c.freq, c.ctr, c.stage));
    const worst  = levels.includes('critical') ? 'critical'
                 : levels.includes('danger')   ? 'danger'
                 : levels.includes('warn')      ? 'warn' : 'ok';
    return { campaigns, worst };
  }

  function _renderFatigue(detailData) {
    const analysis = _fatigueAnalyze(detailData);
    if (!analysis) return '';
    const { campaigns, worst } = analysis;
    const wCfg = _fatigueConfig[worst];

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
          ${_campaignTitle(c, 'text-sm font-semibold text-slate-100 truncate block')}
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

  // Enlace directo a la campaña en el administrador de anuncios de cada plataforma.
  // Meta: Ads Manager filtrado por la campaña (act= lleva el ID numérico de la cuenta).
  // Google: la vista de grupos de anuncios de la campaña; __e fija la cuenta (customer ID sin guiones).
  function _campaignUrl(c) {
    const acct = String(c.account_id || '').replace(/\D/g, '');
    const id   = String(c.id || '').replace(/\D/g, '');
    if (!acct || !id) return '';
    if (c.platform === 'meta')   return `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${acct}&selected_campaign_ids=${id}`;
    if (c.platform === 'google') return `https://ads.google.com/aw/adgroups?campaignId=${id}&__e=${acct}`;
    return '';
  }

  // Nombre de campaña que abre la campaña en su plataforma (pestaña nueva); texto plano si no hay enlace.
  function _campaignTitle(c, cls, prefix = '') {
    const url = _campaignUrl(c);
    if (!url) return `<span class="${cls}">${prefix}${_esc(c.name)}</span>`;
    const where = c.platform === 'google' ? 'Google Ads' : 'Meta Ads Manager';
    return `<a href="${_esc(url)}" target="_blank" rel="noopener noreferrer" title="Abrir en ${where}"
      class="${cls} group hover:text-indigo-300 hover:underline decoration-indigo-400/50 underline-offset-2">${prefix}${_esc(c.name)}<span class="text-slate-500 group-hover:text-indigo-300 ml-1 no-underline">↗</span></a>`;
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
              ${_campaignTitle(c, 'text-sm text-slate-200 font-medium leading-snug', platIcon + ' ')}
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

  async function init() {
    _initSparkHover();
    _showGoogleAdsResult();
    _loadGoogleAdsStatus();
    await _load();
    setThisMonth();
    loadData();
  }

  return {
    init,
    loadData,
    render,
    toggleFilter,
    openGoogleAdsModal,
    closeGoogleAdsModal,
    submitGoogleAdsCode,
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
    _switchBrandTab,
    _saveLeadInput,
    _updateSimulation,
    _reportModeChange,
    _reportQuickRange,
    _createReportLink,
    _reportAction,
  };
})();
