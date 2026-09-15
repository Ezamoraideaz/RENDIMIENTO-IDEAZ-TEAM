// Esquema de pasos/campos del wizard de Rendición Trimestral (rendicion.html).
// Mismo enfoque data-driven que js/briefSchemas.js: un array de "steps", cada
// uno con "fields" que un motor genérico (js/rendicion.js) renderiza,
// valida y guarda. showIf(answers) oculta pasos/campos que no aplican
// ("DATOS CONDICIONALES" del MD de Rendición).
//
// Los keys con "." son rutas anidadas dentro de formData (ver getPath/setPath
// en rendicion.js) — así "client_knowledge.selling" guarda en
// formData.client_knowledge.selling, que luego se manda tal cual dentro de
// answers.client_knowledge al backend.

const RENDICION_NEEDS_OPTIONS = [
  { value: 'nuevo_producto', label: 'Nuevo producto' },
  { value: 'nuevo_servicio', label: 'Nuevo servicio' },
  { value: 'promocion', label: 'Promoción' },
  { value: 'evento', label: 'Evento' },
  { value: 'lanzamiento', label: 'Lanzamiento' },
  { value: 'temporada_especial', label: 'Temporada especial' },
  { value: 'pauta', label: 'Necesidad de pauta' },
  { value: 'landing_page', label: 'Necesidad de landing page' },
  { value: 'fotografia', label: 'Necesidad de fotografía' },
  { value: 'video', label: 'Necesidad de video' },
  { value: 'actualizacion_web', label: 'Necesidad de actualización web' },
  { value: 'reputacion', label: 'Problema de reputación' },
  { value: 'nuevo_contenido', label: 'Nueva oportunidad de contenido' },
];

const RENDICION_SERVICES_OPTIONS = [
  { value: 'pauta_digital', label: 'Pauta digital' },
  { value: 'pagina_web', label: 'Página web' },
  { value: 'landing_page', label: 'Landing page' },
  { value: 'fotografia', label: 'Fotografía' },
  { value: 'video', label: 'Video' },
  { value: 'diseno', label: 'Diseño' },
  { value: 'branding', label: 'Branding' },
  { value: 'email_marketing', label: 'Email marketing' },
  { value: 'sms', label: 'SMS' },
  { value: 'hosting_dominio', label: 'Hosting / dominio' },
  { value: 'eventos', label: 'Eventos' },
  { value: 'automatizaciones', label: 'Automatizaciones' },
  { value: 'desarrollo', label: 'Desarrollo' },
  { value: 'otro', label: 'Otro' },
];

const RENDICION_STAGE_OPTIONS = [
  { value: 'detectada', label: 'Detectada' },
  { value: 'reportada', label: 'Reportada internamente' },
  { value: 'presentada', label: 'Presentada al cliente' },
  { value: 'cotizada', label: 'Cotizada' },
  { value: 'en_negociacion', label: 'En negociación' },
  { value: 'aprobada', label: 'Aprobada' },
  { value: 'vendida', label: 'Vendida' },
  { value: 'perdida', label: 'Perdida' },
  { value: 'pendiente', label: 'Pendiente' },
];

// Trimestres disponibles en los selectores (actual + 4 anteriores) —
// compartido entre rendicion.js (wizard) y rendicionDashboard.js (filtros).
function rendicionQuarterOptions() {
  const now = new Date();
  const currentQ = Math.floor(now.getMonth() / 3) + 1;
  const out = [];
  let y = now.getFullYear();
  let q = currentQ;
  for (let i = 0; i < 5; i++) {
    out.push({ value: `${y}-Q${q}`, label: `Q${q} ${y}` });
    q--;
    if (q < 1) { q = 4; y--; }
  }
  return out;
}

const RENDICION_SCHEMA = {
  steps: [
    {
      id: 'info_general',
      title: 'Información general',
      fields: [
        { key: 'client_id', label: 'Cliente / marca', type: 'select-clients', required: true },
        { key: 'quarter', label: 'Periodo evaluado', type: 'select-quarters', required: true },
        { key: 'contracted_services', label: 'Servicios que actualmente tiene contratados el cliente', type: 'checkbox-group', options: [
          { value: 'community_management', label: 'Community Management' },
          { value: 'pauta_digital', label: 'Pauta digital' },
          { value: 'pagina_web', label: 'Página web' },
          { value: 'diseno_grafico', label: 'Diseño gráfico' },
          { value: 'fotografia', label: 'Fotografía' },
          { value: 'video', label: 'Video' },
          { value: 'branding', label: 'Branding' },
          { value: 'email_sms', label: 'Email marketing / SMS' },
          { value: 'automatizaciones', label: 'Automatizaciones' },
          { value: 'otro', label: 'Otro' },
        ] },
        { key: 'activity_level', label: 'Nivel de actividad de la cuenta', type: 'radio-cards', required: true, options: [
          { value: 'baja', label: 'Baja' }, { value: 'media', label: 'Media' }, { value: 'alta', label: 'Alta' },
        ] },
      ],
    },
    {
      id: 'gestion',
      title: 'Gestión y contacto con el cliente',
      fields: [
        { key: 'meetings_total', label: 'Número total de reuniones realizadas durante el trimestre', type: 'number', required: true },
        { key: 'meetings_planning', label: 'Número de reuniones de planeación', type: 'number' },
        { key: 'meetings_client_requested', label: 'Número de reuniones solicitadas por el cliente', type: 'number' },
        { key: 'meetings_cm_initiated', label: 'Número de reuniones/seguimientos propuestos por tu iniciativa', type: 'number' },
        { key: 'followups_count', label: 'Número aproximado de seguimientos realizados', type: 'number' },
        { key: 'avg_response_time', label: 'Tiempo promedio de respuesta al cliente', type: 'text', placeholder: 'Ej. Menos de 2 horas' },
        { key: 'proactivity_self_score', label: '¿Qué tan proactiva consideras que fue tu gestión con esta cuenta?', type: 'scale5', required: true },
      ],
    },
    {
      id: 'planeacion',
      title: 'Planeación de contenido',
      fields: [
        { key: 'calendar_status', label: '¿El calendario de contenido fue propuesto oportunamente?', type: 'radio-cards', required: true, options: [
          { value: 'si', label: 'Sí' }, { value: 'parcial', label: 'Parcialmente' }, { value: 'no', label: 'No' },
        ] },
        { key: 'calendar_approved', label: '¿El calendario fue aprobado?', type: 'radio-cards', required: true, options: [
          { value: 'si', label: 'Sí' }, { value: 'parcial', label: 'Parcialmente' }, { value: 'no', label: 'No' },
        ] },
        { key: 'changes_requested_count', label: 'Número aproximado de cambios importantes solicitados por el cliente', type: 'number' },
        { key: 'unproduced_content', label: '¿Quedaron contenidos sin producir?', type: 'radio-cards', required: true, options: [
          { value: 'no', label: 'No' }, { value: 'si', label: 'Sí' },
        ] },
        { key: 'unproduced_reason', label: '¿Por qué?', type: 'radio-cards', required: true, showIf: (a) => a.unproduced_content === 'si', options: [
          { value: 'falta_aprobacion', label: 'Falta de aprobación' },
          { value: 'falta_material', label: 'Falta de material' },
          { value: 'falta_informacion', label: 'Falta de información del cliente' },
          { value: 'retraso_interno', label: 'Retraso interno' },
          { value: 'cambio_estrategia', label: 'Cambio de estrategia' },
          { value: 'otro', label: 'Otro' },
        ] },
      ],
    },
    {
      id: 'produccion',
      title: 'Producción y coordinación con diseño',
      fields: [
        { key: 'creation_sessions', label: 'Número de jornadas de creación realizadas', type: 'number' },
        { key: 'client_visits', label: 'Número de visitas al cliente/establecimiento', type: 'number' },
        { key: 'pieces_generated', label: 'Número aproximado de piezas generadas', type: 'number', required: true },
        { key: 'pieces_delivered', label: 'Número aproximado de piezas entregadas a diseño', type: 'number' },
        { key: 'pieces_approved', label: 'Número aproximado de piezas aprobadas', type: 'number' },
        { key: 'pieces_rework', label: 'Número aproximado de piezas rechazadas o que requirieron retrabajo', type: 'number' },
      ],
    },
    {
      id: 'oportunidades',
      title: 'Oportunidades comerciales detectadas',
      fields: [
        { key: 'needs', label: 'Necesidades detectadas en el negocio del cliente', type: 'checkbox-group', options: RENDICION_NEEDS_OPTIONS },
        { key: 'opportunities_detected', label: '¿Detectaste alguna oportunidad comercial para IDeaz?', type: 'radio-cards', required: true, options: [
          { value: 'no', label: 'No' }, { value: 'si', label: 'Sí' },
        ] },
      ],
      // El bloque repetible de oportunidades (servicios / estado / valor) se
      // renderiza aparte, ver renderOpportunities() en rendicion.js — no es un
      // "field" plano porque una cuenta puede reportar varias.
      opportunitiesBlock: { showIf: (a) => a.opportunities_detected === 'si' },
    },
    {
      id: 'fidelizacion',
      title: 'Fidelización y relación',
      fields: [
        { key: 'fidelizacion_actions', label: '¿Qué acciones realizaste durante el trimestre para fortalecer la relación con el cliente?', type: 'checkbox-group', options: [
          { value: 'ideas_contenido', label: 'Nuevas ideas de contenido' },
          { value: 'ideas_campanas', label: 'Nuevas ideas de campañas' },
          { value: 'propuestas_productos', label: 'Propuestas de productos/servicios' },
          { value: 'seguimientos_adicionales', label: 'Seguimientos adicionales' },
          { value: 'fechas_importantes', label: 'Gestión de fechas importantes' },
          { value: 'felicitaciones', label: 'Felicitaciones' },
          { value: 'eventos', label: 'Eventos' },
          { value: 'visitas', label: 'Visitas' },
          { value: 'reuniones_especiales', label: 'Reuniones especiales' },
          { value: 'solucion_proactiva', label: 'Solución proactiva de problemas' },
          { value: 'otro', label: 'Otro' },
        ] },
        { key: 'fidelizacion_detail', label: 'Describe brevemente la acción de mayor valor que realizaste para fortalecer la relación con este cliente', type: 'textarea', required: true, maxlength: 300 },
      ],
    },
    {
      id: 'errores',
      title: 'Errores y retrabajos',
      fields: [
        { key: 'error_types', label: '¿Se presentaron incidencias durante el trimestre?', type: 'checkbox-group', options: [
          { value: 'publicacion_error', label: 'Publicación con error' },
          { value: 'info_incorrecta', label: 'Información incorrecta' },
          { value: 'error_ortografico', label: 'Error ortográfico' },
          { value: 'pieza_equivocada', label: 'Pieza equivocada' },
          { value: 'info_no_aprobada', label: 'Información no aprobada' },
          { value: 'mala_planificacion', label: 'Cambio causado por mala planificación' },
          { value: 'falta_info_equipo', label: 'Falta de información entregada al equipo' },
          { value: 'retrabajo_innecesario', label: 'Retrabajo innecesario' },
          { value: 'otro', label: 'Otro' },
        ] },
        { key: 'incidents_count', label: 'Número aproximado de incidencias relevantes', type: 'number' },
        { key: 'error_detail', label: '¿Qué ocurrió y cómo podemos evitar que vuelva a suceder?', type: 'textarea', required: true, showIf: (a) => Number(a.incidents_count) > 0 },
      ],
    },
    {
      id: 'mejoras',
      title: 'Oportunidades de mejora (mínimo 3)',
      fields: [
        { key: 'improvements.0.problem', label: 'Oportunidad 1 — Problema detectado', type: 'text', required: true },
        { key: 'improvements.0.cause', label: 'Causa', type: 'text' },
        { key: 'improvements.0.proposal', label: 'Propuesta', type: 'text' },
        { key: 'improvements.0.impact', label: 'Impacto esperado', type: 'text' },
        { key: 'improvements.1.problem', label: 'Oportunidad 2 — Problema detectado', type: 'text', required: true },
        { key: 'improvements.1.cause', label: 'Causa', type: 'text' },
        { key: 'improvements.1.proposal', label: 'Propuesta', type: 'text' },
        { key: 'improvements.1.impact', label: 'Impacto esperado', type: 'text' },
        { key: 'improvements.2.problem', label: 'Oportunidad 3 — Problema detectado', type: 'text', required: true },
        { key: 'improvements.2.cause', label: 'Causa', type: 'text' },
        { key: 'improvements.2.proposal', label: 'Propuesta', type: 'text' },
        { key: 'improvements.2.impact', label: 'Impacto esperado', type: 'text' },
      ],
    },
    {
      id: 'conocimiento',
      title: 'Conocimiento del cliente',
      hint: 'Opcional — si prefieres, déjala en blanco y la completan juntos en la reunión de socialización presencial.',
      fields: [
        { key: 'client_knowledge.selling', label: '¿Qué está vendiendo?', type: 'text' },
        { key: 'client_knowledge.wants_to_sell', label: '¿Qué quiere vender?', type: 'text' },
        { key: 'client_knowledge.priority_product', label: '¿Qué producto/servicio quiere impulsar?', type: 'text' },
        { key: 'client_knowledge.problems', label: '¿Qué problemas tiene?', type: 'text' },
        { key: 'client_knowledge.campaigns', label: '¿Qué campañas quiere realizar?', type: 'text' },
        { key: 'client_knowledge.seasons', label: '¿Qué temporadas importantes vienen?', type: 'text' },
        { key: 'client_knowledge.competition', label: '¿Qué competencia está observando?', type: 'text' },
        { key: 'client_knowledge.concerns', label: '¿Qué preocupa al cliente?', type: 'text' },
        { key: 'client_knowledge.growth_opportunities', label: '¿Qué oportunidades tiene?', type: 'text' },
      ],
    },
    {
      id: 'salud_riesgo',
      title: 'Salud y riesgo de la cuenta',
      fields: [
        { key: 'account_health', label: '¿Cómo consideras actualmente la salud de esta cuenta?', type: 'radio-cards', required: true, options: [
          { value: 'verde', label: '🟢 Saludable' }, { value: 'amarillo', label: '🟡 Requiere atención' }, { value: 'rojo', label: '🔴 Riesgo' },
        ] },
        { key: 'has_risk', label: '¿Existe algún riesgo que IDeaz deba conocer?', type: 'radio-cards', required: true, options: [
          { value: '0', label: 'No' }, { value: '1', label: 'Sí' },
        ] },
        { key: 'risk_types', label: 'Tipo de riesgo', type: 'checkbox-group', showIf: (a) => a.has_risk === '1', options: [
          { value: 'insatisfaccion', label: 'Insatisfacción' },
          { value: 'falta_comunicacion', label: 'Falta de comunicación' },
          { value: 'retrasos_constantes', label: 'Retrasos constantes' },
          { value: 'problemas_aprobacion', label: 'Problemas de aprobación' },
          { value: 'problemas_economicos', label: 'Problemas económicos' },
          { value: 'reduccion_servicios', label: 'Solicitud de reducción de servicios' },
          { value: 'posible_cancelacion', label: 'Posible cancelación' },
          { value: 'conflicto', label: 'Conflicto con el cliente' },
          { value: 'otro', label: 'Otro' },
        ] },
        { key: 'risk_detail', label: 'Explica brevemente el riesgo y qué recomiendas hacer', type: 'textarea', required: true, showIf: (a) => a.has_risk === '1' },
      ],
    },
    {
      id: 'valor_ideaz',
      title: 'Valor generado para IDeaz',
      fields: [
        { key: 'value_generated.problem_detected', label: '¿Qué problema detectaste?', type: 'textarea', required: true },
        { key: 'value_generated.solved', label: '¿Qué solucionaste?', type: 'textarea', required: true },
        { key: 'value_generated.opportunity_detected', label: '¿Qué oportunidad comercial detectaste?', type: 'textarea', required: true },
        { key: 'value_generated.additional_service', label: '¿Qué servicio adicional podría necesitar este cliente?', type: 'textarea', required: true },
        { key: 'value_generated.current_risk', label: '¿Qué riesgo ves actualmente?', type: 'textarea', required: true },
        { key: 'value_generated.next_quarter_action', label: '¿Qué debería hacer IDeaz durante el próximo trimestre?', type: 'textarea', required: true },
      ],
    },
    {
      id: 'revision',
      title: 'Revisión y envío',
      review: true,
      fields: [],
    },
  ],
};

if (typeof window !== 'undefined') {
  window.RENDICION_SCHEMA = RENDICION_SCHEMA;
  window.RENDICION_NEEDS_OPTIONS = RENDICION_NEEDS_OPTIONS;
  window.RENDICION_SERVICES_OPTIONS = RENDICION_SERVICES_OPTIONS;
  window.RENDICION_STAGE_OPTIONS = RENDICION_STAGE_OPTIONS;
  window.rendicionQuarterOptions = rendicionQuarterOptions;
}
