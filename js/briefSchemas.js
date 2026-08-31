// Esquema de campos de los 3 tipos de brief (Sitio web / Mercadeo digital /
// Branding). Fuente única para el wizard público (brief-publico.html) y el
// visor de respuestas del panel admin (js/atencionCliente.js) — ninguno de
// los dos duplica la lista de campos ni las etiquetas.
//
// Cada tipo tiene "sections" (pasos del wizard) → "fields". Tipos de campo
// soportados: text, textarea, email, tel, date, number, radio-cards
// (tarjetas grandes, una sola opción), checkbox-group (tarjetas, multi),
// file (adjuntos — el wizard los sube junto con el resto del formulario al
// enviar, ver brief-publico.html/submitForm y brief_public.php).
//
// Tanto una sección como un campo individual pueden llevar showIf(answers)
// para mostrarse solo según una respuesta previa — a nivel de sección para
// ramas completas por tipo de sitio (ej. e-commerce), a nivel de campo para
// preguntas de seguimiento puntuales (ej. "¿cuál es tu dominio?" solo si
// contestaron que ya tienen uno) — así nunca se le pregunta a la marca algo
// que no aplica según lo que ya contestó.
//
// El nombre de la marca/empresa NO se pregunta en ningún schema: el link ya
// es específico de un cliente, así que el equipo ya sabe de quién se trata.
// contacto_cargo/contacto_telefono sí viven dentro de "answers" como
// cualquier otro campo; el nombre y correo de quien llena el formulario NO
// están en el schema — el wizard los pide en un primer paso fijo y se
// guardan en las columnas filled_by_name/filled_by_email de client_briefs.

const BRIEF_SCHEMAS = {
  sitio_web: {
    label: 'Sitio web',
    sections: [
      {
        id: 'general',
        title: 'Sobre el proyecto',
        fields: [
          { key: 'contacto_cargo', label: 'Tu cargo en la empresa', type: 'text', placeholder: 'Ej. Gerente de marketing' },
          { key: 'contacto_telefono', label: 'Teléfono / WhatsApp', type: 'tel', placeholder: '+52 55 1234 5678' },
          {
            key: 'tipo_sitio', label: '¿Qué tipo de sitio necesitas?', type: 'radio-cards', required: true,
            options: [
              { value: 'landing', label: 'Landing page', help: 'Una sola página enfocada en un objetivo: vender o captar contactos' },
              { value: 'informativo', label: 'Sitio informativo', help: 'Varias secciones: Inicio, Nosotros, Servicios, Contacto...' },
              { value: 'ecommerce', label: 'Tienda en línea', help: 'Catálogo de productos con carrito y pago' },
            ],
          },
          { key: 'objetivo', label: '¿Cuál es el objetivo principal del sitio?', type: 'textarea', required: true, placeholder: 'Ej. Vender el producto X, generar citas, dar información de la empresa...' },
          { key: 'publico_objetivo', label: '¿A quién le habla este sitio?', type: 'textarea', required: true, placeholder: 'Edad, género, ubicación, intereses...' },
          { key: 'competencia', label: 'Principales competidores', type: 'textarea', placeholder: 'Nombres o links de sitios de la competencia' },
          { key: 'referencias', label: 'Sitios web que te gusten como referencia', type: 'textarea', placeholder: 'Pega links o nombres de marcas que te gusten y por qué' },
        ],
      },
      {
        id: 'tecnico',
        title: 'Dominio, hosting y marca',
        fields: [
          { key: 'tiene_dominio', label: '¿Ya tienen dominio propio?', type: 'radio-cards', options: [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No, hay que comprarlo' }] },
          { key: 'dominio_detalle', label: '¿Cuál es tu dominio?', type: 'text', placeholder: 'www.mimarca.com', showIf: (a) => a.tiene_dominio === 'si' },
          { key: 'tiene_hosting', label: '¿Ya tienen hosting contratado?', type: 'radio-cards', options: [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No' }, { value: 'no_se', label: 'No sé / no aplica' }] },
          { key: 'logo_files', label: 'Adjunta tu logo (si ya tienes uno)', type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.svg,.pdf,.ai,.eps', help: 'PNG, JPG, SVG, PDF, AI o EPS — mientras más alta la calidad, mejor' },
          { key: 'manual_marca_files', label: 'Adjunta tu manual de marca (si tienen uno)', type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg', help: 'La guía con tus colores, tipografías y usos del logo, si la tienen' },
          { key: 'necesita_diseno_marca', label: 'Si no tienes logo o manual de marca listos, ¿necesitas que te ayudemos a crearlos?', type: 'radio-cards', options: [{ value: 'si', label: 'Sí, necesito ayuda' }, { value: 'no', label: 'No, ya tengo todo' }, { value: 'no_se', label: 'No estoy seguro' }] },
          { key: 'tono', label: '¿Cómo quieren que suene la marca en el sitio?', type: 'radio-cards', options: [{ value: 'formal', label: 'Formal / corporativo' }, { value: 'cercano', label: 'Cercano / amigable' }, { value: 'divertido', label: 'Divertido / juvenil' }, { value: 'tecnico', label: 'Técnico / especializado' }] },
          { key: 'plazo', label: '¿Para cuándo lo necesitan?', type: 'date' },
        ],
      },
      {
        id: 'landing',
        title: 'Detalles de la landing page',
        showIf: (a) => a.tipo_sitio === 'landing',
        fields: [
          { key: 'landing_producto', label: 'Producto o servicio a promocionar', type: 'textarea', required: true },
          { key: 'landing_conversion', label: '¿Qué acción debe hacer quien visite la página?', type: 'radio-cards', required: true, options: [{ value: 'formulario', label: 'Llenar un formulario' }, { value: 'whatsapp', label: 'Escribir por WhatsApp' }, { value: 'compra', label: 'Comprar directo' }, { value: 'llamada', label: 'Llamar' }] },
          { key: 'landing_oferta', label: '¿Hay alguna oferta, descuento o urgencia que se deba comunicar?', type: 'textarea', placeholder: 'Ej. 20% de descuento hasta el 30 de septiembre' },
          { key: 'landing_elementos', label: '¿Qué elementos quieres incluir?', type: 'checkbox-group', options: [{ value: 'video', label: 'Video' }, { value: 'testimonios', label: 'Testimonios' }, { value: 'faq', label: 'Preguntas frecuentes' }, { value: 'countdown', label: 'Contador de tiempo/oferta' }, { value: 'formulario', label: 'Formulario de contacto' }] },
          { key: 'landing_prueba_social_files', label: 'Adjunta testimonios, logos de clientes o certificaciones', type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.pdf', showIf: (a) => Array.isArray(a.landing_elementos) && a.landing_elementos.includes('testimonios') },
          { key: 'landing_pauta', label: '¿Va ligada a una campaña de pauta activa o próxima?', type: 'radio-cards', options: [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No' }] },
          { key: 'landing_pauta_fechas', label: '¿Para qué fechas está planeada la campaña?', type: 'text', placeholder: 'Ej. Del 1 al 15 de octubre', showIf: (a) => a.landing_pauta === 'si' },
        ],
      },
      {
        id: 'informativo',
        title: 'Detalles del sitio informativo',
        showIf: (a) => a.tipo_sitio === 'informativo',
        fields: [
          { key: 'info_secciones', label: '¿Qué secciones necesitas?', type: 'checkbox-group', required: true, options: [{ value: 'inicio', label: 'Inicio' }, { value: 'nosotros', label: 'Nosotros' }, { value: 'servicios', label: 'Servicios/Productos' }, { value: 'blog', label: 'Blog' }, { value: 'contacto', label: 'Contacto' }, { value: 'galeria', label: 'Galería' }, { value: 'testimonios', label: 'Testimonios' }] },
          { key: 'info_contenido_existente', label: '¿Ya tienen los textos e imágenes de cada sección?', type: 'radio-cards', options: [{ value: 'listos', label: 'Sí, todo listo' }, { value: 'parcial', label: 'Parcialmente' }, { value: 'ayuda', label: 'No, necesitamos ayuda para redactarlos' }] },
          { key: 'info_fotos_files', label: 'Adjunta fotos que quieras usar en el sitio (opcional)', type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.webp' },
          { key: 'info_blog', label: '¿Van a publicar contenido de blog seguido?', type: 'radio-cards', options: [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No' }] },
          { key: 'info_blog_frecuencia', label: '¿Con qué frecuencia?', type: 'radio-cards', options: [{ value: 'semanal', label: 'Semanal' }, { value: 'quincenal', label: 'Quincenal' }, { value: 'mensual', label: 'Mensual' }], showIf: (a) => a.info_blog === 'si' },
          { key: 'info_idiomas', label: '¿En qué idioma(s)?', type: 'text', placeholder: 'Ej. Español, o Español e Inglés' },
          { key: 'info_correo_contacto', label: '¿A qué correo deben llegar los mensajes del formulario?', type: 'email' },
        ],
      },
      {
        id: 'ecommerce',
        title: 'Detalles de la tienda en línea',
        showIf: (a) => a.tipo_sitio === 'ecommerce',
        fields: [
          { key: 'ecom_num_productos', label: '¿Cuántos productos aproximadamente?', type: 'number', required: true, placeholder: 'Ej. 50' },
          { key: 'ecom_variantes', label: '¿Tus productos manejan variantes?', type: 'checkbox-group', options: [{ value: 'talla', label: 'Talla' }, { value: 'color', label: 'Color' }, { value: 'material', label: 'Material' }, { value: 'ninguna', label: 'No maneja variantes' }] },
          { key: 'ecom_pasarela', label: '¿Qué pasarela de pago prefieres?', type: 'text', placeholder: 'Ej. Wompi, PayU, Mercado Pago, Stripe...' },
          { key: 'ecom_envio', label: '¿Cómo manejan los envíos?', type: 'textarea', placeholder: 'Transportadora, zonas de cobertura, costos...' },
          { key: 'ecom_facturacion', label: '¿Necesitan facturación electrónica integrada?', type: 'radio-cards', options: [{ value: 'si', label: 'Sí' }, { value: 'no', label: 'No' }] },
          { key: 'ecom_catalogo_listo', label: '¿Ya tienen fotos y descripciones de los productos?', type: 'radio-cards', required: true, options: [{ value: 'si', label: 'Sí, todo listo' }, { value: 'parcial', label: 'Parcialmente' }, { value: 'no', label: 'No, necesitamos ayuda' }] },
          { key: 'ecom_catalogo_files', label: 'Adjunta tu catálogo (Excel/PDF) o fotos de muestra', type: 'file', multiple: true, accept: '.pdf,.xlsx,.png,.jpg,.jpeg,.zip', showIf: (a) => a.ecom_catalogo_listo === 'si' || a.ecom_catalogo_listo === 'parcial' },
          { key: 'ecom_plataforma', label: '¿Tienen alguna plataforma en mente?', type: 'text', placeholder: 'Ej. Shopify, WooCommerce, o "sin preferencia"' },
        ],
      },
    ],
  },

  marketing_digital: {
    label: 'Mercadeo digital',
    sections: [
      {
        id: 'objetivo',
        title: 'Objetivo y público',
        fields: [
          { key: 'contacto_cargo', label: 'Tu cargo en la empresa', type: 'text', placeholder: 'Ej. Gerente de marketing' },
          { key: 'contacto_telefono', label: 'Teléfono / WhatsApp', type: 'tel', placeholder: '+52 55 1234 5678' },
          { key: 'objetivo_principal', label: '¿Cuál es el objetivo principal?', type: 'radio-cards', required: true, options: [{ value: 'ventas', label: 'Ventas' }, { value: 'reconocimiento', label: 'Reconocimiento de marca' }, { value: 'leads', label: 'Generar leads' }, { value: 'trafico', label: 'Tráfico al sitio' }, { value: 'posicionamiento', label: 'Posicionamiento/SEO' }] },
          { key: 'objetivo_detalle', label: '¿Cómo miden hoy este resultado y qué pasa después de que alguien se interesa?', type: 'textarea', placeholder: 'Ej. Hoy vendemos por WhatsApp, alguien del equipo contesta en el día...', showIf: (a) => a.objetivo_principal === 'ventas' || a.objetivo_principal === 'leads' },
          { key: 'publico_objetivo', label: 'Describe a tu público objetivo', type: 'textarea', required: true, placeholder: 'Edad, género, ubicación, intereses, comportamiento de compra...' },
          { key: 'plataformas', label: '¿En qué plataformas quieres tener presencia?', type: 'checkbox-group', required: true, options: [{ value: 'facebook', label: 'Facebook' }, { value: 'instagram', label: 'Instagram' }, { value: 'google', label: 'Google Ads' }, { value: 'tiktok', label: 'TikTok' }, { value: 'linkedin', label: 'LinkedIn' }] },
          { key: 'competencia', label: 'Principales competidores', type: 'textarea', placeholder: 'Nombres o cuentas de la competencia' },
          { key: 'referencias_campanas', label: 'Campañas o contenido de otras marcas que te gusten', type: 'textarea' },
        ],
      },
      {
        id: 'negocio',
        title: 'Presupuesto y contenido',
        fields: [
          { key: 'presupuesto_pauta', label: 'Presupuesto mensual aproximado de pauta', type: 'text', placeholder: 'Ej. $500.000 COP/mes' },
          { key: 'cuentas_activas', label: '¿Ya tienen cuentas activas en redes/Ads?', type: 'radio-cards', options: [{ value: 'si_accesos', label: 'Sí, y tendrán acceso a ellas' }, { value: 'si_sin_accesos', label: 'Sí, pero sin accesos todavía' }, { value: 'no', label: 'No, hay que crearlas' }] },
          { key: 'cuentas_usuarios', label: 'Déjanos los @usuarios o links de esas cuentas', type: 'textarea', showIf: (a) => a.cuentas_activas === 'si_accesos' || a.cuentas_activas === 'si_sin_accesos' },
          { key: 'productos_a_promocionar', label: 'Productos/servicios a promocionar', type: 'textarea', required: true },
          { key: 'promociones_vigentes', label: '¿Tienen promociones u ofertas vigentes?', type: 'textarea' },
          { key: 'kpis_esperados', label: '¿Qué resultado consideran un éxito?', type: 'textarea', placeholder: 'Ej. X ventas al mes, X leads, X seguidores nuevos...' },
          { key: 'frecuencia_contenido', label: 'Frecuencia de contenido deseada', type: 'radio-cards', options: [{ value: 'diaria', label: 'Diaria' }, { value: 'varias_semana', label: 'Varias veces por semana' }, { value: 'semanal', label: 'Semanal' }, { value: 'no_se', label: 'No sé, sugiéranme' }] },
          { key: 'restricciones', label: '¿Hay algo que NO quieran mostrar o mencionar?', type: 'textarea' },
        ],
      },
      {
        id: 'material',
        title: 'Material gráfico',
        fields: [
          { key: 'logo_files', label: 'Adjunta tu logo (si ya tienes uno)', type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.svg,.pdf,.ai,.eps', help: 'PNG, JPG, SVG, PDF, AI o EPS' },
          { key: 'manual_marca_files', label: 'Adjunta tu manual de marca (si tienen uno)', type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg', help: 'Colores, tipografías y usos del logo, si lo tienen' },
          { key: 'creativos_files', label: 'Adjunta fotos o videos de tus productos/servicios (opcional)', type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.webp,.mp4,.mov' },
        ],
      },
    ],
  },

  branding: {
    label: 'Branding',
    sections: [
      {
        id: 'esencia',
        title: 'La esencia de la marca',
        fields: [
          { key: 'contacto_cargo', label: 'Tu cargo en la empresa', type: 'text', placeholder: 'Ej. Gerente de marketing' },
          { key: 'contacto_telefono', label: 'Teléfono / WhatsApp', type: 'tel', placeholder: '+52 55 1234 5678' },
          { key: 'historia_mision', label: 'Cuéntanos brevemente la historia, misión y/o visión de la marca', type: 'textarea', required: true },
          { key: 'valores', label: 'Valores de la marca', type: 'textarea', placeholder: 'Ej. Honestidad, innovación, cercanía...' },
          { key: 'publico_objetivo', label: 'Describe a tu público objetivo', type: 'textarea', required: true },
          { key: 'diferenciadores', label: '¿Qué los diferencia de la competencia?', type: 'textarea' },
          { key: 'adjetivos', label: 'Si la marca fuera una persona, ¿con qué 3-5 palabras la describirías?', type: 'text', required: true, placeholder: 'Ej. Cercana, confiable, moderna, cálida' },
        ],
      },
      {
        id: 'identidad_actual',
        title: 'Identidad actual',
        fields: [
          { key: 'tiene_logo', label: '¿Ya tienen logo?', type: 'radio-cards', required: true, options: [{ value: 'si_rediseno', label: 'Sí, pero quiero rediseñarlo' }, { value: 'si_mantener', label: 'Sí, y quiero conservarlo' }, { value: 'no', label: 'No, desde cero' }] },
          { key: 'logo_files', label: 'Adjunta tu logo actual', type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.svg,.pdf,.ai,.eps', showIf: (a) => a.tiene_logo === 'si_rediseno' || a.tiene_logo === 'si_mantener' },
          { key: 'rediseno_motivo', label: '¿Qué no te gusta del logo actual y qué te gustaría conservar?', type: 'textarea', showIf: (a) => a.tiene_logo === 'si_rediseno' },
          { key: 'manual_marca_files', label: 'Adjunta tu manual de marca actual (si tienen uno)', type: 'file', multiple: true, accept: '.pdf,.png,.jpg,.jpeg' },
          { key: 'colores_preferidos', label: 'Colores que les gustaría usar', type: 'text' },
          { key: 'colores_evitar', label: 'Colores que quieren evitar', type: 'text' },
        ],
      },
      {
        id: 'estilo',
        title: 'Estilo visual',
        fields: [
          { key: 'estilo_visual', label: '¿Qué estilo visual va con la marca?', type: 'radio-cards', required: true, options: [{ value: 'minimalista', label: 'Minimalista' }, { value: 'moderno', label: 'Moderno' }, { value: 'vintage', label: 'Vintage/clásico' }, { value: 'lujo', label: 'Lujo/elegante' }, { value: 'juvenil', label: 'Juvenil/divertido' }] },
          { key: 'tono_voz', label: '¿Con qué tono le habla la marca a la gente?', type: 'radio-cards', options: [{ value: 'formal', label: 'Formal' }, { value: 'cercano', label: 'Cercano' }, { value: 'divertido', label: 'Divertido' }, { value: 'tecnico', label: 'Técnico' }] },
          { key: 'aplicaciones', label: '¿Dónde se va a aplicar la marca?', type: 'checkbox-group', options: [{ value: 'papeleria', label: 'Papelería' }, { value: 'redes', label: 'Redes sociales' }, { value: 'empaques', label: 'Empaques' }, { value: 'uniformes', label: 'Uniformes' }, { value: 'senalizacion', label: 'Señalética/local' }] },
          { key: 'referencias_marcas', label: 'Marcas que admiran o te gustaría que sirvan de referencia', type: 'textarea' },
          { key: 'referencias_files', label: 'Adjunta imágenes de marcas/diseños que te gusten (moodboard)', type: 'file', multiple: true, accept: '.png,.jpg,.jpeg,.webp,.pdf' },
        ],
      },
    ],
  },
};

if (typeof window !== 'undefined') window.BRIEF_SCHEMAS = BRIEF_SCHEMAS;
