<?php
/**
 * Z CAR 設定同期エンドポイント (エックスサーバー上の PHP で動きます)
 *
 * スマホで変えた設定を車載機にも反映させるための、とても小さな置き場です。
 * 同期キー(合言葉)を知っている人だけが読み書きできます。
 *
 * 使い方 (どちらも POST・JSON):
 *   読む   : {"key":"合言葉"}
 *            -> {"ok":true,"settings":{...}|null,"updatedAt":0}
 *   書く   : {"key":"合言葉","updatedAt":1234567890000,"settings":{...}}
 *            -> {"ok":true,"updatedAt":1234567890000}
 *
 * 保存先のファイル名は合言葉のハッシュなので、合言葉を知らなければ
 * ファイルの場所も分かりません。加えて data/ 自体を .htaccess で
 * 直接アクセス禁止にしています。
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

const MAX_BODY_BYTES = 65536;
const MAX_FUEL_ENTRIES = 120;
const MAX_PLAYLISTS = 8;
const MAX_PLAYLIST_LABEL = 24;
const MAP_DESTINATION_COUNT = 5;
const MAX_DESTINATION_LABEL = 8;
const MAX_DESTINATION_TEXT = 200;
const MIN_KEY_LENGTH = 8;
const MAX_KEY_LENGTH = 128;

/** 同期する項目。これ以外は受け取っても保存しない(APIキーや走行状態は端末ごと)。 */
const ALLOWED_FIELDS = [
    'meterTheme'  => 24,
    'storeName'   => 120,
    'storeDest'   => 200,
    'start'       => 5,
    'homeDest'    => 200,
    'carId'       => 40,
];

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

$dir = __DIR__ . '/data';
if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
    fail(500, 'storage unavailable');
}

// 保存先を直接ダウンロードされないように塞いでおく(念のための二重防御)。
$guard = $dir . '/.htaccess';
if (!file_exists($guard)) {
    @file_put_contents($guard, "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n");
}

$file = $dir . '/' . hash('sha256', $key) . '.json';

// --- 読み取り: settings が無いリクエストは読むだけ ---
if (!array_key_exists('settings', $body)) {
    if (!is_file($file)) {
        echo json_encode(['ok' => true, 'settings' => null, 'updatedAt' => 0]);
        exit;
    }
    $stored = json_decode((string) file_get_contents($file), true);
    if (!is_array($stored)) {
        echo json_encode(['ok' => true, 'settings' => null, 'updatedAt' => 0]);
        exit;
    }
    echo json_encode([
        'ok' => true,
        'settings' => $stored['settings'] ?? null,
        'updatedAt' => (int) ($stored['updatedAt'] ?? 0),
    ], JSON_UNESCAPED_UNICODE);
    exit;
}

// --- 書き込み ---
$incoming = $body['settings'];
if (!is_array($incoming)) {
    fail(400, 'invalid settings');
}

// いま保存されている内容。送られてこなかった項目を消さないために使う。
$previous = [];
if (is_file($file)) {
    $decoded = json_decode((string) file_get_contents($file), true);
    if (is_array($decoded) && isset($decoded['settings']) && is_array($decoded['settings'])) {
        $previous = $decoded['settings'];
    }
}

$clean = [];
foreach (ALLOWED_FIELDS as $field => $maxLength) {
    if (!isset($incoming[$field]) || !is_string($incoming[$field])) {
        continue;
    }
    $value = $incoming[$field];
    if (mb_strlen($value, 'UTF-8') > $maxLength) {
        $value = mb_substr($value, 0, $maxLength, 'UTF-8');
    }
    $clean[$field] = $value;
}
// プレイリストは配列なので個別に検証する。IDは YouTube が使う文字だけ許可。
if (isset($incoming['playlists']) && is_array($incoming['playlists'])) {
    $playlists = [];
    foreach ($incoming['playlists'] as $entry) {
        if (!is_array($entry)) {
            continue;
        }
        $id = isset($entry['playlistId']) && is_string($entry['playlistId'])
            ? $entry['playlistId']
            : '';
        if ($id === '' || !preg_match('/^[A-Za-z0-9_-]{2,64}$/', $id)) {
            continue;
        }
        $label = isset($entry['label']) && is_string($entry['label']) ? $entry['label'] : '';
        if (mb_strlen($label, 'UTF-8') > MAX_PLAYLIST_LABEL) {
            $label = mb_substr($label, 0, MAX_PLAYLIST_LABEL, 'UTF-8');
        }
        $playlists[] = ['label' => $label !== '' ? $label : 'PLAYLIST', 'playlistId' => $id];
        if (count($playlists) >= MAX_PLAYLISTS) {
            break;
        }
    }
    if ($playlists !== []) {
        $clean['playlists'] = $playlists;
    }
}

// ナビの目的地はボタンと同じ5件ちょうどに揃える。空欄は未登録として保存する。
if (isset($incoming['mapDestinations']) && is_array($incoming['mapDestinations'])) {
    $destinations = [];
    for ($i = 0; $i < MAP_DESTINATION_COUNT; $i++) {
        $entry = $incoming['mapDestinations'][$i] ?? null;
        $label = is_array($entry) && isset($entry['label']) && is_string($entry['label'])
            ? $entry['label']
            : '';
        $target = is_array($entry) && isset($entry['destination']) && is_string($entry['destination'])
            ? $entry['destination']
            : '';
        $destinations[] = [
            'label' => mb_substr($label, 0, MAX_DESTINATION_LABEL, 'UTF-8'),
            'destination' => mb_substr($target, 0, MAX_DESTINATION_TEXT, 'UTF-8'),
        ];
    }
    $clean['mapDestinations'] = $destinations;
}

// スマホからの再生指示。設定ではなく一度きりの指示なので、null も受け付ける。
if (array_key_exists('nowPlaying', $incoming)) {
    $command = $incoming['nowPlaying'];
    $clean['nowPlaying'] = null;
    if (is_array($command)) {
        $id = isset($command['playlistId']) && is_string($command['playlistId'])
            ? $command['playlistId']
            : '';
        $requestedAt = isset($command['requestedAt']) ? (int) $command['requestedAt'] : 0;
        if ($requestedAt > 0 && preg_match('/^[A-Za-z0-9_-]{2,64}$/', $id)) {
            $label = isset($command['label']) && is_string($command['label'])
                ? mb_substr($command['label'], 0, MAX_PLAYLIST_LABEL, 'UTF-8')
                : '';
            $clean['nowPlaying'] = [
                'playlistId' => $id,
                'label' => $label,
                'requestedAt' => $requestedAt,
            ];
        }
    }
}

// 給油記録。消す操作が無いので、送られてきた分を検査してから
// 下で「いま保存してある分」と足し合わせる。
if (isset($incoming['fuelEntries']) && is_array($incoming['fuelEntries'])) {
    $entries = [];
    foreach ($incoming['fuelEntries'] as $entry) {
        if (!is_array($entry)) {
            continue;
        }
        $id = isset($entry['id']) && is_string($entry['id']) ? $entry['id'] : '';
        $date = isset($entry['date']) && is_string($entry['date']) ? $entry['date'] : '';
        if ($id === '' || strlen($id) > 64 || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
            continue;
        }
        $liters = isset($entry['liters']) ? (float) $entry['liters'] : 0.0;
        $distance = isset($entry['distanceKm']) ? (float) $entry['distanceKm'] : -1.0;
        $amount = isset($entry['amountYen']) ? (float) $entry['amountYen'] : -1.0;
        if ($liters <= 0 || $distance < 0 || $amount < 0) {
            continue;
        }
        $entries[] = [
            'id' => $id,
            'date' => $date,
            'liters' => $liters,
            'distanceKm' => $distance,
            'amountYen' => $amount,
            'createdAt' => isset($entry['createdAt']) ? (int) $entry['createdAt'] : 0,
        ];
        if (count($entries) >= MAX_FUEL_ENTRIES) {
            break;
        }
    }
    $clean['fuelEntries'] = $entries;
}

/*
 * 給油記録は、いま保存してある分と送られてきた分を足し合わせる(idが同じものは1件)。
 * 端末のどれか1台が「記録なし」の状態で送ってきても、サーバーの記録は消えない。
 */
$storedFuel = isset($previous['fuelEntries']) && is_array($previous['fuelEntries'])
    ? $previous['fuelEntries']
    : [];
$mergedFuel = [];
foreach ([$storedFuel, $clean['fuelEntries'] ?? []] as $list) {
    foreach ($list as $entry) {
        if (!is_array($entry) || !isset($entry['id']) || !is_string($entry['id'])) {
            continue;
        }
        $mergedFuel[$entry['id']] = $entry;
    }
}
if ($mergedFuel !== []) {
    $mergedFuel = array_values($mergedFuel);
    usort($mergedFuel, static function (array $a, array $b): int {
        $byDate = strcmp((string) ($b['date'] ?? ''), (string) ($a['date'] ?? ''));
        if ($byDate !== 0) {
            return $byDate;
        }
        return ((int) ($b['createdAt'] ?? 0)) <=> ((int) ($a['createdAt'] ?? 0));
    });
    $clean['fuelEntries'] = array_slice($mergedFuel, 0, MAX_FUEL_ENTRIES);
} else {
    unset($clean['fuelEntries']);
}

if ($clean === []) {
    fail(400, 'nothing to save');
}

// 送られてこなかった項目は、いま保存してある内容をそのまま残す。
$final = $previous;
foreach ($clean as $field => $value) {
    $final[$field] = $value;
}

$updatedAt = (int) ($body['updatedAt'] ?? 0);
if ($updatedAt <= 0) {
    $updatedAt = (int) round(microtime(true) * 1000);
}

$payload = json_encode(
    ['updatedAt' => $updatedAt, 'settings' => $final],
    JSON_UNESCAPED_UNICODE,
);
if ($payload === false) {
    fail(500, 'could not save');
}

// 上書きする前の内容を1世代だけ控えておく(取り違えたときの戻し先)。
if ($previous !== [] && is_file($file)) {
    if (@copy($file, $file . '.bak')) {
        @chmod($file . '.bak', 0600);
    }
}

if (@file_put_contents($file, $payload, LOCK_EX) === false) {
    fail(500, 'could not save');
}
@chmod($file, 0600);

echo json_encode(['ok' => true, 'updatedAt' => $updatedAt]);
