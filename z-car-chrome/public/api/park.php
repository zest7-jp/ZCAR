<?php
/**
 * Z CAR 車両位置 (エックスサーバー上の PHP で動きます)
 *
 * 車載機が、いまいる場所をここへ送ります。スマホはここを読んで、車を停めた
 * 場所(最後に届いた場所)を地図に出します。持っているのは最後の1件だけです。
 * 同期と同じ合言葉を知っている人だけが読み書きできます。
 *
 * 使い方 (どちらも POST・JSON):
 *   読む : {"key":"合言葉"}
 *          -> {"ok":true,"park":{...}|null,"now":1234567890000}
 *   書く : {"key":"合言葉","park":{"lat":34.6,"lng":135.5,"accuracy":12,"moving":false}}
 *          -> {"ok":true,"since":1234567890000,"at":1234567890000}
 *
 * park の since はその場所に来た時刻、at は最後に位置が届いた時刻
 * (どちらもこのサーバーの時計のミリ秒)。前と同じ場所なら since を引き継ぐ。
 * 走行中は、車が送る走行の長さ(drivingMs)から、走り出した時刻(tripSince)も残す。
 *
 * 位置は合言葉から作った鍵で暗号化して保存します。合言葉はどこにも保存しないので、
 * 保存したファイルだけを見ても場所は分かりません。
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const MAX_BODY_BYTES = 4096;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;
/** この距離(m)より近ければ同じ場所とみなし、来た時刻を引き継ぐ。 */
const SAME_PLACE_METERS = 30;
/** 誤差がこれ(m)より大きい位置は、場所が分からないのと同じなので受け取らない。 */
const MAX_ACCURACY_METERS = 5000;
/** 走行の長さとして受け取る上限(ミリ秒)。これより長いのはおかしな値なので捨てる。 */
const MAX_TRIP_MS = 24 * 60 * 60 * 1000;
const CIPHER = 'aes-256-gcm';

function fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

/** 2点の間の距離(m)。 */
function distanceMeters(float $lat1, float $lng1, float $lat2, float $lng2): float
{
    $rad = M_PI / 180;
    $a = sin(($lat2 - $lat1) * $rad / 2) ** 2
        + cos($lat1 * $rad) * cos($lat2 * $rad) * sin(($lng2 - $lng1) * $rad / 2) ** 2;
    return 2 * 6371000 * asin(min(1.0, sqrt($a)));
}

/** 保存してある場所を読む。無い・壊れている・鍵が合わないときは null。 */
function readPark(string $file, string $secret): ?array
{
    if (!is_file($file)) {
        return null;
    }
    $stored = json_decode((string) file_get_contents($file), true);
    if (!is_array($stored)) {
        return null;
    }
    $iv = base64_decode((string) ($stored['iv'] ?? ''), true);
    $tag = base64_decode((string) ($stored['tag'] ?? ''), true);
    $data = base64_decode((string) ($stored['data'] ?? ''), true);
    if ($iv === false || strlen($iv) !== 12 || $tag === false || strlen($tag) !== 16 || $data === false) {
        return null;
    }
    $plain = openssl_decrypt($data, CIPHER, $secret, OPENSSL_RAW_DATA, $iv, $tag);
    if ($plain === false) {
        return null;
    }
    $park = json_decode($plain, true);
    if (!is_array($park)) {
        return null;
    }
    foreach (['lat', 'lng', 'accuracy', 'since', 'at'] as $field) {
        if (!isset($park[$field]) || !is_numeric($park[$field])) {
            return null;
        }
    }
    return [
        'lat' => (float) $park['lat'],
        'lng' => (float) $park['lng'],
        'accuracy' => (float) $park['accuracy'],
        'moving' => ($park['moving'] ?? false) === true,
        'since' => (int) $park['since'],
        'at' => (int) $park['at'],
        'tripSince' => isset($park['tripSince']) && is_numeric($park['tripSince']) ? (int) $park['tripSince'] : null,
    ];
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST only');
}

if (!function_exists('openssl_encrypt') || !function_exists('hash_hkdf')) {
    fail(500, 'crypto unavailable');
}

// 車は画面が消えるときにも送ってくる(sendBeacon)。そのときは text/plain で届くが、
// 中身は同じ JSON なので、種類は見ずに読む。
$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
    fail(413, 'body too large');
}

$body = json_decode($raw, true);
if (!is_array($body)) {
    fail(400, 'invalid json');
}

$key = is_string($body['key'] ?? null) ? trim($body['key']) : '';
$keyLength = strlen($key);
if ($keyLength < MIN_KEY_LENGTH || $keyLength > MAX_KEY_LENGTH) {
    fail(400, 'invalid key');
}

$dir = __DIR__ . '/data';
if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
    fail(500, 'storage unavailable');
}

// 保存先を直接ダウンロードされないように塞いでおく(settings.php と同じ二重防御)。
$guard = $dir . '/.htaccess';
if (!file_exists($guard)) {
    @file_put_contents($guard, "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
}

$file = $dir . '/' . hash('sha256', $key) . '.park.json';
// 位置を暗号化する鍵。ファイル名(合言葉のハッシュ)とは別の作り方にする。
$secret = hash_hkdf('sha256', $key, 32, 'zcar-park-v1');
$now = (int) round(microtime(true) * 1000);

// --- 読み取り: park が無いリクエストは読むだけ ---
if (!array_key_exists('park', $body)) {
    echo json_encode(['ok' => true, 'park' => readPark($file, $secret), 'now' => $now]);
    exit;
}

// --- 書き込み ---
$incoming = $body['park'];
if (!is_array($incoming)) {
    fail(400, 'invalid park');
}
$lat = $incoming['lat'] ?? null;
$lng = $incoming['lng'] ?? null;
$accuracy = $incoming['accuracy'] ?? 0;
$isNumber = static fn ($value): bool => is_int($value) || is_float($value);
if (!$isNumber($lat) || !$isNumber($lng) || !$isNumber($accuracy)) {
    fail(400, 'invalid position');
}
$lat = (float) $lat;
$lng = (float) $lng;
$accuracy = max(0.0, (float) $accuracy);
if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180 || $accuracy > MAX_ACCURACY_METERS) {
    fail(400, 'invalid position');
}

// 前と同じ場所なら、その場所に来た時刻を引き継ぐ(止まっている間に何度届いても変わらない)。
$since = $now;
$previous = readPark($file, $secret);
if (
    $previous !== null
    && distanceMeters($previous['lat'], $previous['lng'], $lat, $lng) <= max(SAME_PLACE_METERS, $accuracy)
) {
    $since = min($now, $previous['since']);
}

// 走り出してからの長さ(ミリ秒)を、サーバーの時計で「走り出した時刻」にする。
$drivingMs = $incoming['drivingMs'] ?? null;
$tripSince = $isNumber($drivingMs) && $drivingMs >= 0 && $drivingMs <= MAX_TRIP_MS
    ? $now - (int) round((float) $drivingMs)
    : null;

$park = [
    'lat' => round($lat, 6),
    'lng' => round($lng, 6),
    'accuracy' => round($accuracy),
    'moving' => ($incoming['moving'] ?? false) === true,
    'since' => $since,
    'at' => $now,
    'tripSince' => $tripSince,
];

$iv = random_bytes(12);
$tag = '';
$data = openssl_encrypt((string) json_encode($park), CIPHER, $secret, OPENSSL_RAW_DATA, $iv, $tag);
if ($data === false) {
    fail(500, 'could not save');
}
$payload = json_encode([
    'v' => 1,
    'iv' => base64_encode($iv),
    'tag' => base64_encode($tag),
    'data' => base64_encode($data),
]);
// 書きかけのファイルを読まれないよう、別のファイルに書いてから置き換える。
$temporary = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
if ($payload === false || @file_put_contents($temporary, $payload) === false) {
    @unlink($temporary);
    fail(500, 'could not save');
}
@chmod($temporary, 0600);
if (!@rename($temporary, $file)) {
    @unlink($temporary);
    fail(500, 'could not save');
}

echo json_encode(['ok' => true, 'since' => $since, 'at' => $now]);
