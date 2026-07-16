// Envuelve Drawflow (js/vendor/drawflow.min.js) para el constructor visual de flujos.
// El grafo se guarda en dos formas dentro de graph_json: `drawflow` (el export nativo,
// usado para recargar el canvas tal cual) y `nodes`/`edges` (formato plano que consume
// backend/includes/trigger_engine.php al ejecutar el flujo).
const FlowBuilder = (() => {
  let editor = null;
  let flowId = null;
  let api = null;

  const NODE_DEFS = {
    trigger_keyword:          { title: '🎯 Palabra clave',      inputs: 0, outputs: 1, defaultData: { keywords: [], platform_scope: 'both' } },
    trigger_comment:          { title: '💭 Comentario en post', inputs: 0, outputs: 1, defaultData: { keywords: [], platform_scope: 'both', public_replies: [''], ai_enabled: false, ai_max_chars: 300, ai_blocklist: [], dm_delay_minutes: 0 } },
    trigger_new_conversation: { title: '✨ Nueva conversación', inputs: 0, outputs: 1, defaultData: { platform_scope: 'both' } },
    trigger_story_reply:      { title: '📖 Respuesta a historia', inputs: 0, outputs: 1, defaultData: { keywords: [], platform_scope: 'instagram' } },
    trigger_ad_message:       { title: '📢 Anuncio "Enviar mensaje"', inputs: 0, outputs: 1, defaultData: { keywords: [], platform_scope: 'both' } },
    message:                  { title: '💬 Mensaje',            inputs: 1, outputs: 1, defaultData: { text: '' } },
    ai:                       { title: '🤖 Respuesta IA',       inputs: 1, outputs: 1, defaultData: { max_chars: 500 } },
    image:                    { title: '🖼️ Imagen',             inputs: 1, outputs: 1, defaultData: { url: '' } },
    card:                     { title: '🃏 Tarjeta CTA',        inputs: 1, outputs: 1, defaultData: { title: '', subtitle: '', image_url: '', buttons: [{ title: 'Ver más', url: '' }] } },
    carousel:                 { title: '🎠 Carrusel',           inputs: 1, outputs: 1, defaultData: { items: [{ title: '', subtitle: '', image_url: '', button_title: 'Ver más', button_url: '' }] } },
    quick_replies:            { title: '🔘 Botones',            inputs: 1, outputs: 2, defaultData: { text: '', options: ['Sí', 'No'] } },
    question:                 { title: '📝 Pregunta (lead)',    inputs: 1, outputs: 1, defaultData: { text: '', field: 'email', validate: 'email', retry_text: '' } },
    csat:                     { title: '⭐ Encuesta CSAT',       inputs: 1, outputs: 5, defaultData: { text: '¿Cómo calificarías tu experiencia?' } },
    condition:                { title: '🔀 Condición',          inputs: 1, outputs: 2, defaultData: { field: 'email', op: 'exists', value: '' } },
    hours:                    { title: '⏰ Horario',            inputs: 1, outputs: 2, defaultData: { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] } },
    ab_split:                 { title: '🎲 Test A/B',           inputs: 1, outputs: 2, defaultData: { percent_a: 50 } },
    tag:                      { title: '🏷️ Etiqueta',           inputs: 1, outputs: 1, defaultData: { tag: '' } },
    notify:                   { title: '📣 Avisar al equipo',   inputs: 1, outputs: 1, defaultData: { email: '', subject: 'Nuevo lead capturado' } },
    delay:                    { title: '⏱️ Espera',             inputs: 1, outputs: 1, defaultData: { minutes: 5 } },
    handoff:                  { title: '🙋 Pasar a humano',     inputs: 1, outputs: 0, defaultData: { text: '' } },
  };

  const CONDITION_OPS = { exists: 'tiene dato', contains: 'contiene', equals: 'es igual a' };

  function previewText(type, data) {
    if (type === 'trigger_keyword') return (data.keywords || []).join(', ') || '(sin palabras clave)';
    if (type === 'trigger_comment') return (data.keywords || []).join(', ') || 'cualquier comentario';
    if (type === 'trigger_new_conversation') return 'primer mensaje del contacto';
    if (type === 'trigger_story_reply') return (data.keywords || []).join(', ') || 'cualquier respuesta a historia';
    if (type === 'trigger_ad_message') return (data.keywords || []).join(', ') || 'cualquier campaña de mensajes';
    if (type === 'message') return (data.text || '').slice(0, 40) || '(vacío)';
    if (type === 'ai') return `máx. ${data.max_chars || 500} caracteres`;
    if (type === 'image') return (data.url || '').split('/').pop() || '(sin imagen)';
    if (type === 'card') return (data.title || '').slice(0, 30) || '(sin título)';
    if (type === 'carousel') return (data.items || []).length + ' elementos';
    if (type === 'quick_replies') return (data.text || '').slice(0, 25) + ' · ' + (data.options || []).length + ' opciones';
    if (type === 'question') return `guarda "${data.field || '?'}"`;
    if (type === 'csat') return (data.text || '').slice(0, 30) || '(vacío)';
    if (type === 'condition') return `${data.field || '?'} ${CONDITION_OPS[data.op] || data.op || ''} ${data.op === 'exists' ? '' : (data.value || '')}`.trim();
    if (type === 'hours') return `${data.start || '?'}–${data.end || '?'}`;
    if (type === 'ab_split') return `A ${data.percent_a ?? 50}% / B ${100 - (data.percent_a ?? 50)}%`;
    if (type === 'tag') return data.tag || '(sin etiqueta)';
    if (type === 'notify') return data.email || '(sin email)';
    if (type === 'delay') return `${data.minutes || 0} min`;
    if (type === 'handoff') return 'detiene el bot';
    return '';
  }

  function nodeHtml(type, data) {
    const def = NODE_DEFS[type];
    return `<div class="df-node-box"><div class="df-node-title">${def.title}</div><div class="df-node-sub" data-preview>${previewText(type, data)}</div></div>`;
  }

  function updatePreviewDom(nodeId, type, data) {
    const el = document.querySelector(`#node-${nodeId} [data-preview]`);
    if (el) el.textContent = previewText(type, data);
  }

  function setStatusText(text) {
    const el = document.getElementById('builder-status');
    if (el) el.textContent = text;
  }

  async function load(id, ctx) {
    flowId = id;
    api = ctx.api;

    const container = document.getElementById('drawflow');
    container.innerHTML = '';

    editor = new Drawflow(container);
    editor.reroute = true;
    editor.start();
    editor.on('nodeSelected', (nodeId) => renderInspector(nodeId));
    editor.on('nodeUnselected', () => renderInspector(null));
    editor.on('nodeRemoved', () => renderInspector(null));

    const data = await api(`api/flows.php?id=${id}`);
    const flow = data.flow;
    document.getElementById('builder-flow-name').value = flow.name;

    const graph = JSON.parse(flow.graph_json || '{}');
    if (graph.drawflow) {
      editor.import(graph.drawflow);
      (graph.nodes || []).forEach((n) => updatePreviewDom(n.id, n.type, n.data));
    }

    setStatusText(`v${flow.version} · ${flow.status}`);
    setupPaletteDragDrop();
    renderInspector(null);
  }

  function setupPaletteDragDrop() {
    document.querySelectorAll('.drawflow-node-drag').forEach((el) => {
      el.ondragstart = (ev) => ev.dataTransfer.setData('node', el.dataset.node);
    });
    const container = document.getElementById('drawflow');
    container.ondragover = (ev) => ev.preventDefault();
    container.ondrop = (ev) => {
      ev.preventDefault();
      const type = ev.dataTransfer.getData('node');
      if (!type || !NODE_DEFS[type]) return;
      addNode(type, ev.clientX, ev.clientY);
    };
  }

  function addNode(type, clientX, clientY) {
    const def = NODE_DEFS[type];
    const rect = editor.precanvas.getBoundingClientRect();
    const posX = (clientX - rect.x) / editor.zoom;
    const posY = (clientY - rect.y) / editor.zoom;
    const data = JSON.parse(JSON.stringify(def.defaultData));
    editor.addNode(type, def.inputs, def.outputs, posX, posY, type, data, nodeHtml(type, data));
    setStatusText('Sin guardar');
  }

  function renderInspector(nodeId) {
    const panel = document.getElementById('builder-inspector');
    if (!nodeId) {
      panel.innerHTML = `<p class="text-slate-500 text-sm">Selecciona un nodo para editarlo.</p>`;
      return;
    }

    const nodeInfo = editor.getNodeFromId(nodeId);
    const type = nodeInfo.name;
    const data = nodeInfo.data;

    if (type === 'trigger_keyword') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Disparador (palabra clave)</p>
        <label class="text-xs text-slate-500">Palabras clave (separadas por coma)</label>
        <textarea id="insp-keywords" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" rows="3">${(data.keywords || []).join(', ')}</textarea>
        <label class="text-xs text-slate-500">Plataforma</label>
        <select id="insp-scope" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1">
          <option value="both" ${data.platform_scope === 'both' ? 'selected' : ''}>Ambas</option>
          <option value="messenger" ${data.platform_scope === 'messenger' ? 'selected' : ''}>Solo Messenger</option>
          <option value="instagram" ${data.platform_scope === 'instagram' ? 'selected' : ''}>Solo Instagram</option>
        </select>`;
      document.getElementById('insp-keywords').oninput = (e) => {
        data.keywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
      document.getElementById('insp-scope').onchange = (e) => {
        data.platform_scope = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'message') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Mensaje</p>
        <label class="text-xs text-slate-500">Texto a enviar</label>
        <textarea id="insp-text" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" rows="5">${data.text || ''}</textarea>`;
      document.getElementById('insp-text').oninput = (e) => {
        data.text = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'ai') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Respuesta con IA</p>
        <p class="text-xs text-slate-600 mb-3">Interpreta el mensaje libre del usuario usando el <strong>contexto de negocio</strong> configurado en la pestaña "Contexto IA" del cliente, más el historial reciente de la conversación.</p>
        <label class="text-xs text-slate-500">Máximo de caracteres de la respuesta</label>
        <input id="insp-max-chars" type="number" min="1" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" value="${data.max_chars || 500}">`;
      bindInput('insp-max-chars', (v) => { data.max_chars = parseInt(v, 10) || 500; }, nodeId, type, data);
    } else if (type === 'delay') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Espera</p>
        <label class="text-xs text-slate-500">Minutos antes de continuar</label>
        <input id="insp-minutes" type="number" min="1" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" value="${data.minutes || 5}">
        <p class="text-xs text-slate-600 mt-2">Solo se envía si la ventana de 24h sigue abierta; si no, aparece en Conversaciones como "requiere seguimiento manual".</p>`;
      document.getElementById('insp-minutes').oninput = (e) => {
        data.minutes = parseInt(e.target.value, 10) || 1;
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'trigger_comment') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Disparador (comentario en publicación)</p>
        <label class="text-xs text-slate-500">Palabras clave del comentario (separadas por coma)</label>
        <textarea id="insp-keywords" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-1" rows="3">${(data.keywords || []).join(', ')}</textarea>
        <p class="text-xs text-slate-600 mb-3">Déjalo vacío para responder a <strong>cualquier</strong> comentario.</p>
        <label class="text-xs text-slate-500">Plataforma</label>
        ${scopeSelectHtml(data)}
        <p class="text-xs text-slate-600 mt-3">Quien comenta recibe el primer mensaje del flujo <strong>por privado</strong>. Si responde al DM, el flujo continúa con los nodos siguientes. El comentario público (si configuraste alguno abajo) siempre se manda de inmediato, con prioridad.</p>
        <label class="text-xs text-slate-500 mt-3 block">Retraso antes de enviar el DM privado</label>
        <div class="flex items-center gap-2 mt-1">
          <div class="flex-1">
            <input id="insp-dm-delay-h" type="number" min="0" max="23" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-center" value="${Math.floor((data.dm_delay_minutes || 0) / 60)}">
            <p class="text-[10px] text-slate-600 mt-0.5 text-center">horas</p>
          </div>
          <span class="text-slate-500 pb-4">:</span>
          <div class="flex-1">
            <input id="insp-dm-delay-m" type="number" min="0" max="59" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-center" value="${(data.dm_delay_minutes || 0) % 60}">
            <p class="text-[10px] text-slate-600 mt-0.5 text-center">minutos</p>
          </div>
        </div>
        <p class="text-xs text-slate-600 mt-1 mb-3">0 y 0 = inmediato. Un pequeño retraso (ej. 0 horas, 2 minutos) se siente menos robótico.</p>
        <label class="flex items-center gap-2 text-xs text-slate-400 mt-3">
          <input type="checkbox" id="insp-ai-enabled" ${data.ai_enabled ? 'checked' : ''}>
          Responder el DM privado con IA (en vez del texto fijo o el nodo conectado)
        </label>
        <div id="insp-ai-wrap" class="mt-2" style="${data.ai_enabled ? '' : 'display:none'}">
          <label class="text-xs text-slate-500">Máximo de caracteres de la respuesta privada</label>
          <input id="insp-ai-max-chars" type="number" min="1" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" value="${data.ai_max_chars || 300}">
          <label class="text-xs text-slate-500">Palabras/temas a evitar (separados por coma) — si el comentario contiene alguna, se usa el texto fijo/nodo conectado en su lugar</label>
          <textarea id="insp-ai-blocklist" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" rows="2">${(data.ai_blocklist || []).join(', ')}</textarea>
        </div>
        <label class="text-xs text-slate-500 mt-4 block">Respuestas públicas en el comentario (opcional) — se publica <strong>una al azar</strong></label>
        <div id="insp-public-replies" class="flex flex-col gap-2 mt-1 mb-2">
          ${(data.public_replies || (data.public_reply ? [data.public_reply] : [''])).map((r, i) => `
            <div class="flex gap-1">
              <textarea data-reply="${i}" rows="2" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm" placeholder="¡Gracias por comentar! Te escribimos por privado 💌">${r}</textarea>
              <button data-reply-del="${i}" class="text-red-400 hover:text-red-300 px-2 text-sm flex-shrink-0" title="Quitar variante">✕</button>
            </div>`).join('')}
        </div>
        <button id="insp-add-reply" class="text-indigo-400 hover:text-indigo-300 text-xs font-semibold">+ Agregar variante</button>
        <p class="text-xs text-slate-600 mt-2">Además de la respuesta privada, publica <strong>una de estas variantes elegida al azar</strong>, visible en el propio comentario (siempre texto fijo, nunca generado por IA, para no exponer info del negocio en público). Usar varias frases distintas ayuda a que no se vea como respuesta automática.</p>`;
      document.getElementById('insp-keywords').oninput = (e) => {
        data.keywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
      bindScopeSelect(nodeId, data);
      const updateDmDelay = () => {
        const h = Math.max(0, parseInt(document.getElementById('insp-dm-delay-h').value, 10) || 0);
        const m = Math.max(0, Math.min(59, parseInt(document.getElementById('insp-dm-delay-m').value, 10) || 0));
        data.dm_delay_minutes = h * 60 + m;
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
      document.getElementById('insp-dm-delay-h').oninput = updateDmDelay;
      document.getElementById('insp-dm-delay-m').oninput = updateDmDelay;
      if (!data.public_replies) data.public_replies = data.public_reply ? [data.public_reply] : [''];
      panel.querySelectorAll('[data-reply]').forEach((textarea) => {
        textarea.oninput = (e) => {
          data.public_replies[+e.target.dataset.reply] = e.target.value;
          editor.updateNodeDataFromId(nodeId, data);
          setStatusText('Sin guardar');
        };
      });
      panel.querySelectorAll('[data-reply-del]').forEach((btn) => {
        btn.onclick = () => {
          if (data.public_replies.length <= 1) { data.public_replies = ['']; }
          else { data.public_replies.splice(+btn.dataset.replyDel, 1); }
          editor.updateNodeDataFromId(nodeId, data);
          setStatusText('Sin guardar');
          renderInspector(nodeId);
        };
      });
      document.getElementById('insp-add-reply').onclick = () => {
        data.public_replies.push('');
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
        renderInspector(nodeId);
      };
      document.getElementById('insp-ai-enabled').onchange = (e) => {
        data.ai_enabled = e.target.checked;
        document.getElementById('insp-ai-wrap').style.display = data.ai_enabled ? '' : 'none';
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
      bindInput('insp-ai-max-chars', (v) => { data.ai_max_chars = parseInt(v, 10) || 300; }, nodeId, type, data);
      document.getElementById('insp-ai-blocklist').oninput = (e) => {
        data.ai_blocklist = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'trigger_new_conversation') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Disparador (nueva conversación)</p>
        <p class="text-xs text-slate-500 mb-3">Se activa con el <strong>primer mensaje</strong> de un contacto nuevo que no coincida con ninguna palabra clave. Ideal para mensajes de bienvenida y menús iniciales.</p>
        <label class="text-xs text-slate-500">Plataforma</label>
        ${scopeSelectHtml(data)}`;
      bindScopeSelect(nodeId, data);
    } else if (type === 'trigger_story_reply') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Disparador (respuesta a historia)</p>
        <p class="text-xs text-slate-500 mb-3">Se activa cuando alguien <strong>responde a una historia</strong> de Instagram que publicaste. Es uno de los canales de mayor interacción de la comunidad — ideal para juegos, encuestas de historia o promociones.</p>
        <label class="text-xs text-slate-500">Palabras clave (opcional, separadas por coma)</label>
        <textarea id="insp-keywords" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-1" rows="2">${(data.keywords || []).join(', ')}</textarea>
        <p class="text-xs text-slate-600">Déjalo vacío para responder a <strong>cualquier</strong> respuesta de historia.</p>`;
      document.getElementById('insp-keywords').oninput = (e) => {
        data.keywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'trigger_ad_message') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Disparador (anuncio "Enviar mensaje")</p>
        <p class="text-xs text-slate-500 mb-3">Se activa cuando alguien escribe por primera vez desde un anuncio <strong>"Enviar mensaje"</strong> (funciona igual en Messenger e Instagram — usa el selector de Plataforma de abajo para restringirlo a uno solo). Permite dar una bienvenida distinta según la campaña que lo trajo.</p>
        <label class="text-xs text-slate-500">La campaña contiene (opcional, separado por coma)</label>
        <textarea id="insp-keywords" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-1" rows="2">${(data.keywords || []).join(', ')}</textarea>
        <p class="text-xs text-slate-600 mb-3">Déjalo vacío para activar con <strong>cualquier</strong> campaña de mensajes. Compara contra el nombre real de la campaña en Meta Ads Manager (no distingue mayúsculas).</p>
        <label class="text-xs text-slate-500">Plataforma</label>
        ${scopeSelectHtml(data)}`;
      document.getElementById('insp-keywords').oninput = (e) => {
        data.keywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
      bindScopeSelect(nodeId, data);
    } else if (type === 'quick_replies') {
      const options = data.options || [];
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Botones (respuesta rápida)</p>
        <label class="text-xs text-slate-500">Texto del mensaje</label>
        <textarea id="insp-text" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" rows="3">${data.text || ''}</textarea>
        <label class="text-xs text-slate-500">Opciones (máx. 20 caracteres c/u) — cada una es una salida del nodo</label>
        <div id="insp-options" class="flex flex-col gap-2 mt-1 mb-2">
          ${options.map((opt, i) => `
            <div class="flex gap-1">
              <input data-opt="${i}" maxlength="20" class="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm" value="${String(opt).replace(/"/g, '&quot;')}">
              <button data-del="${i}" class="text-red-400 hover:text-red-300 px-2 text-sm" title="Quitar opción">✕</button>
            </div>`).join('')}
        </div>
        <button id="insp-add-opt" class="text-indigo-400 hover:text-indigo-300 text-xs font-semibold" ${options.length >= 13 ? 'disabled' : ''}>+ Agregar opción</button>
        <p class="text-xs text-slate-600 mt-3">Funciona en Messenger e Instagram. Conecta cada salida del nodo con la rama que sigue a esa opción.</p>`;

      panel.querySelectorAll('[data-opt]').forEach((input) => {
        input.oninput = (e) => {
          data.options[parseInt(e.target.dataset.opt, 10)] = e.target.value;
          editor.updateNodeDataFromId(nodeId, data);
          updatePreviewDom(nodeId, type, data);
          setStatusText('Sin guardar');
        };
      });
      panel.querySelectorAll('[data-del]').forEach((btn) => {
        btn.onclick = () => {
          if (data.options.length <= 1) { Utils.showToast('Debe quedar al menos una opción', 'warning'); return; }
          data.options.splice(parseInt(btn.dataset.del, 10), 1);
          editor.updateNodeDataFromId(nodeId, data);
          syncQuickReplyOutputs(nodeId, data);
          updatePreviewDom(nodeId, type, data);
          setStatusText('Sin guardar');
          renderInspector(nodeId);
        };
      });
      document.getElementById('insp-add-opt').onclick = () => {
        if (data.options.length >= 13) return;
        data.options.push('Opción ' + (data.options.length + 1));
        editor.updateNodeDataFromId(nodeId, data);
        syncQuickReplyOutputs(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
        renderInspector(nodeId);
      };
      document.getElementById('insp-text').oninput = (e) => {
        data.text = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'question') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Pregunta (captura de lead)</p>
        <label class="text-xs text-slate-500">Pregunta a enviar</label>
        <textarea id="insp-text" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" rows="3">${data.text || ''}</textarea>
        <label class="text-xs text-slate-500">Guardar la respuesta como</label>
        <select id="insp-field" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3">
          <option value="nombre" ${data.field === 'nombre' ? 'selected' : ''}>Nombre</option>
          <option value="email" ${data.field === 'email' ? 'selected' : ''}>Email</option>
          <option value="telefono" ${data.field === 'telefono' ? 'selected' : ''}>Teléfono</option>
          <option value="nota" ${data.field === 'nota' ? 'selected' : ''}>Nota libre</option>
        </select>
        <label class="text-xs text-slate-500">Validación</label>
        <select id="insp-validate" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3">
          <option value="none" ${data.validate === 'none' ? 'selected' : ''}>Ninguna</option>
          <option value="email" ${data.validate === 'email' ? 'selected' : ''}>Email válido</option>
          <option value="phone" ${data.validate === 'phone' ? 'selected' : ''}>Teléfono válido</option>
        </select>
        <label class="text-xs text-slate-500">Mensaje si la respuesta no es válida (opcional)</label>
        <textarea id="insp-retry" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" rows="2" placeholder="Ese dato no parece válido, inténtalo de nuevo…">${data.retry_text || ''}</textarea>
        <p class="text-xs text-slate-600 mt-3">La respuesta se guarda en la ficha del contacto y se ve en el inbox. El flujo continúa cuando la respuesta es válida.</p>`;
      document.getElementById('insp-text').oninput = (e) => {
        data.text = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
      document.getElementById('insp-field').onchange = (e) => {
        data.field = e.target.value;
        if (e.target.value === 'email') data.validate = 'email';
        if (e.target.value === 'telefono') data.validate = 'phone';
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        renderInspector(nodeId);
        setStatusText('Sin guardar');
      };
      document.getElementById('insp-validate').onchange = (e) => {
        data.validate = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
      document.getElementById('insp-retry').oninput = (e) => {
        data.retry_text = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'csat') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Encuesta de satisfacción (CSAT)</p>
        <label class="text-xs text-slate-500">Pregunta a enviar</label>
        <textarea id="insp-text" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" rows="2">${data.text || ''}</textarea>
        <p class="text-xs text-slate-600">Envía 5 caritas (😡🙁😐🙂😍) como respuesta rápida. La calificación (1-5) queda guardada en la ficha del contacto.</p>
        <p class="text-xs text-slate-600 mt-2">Cada salida del nodo es una calificación: <strong>1</strong>=😡 · <strong>2</strong>=🙁 · <strong>3</strong>=😐 · <strong>4</strong>=🙂 · <strong>5</strong>=😍. Conecta, por ejemplo, las salidas 1-2 a un nodo "Pasar a humano" (recuperar al cliente insatisfecho) y la 5 a una Tarjeta pidiendo una reseña pública.</p>`;
      document.getElementById('insp-text').oninput = (e) => {
        data.text = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'handoff') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Pasar a humano</p>
        <label class="text-xs text-slate-500">Mensaje antes de transferir (opcional)</label>
        <textarea id="insp-text" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" rows="3" placeholder="Te conectamos con un asesor…">${data.text || ''}</textarea>
        <p class="text-xs text-slate-600 mt-3">El bot se detiene en esta conversación y queda marcada como "atendida por humano" en el inbox. Responde desde ahí manualmente.</p>`;
      document.getElementById('insp-text').oninput = (e) => {
        data.text = e.target.value;
        editor.updateNodeDataFromId(nodeId, data);
        setStatusText('Sin guardar');
      };
    } else if (type === 'image') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Imagen</p>
        <label class="text-xs text-slate-500">URL pública de la imagen (jpg/png/gif)</label>
        <input id="insp-url" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" placeholder="https://…/promo.jpg" value="${(data.url || '').replace(/"/g, '&quot;')}">
        <p class="text-xs text-slate-600 mt-3">Debe ser una URL accesible públicamente (puedes subirla a tu hosting). Para agregar texto, conecta un nodo Mensaje después.</p>`;
      bindInput('insp-url', (v) => { data.url = v; }, nodeId, type, data);
    } else if (type === 'card') {
      const buttons = data.buttons || [];
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Tarjeta CTA</p>
        <label class="text-xs text-slate-500">Título (máx. 80)</label>
        <input id="insp-title" maxlength="80" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" value="${(data.title || '').replace(/"/g, '&quot;')}">
        <label class="text-xs text-slate-500">Subtítulo (opcional)</label>
        <input id="insp-subtitle" maxlength="80" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" value="${(data.subtitle || '').replace(/"/g, '&quot;')}">
        <label class="text-xs text-slate-500">URL de imagen (opcional)</label>
        <input id="insp-image" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" placeholder="https://…" value="${(data.image_url || '').replace(/"/g, '&quot;')}">
        <label class="text-xs text-slate-500">Botones de enlace (máx. 3)</label>
        <div id="insp-buttons" class="flex flex-col gap-2 mt-1 mb-2">
          ${buttons.map((b, i) => `
            <div class="bg-slate-800/60 border border-slate-700/60 rounded-lg p-2 flex flex-col gap-1">
              <div class="flex gap-1">
                <input data-btn-title="${i}" maxlength="20" placeholder="Texto del botón" class="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" value="${String(b.title || '').replace(/"/g, '&quot;')}">
                <button data-btn-del="${i}" class="text-red-400 hover:text-red-300 px-1 text-sm" title="Quitar botón">✕</button>
              </div>
              <input data-btn-url="${i}" placeholder="https://tulanding.com" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" value="${String(b.url || '').replace(/"/g, '&quot;')}">
            </div>`).join('')}
        </div>
        <button id="insp-add-btn" class="text-indigo-400 hover:text-indigo-300 text-xs font-semibold" ${buttons.length >= 3 ? 'disabled' : ''}>+ Agregar botón</button>
        <p class="text-xs text-slate-600 mt-3">El formato de conversión: lleva al usuario a tu landing, catálogo o WhatsApp (usa un enlace wa.me).</p>`;
      bindInput('insp-title', (v) => { data.title = v; }, nodeId, type, data);
      bindInput('insp-subtitle', (v) => { data.subtitle = v; }, nodeId, type, data);
      bindInput('insp-image', (v) => { data.image_url = v; }, nodeId, type, data);
      panel.querySelectorAll('[data-btn-title]').forEach((input) => {
        input.oninput = (e) => { data.buttons[+e.target.dataset.btnTitle].title = e.target.value; commit(nodeId, type, data); };
      });
      panel.querySelectorAll('[data-btn-url]').forEach((input) => {
        input.oninput = (e) => { data.buttons[+e.target.dataset.btnUrl].url = e.target.value; commit(nodeId, type, data); };
      });
      panel.querySelectorAll('[data-btn-del]').forEach((btn) => {
        btn.onclick = () => { data.buttons.splice(+btn.dataset.btnDel, 1); commit(nodeId, type, data); renderInspector(nodeId); };
      });
      document.getElementById('insp-add-btn').onclick = () => {
        if (data.buttons.length >= 3) return;
        data.buttons.push({ title: '', url: '' });
        commit(nodeId, type, data);
        renderInspector(nodeId);
      };
    } else if (type === 'carousel') {
      const items = data.items || [];
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Carrusel (máx. 10)</p>
        <div id="insp-items" class="flex flex-col gap-3 mb-2">
          ${items.map((it, i) => `
            <div class="bg-slate-800/60 border border-slate-700/60 rounded-lg p-2 flex flex-col gap-1">
              <div class="flex gap-1">
                <input data-it-title="${i}" maxlength="80" placeholder="Título" class="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" value="${String(it.title || '').replace(/"/g, '&quot;')}">
                <button data-it-del="${i}" class="text-red-400 hover:text-red-300 px-1 text-sm" title="Quitar elemento">✕</button>
              </div>
              <input data-it-subtitle="${i}" maxlength="80" placeholder="Subtítulo (opcional)" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" value="${String(it.subtitle || '').replace(/"/g, '&quot;')}">
              <input data-it-image="${i}" placeholder="URL de imagen (opcional)" class="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" value="${String(it.image_url || '').replace(/"/g, '&quot;')}">
              <div class="flex gap-1">
                <input data-it-btn-title="${i}" maxlength="20" placeholder="Texto botón" class="w-24 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" value="${String(it.button_title || '').replace(/"/g, '&quot;')}">
                <input data-it-btn-url="${i}" placeholder="https://…" class="flex-1 bg-slate-800 border border-slate-700 rounded px-2 py-1 text-xs" value="${String(it.button_url || '').replace(/"/g, '&quot;')}">
              </div>
            </div>`).join('')}
        </div>
        <button id="insp-add-item" class="text-indigo-400 hover:text-indigo-300 text-xs font-semibold" ${items.length >= 10 ? 'disabled' : ''}>+ Agregar elemento</button>
        <p class="text-xs text-slate-600 mt-3">Ideal para mostrar varios productos, posts destacados o promociones en un solo mensaje deslizable.</p>`;
      panel.querySelectorAll('[data-it-title]').forEach((input) => {
        input.oninput = (e) => { data.items[+e.target.dataset.itTitle].title = e.target.value; commit(nodeId, type, data); };
      });
      panel.querySelectorAll('[data-it-subtitle]').forEach((input) => {
        input.oninput = (e) => { data.items[+e.target.dataset.itSubtitle].subtitle = e.target.value; commit(nodeId, type, data); };
      });
      panel.querySelectorAll('[data-it-image]').forEach((input) => {
        input.oninput = (e) => { data.items[+e.target.dataset.itImage].image_url = e.target.value; commit(nodeId, type, data); };
      });
      panel.querySelectorAll('[data-it-btn-title]').forEach((input) => {
        input.oninput = (e) => { data.items[+e.target.dataset.itBtnTitle].button_title = e.target.value; commit(nodeId, type, data); };
      });
      panel.querySelectorAll('[data-it-btn-url]').forEach((input) => {
        input.oninput = (e) => { data.items[+e.target.dataset.itBtnUrl].button_url = e.target.value; commit(nodeId, type, data); };
      });
      panel.querySelectorAll('[data-it-del]').forEach((btn) => {
        btn.onclick = () => {
          if (data.items.length <= 1) { Utils.showToast('Debe quedar al menos un elemento', 'warning'); return; }
          data.items.splice(+btn.dataset.itDel, 1);
          commit(nodeId, type, data);
          renderInspector(nodeId);
        };
      });
      document.getElementById('insp-add-item').onclick = () => {
        if (data.items.length >= 10) return;
        data.items.push({ title: '', subtitle: '', image_url: '', button_title: 'Ver más', button_url: '' });
        commit(nodeId, type, data);
        renderInspector(nodeId);
      };
    } else if (type === 'condition') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Condición</p>
        <label class="text-xs text-slate-500">Dato a evaluar</label>
        <select id="insp-field" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3">
          <option value="nombre" ${data.field === 'nombre' ? 'selected' : ''}>Nombre</option>
          <option value="email" ${data.field === 'email' ? 'selected' : ''}>Email</option>
          <option value="telefono" ${data.field === 'telefono' ? 'selected' : ''}>Teléfono</option>
          <option value="nota" ${data.field === 'nota' ? 'selected' : ''}>Nota libre</option>
          <option value="etiqueta" ${data.field === 'etiqueta' ? 'selected' : ''}>Etiqueta</option>
        </select>
        <label class="text-xs text-slate-500">Operador</label>
        <select id="insp-op" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3">
          <option value="exists" ${data.op === 'exists' ? 'selected' : ''}>Tiene dato (existe)</option>
          <option value="contains" ${data.op === 'contains' ? 'selected' : ''}>Contiene</option>
          <option value="equals" ${data.op === 'equals' ? 'selected' : ''}>Es igual a</option>
        </select>
        <div id="insp-value-wrap" style="${data.op === 'exists' ? 'display:none' : ''}">
          <label class="text-xs text-slate-500">Valor a comparar</label>
          <input id="insp-value" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" value="${(data.value || '').replace(/"/g, '&quot;')}">
        </div>
        <p class="text-xs text-slate-600 mt-3">Salida <strong>1</strong> (arriba) = se cumple · Salida <strong>2</strong> (abajo) = no se cumple.</p>`;
      document.getElementById('insp-field').onchange = (e) => { data.field = e.target.value; commit(nodeId, type, data); };
      document.getElementById('insp-op').onchange = (e) => {
        data.op = e.target.value;
        document.getElementById('insp-value-wrap').style.display = data.op === 'exists' ? 'none' : '';
        commit(nodeId, type, data);
      };
      bindInput('insp-value', (v) => { data.value = v; }, nodeId, type, data);
    } else if (type === 'hours') {
      const days = (data.days || []).map(Number);
      const dayNames = { 1: 'L', 2: 'M', 3: 'X', 4: 'J', 5: 'V', 6: 'S', 7: 'D' };
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Horario de atención</p>
        <div class="flex gap-2 mb-3">
          <div class="flex-1"><label class="text-xs text-slate-500">Desde</label>
            <input id="insp-start" type="time" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm mt-1" value="${data.start || '09:00'}"></div>
          <div class="flex-1"><label class="text-xs text-slate-500">Hasta</label>
            <input id="insp-end" type="time" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-2 py-2 text-sm mt-1" value="${data.end || '18:00'}"></div>
        </div>
        <label class="text-xs text-slate-500">Días</label>
        <div class="flex gap-1 mt-1">
          ${[1, 2, 3, 4, 5, 6, 7].map((d) => `
            <button data-day="${d}" class="w-8 h-8 rounded-lg text-xs font-bold border transition-colors ${days.includes(d) ? 'bg-indigo-600 border-indigo-500 text-white' : 'bg-slate-800 border-slate-700 text-slate-500'}">${dayNames[d]}</button>`).join('')}
        </div>
        <p class="text-xs text-slate-600 mt-3">Usa la zona horaria configurada en la marca. Salida <strong>1</strong> = dentro de horario · Salida <strong>2</strong> = fuera (ideal: "te respondemos mañana" + Pasar a humano).</p>`;
      bindInput('insp-start', (v) => { data.start = v; }, nodeId, type, data);
      bindInput('insp-end', (v) => { data.end = v; }, nodeId, type, data);
      panel.querySelectorAll('[data-day]').forEach((btn) => {
        btn.onclick = () => {
          const d = +btn.dataset.day;
          data.days = days.includes(d) ? days.filter((x) => x !== d) : [...days, d].sort();
          commit(nodeId, type, data);
          renderInspector(nodeId);
        };
      });
    } else if (type === 'ab_split') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Test A/B</p>
        <label class="text-xs text-slate-500">% del tráfico hacia la variante A (salida 1)</label>
        <input id="insp-percent" type="range" min="0" max="100" step="5" class="w-full mt-2" value="${data.percent_a ?? 50}">
        <p class="text-center text-sm font-bold text-indigo-400 mt-1"><span id="insp-percent-label">${data.percent_a ?? 50}</span>% A · <span id="insp-percent-b">${100 - (data.percent_a ?? 50)}</span>% B</p>
        <p class="text-xs text-slate-600 mt-3">Reparte al azar a los usuarios entre dos versiones del mensaje para descubrir cuál convierte más. Salida <strong>1</strong> = A · Salida <strong>2</strong> = B.</p>`;
      document.getElementById('insp-percent').oninput = (e) => {
        data.percent_a = +e.target.value;
        document.getElementById('insp-percent-label').textContent = data.percent_a;
        document.getElementById('insp-percent-b').textContent = 100 - data.percent_a;
        commit(nodeId, type, data);
      };
    } else if (type === 'tag') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Etiquetar contacto</p>
        <label class="text-xs text-slate-500">Etiqueta</label>
        <input id="insp-tag" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" placeholder="lead-caliente, interesado-precios…" value="${(data.tag || '').replace(/"/g, '&quot;')}">
        <p class="text-xs text-slate-600 mt-3">Marca al contacto para segmentarlo (p.ej. por interés o campaña). Se ve como chip en el inbox y se puede usar en el nodo Condición.</p>`;
      bindInput('insp-tag', (v) => { data.tag = v; }, nodeId, type, data);
    } else if (type === 'notify') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Avisar al equipo</p>
        <label class="text-xs text-slate-500">Email del equipo/vendedor</label>
        <input id="insp-email" type="email" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1 mb-3" placeholder="ventas@marca.com" value="${(data.email || '').replace(/"/g, '&quot;')}">
        <label class="text-xs text-slate-500">Asunto del correo</label>
        <input id="insp-subject" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1" value="${(data.subject || 'Nuevo lead capturado').replace(/"/g, '&quot;')}">
        <p class="text-xs text-slate-600 mt-3">Envía un correo con los datos del lead (nombre, email, teléfono, etiquetas) en el momento en que el flujo pasa por aquí. El usuario no ve nada.</p>`;
      bindInput('insp-email', (v) => { data.email = v; }, nodeId, type, data);
      bindInput('insp-subject', (v) => { data.subject = v; }, nodeId, type, data);
    }
  }

  // Guarda el cambio de datos del nodo y refresca su tarjeta en el canvas.
  function commit(nodeId, type, data) {
    editor.updateNodeDataFromId(nodeId, data);
    updatePreviewDom(nodeId, type, data);
    setStatusText('Sin guardar');
  }

  function bindInput(id, setter, nodeId, type, data) {
    const el = document.getElementById(id);
    if (el) el.oninput = (e) => { setter(e.target.value); commit(nodeId, type, data); };
  }

  // ── Helpers de inspector ───────────────────────────────────────────────────

  function scopeSelectHtml(data) {
    return `<select id="insp-scope" class="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm mt-1">
      <option value="both" ${data.platform_scope === 'both' ? 'selected' : ''}>Ambas</option>
      <option value="messenger" ${data.platform_scope === 'messenger' ? 'selected' : ''}>Solo Messenger</option>
      <option value="instagram" ${data.platform_scope === 'instagram' ? 'selected' : ''}>Solo Instagram</option>
    </select>`;
  }

  function bindScopeSelect(nodeId, data) {
    document.getElementById('insp-scope').onchange = (e) => {
      data.platform_scope = e.target.value;
      editor.updateNodeDataFromId(nodeId, data);
      setStatusText('Sin guardar');
    };
  }

  // Mantiene el número de salidas del nodo de botones igual al número de opciones,
  // para que cada opción tenga su propio conector en el canvas.
  function syncQuickReplyOutputs(nodeId, data) {
    const current = Object.keys(editor.getNodeFromId(nodeId).outputs || {}).length;
    const target = (data.options || []).length;
    for (let i = current; i < target; i++) editor.addNodeOutput(nodeId);
    for (let i = current; i > target; i--) editor.removeNodeOutput(nodeId, 'output_' + i);
  }

  function exportGraph() {
    const exported = editor.export();
    const raw = exported.drawflow.Home.data;
    const nodes = Object.values(raw).map((n) => ({
      id: String(n.id), type: n.name, data: n.data, position: { x: n.pos_x, y: n.pos_y },
    }));
    const edges = [];
    Object.values(raw).forEach((n) => {
      Object.entries(n.outputs || {}).forEach(([outputKey, output]) => {
        const outputIndex = parseInt(outputKey.split('_')[1], 10) || 1; // "output_2" → 2
        (output.connections || []).forEach((conn) => {
          edges.push({ from: String(n.id), to: String(conn.node), output: outputIndex });
        });
      });
    });
    return { drawflow: exported, nodes, edges };
  }

  async function persist(statusOverride) {
    const name = document.getElementById('builder-flow-name').value.trim();
    const body = { id: flowId, name, graph_json: exportGraph() };
    if (statusOverride) body.status = statusOverride;
    await api('api/flows.php', { method: 'PUT', body: JSON.stringify(body) });
    const labels = { active: 'Publicado', paused: 'Pausado' };
    setStatusText(labels[statusOverride] || 'Guardado');
  }

  async function saveDraft() {
    try {
      await persist();
      Utils.showToast('Borrador guardado', 'success');
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  async function publish() {
    try {
      await persist('active');
      Utils.showToast('Flujo publicado', 'success');
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  // Desactiva el flujo (sus disparadores dejan de escuchar) sin perder el diseño;
  // se puede volver a publicar en cualquier momento desde aquí o desde la lista.
  async function pause() {
    try {
      await persist('paused');
      Utils.showToast('Flujo pausado — sus disparadores ya no están activos', 'success');
    } catch (e) {
      Utils.showToast(e.message, 'danger');
    }
  }

  function destroy() {
    editor = null;
    flowId = null;
  }

  // Controles de zoom del lienzo (Drawflow ya soporta Ctrl+rueda del mouse, pero sin
  // botones visibles no era descubrible — al crecer el flujo no había forma obvia de
  // alejar la vista para seguir viendo/agregando nodos).
  function zoomIn() { editor?.zoom_in(); }
  function zoomOut() { editor?.zoom_out(); }
  function zoomReset() { editor?.zoom_reset(); }

  return { load, save: saveDraft, publish, pause, destroy, zoomIn, zoomOut, zoomReset };
})();

window.FlowBuilder = FlowBuilder;
