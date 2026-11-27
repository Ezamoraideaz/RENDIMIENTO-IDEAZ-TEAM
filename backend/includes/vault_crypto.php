<?php
declare(strict_types=1);

// Funciones puras de la bóveda (sin base de datos): cifrado y códigos TOTP.

// Cifra con AES-256-GCM. $aad ata el resultado a su contexto: si alguien copia el
// texto cifrado de una fila a otra en la BD, el descifrado falla.
function vault_seal(string $plaintext, string $key, string $aad): string
{
    $iv  = random_bytes(12);
    $tag = '';
    $ct  = openssl_encrypt($plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag, $aad, 16);
    if ($ct === false) {
        throw new RuntimeException('Fallo al cifrar.');
    }
    return base64_encode($iv . $tag . $ct);
}

function vault_open(string $sealed, string $key, string $aad): string
{
    $raw = base64_decode($sealed, true);
    if ($raw === false || strlen($raw) < 28) {
        throw new RuntimeException('Datos cifrados inválidos.');
    }
    $plain = openssl_decrypt(substr($raw, 28), 'aes-256-gcm', $key, OPENSSL_RAW_DATA, substr($raw, 0, 12), substr($raw, 12, 16), $aad);
    if ($plain === false) {
        throw new RuntimeException('No se pudo descifrar (¿cambió la clave maestra?).');
    }
    return $plain;
}

const VAULT_B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function vault_base32_encode(string $bytes): string
{
    $bits = '';
    foreach (str_split($bytes) as $c) {
        $bits .= str_pad(decbin(ord($c)), 8, '0', STR_PAD_LEFT);
    }
    $out = '';
    foreach (str_split($bits, 5) as $chunk) {
        $out .= VAULT_B32[bindec(str_pad($chunk, 5, '0'))];
    }
    return $out;
}

function vault_base32_decode(string $text): string
{
    $bits = '';
    foreach (str_split(strtoupper($text)) as $c) {
        $v = strpos(VAULT_B32, $c);
        if ($v !== false) {
            $bits .= str_pad(decbin($v), 5, '0', STR_PAD_LEFT);
        }
    }
    $out = '';
    foreach (str_split($bits, 8) as $byte) {
        if (strlen($byte) === 8) {
            $out .= chr(bindec($byte));
        }
    }
    return $out;
}

// RFC 6238: SHA-1, 6 dígitos, 30 s (lo que usan Google y Microsoft Authenticator)
function vault_totp_at(string $secret, int $step): string
{
    $hash   = hash_hmac('sha1', pack('J', $step), $secret, true);
    $offset = ord($hash[19]) & 0x0f;
    $number = unpack('N', substr($hash, $offset, 4))[1] & 0x7fffffff;
    return str_pad((string)($number % 1000000), 6, '0', STR_PAD_LEFT);
}

// Devuelve el intervalo al que corresponde el código, o null. Solo acepta intervalos
// posteriores a $lastStep (un código no sirve dos veces). Acepta el código anterior
// (hasta 30-60 s después de cambiar en la app, para alcanzar a dictarlo) y el siguiente
// (desfase de reloj). Solo 3 válidos a la vez: cada intervalo extra facilita adivinar.
function vault_totp_match(string $secret, string $code, int $lastStep, ?int $now = null): ?int
{
    $current = intdiv($now ?? time(), 30);
    for ($step = $current - 1; $step <= $current + 1; $step++) {
        if ($step > $lastStep && hash_equals(vault_totp_at($secret, $step), $code)) {
            return $step;
        }
    }
    return null;
}
