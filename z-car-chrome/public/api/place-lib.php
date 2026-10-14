<?php
/**
 * Z CAR 目的地の読み取り(共通の部品)。place.php と share.php から読み込む。
 *
 * Google マップで共有・コピーされたリンク(maps.app.goo.gl/…)の行き先をたどって、
 * 店の名前・住所・場所(緯度・経度)を読む。たどるのは Google マップのアドレスだけ。
 * 名前と行き先の作り方は、スマホの app/place-import.ts と同じ決まりにしてある。
 */

declare(strict_types=1);

// この部品だけを直接開かれたときは、何もしない。
if (basename($_SERVER['SCRIPT_FILENAME'] ?? '') === basename(__FILE__)) {
    http_response_code(404);
    exit;
}

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

/**
 * 共有・コピーされた文字から Google マップのリンクを取り出し、たどって場所を読む。
 * 読めたら readPlace の形の配列、読めなければ理由('no link' / 'not google maps' / 'unreadable')。
 */
function resolvePlace(string $text)
{
    if (!preg_match('#https://[^\s<>"\']+#u', $text, $match)) {
        return 'no link';
    }
    $url = $match[0];
    for ($hop = 0; $hop <= MAX_HOPS; $hop++) {
        if (!isMapsUrl($url)) {
            return 'not google maps';
        }
        $place = readPlace($url);
        if ($place !== null) {
            return $place;
        }
        $next = nextLocation($url);
        if ($next === null) {
            break;
        }
        $url = $next;
    }
    return 'unreadable';
}

/** 名前も住所も無い場所(地図に落としたピン)の名前。スマホの place-import.ts と同じ。 */
const PIN_LABEL = '地図の場所';

/**
 * 読んだ場所から、目的地の名前(8文字まで)と行き先を作る。
 * 名前と住所があれば両方(ナビが店を見つけやすい)。住所が無ければ場所(緯度,経度)。
 */
function placeEntry(array $place): ?array
{
    $name = trim((string) ($place['name'] ?? ''));
    $address = trim((string) ($place['address'] ?? ''));
    $coords = isset($place['lat'], $place['lng'])
        ? sprintf('%.6f,%.6f', (float) $place['lat'], (float) $place['lng'])
        : '';
    if ($name !== '' && $address !== '') {
        $destination = $name . ' ' . $address;
    } elseif ($address !== '') {
        $destination = $address;
    } elseif ($coords !== '') {
        $destination = $coords;
    } else {
        $destination = $name;
    }
    if ($destination === '') {
        return null;
    }
    return [
        'label' => mb_substr($name !== '' ? $name : ($address !== '' ? $address : PIN_LABEL), 0, 8, 'UTF-8'),
        'destination' => mb_substr($destination, 0, 200, 'UTF-8'),
    ];
}
