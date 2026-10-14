<?php
/**
 * Z CAR 目的地の読み取り (エックスサーバー上の PHP で動きます)
 *
 * スマホで Google マップの「共有」→「コピー」をして Z CAR の目的地に貼り付けると、
 * コピーした内容がここに届きます。中の短いリンク(maps.app.goo.gl/…)の行き先をたどって、
 * 店の名前・住所・場所(緯度・経度)を読み取って返します。
 * (リンクの行き先は、スマホのブラウザからは読めないため、サーバーで読みます)
 *
 * 使い方 (POST・JSON):
 *   {"key":"合言葉","text":"コピーした内容"}
 *   -> {"ok":true,"name":"松屋 高石店","address":"〒592-0005 大阪府高石市…","lat":34.52,"lng":135.44}
 *   -> {"ok":false,"error":"unreadable"}   読み取れなかったとき
 *
 * 車とつないだ端末(サーバーに設定がある合言葉)だけが使えます。
 * たどるのは Google マップのアドレスだけです(ほかのサイトは開きません)。
 */

declare(strict_types=1);

require __DIR__ . '/place-lib.php';

const MAX_BODY_BYTES = 8192;
const MAX_TEXT_LENGTH = 2000;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function fail(int $status, string $message): void
{
    http_response_code($status);
    echo json_encode(['ok' => false, 'error' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    fail(405, 'POST only');
}

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
// 車とつないだ合言葉(サーバーに設定がある)だけ。よその人に「リンクを開く係」にされないため。
if (!is_file(__DIR__ . '/data/' . hash('sha256', $key) . '.json')) {
    fail(403, 'not paired');
}

$text = is_string($body['text'] ?? null) ? mb_substr(trim($body['text']), 0, MAX_TEXT_LENGTH, 'UTF-8') : '';
$place = resolvePlace($text);
if ($place === 'no link' || $place === 'not google maps') {
    fail(422, $place);
}
if (!is_array($place)) {
    echo json_encode(['ok' => false, 'error' => 'unreadable']);
    exit;
}
echo json_encode(['ok' => true] + $place, JSON_UNESCAPED_UNICODE);
