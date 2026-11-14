<?php
/**
 * Z CAR 車両位置 (エックスサーバー上の PHP で動きます)
 *
 * 車載機が、いまいる場所をここへ送ります。スマホはここを読んで、車を停めた
 * 場所(最後に届いた場所)を地図に出します。持っているのは最後の1件だけです。
 * 同期と同じ合言葉を知っている人だけが読み書きできます。
 *
 * 使い方 (どれも POST・JSON):
 *   読む : {"key":"合言葉"}
 *          -> {"ok":true,"park":{...}|null,"now":1234567890000}
 *   書く : {"key":"合言葉","park":{"lat":34.6,"lng":135.5,"accuracy":12,"moving":false}}
 *          -> {"ok":true,"since":1234567890000,"at":1234567890000}
 *   知らせ: {"key":"合言葉","alive":true}
 *          -> {"ok":true,"heard":1234567890000|null}
 *
 *   CarPlay の鍵を作る(スマホの Z CAR が呼ぶ): {"key":"合言葉","issue":true}
 *          -> {"ok":true,"token":"…"}   作り直すと、前の鍵は使えなくなる。
 *   CarPlay から送る(iPhone のショートカットが呼ぶ): park.php?t=鍵  本文 {"lat":34.6,"lng":135.5}
 *          -> 通知にそのまま出す文(text/plain)
 *
 * 車載機を CarPlay の画面にしている間は、車の Z CAR は場所を送れない。そこで CarPlay が切れたとき
 * (エンジンを切ったとき)に、iPhone のショートカットが今いる場所を「停めた場所」として送る。
 * この鍵でできるのは、停めた場所を送ることだけ(読むことはできない)。
 * サーバーには鍵そのものは置かず、ハッシュと、鍵で包んだ「位置を暗号化する鍵」だけを置く
 * (保存したファイルだけを見ても、場所は分からないまま)。
 *
 * park の since はその場所に来た時刻、at は最後に位置が届いた時刻、heard は最後に
 * 車から知らせが届いた時刻(どれもこのサーバーの時計のミリ秒)。前と同じ場所なら since を引き継ぐ。
 * GPS が使えない間(屋根の下など)は、車は電源が入っていることだけを知らせてくる(alive)。
 * そのときは場所は変えずに heard だけ進める。
 * 車の画面が消えるとき(エンジンを切ったなど)の最後の知らせには hidden が付く。
 * 画面に戻って次の知らせ(場所・電源)が届けば消える。
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
    $plain = unseal($stored, $secret);
    if ($plain === null) {
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
        // 前の版で保存した場所には無い。そのときは位置が届いた時刻。
        'heard' => isset($park['heard']) && is_numeric($park['heard'])
            ? max((int) $park['heard'], (int) $park['at'])
            : (int) $park['at'],
        'tripSince' => isset($park['tripSince']) && is_numeric($park['tripSince']) ? (int) $park['tripSince'] : null,
        'hidden' => ($park['hidden'] ?? false) === true,
    ];
}

/** 書きかけのファイルを読まれないよう、別のファイルに書いてから置き換える。 */
function writeAtomic(string $file, string $content): bool
{
    $temporary = $file . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($temporary, $content) === false) {
        @unlink($temporary);
        return false;
    }
    @chmod($temporary, 0600);
    if (!@rename($temporary, $file)) {
        @unlink($temporary);
        return false;
    }
    return true;
}

/** 中身を暗号化した形(iv・tag・data)にする。できなければ null。 */
function seal(string $plain, string $secret): ?array
{
    $iv = random_bytes(12);
    $tag = '';
    $data = openssl_encrypt($plain, CIPHER, $secret, OPENSSL_RAW_DATA, $iv, $tag);
    if ($data === false) {
        return null;
    }
    return ['iv' => base64_encode($iv), 'tag' => base64_encode($tag), 'data' => base64_encode($data)];
}

/** seal したものを元に戻す。壊れている・鍵が合わないときは null。 */
function unseal(array $stored, string $secret): ?string
{
    $iv = base64_decode((string) ($stored['iv'] ?? ''), true);
    $tag = base64_decode((string) ($stored['tag'] ?? ''), true);
    $data = base64_decode((string) ($stored['data'] ?? ''), true);
    if ($iv === false || strlen($iv) !== 12 || $tag === false || strlen($tag) !== 16 || $data === false) {
        return null;
    }
    $plain = openssl_decrypt($data, CIPHER, $secret, OPENSSL_RAW_DATA, $iv, $tag);
    return $plain === false ? null : $plain;
}

/** 場所を暗号化して保存する。保存できたか。 */
function writePark(string $file, string $secret, array $park): bool
{
    $sealed = seal((string) json_encode($park), $secret);
    if ($sealed === null) {
        return false;
    }
    $payload = json_encode(['v' => 1] + $sealed);
    return $payload !== false && writeAtomic($file, $payload);
}

/**
 * 新しく届いた場所の、その場所に来た時刻。前と同じ場所(誤差のうち)なら、前の来た時刻を引き継ぐ
 * (止まっている間に何度届いても変わらない)。
 */
function arrivedAt(?array $previous, float $lat, float $lng, float $accuracy, int $now): int
{
    if (
        $previous !== null
        && distanceMeters($previous['lat'], $previous['lng'], $lat, $lng) <= max(SAME_PLACE_METERS, $accuracy)
    ) {
        return min($now, $previous['since']);
    }
    return $now;
}

/** ショートカットへの返事。通知にそのまま出るので、ふつうの文で返す。 */
function reply(string $message): void
{
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

/** 緯度・経度として読める値(数か、数の文字)。 */
function numberIn($value): ?float
{
    if (is_int($value) || is_float($value)) {
        return (float) $value;
    }
    if (is_string($value) && preg_match('/^\s*-?\d+(\.\d+)?\s*$/', $value)) {
        return (float) $value;
    }
    return null;
}

/**
 * ショートカットが送ってきた本文から、緯度・経度を読む。
 * {"lat":…,"lng":…}(latitude・longitude・緯度・経度でもよい)か、「34.70, 135.53」のような文字。
 */
function pointIn($body, string $raw): ?array
{
    if (is_array($body)) {
        $lat = null;
        $lng = null;
        array_walk_recursive($body, static function ($value, $name) use (&$lat, &$lng): void {
            $name = mb_strtolower((string) $name, 'UTF-8');
            if ($lat === null && in_array($name, ['lat', 'latitude', '緯度'], true)) {
                $lat = numberIn($value);
            } elseif ($lng === null && in_array($name, ['lng', 'lon', 'long', 'longitude', '経度'], true)) {
                $lng = numberIn($value);
            }
        });
        if ($lat !== null && $lng !== null) {
            return [$lat, $lng];
        }
    }
    if (preg_match('/(-?\d{1,2}\.\d+)\s*[,、]\s*(-?\d{1,3}\.\d+)/u', $raw, $match)) {
        return [(float) $match[1], (float) $match[2]];
    }
    return null;
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
$dir = __DIR__ . '/data';
$now = (int) round(microtime(true) * 1000);
const RECOPY = 'スマホの Z CAR の車両位置で「CarPlay のとき」を開き、送り先をコピーし直してください。';

// --- CarPlay から送る: iPhone のショートカットが、CarPlay が切れたときに今いる場所を送る ---
if (isset($_GET['t'])) {
    $token = is_string($_GET['t']) ? $_GET['t'] : '';
    if (!preg_match('/^[0-9a-f]{32}$/', $token)) {
        reply('送り先が違います。' . RECOPY);
    }
    $link = null;
    $linkFile = "$dir/parktoken-" . hash('sha256', $token) . '.json';
    if (is_file($linkFile)) {
        $link = json_decode((string) file_get_contents($linkFile), true);
    }
    $parkName = is_array($link) && is_string($link['park'] ?? null) ? $link['park'] : '';
    $secret = is_array($link) ? unseal($link, hash_hkdf('sha256', $token, 32, 'zcar-park-token-v1')) : null;
    if (!preg_match('/^[0-9a-f]{64}$/', $parkName) || $secret === null || strlen($secret) !== 32) {
        reply('この送り先は使えなくなっています。' . RECOPY);
    }
    $point = pointIn($body, (string) $raw);
    if ($point === null) {
        reply('場所が届いていません。ショートカットの本文に、現在地の緯度(lat)と経度(lng)を入れてください。');
    }
    [$lat, $lng] = $point;
    if ($lat < -90 || $lat > 90 || $lng < -180 || $lng > 180 || ($lat === 0.0 && $lng === 0.0)) {
        reply('場所を読み取れませんでした。ショートカットの「現在地を取得」を確かめてください。');
    }
    $accuracy = is_array($body) ? numberIn($body['accuracy'] ?? null) : null;
    $accuracy = $accuracy === null ? 30.0 : max(0.0, min((float) MAX_ACCURACY_METERS, $accuracy));
    $file = "$dir/$parkName.park.json";
    $previous = readPark($file, $secret);
    // 停めた場所として残す(エンジンを切ったときと同じ「画面が消えた」印を付け、スマホはすぐ駐車中にする)。
    $park = [
        'lat' => round($lat, 6),
        'lng' => round($lng, 6),
        'accuracy' => round($accuracy),
        'moving' => false,
        'since' => arrivedAt($previous, $lat, $lng, $accuracy, $now),
        'at' => $now,
        'heard' => $now,
        'tripSince' => null,
        'hidden' => true,
    ];
    if (!writePark($file, $secret, $park)) {
        reply('保存できませんでした。少しあとで、もう一度送ってください。');
    }
    reply('停めた場所を Z CAR に送りました。');
}

if (!is_array($body)) {
    fail(400, 'invalid json');
}

$key = is_string($body['key'] ?? null) ? trim($body['key']) : '';
$keyLength = strlen($key);
if ($keyLength < MIN_KEY_LENGTH || $keyLength > MAX_KEY_LENGTH) {
    fail(400, 'invalid key');
}

if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
    fail(500, 'storage unavailable');
}

// 保存先を直接ダウンロードされないように塞いでおく(settings.php と同じ二重防御)。
$guard = $dir . '/.htaccess';
if (!file_exists($guard)) {
    @file_put_contents($guard, "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
}

$parkName = hash('sha256', $key);
$file = "$dir/$parkName.park.json";
// 位置を暗号化する鍵。ファイル名(合言葉のハッシュ)とは別の作り方にする。
$secret = hash_hkdf('sha256', $key, 32, 'zcar-park-v1');

// --- CarPlay の鍵を作る: 位置を暗号化する鍵を、新しい鍵で包んで置く(作り直すと前の鍵は使えない) ---
if (($body['issue'] ?? false) === true) {
    $token = bin2hex(random_bytes(16));
    $sealed = seal($secret, hash_hkdf('sha256', $token, 32, 'zcar-park-token-v1'));
    $link = $sealed === null ? false : json_encode(['v' => 1, 'park' => $parkName] + $sealed);
    $pointer = "$dir/$parkName.parktoken";
    $old = is_file($pointer) ? trim((string) file_get_contents($pointer)) : '';
    $tokenHash = hash('sha256', $token);
    if ($link === false || !writeAtomic("$dir/parktoken-$tokenHash.json", $link) || !writeAtomic($pointer, $tokenHash)) {
        fail(500, 'could not save');
    }
    if (preg_match('/^[0-9a-f]{64}$/', $old) && $old !== $tokenHash) {
        @unlink("$dir/parktoken-$old.json");
    }
    echo json_encode(['ok' => true, 'token' => $token]);
    exit;
}

// --- 知らせ: 電源が入っていることだけ(GPS が使えないときなど)。場所は変えない ---
if (($body['alive'] ?? false) === true && !array_key_exists('park', $body)) {
    $previous = readPark($file, $secret);
    if ($previous === null) {
        // まだ場所が無ければ、残すものは無い。
        echo json_encode(['ok' => true, 'heard' => null]);
        exit;
    }
    $previous['heard'] = max($now, $previous['heard']);
    // 知らせは画面が出ているときだけ届くので、画面が消えた印は消す。
    $previous['hidden'] = false;
    if (!writePark($file, $secret, $previous)) {
        fail(500, 'could not save');
    }
    echo json_encode(['ok' => true, 'heard' => $previous['heard']]);
    exit;
}

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
$since = arrivedAt(readPark($file, $secret), $lat, $lng, $accuracy, $now);

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
    'heard' => $now,
    'tripSince' => $tripSince,
    'hidden' => ($incoming['hidden'] ?? false) === true,
];
if (!writePark($file, $secret, $park)) {
    fail(500, 'could not save');
}

echo json_encode(['ok' => true, 'since' => $since, 'at' => $now]);
