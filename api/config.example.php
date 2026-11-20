<?php
// Copiar este archivo como config.php y completar con credenciales reales
// NUNCA commitear config.php al repositorio

// Meta Ads — System User Access Token (no expira)
define('META_ACCESS_TOKEN', 'YOUR_META_SYSTEM_USER_TOKEN_HERE');

// Versión de la Graph API de Meta (opcional; si Meta deprecia la versión por
// defecto de api/spend.php, basta con definir aquí una más nueva, ej. 'v21.0')
// define('META_GRAPH_VERSION', 'v19.0');

// Google Ads
// El cliente OAuth debe ser tipo "Aplicación web" con esta URI de redireccionamiento autorizada:
//   https://TU-DOMINIO/dashboard/backend/oauth/google_ads_callback.php
// y la pantalla de consentimiento en estado "En producción" (en "Prueba" Google vence el
// token a los 7 días → "OAuth error: Bad Request"). La conexión se hace con el botón
// "Conectar Google Ads" de Pauta y queda cifrada en la BD; GOOGLE_REFRESH_TOKEN es opcional
// (solo se usa si todavía no se conectó desde Pauta).
// define('GOOGLE_DEVELOPER_TOKEN', '');
// define('GOOGLE_MCC_ID', '');
// define('GOOGLE_CLIENT_ID', '');
// define('GOOGLE_CLIENT_SECRET', '');
// define('GOOGLE_REFRESH_TOKEN', '');

// TikTok Ads (próximamente)
// define('TIKTOK_ACCESS_TOKEN', '');
