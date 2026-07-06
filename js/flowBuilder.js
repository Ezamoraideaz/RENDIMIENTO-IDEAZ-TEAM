// Envuelve Drawflow (js/vendor/drawflow.min.js) para el constructor visual de flujos.
// El grafo se guarda en dos formas dentro de graph_json: `drawflow` (el export nativo,
// usado para recargar el canvas tal cual) y `nodes`/`edges` (formato plano que consume
// backend/includes/trigger_engine.php al ejecutar el flujo).
const FlowBuilder = (() => {
  let editor = null;
  let flowId = null;
  let api = null;

  const NODE_DEFS = {
    trigger_keyword: { title: '🎯 Disparador', inputs: 0, outputs: 1, defaultData: { keywords: [], platform_scope: 'both' } },
    message:         { title: '💬 Mensaje',     inputs: 1, outputs: 1, defaultData: { text: '' } },
    delay:           { title: '⏱️ Espera',      inputs: 1, outputs: 1, defaultData: { minutes: 5 } },
  };

  function previewText(type, data) {
    if (type === 'trigger_keyword') return (data.keywords || []).join(', ') || '(sin palabras clave)';
    if (type === 'message') return (data.text || '').slice(0, 40) || '(vacío)';
    if (type === 'delay') return `${data.minutes || 0} min`;
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
    }
  }

  function exportGraph() {
    const exported = editor.export();
    const raw = exported.drawflow.Home.data;
    const nodes = Object.values(raw).map((n) => ({
      id: String(n.id), type: n.name, data: n.data, position: { x: n.pos_x, y: n.pos_y },
    }));
    const edges = [];
    Object.values(raw).forEach((n) => {
      Object.values(n.outputs || {}).forEach((output) => {
        (output.connections || []).forEach((conn) => {
          edges.push({ from: String(n.id), to: String(conn.node) });
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
