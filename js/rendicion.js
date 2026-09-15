// Módulo "Rendición Trimestral" (Formulario 1 del MD) — wizard corto que
// diligencia el CM por cada cliente/trimestre, más la lista de sus propias
// rendiciones (o todas, si es superadmin/admin). Motor de campos data-driven
// igual al de brief-publico.html/briefSchemas.js, adaptado para: guardar
// borrador contra el backend (no solo localStorage, porque esto vive en el
// dashboard con sesión y puede continuarse desde otro dispositivo), rutas
// anidadas en formData (ver getPath/setPath) y el bloque repetible de
// oportunidades comerciales.

const Rendicion = (() => {
  const API = 'api/rendicion_forms.php';

  let clients = [];
  let formsList = [];
  let isAdmin = false;
  let view = 'list';

  let formId = null;
  let formOperatorId = null;
  let formStatus = 'draft';
  let formData = {};
  let currentStepIndex = 0;
  let readOnly = false;

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  }

  // Botones "chip" (radio-cards / checkbox-group / scale5) — clases Tailwind
  // planas (no una clase custom) a propósito: así el modo claro ya definido
  // en css/main.css (html.light .bg-slate-800, .border-slate-600, etc.) las
  // cubre gratis, sin tener que duplicar esas reglas para un nombre nuevo.
  function chipClass(active) {
    // Mismo par bg-indigo-600/20 + text-indigo-400 que usa el link activo del
    // sidebar (js/sidebar.js) — así el acento "seleccionado" es consistente
    // en toda la app, incluido el tema claro (que no redefine estos tonos).
    return active
      ? 'border rounded-lg px-3 py-2.5 text-sm font-semibold transition-colors border-indigo-500 bg-indigo-600/20 text-indigo-400'
      : 'border rounded-lg px-3 py-2.5 text-sm font-medium transition-colors border-slate-600 bg-slate-800 text-slate-300 hover:bg-slate-700';
  }

  function getPath(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }
  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const nextKey = parts[i + 1];
      if (cur[key] == null || typeof cur[key] !== 'object') {
        cur[key] = /^\d+$/.test(nextKey) ? [] : {};
      }
      cur = cur[key];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // ---- Schema helpers -----------------------------------------------------

  function getSteps() {
    return RENDICION_SCHEMA.steps.filter((s) => !s.showIf || s.showIf(formData));
  }
  function visibleFields(step) {
    return (step.fields || []).filter((f) => !f.showIf || f.showIf(formData));
  }
  function isEmpty(v) {
    return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
  }

  function renderField(field) {
    const value = getPath(formData, field.key);
    const req = field.required ? '<span class="text-red-400">*</span>' : '';
    const disabled = readOnly ? 'disabled' : '';
    let control = '';

    if (field.type === 'select-clients') {
      control = `<select data-key="${field.key}" ${disabled} class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
        <option value="">Selecciona un cliente…</option>
        ${clients.map((c) => `<option value="${c.id}" ${String(value) === String(c.id) ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>`;
    } else if (field.type === 'select-quarters') {
      control = `<select data-key="${field.key}" ${disabled} class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
        <option value="">Selecciona el trimestre…</option>
        ${rendicionQuarterOptions().map((o) => `<option value="${o.value}" ${value === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>`;
    } else if (field.type === 'radio-cards') {
      control = `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2" data-key="${field.key}" data-type="radio-cards">${field.options.map((o) => `
        <button type="button" ${disabled} class="${chipClass(value === o.value)}" data-value="${esc(o.value)}">
          ${esc(o.label)}
        </button>`).join('')}</div>`;
    } else if (field.type === 'checkbox-group') {
      const arr = Array.isArray(value) ? value : [];
      control = `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2" data-key="${field.key}" data-type="checkbox-group">${field.options.map((o) => `
        <button type="button" ${disabled} class="${chipClass(arr.includes(o.value))}" data-value="${esc(o.value)}">
          ${esc(o.label)}
        </button>`).join('')}</div>`;
    } else if (field.type === 'scale5') {
      control = `<div class="flex gap-2" data-key="${field.key}" data-type="scale5">${[1, 2, 3, 4, 5].map((n) => `
        <button type="button" ${disabled} class="${chipClass(Number(value) === n)} w-12 h-11 flex items-center justify-center" data-value="${n}">${n}</button>`).join('')}
        <span class="text-xs text-slate-500 self-center ml-2">1 = poco proactiva · 5 = muy proactiva</span>
      </div>`;
    } else if (field.type === 'number') {
      control = `<input type="number" min="0" data-key="${field.key}" ${disabled} value="${value ?? ''}" placeholder="${esc(field.placeholder || '0')}" class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">`;
    } else if (field.type === 'textarea') {
      const maxAttr = field.maxlength ? `maxlength="${field.maxlength}"` : '';
      control = `<textarea data-key="${field.key}" ${disabled} rows="3" ${maxAttr} placeholder="${esc(field.placeholder || '')}" class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500 resize-vertical">${esc(value || '')}</textarea>
        ${field.maxlength ? `<p class="text-xs text-slate-500 mt-1 text-right" data-counter="${field.key}">${(value || '').length}/${field.maxlength}</p>` : ''}`;
    } else {
      control = `<input type="text" data-key="${field.key}" ${disabled} value="${esc(value || '')}" placeholder="${esc(field.placeholder || '')}" class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">`;
    }

    return `<div class="mb-5" data-field-wrap="${field.key}">
      <label class="block text-sm font-semibold text-slate-200 mb-1.5">${esc(field.label)} ${req}</label>
      ${control}
      <p class="rendicion-error hidden text-xs text-red-400 mt-1">Este campo es obligatorio</p>
    </div>`;
  }

  function markFieldError(key, hasError) {
    const wrap = document.querySelector(`[data-field-wrap="${CSS.escape(key)}"]`);
    if (!wrap) return;
    const err = wrap.querySelector('.rendicion-error');
    if (err) err.classList.toggle('hidden', !hasError);
    wrap.querySelectorAll('input, textarea, select, button[data-value]').forEach((el) => el.classList.toggle('border-red-500', hasError));
  }

  // ---- Bloque repetible de oportunidades ----------------------------------

  function emptyOpportunity() { return { needs: [], services: [], stage: 'detectada', estimated_value: '' }; }

  function renderOpportunities() {
    const opps = Array.isArray(formData.opportunities) ? formData.opportunities : [];
    const disabled = readOnly ? 'disabled' : '';
    return `<div id="rendicion-opportunities">
      ${opps.map((opp, i) => `
        <div class="border border-slate-700 rounded-xl p-4 mb-3" data-opp-index="${i}">
          <div class="flex items-center justify-between mb-3">
            <p class="text-sm font-bold text-indigo-300">Oportunidad ${i + 1}</p>
            ${readOnly ? '' : `<button type="button" data-remove-opp="${i}" class="text-xs text-red-400 hover:text-red-300">✕ Quitar</button>`}
          </div>
          <label class="block text-xs font-semibold text-slate-400 mb-1.5">Servicios potenciales</label>
          <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3" data-opp-field="services" data-opp-index="${i}">
            ${RENDICION_SERVICES_OPTIONS.map((o) => `<button type="button" ${disabled} class="${chipClass((opp.services || []).includes(o.value))} text-xs" data-value="${esc(o.value)}">${esc(o.label)}</button>`).join('')}
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-semibold text-slate-400 mb-1.5">Estado</label>
              <select ${disabled} data-opp-field="stage" data-opp-index="${i}" class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
                ${RENDICION_STAGE_OPTIONS.map((o) => `<option value="${o.value}" ${opp.stage === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
              </select>
            </div>
            <div>
              <label class="block text-xs font-semibold text-slate-400 mb-1.5">Valor comercial estimado (opcional)</label>
              <input type="number" min="0" ${disabled} data-opp-field="estimated_value" data-opp-index="${i}" value="${opp.estimated_value ?? ''}" class="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-100 focus:outline-none focus:border-indigo-500">
            </div>
          </div>
        </div>`).join('')}
      ${readOnly ? '' : `<button type="button" id="rendicion-add-opp" class="text-sm font-semibold text-indigo-400 hover:text-indigo-300">+ Agregar otra oportunidad</button>`}
    </div>`;
  }

  // ---- Paso "Revisión" -----------------------------------------------------

  function renderReview() {
    const client = clients.find((c) => String(c.id) === String(formData.client_id));
    const opps = Array.isArray(formData.opportunities) ? formData.opportunities.length : 0;
    return `<div class="space-y-2 text-sm">
      <p><span class="text-slate-500">Cliente:</span> <span class="font-semibold">${esc(client ? client.name : '—')}</span></p>
      <p><span class="text-slate-500">Trimestre:</span> <span class="font-semibold">${esc(formData.quarter || '—')}</span></p>
      <p><span class="text-slate-500">Nivel de actividad:</span> <span class="font-semibold">${esc(formData.activity_level || '—')}</span></p>
      <p><span class="text-slate-500">Reuniones totales:</span> <span class="font-semibold">${formData.meetings_total ?? '—'}</span></p>
      <p><span class="text-slate-500">Piezas generadas:</span> <span class="font-semibold">${formData.pieces_generated ?? '—'}</span></p>
      <p><span class="text-slate-500">Oportunidades comerciales reportadas:</span> <span class="font-semibold">${opps}</span></p>
      <p><span class="text-slate-500">Salud de la cuenta:</span> <span class="font-semibold">${formData.account_health || '—'}</span></p>
      <p class="text-slate-500 pt-2">Revisa que todo esté correcto y presiona "Enviar rendición ✓". Una vez enviada, un administrador debe reabrirla para poder editarla.</p>
    </div>`;
  }

  // ---- Render de paso -------------------------------------------------------

  function renderCurrentStepFields() {
    const step = getSteps()[currentStepIndex];
    const container = document.getElementById('rendicion-step-fields');
    if (step.review) {
      container.innerHTML = renderReview();
      return;
    }
    let html = visibleFields(step).map(renderField).join('');
    if (step.opportunitiesBlock && step.opportunitiesBlock.showIf(formData)) {
      html += `<div class="mt-2"><label class="block text-sm font-semibold text-slate-200 mb-2">Oportunidades reportadas</label>${renderOpportunities()}</div>`;
    }
    container.innerHTML = html;
  }

  function renderStep() {
    const steps = getSteps();
    if (currentStepIndex >= steps.length) currentStepIndex = steps.length - 1;
    if (currentStepIndex < 0) currentStepIndex = 0;
    const step = steps[currentStepIndex];
    const isLast = currentStepIndex === steps.length - 1;

    document.getElementById('rendicion-progress-label').textContent = `Paso ${currentStepIndex + 1} de ${steps.length}`;
    document.getElementById('rendicion-progress-bar').style.width = `${((currentStepIndex + 1) / steps.length) * 100}%`;
    document.getElementById('rendicion-step-title').textContent = step.title;
    document.getElementById('rendicion-form-error').style.display = 'none';
    renderCurrentStepFields();

    document.getElementById('rendicion-back-btn').style.visibility = currentStepIndex === 0 ? 'hidden' : 'visible';
    const nextBtn = document.getElementById('rendicion-next-btn');
    if (readOnly) {
      nextBtn.textContent = isLast ? 'Cerrar' : 'Siguiente →';
    } else {
      nextBtn.textContent = isLast ? 'Enviar rendición ✓' : 'Siguiente →';
    }
    nextBtn.disabled = false;
    document.getElementById('rendicion-reopen-btn').style.display = (readOnly && isAdmin && formStatus === 'submitted') ? '' : 'none';
    window.scrollTo(0, 0);
  }

  function validateStep(step) {
    if (step.review) return true;
    let valid = true;
    visibleFields(step).forEach((f) => {
      const hasError = !!f.required && isEmpty(getPath(formData, f.key));
      markFieldError(f.key, hasError);
      if (hasError) valid = false;
    });
    if (step.opportunitiesBlock && step.opportunitiesBlock.showIf(formData)) {
      const opps = Array.isArray(formData.opportunities) ? formData.opportunities : [];
      if (!opps.length || opps.some((o) => !o.services || !o.services.length)) {
        flashFormMessage('Agrega al menos una oportunidad con sus servicios potenciales, o marca que no detectaste ninguna.');
        valid = false;
      }
    }
    return valid;
  }

  function flashFormMessage(msg) {
    const el = document.getElementById('rendicion-form-error');
    el.textContent = msg;
    el.style.display = '';
    clearTimeout(flashFormMessage._t);
    flashFormMessage._t = setTimeout(() => { el.style.display = 'none'; }, 4500);
  }

  // ---- Eventos del contenedor de campos ------------------------------------

  function bindStepFieldsContainer() {
    const container = document.getElementById('rendicion-step-fields');

    container.addEventListener('input', (e) => {
      const key = e.target.dataset.key;
      if (key) {
        const field = findFieldDef(key);
        setPath(formData, key, e.target.value);
        markFieldError(key, false);
        if (field && field.maxlength) {
          const counter = container.querySelector(`[data-counter="${CSS.escape(key)}"]`);
          if (counter) counter.textContent = `${e.target.value.length}/${field.maxlength}`;
        }
        return;
      }
      const oppField = e.target.dataset.oppField;
      if (oppField) {
        const idx = Number(e.target.dataset.oppIndex);
        formData.opportunities[idx][oppField] = e.target.value;
      }
    });

    container.addEventListener('change', (e) => {
      const oppField = e.target.dataset.oppField;
      if (oppField === 'stage') {
        const idx = Number(e.target.dataset.oppIndex);
        formData.opportunities[idx].stage = e.target.value;
      }
    });

    container.addEventListener('click', (e) => {
      const addOpp = e.target.closest('#rendicion-add-opp');
      if (addOpp) {
        formData.opportunities = formData.opportunities || [];
        formData.opportunities.push(emptyOpportunity());
        renderCurrentStepFields();
        return;
      }
      const removeOpp = e.target.closest('[data-remove-opp]');
      if (removeOpp) {
        const idx = Number(removeOpp.dataset.removeOpp);
        formData.opportunities.splice(idx, 1);
        renderCurrentStepFields();
        return;
      }

      const oppChip = e.target.closest('button[data-value]');
      if (oppChip && oppChip.closest('[data-opp-field="services"]')) {
        const wrap = oppChip.closest('[data-opp-field="services"]');
        const idx = Number(wrap.dataset.oppIndex);
        const arr = formData.opportunities[idx].services || [];
        const i = arr.indexOf(oppChip.dataset.value);
        if (i >= 0) arr.splice(i, 1); else arr.push(oppChip.dataset.value);
        formData.opportunities[idx].services = arr;
        renderCurrentStepFields();
        return;
      }

      const card = e.target.closest('button[data-value]');
      if (!card) return;
      const wrap = card.closest('[data-type]');
      if (!wrap) return;
      const key = wrap.dataset.key;
      const type = wrap.dataset.type;
      if (type === 'radio-cards') {
        setPath(formData, key, card.dataset.value);
      } else if (type === 'scale5') {
        setPath(formData, key, Number(card.dataset.value));
      } else if (type === 'checkbox-group') {
        const arr = Array.isArray(getPath(formData, key)) ? getPath(formData, key).slice() : [];
        const i = arr.indexOf(card.dataset.value);
        if (i >= 0) arr.splice(i, 1); else arr.push(card.dataset.value);
        setPath(formData, key, arr);
      } else {
        return;
      }
      markFieldError(key, false);
      renderCurrentStepFields();
    });
  }

  function findFieldDef(key) {
    for (const step of RENDICION_SCHEMA.steps) {
      const f = (step.fields || []).find((x) => x.key === key);
      if (f) return f;
    }
    return null;
  }

  // ---- Payload / guardado ---------------------------------------------------

  const ANSWER_KEYS = ['calendar_status', 'calendar_approved', 'changes_requested_count', 'unproduced_content',
    'unproduced_reason', 'needs', 'opportunities_detected', 'fidelizacion_actions', 'fidelizacion_detail',
    'error_types', 'error_detail', 'improvements', 'client_knowledge', 'risk_types', 'risk_detail', 'value_generated'];

  // A diferencia de "|| ''", conserva un 0 real puesto por el usuario (o
  // recargado desde un borrador) — "0 || ''" en JS da '' porque 0 es falsy,
  // lo que borraría de golpe una respuesta legítima de "0 reuniones".
  function numVal(v) {
    return (v === undefined || v === null || v === '') ? '' : v;
  }

  function buildPayload(submit) {
    const answers = {};
    ANSWER_KEYS.forEach((k) => { if (formData[k] !== undefined) answers[k] = formData[k]; });
    return {
      id: formId || undefined,
      client_id: Number(formData.client_id) || 0,
      quarter: formData.quarter || '',
      activity_level: formData.activity_level || '',
      contracted_services: formData.contracted_services || [],
      meetings_total: numVal(formData.meetings_total),
      meetings_planning: numVal(formData.meetings_planning),
      meetings_client_requested: numVal(formData.meetings_client_requested),
      meetings_cm_initiated: numVal(formData.meetings_cm_initiated),
      followups_count: numVal(formData.followups_count),
      avg_response_time: formData.avg_response_time || '',
      proactivity_self_score: numVal(formData.proactivity_self_score),
      pieces_generated: numVal(formData.pieces_generated),
      pieces_delivered: numVal(formData.pieces_delivered),
      pieces_approved: numVal(formData.pieces_approved),
      pieces_rework: numVal(formData.pieces_rework),
      creation_sessions: numVal(formData.creation_sessions),
      client_visits: numVal(formData.client_visits),
      incidents_count: numVal(formData.incidents_count) === '' ? 0 : formData.incidents_count,
      account_health: formData.account_health || '',
      has_risk: formData.has_risk === '1',
      opportunities_detected: formData.opportunities_detected === 'si',
      opportunities: formData.opportunities_detected === 'si' ? (formData.opportunities || []) : [],
      answers,
      submit: !!submit,
    };
  }

  async function persist(submit) {
    const payload = buildPayload(submit);
    const data = await Session.apiFetch(API, { method: 'POST', body: JSON.stringify(payload) });
    formId = data.id;
    formStatus = data.status;
    return data;
  }

  // Si es una rendición nueva (formId aún null) y ya existe un registro para
  // ese mismo cliente+trimestre (propio, o del mismo operador si es admin),
  // lo abre en vez de seguir — evita que un guardado con formData en blanco
  // pise por accidente (vía el UNIQUE KEY del backend) un borrador en curso.
  function findDuplicateDraft() {
    return formsList.find((f) => String(f.client_id) === String(formData.client_id) && f.quarter === formData.quarter
      && (!isAdmin || Number(f.operator_id) === Number(Session.user.id)));
  }

  async function goNext() {
    const steps = getSteps();
    const step = steps[currentStepIndex];
    if (readOnly) {
      const isLast = currentStepIndex === steps.length - 1;
      if (isLast) { Rendicion.showList(); return; }
      currentStepIndex++;
      renderStep();
      return;
    }
    if (!validateStep(step)) return;
    if (!formId && currentStepIndex === 0) {
      const dup = findDuplicateDraft();
      if (dup) {
        Utils.showToast('Ya existía una rendición para ese cliente y trimestre — la abrimos para continuar', 'warning');
        openForm({ id: dup.id });
        return;
      }
    }
    const isLast = currentStepIndex === steps.length - 1;
    const btn = document.getElementById('rendicion-next-btn');
    btn.disabled = true;
    btn.textContent = isLast ? 'Enviando…' : 'Guardando…';
    try {
      await persist(isLast);
      if (isLast) {
        Utils.showToast('Rendición enviada ✓', 'success');
        Rendicion.showList();
        return;
      }
      currentStepIndex++;
      renderStep();
    } catch (err) {
      flashFormMessage(err.message);
      btn.disabled = false;
      btn.textContent = isLast ? 'Enviar rendición ✓' : 'Siguiente →';
    }
  }

  async function goBack() {
    if (currentStepIndex === 0) return;
    currentStepIndex--;
    if (!readOnly) {
      try { await persist(false); } catch (_) { /* no bloquear la navegación por un guardado fallido */ }
    }
    renderStep();
  }

  async function reopenCurrent() {
    if (!formId) return;
    try {
      await Session.apiFetch(API, { method: 'POST', body: JSON.stringify({ action: 'reopen', id: formId }) });
      Utils.showToast('Formulario reabierto — ya se puede editar', 'success');
      openForm({ id: formId });
    } catch (err) {
      Utils.showToast(err.message, 'error');
    }
  }

  // ---- Lista de rendiciones ---------------------------------------------

  function healthBadge(health) {
    if (health === 'verde') return '<span class="text-emerald-400">🟢</span>';
    if (health === 'amarillo') return '<span class="text-amber-400">🟡</span>';
    if (health === 'rojo') return '<span class="text-red-400">🔴</span>';
    return '<span class="text-slate-600">—</span>';
  }

  async function loadFormsList() {
    const data = await Session.apiFetch(`${API}?ts=${Date.now()}`);
    formsList = data.forms || [];
  }

  function renderList() {
    const wrap = document.getElementById('rendicion-list-wrap');
    if (!formsList.length) {
      wrap.innerHTML = `<p class="text-slate-500 text-sm p-6 text-center">Todavía no hay rendiciones registradas. Crea la primera con el botón de arriba.</p>`;
      return;
    }
    const rows = formsList.map((f) => `
      <tr class="border-t border-slate-800 hover:bg-slate-800/30 cursor-pointer" data-open-form="${f.id}">
        <td class="px-4 py-3 font-semibold">${esc(f.client_name)}</td>
        ${isAdmin ? `<td class="px-4 py-3 text-slate-400">${esc(f.operator_name)}</td>` : ''}
        <td class="px-4 py-3 text-slate-400">${esc(f.quarter)}</td>
        <td class="px-4 py-3">${f.status === 'submitted' ? '<span class="text-emerald-400 font-semibold">Enviada</span>' : '<span class="text-amber-400 font-semibold">Borrador</span>'}</td>
        <td class="px-4 py-3">${healthBadge(f.account_health)} ${f.has_risk ? '<span class="text-xs text-red-400 ml-1">⚠ riesgo</span>' : ''}</td>
        <td class="px-4 py-3 text-right text-indigo-400 font-semibold">${f.status === 'submitted' ? 'Ver →' : 'Continuar →'}</td>
      </tr>`).join('');
    wrap.innerHTML = `<table class="w-full text-sm">
      <thead><tr class="text-left text-xs text-slate-500 uppercase">
        <th class="px-4 py-2">Cliente</th>
        ${isAdmin ? '<th class="px-4 py-2">CM</th>' : ''}
        <th class="px-4 py-2">Trimestre</th>
        <th class="px-4 py-2">Estado</th>
        <th class="px-4 py-2">Salud</th>
        <th class="px-4 py-2"></th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
    wrap.querySelectorAll('[data-open-form]').forEach((tr) => {
      tr.addEventListener('click', () => openForm({ id: Number(tr.dataset.openForm) }));
    });
  }

  // ---- Cambio de vista ------------------------------------------------------

  function showList() {
    view = 'list';
    document.getElementById('rendicion-list-view').style.display = '';
    document.getElementById('rendicion-wizard-view').style.display = 'none';
    loadFormsList().then(renderList).catch((err) => Utils.showToast(err.message, 'error'));
  }

  async function openForm(existing) {
    view = 'wizard';
    document.getElementById('rendicion-list-view').style.display = 'none';
    document.getElementById('rendicion-wizard-view').style.display = '';
    currentStepIndex = 0;

    if (existing && existing.id) {
      const data = await Session.apiFetch(`${API}?detail=1&id=${existing.id}`);
      const f = data.form;
      formId = f.id;
      formOperatorId = f.operator_id;
      formStatus = f.status;
      formData = Object.assign({
        client_id: f.client_id, quarter: f.quarter, activity_level: f.activity_level || '',
        contracted_services: f.contracted_services || [],
        meetings_total: f.meetings_total, meetings_planning: f.meetings_planning,
        meetings_client_requested: f.meetings_client_requested, meetings_cm_initiated: f.meetings_cm_initiated,
        followups_count: f.followups_count, avg_response_time: f.avg_response_time || '',
        proactivity_self_score: f.proactivity_self_score,
        pieces_generated: f.pieces_generated, pieces_delivered: f.pieces_delivered,
        pieces_approved: f.pieces_approved, pieces_rework: f.pieces_rework,
        creation_sessions: f.creation_sessions, client_visits: f.client_visits,
        incidents_count: f.incidents_count, account_health: f.account_health || '',
        has_risk: f.has_risk ? '1' : '0',
        opportunities: (f.opportunities || []).map((o) => ({ needs: o.needs || [], services: o.services || [], stage: o.stage, estimated_value: o.estimated_value ?? '' })),
      }, f.answers || {});
      // Toda rendición enviada abre de solo lectura, incluso para admin — la
      // única forma de editarla es el botón "Reabrir" (reopenCurrent), que
      // la vuelve a status=draft en el backend antes de permitir guardar.
      readOnly = formStatus === 'submitted';
    } else {
      formId = null;
      formOperatorId = null;
      formStatus = 'draft';
      formData = { opportunities: [] };
      readOnly = false;
    }

    renderStep();
  }

  // ---- Init -------------------------------------------------------------

  async function init() {
    isAdmin = ['superadmin', 'admin'].includes(Session.user.role);
    const clientsData = await Session.apiFetch('api/clients.php');
    clients = (clientsData.clients || []).filter((c) => c.status === 'active');

    document.getElementById('rendicion-new-btn').addEventListener('click', () => openForm(null));
    document.getElementById('rendicion-back-to-list').addEventListener('click', showList);
    bindStepFieldsContainer();
    document.getElementById('rendicion-back-btn').addEventListener('click', goBack);
    document.getElementById('rendicion-next-btn').addEventListener('click', goNext);
    document.getElementById('rendicion-reopen-btn').addEventListener('click', reopenCurrent);

    // Permite abrir directo una rendición desde un link externo (ej. la
    // tabla de cuentas de rendicion-dashboard.html), sin pasar por la lista.
    const directId = Number(Utils.getQueryParam('form'));
    if (directId > 0) {
      openForm({ id: directId }).catch(() => showList());
    } else {
      showList();
    }
  }

  return { init, showList };
})();

window.Rendicion = Rendicion;
