<?php
declare(strict_types=1);

// Cifra un token de acceso (Page/IG) con AES-256-GCM antes de guardarlo en BD.
// Devuelve ['ciphertext' => base64, 'iv' => base64]; el tag de autenticación (16 bytes)
// va concatenado al final del ciphertext.
function encrypt_token(string $plaintext): array
{
    $key = base64_decode(ENCRYPTION_KEY, true);
    if ($key === false || strlen($key) !== 32) {
        throw new RuntimeException('ENCRYPTION_KEY inválida: debe ser 32 bytes en base64 (php -r "echo base64_encode(random_bytes(32));").');
    }

    $iv  = random_bytes(12);
    $tag = '';
    $ciphertext = openssl_encrypt($plaintext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    if ($ciphertext === false) {
        throw new RuntimeException('Fallo al cifrar el token.');
    }

    return [
        'ciphertext' => base64_encode($ciphertext . $tag),
        'iv'         => base64_encode($iv),
    ];
}

function decrypt_token(string $ciphertextB64, string $ivB64): string
{
    $key = base64_decode(ENCRYPTION_KEY, true);
    $iv  = base64_decode($ivB64, true);
    $raw = base64_decode($ciphertextB64, true);
    if ($key === false || $iv === false || $raw === false || strlen($raw) < 16) {
        throw new RuntimeException('Datos cifrados inválidos.');
    }

    $tag        = substr($raw, -16);
    $ciphertext = substr($raw, 0, -16);
    $plaintext  = openssl_decrypt($ciphertext, 'aes-256-gcm', $key, OPENSSL_RAW_DATA, $iv, $tag);
    if ($plaintext === false) {
        throw new RuntimeException('Fallo al descifrar el token (¿cambió ENCRYPTION_KEY?).');
    }

    return $plaintext;
}
