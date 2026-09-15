// Dashboard consolidado de Rendición Trimestral (solo superadmin/admin) —
// consume backend/api/rendicion_dashboard.php (indicadores + score ya
// calculados server-side) y backend/api/client_surveys.php (generar/copiar/
// revocar el link de la encuesta al cliente, mismo patrón que "Generar link"
// de Briefs en atencion-cliente.html).

const RendicionDashboard = (() => {
  let clients = [];
  let data = null;
  let operatorFilter = null; // set al hacer clic en una fila del ranking de CMs

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }
  function fmt(n) { return n === null || n === undefined ? '—' : n; }
  function money(n) { return n ? '$' + Number(n).toLocaleString('es-CO') : '$0'; }

  function healthBadge(health) {
    if (health === 'verde') return '🟢';
    if (health === 'amarillo') return '🟡';
    if (health === 'rojo') return '🔴';
    return '—';
  }

  function currentFilters() {
    return {
      quarter: document.getElementById('f-quarter').value,
      client_id: document.getElementById('f-client').value,
    };
  }

  function populateFilters() {
    const qSel = document.getElementById('f-quarter');
    qSel.innerHTML = rendicionQuarterOptions().map((o) => `<option value="${o.value}">${esc(o.label)}</option>`).join('');
    const cSel = document.getElementById('f-client');
    cSel.innerHTML = `<option value="">Todos los clientes</option>` + clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');

    const surveyClientSel = document.getElementById('survey-client');
    surveyClientSel.innerHTML = `<option value="">Selecciona un cliente…</option>` + clients.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  }

  function statCard(label, value, sub) {
    return `<div class="bg-slate-900 border border-slate-700 rounded-xl p-4">
      <p class="text-xs text-slate-500 mb-1">${esc(label)}</p>
      <p class="text-2xl font-black text-slate-100">${value}</p>
      ${sub ? `<p class="text-xs text-slate-500 mt-1">${sub}</p>` : ''}
    </div>`;
  }

  function renderSummary() {
    const s = data.summary;
    document.getElementById('dash-management').innerHTML = [
      statCard('Cuentas evaluadas', fmt(s.total_accounts), `${fmt(s.total_cms)} CM(s)`),
      statCard('Reuniones totales', fmt(s.meetings_total)),
      statCard('Seguimientos', fmt(s.followups_total)),
      statCard('Proactividad promedio', s.avg_proactivity_self ? `${s.avg_proactivity_self}/5` : '—'),
    ].join('');

    document.getElementById('dash-production').innerHTML = [
      statCard('Jornadas de creación', fmt(s.creation_sessions)),
      statCard('Piezas generadas', fmt(s.pieces_generated)),
      statCard('Tasa de aprobación', s.approval_rate !== null ? `${s.approval_rate}%` : '—', `${fmt(s.pieces_rework)} con retrabajo`),
      statCard('Incidencias', fmt(s.incidents_count)),
    ].join('');

    const stages = data.commercial.opportunities_by_stage;
    const stageLabels = { detectada: 'Detectadas', reportada: 'Reportadas', presentada: 'Presentadas', cotizada: 'Cotizadas', en_negociacion: 'En negociación', aprobada: 'Aprobadas', vendida: 'Vendidas', perdida: 'Perdidas', pendiente: 'Pendientes' };
    document.getElementById('dash-commercial').innerHTML = [
      statCard('Oportunidades detectadas', fmt(Object.values(stages).reduce((a, b) => a + b, 0))),
      statCard('Vendidas', fmt(stages.vendida || 0), money(data.commercial.sold_value_sum)),
      statCard('Valor potencial total', money(data.commercial.potential_value_sum)),
    ].join('') + `<div class="col-span-full flex flex-wrap gap-2 mt-1">${Object.keys(stageLabels).map((k) => `<span class="text-xs bg-slate-800 border border-slate-700 rounded-full px-3 py-1">${stageLabels[k]}: <b>${stages[k] || 0}</b></span>`).join('')}</div>`;

    document.getElementById('dash-client').innerHTML = [
      statCard('Satisfacción promedio', data.client_satisfaction.avg_overall ? `${data.client_satisfaction.avg_overall}/5` : '—'),
      statCard('Encuestas respondidas', fmt(data.client_satisfaction.surveys_filled)),
      statCard('Encuestas pendientes', fmt(data.client_satisfaction.surveys_pending)),
    ].join('');

    document.getElementById('dash-risk').innerHTML = [
      statCard('🟢 Saludables', fmt(data.risk.verde || 0)),
      statCard('🟡 Requieren atención', fmt(data.risk.amarillo || 0)),
      statCard('🔴 En riesgo', fmt(data.risk.rojo || 0)),
      statCard('Cuentas con riesgo reportado', fmt(data.risk.with_risk_count)),
    ].join('');

    document.getElementById('dash-improvement').innerHTML = statCard('Mejoras registradas este periodo', fmt(data.improvement.total_improvements_logged));
  }

  function renderRanking() {
    const wrap = document.getElementById('cm-ranking-wrap');
    if (!data.cm_ranking.length) {
      wrap.innerHTML = `<p class="text-slate-500 text-sm p-4">Sin rendiciones enviadas todavía para este filtro.</p>`;
      return;
    }
    const rows = data.cm_ranking.map((cm) => `
      <tr class="border-t border-slate-800 hover:bg-slate-800/30 cursor-pointer ${operatorFilter === cm.operator_id ? 'bg-slate-800/50' : ''}" data-cm-row="${cm.operator_id}">
        <td class="px-4 py-3 font-semibold">${esc(cm.operator_name)}</td>
        <td class="px-4 py-3 text-slate-400">${cm.accounts_count}</td>
        <td class="px-4 py-3 font-bold">${cm.avg_score}</td>
        <td class="px-4 py-3">${healthBadge(cm.semaforo)}</td>
      </tr>`).join('');
    wrap.innerHTML = `<table class="w-full text-sm">
      <thead><tr class="text-left text-xs text-slate-500 uppercase">
        <th class="px-4 py-2">Community Manager</th><th class="px-4 py-2">Cuentas</th><th class="px-4 py-2">Score</th><th class="px-4 py-2">Semáforo</th>
      </tr></thead><tbody>${rows}</tbody></table>
      <p class="text-xs text-slate-500 px-4 py-2">Haz clic en un CM para filtrar sus cuentas abajo.</p>`;
    wrap.querySelectorAll('[data-cm-row]').forEach((tr) => {
      tr.addEventListener('click', () => {
        const id = Number(tr.dataset.cmRow);
        operatorFilter = operatorFilter === id ? null : id;
        renderRanking();
        renderAccounts();
      });
    });
  }

  function renderAccounts() {
    const wrap = document.getElementById('accounts-wrap');
    const accounts = operatorFilter ? data.accounts.filter((a) => a.operator_id === operatorFilter) : data.accounts;
    if (!accounts.length) {
      wrap.innerHTML = `<p class="text-slate-500 text-sm p-4">Sin cuentas para este filtro.</p>`;
      return;
    }
    const rows = accounts.map((a) => `
      <tr class="border-t border-slate-800 hover:bg-slate-800/30 cursor-pointer" data-open-form="${a.form_id}">
        <td class="px-4 py-3 font-semibold">${esc(a.client_name)}</td>
        <td class="px-4 py-3 text-slate-400">${esc(a.operator_name)}</td>
        <td class="px-4 py-3 text-slate-400">${esc(a.quarter)}</td>
        <td class="px-4 py-3 font-bold">${a.score}</td>
        <td class="px-4 py-3">${healthBadge(a.score_health)}</td>
        <td class="px-4 py-3">${a.has_risk ? '<span class="text-red-400 text-xs font-semibold">⚠ riesgo</span>' : '<span class="text-slate-600 text-xs">—</span>'}</td>
        <td class="px-4 py-3">${a.survey_filled ? '<span class="text-emerald-400 text-xs">✓ encuesta</span>' : '<span class="text-slate-600 text-xs">sin encuesta</span>'}</td>
      </tr>`).join('');
    wrap.innerHTML = `<table class="w-full text-sm">
      <thead><tr class="text-left text-xs text-slate-500 uppercase">
        <th class="px-4 py-2">Cliente</th><th class="px-4 py-2">CM</th><th class="px-4 py-2">Trimestre</th>
        <th class="px-4 py-2">Score</th><th class="px-4 py-2">Salud</th><th class="px-4 py-2">Riesgo</th><th class="px-4 py-2">Cliente respondió</th>
      </tr></thead><tbody>${rows}</tbody></table>`;
    wrap.querySelectorAll('[data-open-form]').forEach((tr) => {
      tr.addEventListener('click', () => { window.location.href = `rendicion.html?form=${tr.dataset.openForm}`; });
    });
  }

  async function refresh() {
    operatorFilter = null;
    const filters = currentFilters();
    const params = new URLSearchParams();
    if (filters.quarter) params.set('quarter', filters.quarter);
    if (filters.client_id) params.set('client_id', filters.client_id);
    data = await Session.apiFetch(`api/rendicion_dashboard.php?${params.toString()}`);
    renderSummary();
    renderRanking();
    renderAccounts();
  }

  // ---- Panel de encuesta al cliente ---------------------------------------

  function surveyLinkUrl(token) {
    const base = location.origin + location.pathname.replace(/[^/]*$/, '');
    return `${base}encuesta-publica.html?t=${token}`;
  }

  function renderSurveyBox(survey) {
    const box = document.getElementById('survey-box');
    if (survey && survey.status === 'filled') {
      box.innerHTML = `<p class="text-sm text-emerald-400">✓ Respondida por ${esc(survey.filled_by_name)} el ${new Date(survey.filled_at).toLocaleDateString('es-CO')}</p>
        <p class="text-sm text-slate-400 mt-1">Calificación general: ${survey.rating_overall}/5 · NPS: ${survey.nps}/10</p>`;
      return;
    }
    const btns = [];
    if (survey && survey.link_generated) {
      btns.push(`<span class="text-amber-400 font-semibold text-sm">🔗 Link enviado — pendiente de respuesta</span>`);
      btns.push(`<button id="survey-regenerate-btn" class="bg-slate-800 hover:bg-slate-700 border border-slate-600 text-slate-200 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">Regenerar</button>`);
      btns.push(`<button id="survey-revoke-btn" class="bg-slate-800 hover:bg-red-900/40 border border-red-700/50 text-red-400 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors">Revocar</button>`);
    } else {
      btns.push(`<button id="survey-generate-btn" class="bg-indigo-600 hover:bg-indigo-500 text-white font-semibold px-4 py-2 rounded-lg text-sm transition-colors">Generar link de encuesta</button>`);
    }
    box.innerHTML = `<div class="flex flex-wrap items-center gap-2">${btns.join('')}</div>`;
    document.getElementById('survey-generate-btn')?.addEventListener('click', generateSurveyLink);
    document.getElementById('survey-regenerate-btn')?.addEventListener('click', generateSurveyLink);
    document.getElementById('survey-revoke-btn')?.addEventListener('click', revokeSurveyLink);
  }

  async function loadSurveyBox() {
    const clientId = document.getElementById('survey-client').value;
    const quarter = document.getElementById('survey-quarter').value;
    if (!clientId || !quarter) {
      document.getElementById('survey-box').innerHTML = `<p class="text-xs text-slate-500">Selecciona cliente y trimestre.</p>`;
      return;
    }
    const data = await Session.apiFetch(`api/client_surveys.php?client_id=${clientId}&quarter=${quarter}`);
    renderSurveyBox(data.survey);
  }

  async function generateSurveyLink() {
    const clientId = document.getElementById('survey-client').value;
    const quarter = document.getElementById('survey-quarter').value;
    try {
      const res = await Session.apiFetch('api/client_surveys.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId, quarter, action: 'generate_link' }),
      });
      const url = surveyLinkUrl(res.token);
      await loadSurveyBox();
      try {
        await navigator.clipboard.writeText(url);
        Utils.showToast('Link generado y copiado ✓', 'success');
      } catch (_) {
        Utils.showToast(`Link generado: ${url}`, 'warning');
      }
    } catch (err) {
      Utils.showToast(err.message, 'error');
    }
  }

  async function revokeSurveyLink() {
    const clientId = document.getElementById('survey-client').value;
    const quarter = document.getElementById('survey-quarter').value;
    try {
      await Session.apiFetch('api/client_surveys.php', {
        method: 'POST',
        body: JSON.stringify({ client_id: clientId, quarter, action: 'revoke_link' }),
      });
      Utils.showToast('Link revocado', 'success');
      loadSurveyBox();
    } catch (err) {
      Utils.showToast(err.message, 'error');
    }
  }

  async function init() {
    const clientsData = await Session.apiFetch('api/clients.php');
    clients = (clientsData.clients || []).filter((c) => c.status === 'active');
    populateFilters();

    document.getElementById('f-quarter').addEventListener('change', refresh);
    document.getElementById('f-client').addEventListener('change', refresh);
    document.getElementById('survey-client').addEventListener('change', loadSurveyBox);
    document.getElementById('survey-quarter').innerHTML = document.getElementById('f-quarter').innerHTML;
    document.getElementById('survey-quarter').addEventListener('change', loadSurveyBox);

    await refresh();
  }

  return { init };
})();

window.RendicionDashboard = RendicionDashboard;
