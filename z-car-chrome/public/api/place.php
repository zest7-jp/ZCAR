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

const MAX_BODY_BYTES = 8192;
const MAX_TEXT_LENGTH = 2000;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;
/** リンクをたどる回数の上限。 */
const MAX_HOPS = 5;
const PREFECTURE = '(北海道|東京都|大阪府|京都府|(青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県)';

/** たどってよい Google マップのアドレスか(https だけ)。 */
function isMapsUrl(string $url): bool
{
    $parts = parse_url($url);
    if (!is_array($parts) || strtolower($parts['scheme'] ?? '') !== 'https') {
        return false;
    }
    $host = strtolower($parts['host'] ?? '');
    $path = $parts['path'] ?? '/';
    if ($host === 'maps.app.goo.gl' || $host === 'maps.google.com' || $host === 'maps.google.co.jp') {
        return true;
    }
    if ($host === 'goo.gl') {
        return strpos($path, '/maps') === 0;
    }
    if (in_array($host, ['www.google.com', 'google.com', 'www.google.co.jp', 'google.co.jp'], true)) {
        return strpos($path, '/maps') === 0;
    }
    return false;
}

/** 全角の英数字・記号・空白を半角にする(住所の「１丁目１２−１」を「1丁目12-1」に)。 */
function halfWidth(string $text): string
{
    $text = mb_convert_kana($text, 'as', 'UTF-8');
    return str_replace(["\u{2212}", "\u{2010}", "\u{2011}", "\u{2013}"], '-', $text);
}

/** 住所の書き出しか(〒・郵便番号・都道府県で始まる)。 */
function looksLikeAddress(string $text): bool
{
    return (bool) preg_match('/^(〒|\d{3}-?\d{4}\s|' . PREFECTURE . ')/u', $text);
}

/** 「名前, 住所」の形を分ける。住所だけなら名前は空、名前だけなら住所は空。 */
function splitNameAddress(string $text): array
{
    $clean = static fn (string $part): string => trim((string) preg_replace('/^日本[、,]\s*/u', '', trim($part)));
    $text = $clean((string) preg_replace('/\s+/u', ' ', $text));
    $pieces = preg_split('/\s*,\s*/u', $text, 2);
    if (is_array($pieces) && count($pieces) === 2 && !looksLikeAddress($pieces[0])) {
        return [$pieces[0], $clean($pieces[1])];
    }
    return looksLikeAddress($text) ? ['', $text] : [$text, ''];
}

/**
 * Google マップのアドレスから、名前・住所・場所を読む。何も読めなければ null。
 * 読める形: ?q=名前,+住所 / ?q=緯度,経度 / /maps/place/名前/@…!3d緯度!4d経度 /
 *           /maps/search/文字/ / ?query= / ?daddr= / ?destination= / ?ll=
 */
function readPlace(string $url): ?array
{
    $parts = parse_url($url);
    if (!is_array($parts)) {
        return null;
    }
    $query = [];
    parse_str($parts['query'] ?? '', $query);
    $path = $parts['path'] ?? '';
    $lat = null;
    $lng = null;
    $text = '';

    // 店そのものの場所(!3d緯度!4d経度)。地図の真ん中(@緯度,経度)より正確。
    if (preg_match('/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/', $url, $match)) {
        $lat = (float) $match[1];
        $lng = (float) $match[2];
    }
    if (preg_match('#/maps/(?:place|search)/([^/]+)#', $path, $match)) {
        $text = str_replace('+', ' ', rawurldecode($match[1]));
    }
    foreach (['q', 'query', 'daddr', 'destination'] as $field) {
        if ($text === '' && isset($query[$field]) && is_string($query[$field])) {
            $text = $query[$field];
        }
    }
    $text = trim(halfWidth($text));
    // 文字が「緯度,経度」だけのとき。
    if (preg_match('/^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/', $text, $match)) {
        $lat = $lat ?? (float) $match[1];
        $lng = $lng ?? (float) $match[2];
        $text = '';
    }
    if ($lat === null && isset($query['ll']) && is_string($query['ll'])
        && preg_match('/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/', $query['ll'], $match)) {
        $lat = (float) $match[1];
        $lng = (float) $match[2];
    }
    if ($lat === null && $text !== '' && preg_match('#/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)#', $path, $match)) {
        $lat = (float) $match[1];
        $lng = (float) $match[2];
    }
    if ($lat !== null && (abs($lat) > 90 || abs((float) $lng) > 180)) {
        $lat = null;
        $lng = null;
    }

    [$name, $address] = $text === '' ? ['', ''] : splitNameAddress($text);
    if ($name === '' && $address === '' && $lat === null) {
        return null;
    }
    return [
        'name' => mb_substr($name, 0, 80, 'UTF-8'),
        'address' => mb_substr($address, 0, 160, 'UTF-8'),
        'lat' => $lat,
        'lng' => $lng,
    ];
}

/** 移動先が相対(/maps/…)で書かれていても、https:// から始まる形にする。 */
function absoluteUrl(string $location, string $base): string
{
    if (preg_match('#^https?://#i', $location)) {
        return $location;
    }
    if (strpos($location, '//') === 0) {
        return 'https:' . $location;
    }
    $host = parse_url($base, PHP_URL_HOST);
    return strpos($location, '/') === 0 && is_string($host) ? 'https://' . $host . $location : '';
}

/** 1回だけ開いて、移動先(Location)を返す。移動しなければ null。中身は読まない。 */
function nextLocation(string $url): ?string
{
    if (!function_exists('curl_init')) {
        return null;
    }
    $headers = [];
    $handle = curl_init($url);
    curl_setopt_array($handle, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 8,
        CURLOPT_USERAGENT => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 '
            . '(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
        CURLOPT_HTTPHEADER => ['Accept-Language: ja'],
        CURLOPT_HEADERFUNCTION => static function ($curl, string $line) use (&$headers): int {
            $pair = explode(':', $line, 2);
            if (count($pair) === 2) {
                $headers[strtolower(trim($pair[0]))] = trim($pair[1]);
            }
            return strlen($line);
        },
        // 中身(ページ)はいらないので、届き始めたら止める。
        CURLOPT_WRITEFUNCTION => static fn ($curl, string $data): int => 0,
    ]);
    curl_exec($handle);
    $status = (int) curl_getinfo($handle, CURLINFO_RESPONSE_CODE);
    curl_close($handle);
    if ($status < 300 || $status >= 400 || empty($headers['location'])) {
        return null;
    }
    $next = absoluteUrl($headers['location'], $url);
    return $next === '' ? null : $next;
}

// テストから関数だけを読み込むときは、ここで止める。
if (defined('ZCAR_PLACE_TEST')) {
    return;
}

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
if (!preg_match('#https://[^\s<>"\']+#u', $text, $match)) {
    fail(422, 'no link');
}

$url = $match[0];
for ($hop = 0; $hop <= MAX_HOPS; $hop++) {
    if (!isMapsUrl($url)) {
        fail(422, 'not google maps');
    }
    $place = readPlace($url);
    if ($place !== null) {
        echo json_encode(['ok' => true] + $place, JSON_UNESCAPED_UNICODE);
        exit;
    }
    $next = nextLocation($url);
    if ($next === null) {
        break;
    }
    $url = $next;
}

echo json_encode(['ok' => false, 'error' => 'unreadable']);
