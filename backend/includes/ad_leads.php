<?php
declare(strict_types=1);

// Captura de leads de formularios instantáneos de Meta Ads (Instant Forms), vía el
// campo de webhook "leadgen". A diferencia de una conversación de Messenger, aquí NO
// hay PSID ni canal de mensajería — Meta solo entrega los datos del formulario. Este
// módulo guarda el lead completo (respaldo propio: Meta solo lo conserva ~90 días) y
// aplica reglas de notificación/etiqueta por formulario/campaña.

function capture_ad_lead(array $change, string $pageId): void
{
    $value = $change['value'] ?? [];
    $leadgenId = (string)($value['leadgen_id'] ?? '');
    if ($leadgenId === '' || $pageId === '') {
        return;
    }

    $stmt = db()->prepare('SELECT * FROM social_accounts WHERE platform = "facebook_page" AND page_id = ? AND status = "active" LIMIT 1');
    $stmt->execute([$pageId]);
    $account = $stmt->fetch();
    if (!$account) {
        return; // página no conectada en el sistema; ignorar el evento
    }

    $pageToken = decrypt_token($account['page_access_token_encrypted'], $account['page_token_iv']);

    try {
        $lead = MetaClient::getLeadDetails($pageToken, $leadgenId);
    } catch (Throwable $e) {
        return; // sin datos no hay nada que respaldar
    }

    $formId = (string)($lead['form_id'] ?? '');
    $formName = null;
    if ($formId !== '') {
        try {
            $formName = MetaClient::getFormName($pageToken, $formId);
        } catch (Throwable $e) {
            // best-effort: se guarda el lead igual, solo sin nombre de formulario
        }
    }

    [$name, $email, $phone] = flatten_ad_lead_fields($lead['field_data'] ?? []);
    $leadCreatedAt = !empty($lead['created_time']) ? date('Y-m-d H:i:s', strtotime($lead['created_time'])) : null;

    $pdo = db();
    $pdo->prepare('
        INSERT INTO ad_leads
            (client_id, social_account_id, leadgen_id, form_id, form_name, campaign_id, campaign_name,
             ad_id, ad_name, name, email, phone, field_data, lead_created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            form_name = VALUES(form_name), field_data = VALUES(field_data),
            name = VALUES(name), email = VALUES(email), phone = VALUES(phone)
    ')->execute([
        $account['client_id'], $account['id'], $leadgenId,
        $formId ?: null, $formName,
        $lead['campaign_id'] ?? null, $lead['campaign_name'] ?? null,
        $lead['ad_id'] ?? null, $lead['ad_name'] ?? null,
        $name, $email, $phone, json_encode($lead['field_data'] ?? []), $leadCreatedAt,
    ]);

    $stmt = $pdo->prepare('SELECT id FROM ad_leads WHERE leadgen_id = ?');
    $stmt->execute([$leadgenId]);
    $adLeadId = (int)$stmt->fetchColumn();

    apply_ad_lead_rule($pdo, $adLeadId, (int)$account['id'], $account, $lead, $name, $email, $phone);
}

// Aplana field_data ([{name, values:[...]}]) y extrae nombre/email/teléfono por los
// nombres de campo más comunes que usan los formularios de Meta.
function flatten_ad_lead_fields(array $fieldData): array
{
    $flat = [];
    foreach ($fieldData as $field) {
        $key = (string)($field['name'] ?? '');
        if ($key === '') {
            continue;
        }
        $flat[$key] = implode(', ', array_map('strval', $field['values'] ?? []));
    }
    $name = $flat['full_name'] ?? trim(($flat['first_name'] ?? '') . ' ' . ($flat['last_name'] ?? ''));
    $email = $flat['email'] ?? '';
    $phone = $flat['phone_number'] ?? $flat['phone'] ?? '';
    return [$name !== '' ? $name : null, $email !== '' ? $email : null, $phone !== '' ? $phone : null];
}

// Busca la regla más específica (formulario+campaña > solo formulario > solo campaña >
// comodín total) y aplica su etiqueta/notificación. No hace nada si ninguna coincide.
function apply_ad_lead_rule(PDO $pdo, int $adLeadId, int $socialAccountId, array $account, array $lead, ?string $name, ?string $email, ?string $phone): void
{
    if ($adLeadId <= 0) {
        return;
    }
    $formId = (string)($lead['form_id'] ?? '');
    $campaignName = mb_strtolower(trim((string)($lead['campaign_name'] ?? '')));

    $stmt = $pdo->prepare('
        SELECT * FROM ad_lead_rules
        WHERE social_account_id = ? AND active = 1
        ORDER BY (form_id IS NOT NULL) + (campaign_name IS NOT NULL) DESC, priority DESC
    ');
    $stmt->execute([$socialAccountId]);

    $matched = null;
    foreach ($stmt->fetchAll() as $rule) {
        if (!empty($rule['form_id']) && $rule['form_id'] !== $formId) {
            continue;
        }
        if (!empty($rule['campaign_name']) && ($campaignName === '' || mb_strpos($campaignName, mb_strtolower($rule['campaign_name'])) === false)) {
            continue;
        }
        $matched = $rule;
        break;
    }

    if (!$matched) {
        return;
    }

    if (!empty($matched['tag'])) {
        $pdo->prepare('UPDATE ad_leads SET tag = ? WHERE id = ?')->execute([$matched['tag'], $adLeadId]);
    }

    if (!empty($matched['notify_email']) && filter_var($matched['notify_email'], FILTER_VALIDATE_EMAIL)) {
        send_ad_lead_notification($matched['notify_email'], $account, $lead, $name, $email, $phone);
        $pdo->prepare('UPDATE ad_leads SET notified_at = NOW() WHERE id = ?')->execute([$adLeadId]);
    }
}

function send_ad_lead_notification(string $to, array $account, array $lead, ?string $name, ?string $email, ?string $phone): void
{
    $skipKeys = ['email', 'full_name', 'first_name', 'last_name', 'phone_number', 'phone'];
    $lines = [
        'Nuevo lead desde formulario de Meta Ads:',
        '',
        'Página: ' . ($account['page_name'] ?? '—'),
        'Campaña: ' . ($lead['campaign_name'] ?? '—'),
        'Anuncio: ' . ($lead['ad_name'] ?? '—'),
        'Nombre: ' . ($name ?? '—'),
        'Email: ' . ($email ?? '—'),
        'Teléfono: ' . ($phone ?? '—'),
    ];
    foreach (($lead['field_data'] ?? []) as $field) {
        $key = (string)($field['name'] ?? '');
        if ($key === '' || in_array($key, $skipKeys, true)) {
            continue;
        }
        $lines[] = ucfirst($key) . ': ' . implode(', ', array_map('strval', $field['values'] ?? []));
    }
    $lines[] = '';
    $lines[] = 'Los formularios instantáneos no permiten enviar DM automático (Meta no entrega PSID) — contáctalo por teléfono/WhatsApp cuanto antes.';
    $lines[] = 'Ver respaldo completo: ' . APP_BASE_URL . '/atencion-cliente.html';

    $subject = 'Nuevo lead de Meta Ads' . (!empty($lead['campaign_name']) ? ' — ' . $lead['campaign_name'] : '');
    $headers = 'From: no-reply@' . (parse_url(APP_BASE_URL, PHP_URL_HOST) ?: 'localhost') . "\r\n"
             . "Content-Type: text/plain; charset=UTF-8\r\n";
    @mail($to, '=?UTF-8?B?' . base64_encode($subject) . '?=', implode("\n", $lines), $headers);
}
