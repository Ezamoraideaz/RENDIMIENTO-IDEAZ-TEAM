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
    trigger_comment:          { title: '💭 Comentario en post', inputs: 0, outputs: 1, defaultData: { keywords: [], platform_scope: 'both' } },
    trigger_new_conversation: { title: '✨ Nueva conversación', inputs: 0, outputs: 1, defaultData: { platform_scope: 'both' } },
    message:                  { title: '💬 Mensaje',            inputs: 1, outputs: 1, defaultData: { text: '' } },
    quick_replies:            { title: '🔘 Botones',            inputs: 1, outputs: 2, defaultData: { text: '', options: ['Sí', 'No'] } },
    question:                 { title: '📝 Pregunta (lead)',    inputs: 1, outputs: 1, defaultData: { text: '', field: 'email', validate: 'email', retry_text: '' } },
    delay:                    { title: '⏱️ Espera',             inputs: 1, outputs: 1, defaultData: { minutes: 5 } },
    handoff:                  { title: '🙋 Pasar a humano',     inputs: 1, outputs: 0, defaultData: { text: '' } },
  };

  function previewText(type, data) {
    if (type === 'trigger_keyword') return (data.keywords || []).join(', ') || '(sin palabras clave)';
    if (type === 'trigger_comment') return (data.keywords || []).join(', ') || 'cualquier comentario';
    if (type === 'trigger_new_conversation') return 'primer mensaje del contacto';
    if (type === 'message') return (data.text || '').slice(0, 40) || '(vacío)';
    if (type === 'quick_replies') return (data.text || '').slice(0, 25) + ' · ' + (data.options || []).length + ' opciones';
    if (type === 'question') return `guarda "${data.field || '?'}"`;
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
        <p class="text-xs text-slate-600 mt-3">Quien comenta recibe el primer mensaje del flujo <strong>por privado</strong>. Si responde al DM, el flujo continúa con los nodos siguientes.</p>`;
      document.getElementById('insp-keywords').oninput = (e) => {
        data.keywords = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
        editor.updateNodeDataFromId(nodeId, data);
        updatePreviewDom(nodeId, type, data);
        setStatusText('Sin guardar');
      };
      bindScopeSelect(nodeId, data);
    } else if (type === 'trigger_new_conversation') {
      panel.innerHTML = `
        <p class="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Disparador (nueva conversación)</p>
        <p class="text-xs text-slate-500 mb-3">Se activa con el <strong>primer mensaje</strong> de un contacto nuevo que no coincida con ninguna palabra clave. Ideal para mensajes de bienvenida y menús iniciales.</p>
        <label class="text-xs text-slate-500">Plataforma</label>
        ${scopeSelectHtml(data)}`;
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
    }
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
    setStatusText(statusOverride === 'active' ? 'Publicado' : 'Guardado');
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

  function destroy() {
    editor = null;
    flowId = null;
  }

  return { load, save: saveDraft, publish, destroy };
})();

window.FlowBuilder = FlowBuilder;
