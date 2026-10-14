<?php
/**
 * Z CAR 目的地をショートカットから送る (エックスサーバー上の PHP で動きます)
 *
 * iPhone の「ショートカット」アプリから、Google マップで共有した場所を受け取り、
 * 車とスマホの目的地の一覧に足します(車にも自動で届きます)。
 *
 * 1. 鍵を作る(スマホの Z CAR が呼ぶ。POST・JSON):
 *      {"key":"同期の合言葉","issue":true}  ->  {"ok":true,"token":"…"}
 *    作り直すと、前の鍵は使えなくなります。
 * 2. 送る(ショートカットが呼ぶ。POST・JSON):
 *      share.php?k=鍵   本文 {"text":"共有された内容"}(キーの名前は問わない)
 *      ->  通知にそのまま出す文(text/plain)
 *
 * この鍵でできるのは目的地を足すことだけです(給油記録や目的地を読むことはできません)。
 * サーバーには鍵そのものは置かず、ハッシュだけを置きます。
 */

declare(strict_types=1);

require __DIR__ . '/place-lib.php';

const MAX_BODY_BYTES = 8192;
const MAX_TEXT_LENGTH = 2000;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;
/** 目的地の上限(settings.php・スマホと同じ)。 */
const MAX_PLACES = 30;

header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

/** ショートカットへの返事。通知にそのまま出るので、ふつうの文で返す。 */
function reply(string $message): void
{
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

/** スマホの Z CAR への返事(JSON)。 */
function fail(int $status, string $message): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

/** 書きかけを読まれないよう、別のファイルに書いてから置き換える。 */
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

const RECOPY = 'Z CAR の目的地の「Google マップから直接送る」で、送り先をコピーし直してください。';

$dir = __DIR__ . '/data';
$fromShortcut = isset($_GET['k']);

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    if ($fromShortcut) {
        reply('ショートカットの「URLの内容を取得」の「方法」を POST にしてください。');
    }
    fail(405, 'POST only');
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > MAX_BODY_BYTES) {
    if ($fromShortcut) {
        reply('送られた内容が大きすぎます。');
    }
    fail(413, 'body too large');
}
$body = json_decode((string) $raw, true);

// --- 1. 鍵を作る(スマホの Z CAR から) ---
if (!$fromShortcut) {
    if (!is_array($body) || ($body['issue'] ?? false) !== true) {
        fail(400, 'invalid request');
    }
    $key = is_string($body['key'] ?? null) ? trim($body['key']) : '';
    $keyLength = strlen($key);
    if ($keyLength < MIN_KEY_LENGTH || $keyLength > MAX_KEY_LENGTH) {
        fail(400, 'invalid key');
    }
    $settingsHash = hash('sha256', $key);
    if (!is_file("$dir/$settingsHash.json")) {
        fail(403, 'not paired');
    }
    // 前に作った鍵は使えなくする(1つの合言葉に鍵は1つ)。
    $pointer = "$dir/$settingsHash.share";
    $previous = is_file($pointer) ? trim((string) file_get_contents($pointer)) : '';
    if (preg_match('/^[0-9a-f]{64}$/', $previous)) {
        @unlink("$dir/share-$previous.json");
    }
    $token = bin2hex(random_bytes(16));
    $tokenHash = hash('sha256', $token);
    $link = json_encode(['settings' => $settingsHash, 'createdAt' => (int) round(microtime(true) * 1000)]);
    if ($link === false || !writeAtomic("$dir/share-$tokenHash.json", $link) || !writeAtomic($pointer, $tokenHash)) {
        fail(500, 'could not save');
    }
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => true, 'token' => $token]);
    exit;
}

// --- 2. ショートカットから送る ---
$token = is_string($_GET['k']) ? $_GET['k'] : '';
if (!preg_match('/^[0-9a-f]{32}$/', $token)) {
    reply('送り先が違います。' . RECOPY);
}
$linkFile = "$dir/share-" . hash('sha256', $token) . '.json';
$link = is_file($linkFile) ? json_decode((string) file_get_contents($linkFile), true) : null;
$settingsHash = is_array($link) && is_string($link['settings'] ?? null) ? $link['settings'] : '';
$settingsFile = "$dir/$settingsHash.json";
if (!preg_match('/^[0-9a-f]{64}$/', $settingsHash) || !is_file($settingsFile)) {
    reply('この送り先は使えなくなっています。' . RECOPY);
}

// 共有された内容。本文の文字をすべてつなげて読む(JSON のキーの名前は問わない)。
$text = '';
if (is_array($body)) {
    array_walk_recursive($body, static function ($value) use (&$text): void {
        if (is_string($value)) {
            $text .= "\n" . $value;
        }
    });
} else {
    $text = (string) $raw;
}
$text = mb_substr(trim($text), 0, MAX_TEXT_LENGTH, 'UTF-8');
if ($text === '') {
    reply('共有された場所が届いていません。ショートカットの本文に「ショートカットの入力」を入れてください。');
}

$place = resolvePlace($text);
if ($place === 'no link' || $place === 'not google maps') {
    reply('Google マップの場所を共有してください。');
}
$entry = is_array($place) ? placeEntry($place) : null;
if ($entry === null) {
    reply('場所を読み取れませんでした。Z CAR の目的地の「FROM MAPS」でも試してください。');
}

// 目的地の一覧に足す。
$stored = json_decode((string) file_get_contents($settingsFile), true);
if (!is_array($stored) || !is_array($stored['settings'] ?? null)) {
    reply('Z CAR の設定を読めませんでした。Z CAR を一度開いてから送ってください。');
}
$settings = $stored['settings'];
if (!isset($settings['places']) || !is_array($settings['places'])) {
    // 前の版の1〜5の枠しか無いときは、Z CAR が一覧に移してから足す。
    reply('Z CAR を一度開いてから送ってください。');
}
$places = $settings['places'];
foreach ($places as $existing) {
    if (is_array($existing) && ($existing['destination'] ?? '') === $entry['destination']) {
        reply("「{$entry['label']}」は、もう目的地にあります。");
    }
}
if (count($places) >= MAX_PLACES) {
    reply('目的地がいっぱいです(' . MAX_PLACES . '件まで)。Z CAR で減らしてから送ってください。');
}
$places[] = [
    'id' => 'share-' . base_convert((string) time(), 10, 36) . bin2hex(random_bytes(3)),
    'label' => $entry['label'],
    'destination' => $entry['destination'],
];
$settings['places'] = $places;

$payload = json_encode(
    ['updatedAt' => (int) round(microtime(true) * 1000), 'settings' => $settings],
    JSON_UNESCAPED_UNICODE,
);
// 上書きする前の内容を1世代だけ控えておく(settings.php と同じ)。
if (@copy($settingsFile, $settingsFile . '.bak')) {
    @chmod($settingsFile . '.bak', 0600);
}
if ($payload === false || !writeAtomic($settingsFile, $payload)) {
    reply('保存できませんでした。少しあとで、もう一度送ってください。');
}

reply("「{$entry['label']}」を目的地に追加しました。車にも届きます。");
