"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { useObd2, type ObdConnectionStatus } from "./hooks/use-obd2";
import {
  buildSyncHandoffUrl,
  CAR_DEVICE_KEY,
  defaults,
  fetchMusicTracks,
  fetchSharedSettings,
  saveMusicPlaylists,
  generateSyncKey,
  MIN_SYNC_KEY_LENGTH,
  MUSIC_CACHE_NAME,
  musicTrackUrl,
  readStoredLibrary,
  writeStoredLibrary,
  PHONE_LONG_EDGE_MAX,
  sanitizeSyncedSettings,
  pickSyncedFields,
  PLAY_COMMAND_MAX_AGE_MS,
  mergeFuelEntries,
  readHandledPlayAt,
  writeHandledPlayAt,
  pushSharedSettings,
  readSettings,
  SETTINGS_STORAGE_KEY,
  writeSettings,
  type MusicPlaylist,
  type MusicTrack,
  type Settings,
} from "./settings-store";

type RouteEta = {
  arrivalAt: number;
  durationSeconds: number;
  destination: "HOME" | "DESTINATION";
};
type WeatherHour = {
  time: string;
  temperature: number;
  code: number;
  isDay: boolean;
};
type WeatherData = {
  temperature: number;
  code: number;
  isDay: boolean;
  hours: WeatherHour[];
  sunrise: string | null;
  sunset: string | null;
};
type FuelEntry = {
  id: string;
  date: string;
  liters: number;
  distanceKm: number;
  amountYen: number;
  createdAt: number;
};
type FuelDraft = {
  date: string;
  liters: string;
  distanceKm: string;
  amountYen: string;
};

const FUEL_TANK_CAPACITY_L = 36;
const FUEL_RESERVE_L = 4;
const GREEN_METER_MAP_ZOOM = 12;
// 地図タイルが来るまでの下地。フィルタ後もほぼ黒に沈む暗色。
const GREEN_METER_MAP_BACKGROUND = "#03150b";
// Referrer-restricted (https://zest7.jp/*) browser key, Maps JavaScript API
// only — safe to ship in client code. The settings key overrides it.
const DEFAULT_GMAPS_KEY = "AIzaSyDndPX8sQmYXOCwVyJtmNUXv-GWXLT6Qh8";

// Google's night-mode map styling, shared by the home and meter maps.
const NIGHT_MAP_STYLES = [
  { elementType: "geometry", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#242f3e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#746855" }] },
  {
    featureType: "administrative.locality",
    elementType: "labels.text.fill",
    stylers: [{ color: "#d59563" }],
  },
  {
    featureType: "poi",
    elementType: "labels.text.fill",
    stylers: [{ color: "#d59563" }],
  },
  {
    featureType: "poi.park",
    elementType: "geometry",
    stylers: [{ color: "#263c3f" }],
  },
  {
    featureType: "poi.park",
    elementType: "labels.text.fill",
    stylers: [{ color: "#6b9a76" }],
  },
  {
    featureType: "road",
    elementType: "geometry",
    stylers: [{ color: "#38414e" }],
  },
  {
    featureType: "road",
    elementType: "geometry.stroke",
    stylers: [{ color: "#212a37" }],
  },
  {
    featureType: "road",
    elementType: "labels.text.fill",
    stylers: [{ color: "#9ca5b3" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry",
    stylers: [{ color: "#746855" }],
  },
  {
    featureType: "road.highway",
    elementType: "geometry.stroke",
    stylers: [{ color: "#1f2835" }],
  },
  {
    featureType: "road.highway",
    elementType: "labels.text.fill",
    stylers: [{ color: "#f3d19c" }],
  },
  {
    featureType: "transit",
    elementType: "geometry",
    stylers: [{ color: "#2f3948" }],
  },
  {
    featureType: "transit.station",
    elementType: "labels.text.fill",
    stylers: [{ color: "#d59563" }],
  },
  {
    featureType: "water",
    elementType: "geometry",
    stylers: [{ color: "#17263c" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.fill",
    stylers: [{ color: "#515c6d" }],
  },
  {
    featureType: "water",
    elementType: "labels.text.stroke",
    stylers: [{ color: "#17263c" }],
  },
];

// ターコイズメーターの円形窓用: 夜間配色に加えて、スポット等の
// アイコン類を非表示にしたレーダー向けスタイル。ラスター地図でのみ
// 有効(ベクター+Map IDの地図はクラウド側スタイルが優先される)。
const GREEN_METER_MAP_STYLES = [
  ...NIGHT_MAP_STYLES,
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "poi", elementType: "labels.text", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

// Loads the Google Maps JavaScript API once and caches the promise.
const loadGoogleMaps = (key: string) => {
  const w = window as unknown as {
    google?: { maps?: unknown };
    __gmapsPromise?: Promise<unknown>;
  };
  if (w.google?.maps) return Promise.resolve(w.google.maps);
  if (!w.__gmapsPromise) {
    w.__gmapsPromise = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
      script.async = true;
      script.onload = () => resolve(w.google?.maps);
      script.onerror = () => {
        delete w.__gmapsPromise;
        reject(new Error("Google Maps failed to load"));
      };
      document.head.appendChild(script);
    });
  }
  return w.__gmapsPromise;
};
/** 再生位置の表示(秒 -> 0:00)。 */
const formatMusicTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/** 音源置き場の一覧を見に行く間隔(設定より頻度は低くてよい)。 */
const MUSIC_POLL_MS = 120000;
// 接続用QRを出しておく秒数。合言葉そのものなので出しっぱなしにしない。
const PAIRING_AUTO_CLOSE_S = 10;

// 他の端末での設定変更を取りに行く間隔。
const SYNC_POLL_MS = 30000;
const FUEL_LOG_STORAGE_KEY = "zcar-fuel-log-v1";
const DAILY_TRIP_STORAGE_KEY = "zcar-daily-trip-v1";
const IMPORTED_FUEL_ENTRIES: FuelEntry[] = [
  { id: "import-2026-07-05", date: "2026-07-05", liters: 19.33, distanceKm: 300, amountYen: 3131, createdAt: Date.parse("2026-07-05T12:00:00+09:00") },
  { id: "import-2026-07-16", date: "2026-07-16", liters: 19.3, distanceKm: 229.9, amountYen: 3127, createdAt: Date.parse("2026-07-16T12:00:00+09:00") },
  { id: "import-2026-07-18", date: "2026-07-18", liters: 14.22, distanceKm: 191.9, amountYen: 2261, createdAt: Date.parse("2026-07-18T12:00:00+09:00") },
  { id: "import-2026-07-25", date: "2026-07-25", liters: 24.27, distanceKm: 361.4, amountYen: 3956, createdAt: Date.parse("2026-07-25T12:00:00+09:00") },
  { id: "import-2026-07-27", date: "2026-07-27", liters: 15.64, distanceKm: 200, amountYen: 2549, createdAt: Date.parse("2026-07-27T12:00:00+09:00") },
  { id: "import-2026-07-29", date: "2026-07-29", liters: 16.8, distanceKm: 195.7, amountYen: 2688, createdAt: Date.parse("2026-07-29T12:00:00+09:00") },
  { id: "import-2026-08-05", date: "2026-08-05", liters: 29.36, distanceKm: 396.3, amountYen: 4968, createdAt: Date.parse("2026-08-05T12:00:00+09:00") },
  { id: "import-2026-08-07", date: "2026-08-07", liters: 13.51, distanceKm: 201.4, amountYen: 2202, createdAt: Date.parse("2026-08-07T12:00:00+09:00") },
  { id: "import-2026-08-10", date: "2026-08-10", liters: 19.59, distanceKm: 275.6, amountYen: 3134, createdAt: Date.parse("2026-08-10T12:00:00+09:00") },
  { id: "import-2026-08-14", date: "2026-08-14", liters: 13.61, distanceKm: 200, amountYen: 2218, createdAt: Date.parse("2026-08-14T12:00:00+09:00") },
  { id: "import-2026-08-19", date: "2026-08-19", liters: 27.36, distanceKm: 473.3, amountYen: 4461, createdAt: Date.parse("2026-08-19T12:00:00+09:00") },
  { id: "import-2026-08-23", date: "2026-08-23", liters: 18.1, distanceKm: 247.9, amountYen: 2842, createdAt: Date.parse("2026-08-23T12:00:00+09:00") },
  { id: "import-2026-08-27", date: "2026-08-27", liters: 12.55, distanceKm: 180, amountYen: 2008, createdAt: Date.parse("2026-08-27T12:00:00+09:00") },
];


const hm = () =>
  new Date().toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const worldHm = (timeZone: string) =>
  new Date().toLocaleTimeString("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

const minutesFromHm = (value: string | null | undefined) => {
  if (!value || !/^\d{2}:\d{2}/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
};

const japanDateKey = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};

const openMap = (destination: string) => {
  window.location.href =
    "https://www.google.com/maps/dir/?api=1&destination=" +
    encodeURIComponent(destination) +
    "&travelmode=driving&dir_action=navigate";
};

const svgPoint = (cx: number, cy: number, radius: number, degrees: number) => {
  const radians = ((degrees - 90) * Math.PI) / 180;
  return { x: cx + radius * Math.cos(radians), y: cy + radius * Math.sin(radians) };
};

const svgArc = (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => {
  const start = svgPoint(cx, cy, radius, endAngle);
  const end = svgPoint(cx, cy, radius, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
};

const svgArcForward = (cx: number, cy: number, radius: number, startAngle: number, endAngle: number) => {
  const start = svgPoint(cx, cy, radius, startAngle);
  const end = svgPoint(cx, cy, radius, endAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? 0 : 1;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
};

const weatherKind = (code: number) => {
  if (code === 0) return "clear";
  if (code <= 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  return "cloud";
};

const weatherLabel = (code: number) => {
  const kind = weatherKind(code);
  if (kind === "clear") return "CLEAR";
  if (kind === "fog") return "FOG";
  if (kind === "storm") return "THUNDER";
  if (kind === "snow") return "SNOW";
  if (kind === "rain") return "RAIN";
  return code <= 2 ? "PARTLY CLOUDY" : "CLOUDY";
};

function WeatherGlyph({
  code,
  isDay,
  x,
  y,
  size,
}: {
  code: number;
  isDay: boolean;
  x: number;
  y: number;
  size: number;
}) {
  const kind = weatherKind(code);
  const transform = `translate(${x - size / 2} ${y - size / 2}) scale(${size / 48})`;
  const cloud = <path d="M 12 31 H 35 C 40 31 42 28 42 24 C 42 19 38 16 33 16 C 31 11 27 9 22 9 C 16 9 12 13 11 18 C 7 19 5 22 5 25 C 5 29 8 31 12 31 Z" />;

  return (
    <g className={`weather-glyph ${kind}`} transform={transform} aria-hidden="true">
      {kind === "clear" && (
        <>
          <circle cx="24" cy="24" r="8" />
          <path d="M24 5V11 M24 37V43 M5 24H11 M37 24H43 M10.5 10.5L15 15 M33 33L37.5 37.5 M37.5 10.5L33 15 M15 33L10.5 37.5" />
        </>
      )}
      {kind === "cloud" && (
        <>
          {isDay && <circle className="weather-sun" cx="16" cy="16" r="7" />}
          {cloud}
        </>
      )}
      {kind === "fog" && <path d="M7 16H37 M4 24H41 M9 32H35" />}
      {(kind === "rain" || kind === "snow" || kind === "storm") && cloud}
      {kind === "rain" && <path className="weather-fall" d="M14 35L11 41 M24 35L21 41 M34 35L31 41" />}
      {kind === "snow" && <path className="weather-fall" d="M14 35V43 M10 39H18 M24 35V43 M20 39H28 M34 35V43 M30 39H38" />}
      {kind === "storm" && <path className="weather-bolt" d="M25 32L18 41H24L21 47L33 36H27L31 32Z" />}
    </g>
  );
}

function EvaCockpit({
  rpm,
  speed,
  coolant,
  voltage,
  status,
}: {
  rpm: number | null;
  speed: number | null;
  coolant: number | null;
  voltage: number | null;
  status: ObdConnectionStatus;
}) {
  const live = status === "live";
  const linking =
    status === "requesting" ||
    status === "connecting" ||
    status === "connected" ||
    status === "initializing";
  const coolantWarn = coolant !== null && coolant >= 100;
  const voltageWarn = voltage !== null && voltage <= 11.8;
  const anyWarn = coolantWarn || voltageWarn;
  const pattern = anyWarn
    ? { code: "赤", label: "PATTERN RED", tone: "alert" }
    : live
      ? { code: "緑", label: "PATTERN GREEN", tone: "normal" }
      : { code: "橙", label: "PATTERN ORANGE", tone: "hold" };
  const revCells = 24;
  const revActive = Math.round(
    Math.max(0, Math.min(1, (rpm ?? 0) / 8000)) * revCells,
  );
  const coolantLevel =
    coolant === null
      ? 0
      : Math.max(0, Math.min(100, ((coolant - 40) / 80) * 100));
  const voltageLevel =
    voltage === null
      ? 0
      : Math.max(0, Math.min(100, ((voltage - 10) / 5) * 100));
  const signalLabel = live
    ? "回線接続 LINK ACTIVE"
    : linking
      ? "同期中 SYNCING"
      : "信号消失 NO SIGNAL";

  return (
    <div className={`eva-stage ${pattern.tone}`}>
      <div className="eva-column">
        <article className={`eva-box${coolantWarn ? " warn" : ""}`}>
          <small>水温 <span>COOLANT</span></small>
          <strong>
            {coolant ?? "--"}
            <em>°C</em>
          </strong>
          <div className="eva-bar" aria-hidden="true">
            <i style={{ width: `${coolantLevel}%` }} />
          </div>
          <b>{coolantWarn ? "警告 OVERHEAT" : "正常 NOMINAL"}</b>
        </article>
        <article className={`eva-box${voltageWarn ? " warn" : ""}`}>
          <small>電圧 <span>VOLTAGE</span></small>
          <strong>
            {voltage ?? "--"}
            <em>V</em>
          </strong>
          <div className="eva-bar" aria-hidden="true">
            <i style={{ width: `${voltageLevel}%` }} />
          </div>
          <b>{voltageWarn ? "警告 LOW VOLT" : "正常 NOMINAL"}</b>
        </article>
      </div>

      <div className="eva-center">
        <header className={`eva-pattern ${pattern.tone}`}>
          <span className="eva-pattern-code">{pattern.code}</span>
          <span className="eva-pattern-label">{pattern.label}</span>
        </header>
        <div
          className="eva-speed"
          aria-label={`Speed ${speed ?? 0} kilometers per hour`}
        >
          <strong>{speed === null ? "--" : Math.round(speed)}</strong>
          <span>
            km/h<small>速度 VELOCITY</small>
          </span>
        </div>
        <div
          className="eva-rev"
          aria-label={`Engine ${rpm ?? 0} RPM`}
        >
          <small>回転 REV</small>
          <div className="eva-rev-cells" aria-hidden="true">
            {Array.from({ length: revCells }, (_, index) => (
              <i
                key={index}
                className={
                  index < revActive
                    ? index >= revCells - 4
                      ? "on hot"
                      : "on"
                    : undefined
                }
              />
            ))}
          </div>
          <b>{rpm === null ? "---- rpm" : `${rpm} rpm`}</b>
        </div>
      </div>

      <div className="eva-column">
        <article className={`eva-box eva-signal${live ? "" : " warn"}`}>
          <small>信号 <span>SIGNAL</span></small>
          <strong className="eva-signal-state">{signalLabel}</strong>
          <b>{live ? "OBD2 TELEMETRY" : "TOUCH OBD2 TO LINK"}</b>
        </article>
        <article className={`eva-box eva-status${anyWarn ? " warn" : ""}`}>
          <small>状態 <span>STATUS</span></small>
          <ul>
            <li className={coolantWarn ? "bad" : undefined}>
              {coolantWarn ? "▲ 機関温度上昇" : "・機関温度 安定"}
            </li>
            <li className={voltageWarn ? "bad" : undefined}>
              {voltageWarn ? "▲ 電圧低下" : "・電源系 安定"}
            </li>
            <li>{live ? "・遠隔測定 良好" : "・遠隔測定 待機"}</li>
          </ul>
        </article>
      </div>
    </div>
  );
}

// ビルド時刻(JST)。反映確認用に起動画面の隅に表示する。
const BUILD_STAMP = (() => {
  const iso = process.env.NEXT_PUBLIC_BUILD_TIME;
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
})();

export default function Home() {
  const [settings, setSettings] = useState<Settings>(defaults);
  // スマホから送られてきた再生指示で鳴らしているプレイリスト。
  // reloadKey は「音が出ないときのタップ」で作り直すための目印。
  // ホーム画面の待機プレイヤー。設定したプレイリストからランダムに選ぶ。
  const [carPlaying, setCarPlaying] = useState<{
    playlistId: string;
    label: string;
    reloadKey: number;
    /** 再生を押したあとは表示を畳んで、音だけ鳴らし続ける。 */
    collapsed: boolean;
  } | null>(null);
  // 一度反応した指示を覚えておき、同じものを繰り返し再生しないようにする。
  const handledPlayRef = useRef(0);

  // マップ画面の 1〜5 のナビ目的地。設定ページから編集できる。
  const mapDestinations = settings.mapDestinations;
  // 案内開始で使う行き先。「目的地設定」から選ぶ。
  const [navTargetKey, setNavTargetKey] = useState("work");
  // 出勤・退勤は設定した店舗/自宅住所を使い、未入力なら1番・2番で代用する。
  const workDestination =
    settings.storeDest.trim() ||
    settings.storeName.trim() ||
    mapDestinations[0]?.destination ||
    "";
  const homeDestination =
    settings.homeDest.trim() || mapDestinations[1]?.destination || "";
  // 「目的地設定」で選べる候補。出勤・退勤と、登録済みの 1〜5。
  const navChoices = [
    { key: "work", label: "出勤", note: "店舗へ", destination: workDestination },
    { key: "home", label: "退勤", note: "自宅へ", destination: homeDestination },
    ...mapDestinations.map((entry, index) => ({
      key: `dest-${index}`,
      label: entry.label.trim() || `${index + 1}番`,
      note: `${index + 1}番`,
      destination: entry.destination.trim(),
    })),
  ].filter((entry) => entry.destination);
  const navTarget =
    navChoices.find((entry) => entry.key === navTargetKey) ?? navChoices[0] ?? null;
  const [clock, setClock] = useState("--:--");
  const [californiaClock, setCaliforniaClock] = useState("--:--");
  const [russiaClock, setRussiaClock] = useState("--:--");
  const [chinaClock, setChinaClock] = useState("--:--");
  const [isOnline, setIsOnline] = useState(true);
  const [ready, setReady] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [showFuel, setShowFuel] = useState(false);
  // 給油記録は設定と同じ入れ物に置き、スマホと共有する。
  const fuelEntries = settings.fuelEntries;
  const [fuelDraft, setFuelDraft] = useState<FuelDraft>({
    date: japanDateKey(),
    liters: "",
    distanceKm: "",
    amountYen: "",
  });
  const {
    status: obdStatus,
    metrics: obdData,
    deviceName: obdDeviceName,
    connectionLabel: obdConnectionLabel,
    errorMessage: obdErrorMessage,
    connect: connectObd,
  } = useObd2();
  const [displaySpeed, setDisplaySpeed] = useState<number | null>(null);
  const [fuelTripKm, setFuelTripKm] = useState(0);
  const [dailyTrip, setDailyTrip] = useState({
    date: japanDateKey(),
    distanceKm: 0,
  });
  const [fuelResetting, setFuelResetting] = useState(false);
  const [routeEta, setRouteEta] = useState<RouteEta | null>(null);
  const [routeEtaStatus, setRouteEtaStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [location, setLocation] = useState<{
    lat: number;
    lng: number;
    accuracy: number;
    heading: number | null;
  } | null>(null);
  const [locationStatus, setLocationStatus] = useState<
    "locating" | "ready" | "unavailable"
  >("locating");
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherStatus, setWeatherStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const destDialog = useRef<HTMLDialogElement>(null);
  const connectDialog = useRef<HTMLDialogElement>(null);
  const settingsDialog = useRef<HTMLDialogElement>(null);
  // QRを出しっぱなしにしない(合言葉そのものなので)。表示してから
  // PAIRING_AUTO_CLOSE_S 秒で自動的に閉じる。
  const pairingTimerRef = useRef<number | null>(null);
  const [pairingLeft, setPairingLeft] = useState(0);
  // 音源置き場の曲(スマホから預けたもの)と、車で直接選んだ曲(USBなど)。
  const [serverTracks, setServerTracks] = useState<MusicTrack[]>([]);
  const [musicPlaylists, setMusicPlaylists] = useState<MusicPlaylist[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState("");
  const [trackIndex, setTrackIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);
  // 車に貯めた曲(オフラインでも鳴らせる)。中身は曲のURL。
  const [savedTracks, setSavedTracks] = useState<Set<string>>(new Set());
  const [savingCount, setSavingCount] = useState(0);
  // いま鳴らすURL。貯めてあれば端末の中から、無ければサーバーから読む。
  const [playUrl, setPlayUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  // 曲を変えたあと、読み込みが終わってから鳴らすための印。
  const wantPlayRef = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  // スマホと接続するためのQR(設定ダイアログの中で表示する)。
  const [pairingQr, setPairingQr] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState(false);
  // 同期用: 最新の設定と、最後にサーバーへ送った内容を覚えておく。
  const settingsRef = useRef<Settings>(defaults);
  const lastPushedRef = useRef<string | null>(null);
  const themeDialog = useRef<HTMLDialogElement>(null);
  const fuelMotionRef = useRef<{
    speed: number | null;
    status: ObdConnectionStatus;
  }>({
    speed: null,
    status: "idle",
  });
  const speedTargetRef = useRef<number | null>(null);
  const speedSamplesRef = useRef<Array<{ value: number; sampledAt: number }>>([]);
  const smoothedSpeedRef = useRef<number | null>(null);
  const speedZeroSinceRef = useRef<number | null>(null);
  const fuelResetTimerRef = useRef<number | null>(null);
  const locationWatchRef = useRef<number | null>(null);
  // google.maps objects, typed loosely because the SDK loads at runtime.
  const greenMapElementRef = useRef<HTMLDivElement>(null);
  // 中央メーターの地図タイルが1枚でも描画できたか(待機表示の出し分け用)。
  const [greenMapReady, setGreenMapReady] = useState(false);
  const greenGmapRef = useRef<{
    setCenter: (point: { lat: number; lng: number }) => void;
    moveCamera: (camera: Record<string, unknown>) => void;
  } | null>(null);
  const weatherLatitude = location ? Number(location.lat.toFixed(2)) : null;
  const weatherLongitude = location ? Number(location.lng.toFixed(2)) : null;
  const weatherLocationKey =
    weatherLatitude === null || weatherLongitude === null
      ? ""
      : `${weatherLatitude},${weatherLongitude}`;

  useEffect(() => {
    try {
      setSettings(readSettings());
      const savedFuelTrip = Number.parseFloat(
        localStorage.getItem("zcar-fuel-trip-km") || "0",
      );
      setFuelTripKm(
        Number.isFinite(savedFuelTrip)
          ? Math.max(0, savedFuelTrip)
          : 0,
      );
      const savedDailyTrip = JSON.parse(
        localStorage.getItem(DAILY_TRIP_STORAGE_KEY) || "null",
      ) as { date?: unknown; distanceKm?: unknown } | null;
      const currentDate = japanDateKey();
      setDailyTrip({
        date: currentDate,
        distanceKm:
          savedDailyTrip?.date === currentDate &&
          typeof savedDailyTrip.distanceKm === "number" &&
          Number.isFinite(savedDailyTrip.distanceKm)
            ? Math.max(0, savedDailyTrip.distanceKm)
            : 0,
      });
      const savedFuelEntries = readSettings().fuelEntries;
      const validatedFuelEntries = Array.isArray(savedFuelEntries)
        ? savedFuelEntries.filter(
            (entry) =>
              entry &&
              typeof entry.id === "string" &&
              /^\d{4}-\d{2}-\d{2}$/.test(entry.date) &&
              Number.isFinite(entry.liters) &&
              entry.liters > 0 &&
              Number.isFinite(entry.distanceKm) &&
              entry.distanceKm >= 0 &&
              Number.isFinite(entry.amountYen) &&
              entry.amountYen >= 0,
          )
        : [];
      const mergedFuelEntries = [...validatedFuelEntries];
      for (const importedEntry of IMPORTED_FUEL_ENTRIES) {
        const alreadyExists = mergedFuelEntries.some(
          (entry) =>
            entry.date === importedEntry.date &&
            entry.liters === importedEntry.liters &&
            entry.distanceKm === importedEntry.distanceKm &&
            entry.amountYen === importedEntry.amountYen,
        );
        if (!alreadyExists) mergedFuelEntries.push(importedEntry);
      }
      setSettings((current) => ({
        ...current,
        fuelEntries: mergeFuelEntries(current.fuelEntries, mergedFuelEntries),
      }));
      const savedRouteEta = JSON.parse(
        localStorage.getItem("zcar-route-eta") || "null",
      ) as RouteEta | null;
      if (
        savedRouteEta &&
        Number.isFinite(savedRouteEta.arrivalAt) &&
        savedRouteEta.arrivalAt > Date.now() - 30 * 60 * 1000
      ) {
        setRouteEta(savedRouteEta);
        setRouteEtaStatus("ready");
      }
    } catch {
      setSettings(defaults);
    }
    const updateClocks = () => {
      setClock(hm());
      setCaliforniaClock(worldHm("America/Los_Angeles"));
      setRussiaClock(worldHm("Europe/Moscow"));
      setChinaClock(worldHm("Asia/Shanghai"));
    };
    updateClocks();
    setIsOnline(navigator.onLine);
    setReady(true);
    // 大きい画面でダッシュボードが開けた端末は、車載機として覚えておく。
    // ブラウザの表示領域が変わっても、次からは設定ページへ送られない。
    if (
      Math.max(window.innerWidth, window.innerHeight) >= PHONE_LONG_EDGE_MAX
    ) {
      try {
        localStorage.setItem(CAR_DEVICE_KEY, "car");
      } catch {
        // 保存できない設定でも動作に支障はない。
      }
    }
    const timer = window.setInterval(updateClocks, 1000);
    const updateOnlineStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/sw.js`)
        .catch(() => undefined);
    }
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (fuelResetTimerRef.current !== null) {
        window.clearTimeout(fuelResetTimerRef.current);
      }
      if (locationWatchRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(locationWatchRef.current);
      }
      greenGmapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (ready) writeSettings(settings);
  }, [ready, settings]);

  useEffect(() => {
    settingsRef.current = settings;
  });

  // スマホからの再生指示を受け取る。開き直したときに古い指示で急に音が
  // 鳴らないよう、新しくて期限内のものだけを対象にする。
  useEffect(() => {
    const command = settings.nowPlaying;
    if (!command) return;
    // 反応済みの指示は端末にも記録してあるので、開き直しても鳴り直さない。
    const handled = Math.max(handledPlayRef.current, readHandledPlayAt());
    if (command.requestedAt <= handled) return;
    handledPlayRef.current = command.requestedAt;
    writeHandledPlayAt(command.requestedAt);
    if (Date.now() - command.requestedAt > PLAY_COMMAND_MAX_AGE_MS) return;
    setCarPlaying({
      playlistId: command.playlistId,
      label: command.label,
      reloadKey: command.requestedAt,
      collapsed: false,
    });
  }, [settings.nowPlaying]);

  // --- 設定の同期 ---
  // 合言葉を入れておくと、スマホ側で変えたメーターの色などをここでも取り込む。
  // 走行状態やAPIキーは端末ごとの値なので同期しない(settings-store の SYNCED_FIELDS)。
  const syncKey = settings.syncKey.trim();
  const syncEnabled = ready && syncKey.length >= MIN_SYNC_KEY_LENGTH;
  // スマホとのやりとりが通っているか(上のステータス表示用)。
  const [phoneLinkOk, setPhoneLinkOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (!syncEnabled) return;
    let active = true;

    const pull = async () => {
      try {
        const result = await fetchSharedSettings(syncKey);
        if (!active) return;
        setPhoneLinkOk(result.ok);
        if (!result.ok) return;
        const current = settingsRef.current;
        if (!result.settings) {
          // サーバーにまだ何も無ければ、この端末の設定を最初の1件として置く。
          const seeded = await pushSharedSettings(syncKey, current);
          if (!active || !seeded.updatedAt) return;
          lastPushedRef.current = JSON.stringify(pickSyncedFields(current));
          setSettings((now) => ({ ...now, syncedAt: seeded.updatedAt as number }));
          return;
        }
        const updatedAt = result.updatedAt ?? 0;
        if (updatedAt <= current.syncedAt) return;
        const shared = sanitizeSyncedSettings(result.settings);
        const merged = {
          ...current,
          ...shared,
          // 給油記録はどちらの端末の分も残す(消す操作が無いので足し合わせる)。
          fuelEntries: mergeFuelEntries(current.fuelEntries, shared.fuelEntries ?? []),
          syncedAt: updatedAt,
        };
        // 取り込んだ内容をそのまま送り返さないよう、送信済みとして覚えておく。
        lastPushedRef.current = JSON.stringify(pickSyncedFields(merged));
        setSettings(merged);
      } catch {
        // 圏外や一時的なエラーは次の周期に任せる。
        if (active) setPhoneLinkOk(false);
      }
    };

    void pull();
    const timer = window.setInterval(pull, SYNC_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [syncEnabled, syncKey]);

  useEffect(() => {
    if (!syncEnabled) {
      lastPushedRef.current = null;
      return;
    }
    const payload = JSON.stringify(pickSyncedFields(settings));
    if (lastPushedRef.current === null) {
      lastPushedRef.current = payload;
      return;
    }
    if (lastPushedRef.current === payload) return;
    lastPushedRef.current = payload;
    void pushSharedSettings(syncKey, settings)
      .then((result) => {
        if (result.updatedAt) {
          setSettings((now) => ({ ...now, syncedAt: result.updatedAt as number }));
        }
      })
      .catch(() => undefined);
  }, [syncEnabled, syncKey, settings]);

  // 給油記録は設定と一緒に保存されるが、旧キーにも書いておく(古い版に戻しても読める)。
  useEffect(() => {
    if (ready) {
      localStorage.setItem(FUEL_LOG_STORAGE_KEY, JSON.stringify(fuelEntries));
    }
  }, [fuelEntries, ready]);

  useEffect(() => {
    fuelMotionRef.current = { speed: obdData.speed, status: obdStatus };
  }, [obdData.speed, obdStatus]);

  useEffect(() => {
    speedTargetRef.current = obdData.speed;
    if (obdData.speed === null) {
      speedSamplesRef.current = [];
      smoothedSpeedRef.current = null;
      speedZeroSinceRef.current = null;
      setDisplaySpeed(null);
    }
  }, [obdData.speed]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const rawSpeed = speedTargetRef.current;
      if (rawSpeed === null) return;

      const now = performance.now();
      const speed = Math.max(0, rawSpeed);

      if (speed === 0) {
        speedZeroSinceRef.current ??= now;
      } else if (speedZeroSinceRef.current !== null) {
        speedZeroSinceRef.current = null;
        speedSamplesRef.current = [];
        smoothedSpeedRef.current = null;
      }

      speedSamplesRef.current = [
        ...speedSamplesRef.current.filter((sample) => now - sample.sampledAt <= 2000),
        { value: speed, sampledAt: now },
      ];

      if (
        speedZeroSinceRef.current !== null &&
        now - speedZeroSinceRef.current >= 800
      ) {
        smoothedSpeedRef.current = 0;
        setDisplaySpeed(0);
        return;
      }

      const ordered = speedSamplesRef.current
        .map((sample) => sample.value)
        .sort((left, right) => left - right);
      const stableValues =
        ordered.length >= 5 ? ordered.slice(1, -1) : ordered;
      const average =
        stableValues.reduce((total, value) => total + value, 0) /
        stableValues.length;
      const previous = smoothedSpeedRef.current;
      const smoothed = previous === null
        ? average
        : previous + (average - previous) * 0.4;

      smoothedSpeedRef.current = smoothed;
      setDisplaySpeed(Math.round(smoothed));
    }, 400);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let previousSample = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      const elapsedMs = Math.min(now - previousSample, 3000);
      previousSample = now;
      const { speed, status } = fuelMotionRef.current;
      if (status !== "live" || speed === null || speed <= 0) return;
      const travelledKm = speed * (elapsedMs / 3_600_000);
      setFuelTripKm((current) => current + travelledKm);
      const currentDate = japanDateKey();
      setDailyTrip((current) => ({
        date: currentDate,
        distanceKm:
          current.date === currentDate
            ? current.distanceKm + travelledKm
            : travelledKm,
      }));
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (ready) {
      localStorage.setItem("zcar-fuel-trip-km", fuelTripKm.toFixed(4));
    }
  }, [fuelTripKm, ready]);

  useEffect(() => {
    if (ready) {
      localStorage.setItem(DAILY_TRIP_STORAGE_KEY, JSON.stringify(dailyTrip));
    }
  }, [dailyTrip, ready]);

  useEffect(() => {
    const syncFullscreen = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", syncFullscreen);
    syncFullscreen();
    return () =>
      document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  useEffect(() => {
    // 画面はメーターと燃費の2つだけ。戻る操作ではメーターに帰る。
    const backToMeter = () => setShowFuel(false);
    window.addEventListener("popstate", backToMeter);
    return () => window.removeEventListener("popstate", backToMeter);
  }, []);




  const toggleFuelView = () => {
    if (showFuel) {
      setShowFuel(false);
      if (window.history.state?.zcarView === "fuel") {
        window.history.back();
      }
      return;
    }

    setShowFuel(true);
    setFuelDraft((current) => ({ ...current, date: japanDateKey() }));
    window.history.pushState(
      { ...(window.history.state || {}), zcarView: "fuel" },
      "",
    );
  };

  const requestLocation = () => {
    if (!navigator.geolocation) {
      setLocationStatus("unavailable");
      return;
    }
    setLocationStatus("locating");
    if (locationWatchRef.current !== null) {
      navigator.geolocation.clearWatch(locationWatchRef.current);
    }
    locationWatchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        setLocation((current) => {
          const rawHeading = position.coords.heading;
          let heading = current?.heading ?? null;
          if (rawHeading !== null && Number.isFinite(rawHeading)) {
            if (heading === null) {
              heading = rawHeading;
            } else {
              const normalizedCurrent = ((heading % 360) + 360) % 360;
              const shortestTurn = ((rawHeading - normalizedCurrent + 540) % 360) - 180;
              heading += shortestTurn;
            }
          }
          return {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            heading,
          };
        });
        setLocationStatus("ready");
      },
      () =>
        setLocationStatus((current) =>
          current === "ready" ? current : "unavailable",
        ),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 1000 },
    );
  };

  useEffect(() => {
    if (ready && hasStarted) requestLocation();
  }, [ready, hasStarted]);

  // Zのボタンを押したらメーターへ。全画面もここで頼む(画面に触れた
  // ときしか頼めないため)。
  const launchZCar = () => {
    setHasStarted(true);
    if (!document.fullscreenElement) {
      void document.documentElement.requestFullscreen().catch(() => {
        // 全画面にできないブラウザでも、そのまま使える。
      });
    }
  };

  // 「戻る」でメーターに帰れるよう、最初の履歴に印を付けておく。
  useEffect(() => {
    window.history.replaceState(
      { ...(window.history.state || {}), zcarView: "meter" },
      "",
    );
  }, []);


  useEffect(() => {
    if (!weatherLocationKey || weatherLatitude === null || weatherLongitude === null) return;
    let cancelled = false;

    const loadWeather = async () => {
      setWeatherStatus("loading");
      try {
        const query = new URLSearchParams({
          latitude: String(weatherLatitude),
          longitude: String(weatherLongitude),
          current: "temperature_2m,weather_code,is_day",
          hourly: "temperature_2m,weather_code,is_day",
          daily: "sunrise,sunset",
          forecast_hours: "16",
          forecast_days: "1",
          timezone: "auto",
        });
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?${query}`);
        if (!response.ok) throw new Error("Weather request failed");
        const payload = (await response.json()) as {
          current?: { temperature_2m?: number; weather_code?: number; is_day?: number };
          hourly?: {
            time?: string[];
            temperature_2m?: number[];
            weather_code?: number[];
            is_day?: number[];
          };
          daily?: { sunrise?: string[]; sunset?: string[] };
        };
        const current = payload.current;
        const hourly = payload.hourly;
        if (
          !current ||
          !Number.isFinite(current.temperature_2m) ||
          !Number.isFinite(current.weather_code) ||
          !hourly?.time ||
          !hourly.temperature_2m ||
          !hourly.weather_code ||
          !hourly.is_day
        ) {
          throw new Error("Weather data unavailable");
        }
        const hours = [3, 6, 9, 12, 15].flatMap((index) => {
          const time = hourly.time?.[index];
          const temperature = hourly.temperature_2m?.[index];
          const code = hourly.weather_code?.[index];
          const isDay = hourly.is_day?.[index];
          if (!time || !Number.isFinite(temperature) || !Number.isFinite(code)) return [];
          return [{
            time: time.slice(11, 16),
            temperature: temperature as number,
            code: code as number,
            isDay: Boolean(isDay),
          }];
        });
        if (cancelled) return;
        setWeather({
          temperature: current.temperature_2m as number,
          code: current.weather_code as number,
          isDay: Boolean(current.is_day),
          hours,
          sunrise: payload.daily?.sunrise?.[0]?.slice(11, 16) ?? null,
          sunset: payload.daily?.sunset?.[0]?.slice(11, 16) ?? null,
        });
        setWeatherStatus("ready");
      } catch {
        if (!cancelled) setWeatherStatus("error");
      }
    };

    void loadWeather();
    const timer = window.setInterval(() => void loadWeather(), 30 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [weatherLocationKey]);

  const mapsApiKey = settings.googleRoutesApiKey.trim() || DEFAULT_GMAPS_KEY;

  useEffect(() => {
    if (!showFuel && settings.meterTheme === "green") return;
    greenGmapRef.current = null;
    setGreenMapReady(false);
  }, [showFuel, settings.meterTheme]);

  useEffect(() => {
    if (
      showFuel ||
      settings.meterTheme !== "green" ||
      !mapsApiKey ||
      !greenMapElementRef.current
    ) return;
    let cancelled = false;
    const focusPoint = location
      ? { lat: location.lat, lng: location.lng }
      : { lat: 34.6937, lng: 135.5023 };

    // ラスター地図(スタイル指定でアイコン非表示にするため)。heading は
    // ベクター専用なので、進行方向の回転は --green-map-rotation のCSSで行う。
    void loadGoogleMaps(mapsApiKey)
      .then((maps) => {
        if (cancelled || !greenMapElementRef.current) return;
        const mapsApi = maps as {
          Map: new (
            element: HTMLElement,
            options: Record<string, unknown>,
          ) => {
            setCenter: (point: { lat: number; lng: number }) => void;
            moveCamera: (camera: Record<string, unknown>) => void;
          };
          event: {
            addListenerOnce: (
              instance: unknown,
              eventName: string,
              handler: () => void,
            ) => void;
          };
        };
        if (!greenGmapRef.current) {
          const map = new mapsApi.Map(greenMapElementRef.current, {
            center: focusPoint,
            zoom: GREEN_METER_MAP_ZOOM,
            styles: GREEN_METER_MAP_STYLES,
            // タイル未読込の間に出る既定の明るい下地(#e5e3df)が、
            // メーターのフィルタを通ると白く光ってしまうので暗色にする。
            backgroundColor: GREEN_METER_MAP_BACKGROUND,
            disableDefaultUI: true,
            clickableIcons: false,
            gestureHandling: "none",
            keyboardShortcuts: false,
          });
          greenGmapRef.current = map;
          // tilesloaded は地図インスタンスのイベントで、この effect の実行回とは
          // 無関係。位置情報が更新されるたび cleanup で cancelled が立つため、
          // ここで cancelled を見ると待機表示が永久に消えなくなる。
          mapsApi.event.addListenerOnce(map, "tilesloaded", () => {
            setGreenMapReady(true);
          });
          return;
        }
        greenGmapRef.current.setCenter(focusPoint);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showFuel, location, settings.meterTheme, mapsApiKey]);


  const hour = new Date().getHours();
  const stateLabel =
    settings.state === "not_departed"
      ? "未出発"
      : settings.state === "departed"
        ? `出発済み ・ ${settings.departedAt}`
        : `退勤済み ・ ${settings.checkedOutAt}`;

  const today = japanDateKey();
  const routeMinutesRemaining = routeEta
    ? Math.max(0, Math.ceil((routeEta.arrivalAt - Date.now()) / 60_000))
    : null;
  const routeArrivalTime = routeEta
    ? new Date(routeEta.arrivalAt).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : null;
  const greenRpmPercent = Math.max(
    0,
    Math.min(100, ((obdData.rpm ?? 0) / 8000) * 100),
  );
  const greenSpeedPercent = Math.max(
    0,
    Math.min(100, ((displaySpeed ?? 0) / 120) * 100),
  );
  const greenHeading =
    location?.heading === null || location?.heading === undefined
      ? null
      : ((location.heading % 360) + 360) % 360;
  const greenMeterHeading =
    greenHeading === null ? 0 : (Math.round(greenHeading / 15) * 15) % 360;
  const greenCockpitStyle = {
    "--green-rpm-level": `${greenRpmPercent}%`,
    "--green-speed-level": `${greenSpeedPercent}%`,
    "--rpm-progress": `${greenRpmPercent * 3}deg`,
    "--green-map-rotation": `${-greenMeterHeading}deg`,
  } as CSSProperties;
  const greenCenterSpeed =
    displaySpeed === null ? null : Math.round(displaySpeed);
  const dailyTripKm = dailyTrip.date === today ? dailyTrip.distanceKm : 0;
  const performanceDate = `${today.slice(5, 7)}.${today.slice(8, 10)}`;
  const performanceWeekday = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  })
    .format(new Date(`${today}T00:00:00+09:00`))
    .toUpperCase();
  const solarSunrise = weather?.sunrise ?? null;
  const solarSunset = weather?.sunset ?? null;
  const solarNowMinutes = minutesFromHm(clock);
  const solarRiseMinutes = minutesFromHm(solarSunrise);
  const solarSetMinutes = minutesFromHm(solarSunset);
  const solarProgress =
    solarNowMinutes === null ||
    solarRiseMinutes === null ||
    solarSetMinutes === null ||
    solarSetMinutes <= solarRiseMinutes
      ? null
      : Math.max(0, Math.min(1, (solarNowMinutes - solarRiseMinutes) / (solarSetMinutes - solarRiseMinutes)));
  const solarPointX = 4 + 82 * (solarProgress ?? 0.5);
  const solarPointY = 24 - 22 * Math.sin(Math.PI * (solarProgress ?? 0.5));
  const obdStatusLabelEn = obdConnectionLabel;
  // ターコイズのメーターだけ、操作用の上のバーを消して、
  // かわりに状態だけを出す細いバーにする。
  const hideTopbar = !showFuel && settings.meterTheme === "green";

  // 上のバーに出す4つの状態。表記は英語。
  // tone は色(ok=通っている / warn=途中 / off=つながっていない)。
  const meterStatusItems: {
    key: string;
    label: string;
    value: string;
    tone: "ok" | "warn" | "off";
  }[] = [
    {
      key: "net",
      label: "NET",
      value: isOnline ? "ONLINE" : "OFFLINE",
      tone: isOnline ? "ok" : "off",
    },
    {
      key: "phone",
      label: "PHONE",
      value: !syncKey
        ? "UNPAIRED"
        : phoneLinkOk === false
          ? "NO LINK"
          : phoneLinkOk === null
            ? "SYNCING"
            : "LINKED",
      tone: !syncKey ? "off" : phoneLinkOk === true ? "ok" : "warn",
    },
    {
      key: "obd",
      label: "OBD2",
      value:
        obdStatus === "live"
          ? "LIVE"
          : obdStatus === "connected" || obdStatus === "initializing"
            ? "INIT"
            : obdStatus === "connecting" || obdStatus === "requesting"
              ? "LINKING"
              : obdStatus === "unsupported"
                ? "N/A"
                : obdStatus === "error" || obdStatus === "disconnected"
                  ? "LOST"
                  : "STANDBY",
      tone:
        obdStatus === "live"
          ? "ok"
          : obdStatus === "connected" ||
              obdStatus === "initializing" ||
              obdStatus === "connecting" ||
              obdStatus === "requesting"
            ? "warn"
            : "off",
    },
    {
      key: "gps",
      label: "GPS",
      value:
        locationStatus === "ready"
          ? "LOCK"
          : locationStatus === "locating"
            ? "SEARCH"
            : "NO FIX",
      tone:
        locationStatus === "ready"
          ? "ok"
          : locationStatus === "locating"
            ? "warn"
            : "off",
    },
  ];

  const cancelFuelReset = () => {
    if (fuelResetTimerRef.current !== null) {
      window.clearTimeout(fuelResetTimerRef.current);
      fuelResetTimerRef.current = null;
    }
    setFuelResetting(false);
  };

  const startFuelReset = () => {
    cancelFuelReset();
    setFuelResetting(true);
    fuelResetTimerRef.current = window.setTimeout(() => {
      setFuelTripKm(0);
      setFuelResetting(false);
      fuelResetTimerRef.current = null;
      navigator.vibrate?.(60);
    }, 900);
  };

  // --- 音楽プレイヤー ---
  // 鳴らす曲: スマホで選んだプレイリストがあればその順番で、
  // 無ければ置いてある曲を全部その並びのまま鳴らす。
  const activePlaylist =
    musicPlaylists.find((list) => list.id === activePlaylistId) ?? null;
  const playlistTracks = (
    activePlaylist
      ? activePlaylist.trackIds.flatMap((id) => {
          const track = serverTracks.find((entry) => entry.id === id);
          return track ? [track] : [];
        })
      : serverTracks
  ).map((track) => ({
    id: track.id,
    title: track.title,
    url: musicTrackUrl(track),
  }));
  const currentTrack = playlistTracks[trackIndex] ?? null;

  // 起動時は、前に見た一覧を端末から読む(圏外でもそのまま鳴らせる)。
  useEffect(() => {
    if (!ready) return;
    const stored = readStoredLibrary();
    if (stored.tracks.length) {
      setServerTracks(stored.tracks);
      setMusicPlaylists(stored.playlists);
      setActivePlaylistId(stored.activePlaylistId);
    }
  }, [ready]);

  // どの曲を貯め終えているかを調べ、まだの曲を順番に貯める。
  useEffect(() => {
    if (!ready || typeof caches === "undefined" || !serverTracks.length) return;
    let active = true;

    const store = async () => {
      const cache = await caches.open(MUSIC_CACHE_NAME);
      const wanted = serverTracks.map((track) => musicTrackUrl(track));
      // 消された曲は端末からも消す(容量を空ける)。
      const keys = await cache.keys();
      await Promise.all(
        keys
          .filter((request) => !wanted.some((url) => request.url.endsWith(url)))
          .map((request) => cache.delete(request)),
      );

      const done = new Set<string>();
      for (const url of wanted) {
        if (await cache.match(url)) done.add(url);
      }
      if (!active) return;
      setSavedTracks(new Set(done));

      // まだ貯めていない曲を、1曲ずつ落としてくる(通信を細く使う)。
      const missing = wanted.filter((url) => !done.has(url));
      setSavingCount(missing.length);
      for (const url of missing) {
        if (!active) return;
        try {
          await cache.add(url);
          done.add(url);
          setSavedTracks(new Set(done));
        } catch {
          // 圏外などで落とせなければ、次に開いたときに試す。
        }
        if (!active) return;
        setSavingCount((current) => Math.max(0, current - 1));
      }
    };

    void store().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [ready, serverTracks]);

  // 鳴らすURLを決める。貯めてあれば端末の中から読む(通信を使わない)。
  useEffect(() => {
    let active = true;
    const release = () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
    if (!currentTrack) {
      release();
      setPlayUrl(null);
      return;
    }
    const url = currentTrack.url;
    const resolve = async () => {
      if (typeof caches !== "undefined") {
        try {
          const cache = await caches.open(MUSIC_CACHE_NAME);
          const hit = await cache.match(url);
          if (hit) {
            const blob = await hit.blob();
            if (!active) return;
            release();
            const objectUrl = URL.createObjectURL(blob);
            objectUrlRef.current = objectUrl;
            setPlayUrl(objectUrl);
            return;
          }
        } catch {
          // 取り出せなければサーバーから読む。
        }
      }
      if (!active) return;
      release();
      setPlayUrl(url);
    };
    void resolve();
    return () => {
      active = false;
    };
  }, [currentTrack?.url]);

  // 曲を切り替えたときは、読み込みが終わってから鳴らす。
  useEffect(() => {
    if (!playUrl || !wantPlayRef.current) return;
    wantPlayRef.current = false;
    const audio = audioRef.current;
    if (!audio) return;
    void audio.play().catch(() => setIsPlaying(false));
  }, [playUrl]);

  // 置き場の曲を読みに行く(合言葉があるときだけ)。
  useEffect(() => {
    if (!syncEnabled) return;
    let active = true;
    const load = () => {
      fetchMusicTracks(syncKey)
        .then((result) => {
          if (!active || !result.ok) return;
          setServerTracks((current) => {
            const same =
              current.length === result.tracks.length &&
              current.every((track, index) => track.id === result.tracks[index]?.id);
            return same ? current : result.tracks;
          });
          setMusicPlaylists((current) => {
            const same = JSON.stringify(current) === JSON.stringify(result.playlists);
            return same ? current : result.playlists;
          });
          setActivePlaylistId(result.activePlaylistId);
          writeStoredLibrary({
            tracks: result.tracks,
            playlists: result.playlists,
            activePlaylistId: result.activePlaylistId,
          });
        })
        .catch(() => {
          // 圏外などは次の周期に任せる。
        });
    };
    load();
    const timer = window.setInterval(load, MUSIC_POLL_MS);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [syncEnabled, syncKey]);

  // スマホから再生を頼まれたら、こちらの音楽は止める(音が二重にならないように)。
  useEffect(() => {
    if (carPlaying) audioRef.current?.pause();
  }, [carPlaying]);

  // プレイリストを切り替えられたら、その1曲目から始める。
  useEffect(() => {
    setTrackIndex(0);
  }, [activePlaylistId]);

  // 曲が減ったときに、選択位置が範囲の外へ出ないようにする。
  useEffect(() => {
    setTrackIndex((current) =>
      playlistTracks.length === 0
        ? 0
        : Math.min(current, playlistTracks.length - 1),
    );
  }, [playlistTracks.length]);

  const playTrack = (index: number, autoPlay = true) => {
    if (!playlistTracks.length) return;
    const next = (index + playlistTracks.length) % playlistTracks.length;
    setTrackIndex(next);
    if (!autoPlay) return;
    // 曲の読み込み先が決まってから鳴らす(貯めた曲は端末の中から読む)。
    wantPlayRef.current = true;
  };

  /** 車の画面からプレイリストを切り替える(スマホにも反映される)。 */
  const selectPlaylist = (id: string) => {
    if (id === activePlaylistId) return;
    setActivePlaylistId(id);
    setTrackIndex(0);
    if (!syncEnabled) return;
    void saveMusicPlaylists(syncKey, musicPlaylists, id).catch(() => undefined);
  };

  const toggleMusic = () => {
    const audio = audioRef.current;
    if (!audio || !currentTrack) return;
    if (audio.paused) {
        void audio.play().catch(() => setIsPlaying(false));
    } else {
      audio.pause();
    }
  };

  const stopPairingTimer = () => {
    if (pairingTimerRef.current !== null) {
      window.clearInterval(pairingTimerRef.current);
      pairingTimerRef.current = null;
    }
  };

  const closePairing = () => {
    stopPairingTimer();
    setPairingLeft(0);
    settingsDialog.current?.close();
  };

  /** 表示してからの残り秒を数え、0になったら自動で閉じる。 */
  const armPairingTimer = () => {
    stopPairingTimer();
    setPairingLeft(PAIRING_AUTO_CLOSE_S);
    pairingTimerRef.current = window.setInterval(() => {
      setPairingLeft((left) => {
        if (left <= 1) {
          stopPairingTimer();
          settingsDialog.current?.close();
          return 0;
        }
        return left - 1;
      });
    }, 1000);
  };

  const openPairing = () => {
    setPairingQr(null);
    setPairingError(false);
    settingsDialog.current?.showModal();
    void startPairing();
  };

  /**
   * スマホと接続する。合言葉がまだ無ければここで作り、それを入れたURLの
   * QRを出す。合言葉は「#」より後ろに置くのでサーバーには送信されない。
   * QRの生成は使うときだけ読み込む(車載機の起動を重くしないため)。
   */
  const startPairing = async () => {
    setPairingError(false);
    let key = settings.syncKey.trim();
    if (key.length < MIN_SYNC_KEY_LENGTH) {
      key = generateSyncKey();
      const next = { ...settings, syncKey: key, syncedAt: 0 };
      setSettings(next);
    }
    try {
      const QRCode = (await import("qrcode")).default;
      const image = await QRCode.toDataURL(buildSyncHandoffUrl(key), {
        // 実寸より大きめに作り、CSS側で縮小して表示する(粗さが出ないように)。
        width: 720,
        margin: 1,
        errorCorrectionLevel: "M",
        color: { dark: "#04110c", light: "#e6fbf7" },
      });
      setPairingQr(image);
      armPairingTimer();
    } catch {
      setPairingError(true);
    }
  };

  const beginNavigation = async (
    destination: string,
    destinationLabel: RouteEta["destination"],
  ) => {
    const apiKey = settings.googleRoutesApiKey.trim() || DEFAULT_GMAPS_KEY;
    if (apiKey && location) {
      setRouteEtaStatus("loading");
      const controller = new AbortController();
      const timeout = window.setTimeout(() => controller.abort(), 6500);
      try {
        const response = await fetch(
          "https://routes.googleapis.com/directions/v2:computeRoutes",
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              "X-Goog-Api-Key": apiKey,
              "X-Goog-FieldMask": "routes.duration,routes.distanceMeters",
            },
            body: JSON.stringify({
              origin: {
                location: {
                  latLng: {
                    latitude: location.lat,
                    longitude: location.lng,
                  },
                },
              },
              destination: { address: destination },
              travelMode: "DRIVE",
              routingPreference: "TRAFFIC_AWARE",
              languageCode: "ja",
              units: "METRIC",
            }),
          },
        );
        if (!response.ok) throw new Error("route request failed");
        const data = (await response.json()) as {
          routes?: Array<{ duration?: string }>;
        };
        const durationSeconds = Math.ceil(
          Number.parseFloat(data.routes?.[0]?.duration?.replace("s", "") || ""),
        );
        if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
          throw new Error("route duration unavailable");
        }
        const nextEta: RouteEta = {
          arrivalAt: Date.now() + durationSeconds * 1000,
          durationSeconds,
          destination: destinationLabel,
        };
        localStorage.setItem("zcar-route-eta", JSON.stringify(nextEta));
        setRouteEta(nextEta);
        setRouteEtaStatus("ready");
      } catch {
        setRouteEtaStatus("error");
      } finally {
        window.clearTimeout(timeout);
      }
    }
    openMap(destination);
  };


  const fuelLitersInput = Number.parseFloat(fuelDraft.liters);
  const fuelDistanceInput = Number.parseFloat(fuelDraft.distanceKm);
  const fuelAmountInput = Number.parseFloat(fuelDraft.amountYen);
  const fuelDraftIsValid =
    /^\d{4}-\d{2}-\d{2}$/.test(fuelDraft.date) &&
    Number.isFinite(fuelLitersInput) &&
    fuelLitersInput > 0 &&
    Number.isFinite(fuelDistanceInput) &&
    fuelDistanceInput >= 0 &&
    Number.isFinite(fuelAmountInput) &&
    fuelAmountInput >= 0;
  const currentFuelEconomy =
    Number.isFinite(fuelLitersInput) &&
    fuelLitersInput > 0 &&
    Number.isFinite(fuelDistanceInput) &&
    fuelDistanceInput >= 0
      ? fuelDistanceInput / fuelLitersInput
      : null;
  const currentMonthKey = japanDateKey().slice(0, 7);
  const currentMonthFuelEntries = fuelEntries.filter((entry) =>
    entry.date.startsWith(currentMonthKey),
  );
  const monthlyFuelLiters = currentMonthFuelEntries.reduce(
    (total, entry) => total + entry.liters,
    0,
  );
  const monthlyFuelDistance = currentMonthFuelEntries.reduce(
    (total, entry) => total + entry.distanceKm,
    0,
  );
  const monthlyFuelAmount = currentMonthFuelEntries.reduce(
    (total, entry) => total + entry.amountYen,
    0,
  );
  const monthlyFuelEconomy =
    monthlyFuelLiters > 0 ? monthlyFuelDistance / monthlyFuelLiters : null;
  const sortedFuelEntries = [...fuelEntries].sort(
    (left, right) =>
      right.date.localeCompare(left.date) || right.createdAt - left.createdAt,
  );
  const recentFuelEntries = sortedFuelEntries.slice(0, 5);
  const recentFuelLiters = recentFuelEntries.reduce(
    (total, entry) => total + entry.liters,
    0,
  );
  const recentFuelDistance = recentFuelEntries.reduce(
    (total, entry) => total + entry.distanceKm,
    0,
  );
  const recentFuelEconomy =
    recentFuelLiters > 0 ? recentFuelDistance / recentFuelLiters : null;
  const estimatedUsedLiters =
    recentFuelEconomy === null ? null : fuelTripKm / recentFuelEconomy;
  const estimatedRemainingLiters =
    estimatedUsedLiters === null
      ? null
      : Math.max(0, FUEL_TANK_CAPACITY_L - estimatedUsedLiters);
  const safeRemainingLiters =
    estimatedRemainingLiters === null
      ? null
      : Math.max(0, estimatedRemainingLiters - FUEL_RESERVE_L);
  const fuelRangeKm =
    safeRemainingLiters === null || recentFuelEconomy === null
      ? 0
      : safeRemainingLiters * recentFuelEconomy;
  const fuelPercent =
    estimatedRemainingLiters === null
      ? 0
      : Math.max(0, Math.min(100, (estimatedRemainingLiters / FUEL_TANK_CAPACITY_L) * 100));
  const estimatedAverageFuelEconomy = recentFuelEconomy;

  const recordFuelEntry = () => {
    if (!fuelDraftIsValid) return;
    const now = Date.now();
    setSettings((current) => ({
      ...current,
      fuelEntries: mergeFuelEntries(current.fuelEntries, [
        {
          id: `${now}`,
          date: fuelDraft.date,
          liters: fuelLitersInput,
          distanceKm: fuelDistanceInput,
          amountYen: Math.round(fuelAmountInput),
          createdAt: now,
        },
      ]),
    }));
    setFuelTripKm(0);
    navigator.vibrate?.(60);
    setFuelDraft({
      date: japanDateKey(),
      liters: "",
      distanceKm: "",
      amountYen: "",
    });
  };

  // 音楽プレイヤーの中身。ホームとメーターの両方で同じものを出す。
  const musicPanel = (
    <>
                <header>
                  <small>
                    {activePlaylist ? activePlaylist.name : "MUSIC"}
                    {savingCount > 0 ? ` · 保存中 ${savingCount}` : ""}
                  </small>
                  <b>
                    {playlistTracks.length
                      ? `${trackIndex + 1} / ${playlistTracks.length}`
                      : "NO TRACK"}
                  </b>
                </header>
                <p className="media-title">
                  {currentTrack
                    ? currentTrack.title
                    : "スマホの設定「音源フォルダ」に曲を入れてください"}
                </p>
                <div className="media-status">
                  <span className={isPlaying ? "is-playing" : undefined}>
                    <i aria-hidden="true" />
                    {currentTrack
                      ? isPlaying
                        ? "PLAYING"
                        : "PAUSED"
                      : "STOPPED"}
                    {currentTrack && savedTracks.has(currentTrack.url) ? (
                      <b title="この端末に保存済み(通信なしで鳴ります)">SAVED</b>
                    ) : null}
                  </span>
                  <em>
                    {formatMusicTime(audioTime)} / {formatMusicTime(audioDuration)}
                  </em>
                </div>
                <div
                  className="media-progress"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={Math.round(audioDuration)}
                  aria-valuenow={Math.round(audioTime)}
                >
                  <i
                    style={{
                      width: `${audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0}%`,
                    }}
                  />
                </div>
                <div className="media-controls">
                  <button
                    type="button"
                    onClick={() => playTrack(trackIndex - 1)}
                    disabled={!currentTrack}
                    aria-label="前の曲"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M7 5v14M20 5 9 12l11 7z" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={toggleMusic}
                    disabled={!currentTrack}
                    aria-label={isPlaying ? "一時停止" : "再生"}
                  >
                    {isPlaying ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 5v14M16 5v14" />
                      </svg>
                    ) : (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M7 4.5 20 12 7 19.5z" />
                      </svg>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => playTrack(trackIndex + 1)}
                    disabled={!currentTrack}
                    aria-label="次の曲"
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M17 5v14M4 5l11 7-11 7z" />
                    </svg>
                  </button>
                </div>
                {musicPlaylists.length ? (
                  <div className="media-lists" aria-label="プレイリスト">
                    <button
                      type="button"
                      className={activePlaylistId === "" ? "is-active" : undefined}
                      onClick={() => selectPlaylist("")}
                    >
                      すべて
                    </button>
                    {musicPlaylists.map((list) => (
                      <button
                        key={list.id}
                        type="button"
                        className={activePlaylistId === list.id ? "is-active" : undefined}
                        onClick={() => selectPlaylist(list.id)}
                      >
                        {list.name}
                      </button>
                    ))}
                  </div>
                ) : null}
    </>
  );

  if (!hasStarted) {
    return (
      <div className="screen-shell">
        <main className="launch-screen">
          <button
            type="button"
            className="launch-z-button"
            onClick={launchZCar}
            aria-label="Z CARを起動"
          >
            <span className="launch-grid" aria-hidden="true" />
            <span className="launch-mark" aria-hidden="true">
              <svg viewBox="0 0 200 200">
                <circle className="launch-ring-spin" cx="100" cy="100" r="90" />
                <circle className="launch-ring-thin" cx="100" cy="100" r="76" />
                <path
                  className="launch-z"
                  d="M52 46 L148 46 L148 68 L88 122 L148 122 L148 144 L52 144 L52 122 L112 68 L52 68 Z"
                />
              </svg>
            </span>
            <span className="launch-word" aria-hidden="true">Z CAR</span>
            <span className="launch-hint" aria-hidden="true">TOUCH TO START</span>
            {BUILD_STAMP ? (
              <span className="build-stamp launch-build" aria-hidden="true">
                {BUILD_STAMP}
              </span>
            ) : null}
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="screen-shell">
      <div
        id="app"
        className={`${showFuel ? "" : "is-fullscreen "}${isFullscreen ? "browser-fullscreen " : ""}meter-theme-${settings.meterTheme}`}
        aria-label="Z CAR"
      >
        {/* ターコイズのメーターは四隅の操作だけで完結するので、上のバーは
            出さない。燃費画面と、まだ四隅の無いオレンジでは出す。 */}
        {!hideTopbar && (
          <header className="topbar">
            <div className="brand">
              <b>Z CAR</b>
              <small>
                {showFuel ? "TANTO FUEL ECONOMY" : "OBD2 VEHICLE MONITOR"}
              </small>
            </div>
            <div className="car-status">
              {showFuel ? (
                <button
                  type="button"
                  className="car-id car-id-button active"
                  onClick={toggleFuelView}
                  aria-label="メーターに戻る"
                >
                  METER
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="meter-theme-button"
                    onClick={() => themeDialog.current?.showModal()}
                    aria-label="Select meter theme"
                  >
                    THEME
                  </button>
                  <button
                    type="button"
                    className={`obd-connect-compact ${obdStatus}`}
                    onClick={connectObd}
                    aria-label="Connect OBD2"
                    title={`${obdDeviceName} · ${obdStatusLabelEn}${obdErrorMessage ? ` · ${obdErrorMessage}` : ""}`}
                  >
                    <i aria-hidden="true" />
                    <span>OBD2</span>
                  </button>
                </>
              )}
              <strong className="clock" aria-label={`現在時刻 ${clock}`}>
                {clock}
              </strong>
            </div>
          </header>
        )}

        {/* 操作用のバーのかわりに、状態だけを出す細いバー。 */}
        {hideTopbar && (
          <header className="meter-status" aria-label="接続の状態">
            {meterStatusItems.map((item) => (
              <span key={item.key} className={`meter-status-item is-${item.tone}`}>
                <i aria-hidden="true" />
                <small>{item.label}</small>
                <b>{item.value}</b>
              </span>
            ))}
            {/* 反映確認用のビルド時刻。帯の右端に薄く出す。 */}
            {BUILD_STAMP ? (
              <span className="build-stamp" aria-hidden="true">
                {BUILD_STAMP}
              </span>
            ) : null}
          </header>
        )}

        {!showFuel && (
          <main className="fullscreen-obd" aria-label="CARISTA OBD2 vehicle monitor">
            {settings.meterTheme === "eva" ? (
              <section className="eva-cluster" aria-label="Pattern orange command cockpit">
                <header className={`eva-topline ${obdStatus}`}>
                  <strong>特別警戒 DRIVE MONITOR</strong>
                  <span><i aria-hidden="true" />{obdStatusLabelEn}</span>
                  <b>
                    {routeMinutesRemaining === null
                      ? "ETA --"
                      : `DESTINATION ${routeMinutesRemaining} MIN`}
                  </b>
                </header>

                <EvaCockpit
                  rpm={obdData.rpm}
                  speed={displaySpeed}
                  coolant={obdData.coolant}
                  voltage={obdData.voltage}
                  status={obdStatus}
                />

                <footer className="eva-footer">
                  <span><small>時刻 LOCAL TIME</small><b>{clock}</b></span>
                  <button
                    type="button"
                    className={
                      [
                        fuelResetting ? "resetting" : "",
                        estimatedRemainingLiters !== null &&
                        estimatedRemainingLiters <= FUEL_RESERVE_L
                          ? "critical"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onPointerDown={startFuelReset}
                    onPointerUp={cancelFuelReset}
                    onPointerLeave={cancelFuelReset}
                    onPointerCancel={cancelFuelReset}
                    onContextMenu={(event) => event.preventDefault()}
                    aria-label={`Estimated range ${Math.round(fuelRangeKm)} kilometers. Hold to refuel.`}
                  >
                    <small>活動限界 ACTIVITY LIMIT</small>
                    <b>{Math.round(fuelRangeKm)} km</b>
                    <i style={{ width: `${fuelPercent}%` }} aria-hidden="true" />
                  </button>
                  <span>
                    <small>平均燃費 FUEL AVG</small>
                    <b>
                      {monthlyFuelEconomy === null
                        ? "-- km/L"
                        : `${monthlyFuelEconomy.toFixed(1)} km/L`}
                    </b>
                  </span>
                </footer>
              </section>
            ) : (
              <section className="performance-cluster green-nav-cluster" style={greenCockpitStyle}>
              <aside className="performance-side performance-left green-instrument-rail">
                <article className={`performance-date solar-clock-card ${weather?.isDay ? "day" : "night"}`}>
                  <div className="solar-clock-heading">
                    <small>LOCAL TIME</small>
                    <time>{clock}</time>
                  </div>
                  <div className="solar-clock-date">
                    <strong>{performanceDate}</strong>
                    <span>{performanceWeekday} · JST</span>
                  </div>
                  <div className={`solar-cycle ${weatherStatus}`} aria-label={`Sunrise ${solarSunrise ?? "unavailable"}, sunset ${solarSunset ?? "unavailable"}`}>
                    <span className="sunrise">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 18h18M5 14h2m10 0h2M8 10 6.5 8.5M16 10l1.5-1.5M12 8V5" />
                        <path d="M7.5 18a4.5 4.5 0 0 1 9 0" />
                        <path d="m10 12 2-2 2 2M12 10v5" />
                      </svg>
                      <b>{solarSunrise ?? "--:--"}</b>
                    </span>
                    <svg className="solar-orbit" viewBox="0 0 90 28" aria-hidden="true">
                      <path className="solar-horizon" d="M3 24H87" />
                      <path className="solar-path" d="M4 24Q45 -7 86 24" />
                      {solarProgress !== null ? <circle cx={solarPointX} cy={solarPointY} r="2.8" /> : null}
                    </svg>
                    <span className="sunset">
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M3 18h18M5 14h2m10 0h2M8 10 6.5 8.5M16 10l1.5-1.5M12 8V5" />
                        <path d="M7.5 18a4.5 4.5 0 0 1 9 0" />
                        <path d="m10 12 2 2 2-2M12 9v5" />
                      </svg>
                      <b>{solarSunset ?? "--:--"}</b>
                    </span>
                  </div>
                </article>

                <article className={`green-temperature-card ${weatherStatus}`}>
                  <small>OUTSIDE TEMPERATURE</small>
                  <p>
                    <strong>{weather ? Math.round(weather.temperature) : "—"}</strong>
                    <em>°C</em>
                  </p>
                  <span>CURRENT LOCATION</span>
                </article>

                <article className={`green-weather green-weather-side ${weatherStatus}`}>
                  {weather ? (
                    <div className="green-weather-timeline" aria-label="現在から6時間先までの天気">
                      <span>
                        <small>NOW</small>
                        <svg viewBox="0 0 48 48" aria-hidden="true">
                          <WeatherGlyph
                            code={weather.code}
                            isDay={weather.isDay}
                            x={24}
                            y={24}
                            size={43}
                          />
                        </svg>
                        <b>{weatherLabel(weather.code)}</b>
                      </span>
                      {weather.hours.slice(0, 2).map((hour, index) => (
                        <span key={hour.time}>
                          <small>{index === 0 ? "+3H" : "+6H"}</small>
                          <svg viewBox="0 0 48 48" aria-hidden="true">
                            <WeatherGlyph
                              code={hour.code}
                              isDay={hour.isDay}
                              x={24}
                              y={24}
                              size={39}
                            />
                          </svg>
                          <b>{weatherLabel(hour.code)}</b>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <span>
                      <small>LOCAL WEATHER</small>
                      <strong>{weatherStatus === "loading" ? "···" : "—"}</strong>
                    </span>
                  )}
                </article>

                <article className="green-world-times-card" aria-label="World time">
                  <small>WORLD TIME</small>
                  <div className="green-world-times">
                    <span aria-label={`California time ${californiaClock}`}>
                      <b>CALIFORNIA</b>
                      <time>{californiaClock}</time>
                    </span>
                    <span aria-label={`Russia Moscow time ${russiaClock}`}>
                      <b>RUSSIA</b>
                      <time>{russiaClock}</time>
                    </span>
                    <span aria-label={`China Beijing time ${chinaClock}`}>
                      <b>CHINA</b>
                      <time>{chinaClock}</time>
                    </span>
                  </div>
                </article>

                <article className="green-daily-distance-card">
                  <div className="green-daily-distance">
                    <small>TODAY DISTANCE</small>
                    <span><strong>{dailyTripKm.toFixed(1)}</strong><em>km</em></span>
                  </div>
                </article>

              </aside>

              <article className="performance-main-gauge green-map-gauge" aria-label="Map integrated tachometer and speedometer">
                {/* 円の外側に余る四隅に、メーターを離れずに押せるボタンを置く。
                    計器の配置には触らない(重ねるだけ)。 */}
                <div className="gauge-corners" aria-label="メーターからの操作">
                  <button
                    type="button"
                    className="gauge-corner gauge-corner-tl"
                    onClick={() =>
                      navTarget &&
                      void beginNavigation(navTarget.destination, "DESTINATION")
                    }
                    disabled={!navTarget}
                  >
                    <small>案内開始</small>
                    <b>{navTarget?.label ?? "未設定"}</b>
                  </button>
                  <button
                    type="button"
                    className={`gauge-corner gauge-corner-tr obd-${obdStatus}`}
                    onClick={() => connectDialog.current?.showModal()}
                  >
                    <small>OBD2・スマホ</small>
                    <b>接続</b>
                  </button>
                  <button
                    type="button"
                    className="gauge-corner gauge-corner-bl"
                    onClick={() => destDialog.current?.showModal()}
                  >
                    <small>変更</small>
                    <b>目的地</b>
                  </button>
                  <button
                    type="button"
                    className="gauge-corner gauge-corner-br"
                    onClick={() => themeDialog.current?.showModal()}
                  >
                    <small>切り替え</small>
                    <b>テーマ</b>
                  </button>
                </div>
                <div className="performance-rpm-track" aria-hidden="true" />
                <div className="performance-rpm-ticks" aria-hidden="true" />
                <div className="performance-rpm-labels" aria-hidden="true">
                  <span>0</span><span>1</span><span>2</span><span>3</span><span>4</span>
                  <span>5</span><span>6</span><span>7</span><span>8</span>
                </div>
                <small className="performance-rpm-title">ENGINE SPEED · ×1000 RPM</small>

                <div className="green-gauge-map-window">
                  <div
                    ref={greenMapElementRef}
                    className="green-nav-map-canvas"
                    aria-hidden="true"
                  />
                  <div
                    className={`green-map-standby${greenMapReady ? " is-ready" : ""}`}
                    aria-hidden="true"
                  >
                    <i className="green-map-standby-sweep" />
                    <b>ACQUIRING MAP</b>
                  </div>
                  <div className="green-map-grid" aria-hidden="true" />
                  <div className="green-map-vignette" aria-hidden="true" />
                  <div className={`green-compass-bearing ${locationStatus}`} aria-hidden="true">
                    <span className="north">N</span>
                    <span className="east">E</span>
                    <span className="south">S</span>
                    <span className="west">W</span>
                  </div>
                  <div className="green-gauge-speed">
                    <small>SPEED</small>
                    <strong>{greenCenterSpeed ?? "—"}</strong>
                    <span>km/h</span>
                  </div>
                </div>

                <div className="performance-rpm-digital">
                  <small>RPM</small>
                  <b>{obdData.rpm ?? "—"}</b>
                  <span>rpm</span>
                </div>
              </article>

              <aside className="performance-side performance-right green-drive-panel green-instrument-rail">
                <article
                  className="green-range-card"
                  aria-label={`Safe estimated range ${Math.round(fuelRangeKm)} kilometers. Resets automatically when a refuel record is saved.`}
                >
                  <small>SAFE EST. RANGE</small>
                  <span><strong>{Math.round(fuelRangeKm)}</strong><em>km</em></span>
                  <div className="green-range-scale" aria-hidden="true">
                    <b>F</b><div><i style={{ width: `${fuelPercent}%` }} /></div><b>E</b>
                  </div>
                  <small>AUTO RESET · REFUEL LOG</small>
                </article>
                <button
                  type="button"
                  className="green-average-fuel-card green-card-button"
                  onClick={toggleFuelView}
                  aria-label="燃費の記録・確認を開く"
                >
                  <div className="green-average-fuel" aria-label="Estimated average fuel economy">
                    <span>
                      <small>EST. AVERAGE FUEL</small>
                      <b>{estimatedAverageFuelEconomy === null ? "—" : estimatedAverageFuelEconomy.toFixed(1)}</b>
                      <em>km/L</em>
                    </span>
                    <i>FULL TANK TRIP {Math.round(fuelTripKm)} km / EST {estimatedRemainingLiters?.toFixed(1) ?? "—"} L</i>
                  </div>
                </button>
                <article className="green-speed-card">
                  <div className="green-telemetry-graph green-speed-graph">
                    <header><small>SPEED</small><em>km/h</em></header>
                    <div className="green-range-scale green-speed-scale" aria-label="Speed from 0 to 120 kilometers per hour">
                      <b>0</b><div><i /></div><b>120</b>
                    </div>
                  </div>
                </article>
                <article className="green-obd-card">
                  <small>COOLANT TEMP</small>
                  <p><strong>{obdData.coolant ?? "—"}</strong><em>°C</em></p>
                  <span>ENGINE THERMAL</span>
                </article>
                <article className="green-obd-card">
                  <small>SYSTEM VOLTAGE</small>
                  <p><strong>{obdData.voltage?.toFixed(1) ?? "—"}</strong><em>V</em></p>
                  <span>BATTERY SYSTEM</span>
                </article>
                {/* 右下のYouTube。スマホから指定された曲を鳴らしている間は、
                    右下に出るプレイヤーと重なるので出さない(音も二重になる)。 */}
                {carPlaying ? null : (
                  <article className="media-card" aria-label="音楽プレイヤー">
                    {musicPanel}
                  </article>
                )}
              </aside>
              </section>
            )}
          </main>
        )}

        {showFuel ? (
          <main className="fuel-page" aria-label="タント燃費計算">
            <section className="fuel-page-heading">
              <span>
                <small>TANTO / FUEL LOG</small>
                <h1>満タン法 燃費計算</h1>
              </span>
              <p>給油時の走行距離 ÷ 給油量で実燃費を記録します</p>
            </section>

            <section className="fuel-summary" aria-label="今月の燃費集計">
              <article className="fuel-summary-primary">
                <small>今月の平均燃費</small>
                <strong>{monthlyFuelEconomy === null ? "—" : monthlyFuelEconomy.toFixed(1)}</strong>
                <em>km/L</em>
              </article>
              <article>
                <small>今月の合計給油量</small>
                <strong>{monthlyFuelLiters.toFixed(1)}</strong>
                <em>L</em>
              </article>
              <article>
                <small>今月の合計金額</small>
                <strong>{Math.round(monthlyFuelAmount).toLocaleString("ja-JP")}</strong>
                <em>円</em>
              </article>
              <article>
                <small>今月の走行距離</small>
                <strong>{monthlyFuelDistance.toFixed(1)}</strong>
                <em>km</em>
              </article>
            </section>

            <div className="fuel-workspace">
              <section className="fuel-entry-card" aria-label="給油記録を入力">
                <header>
                  <span><small>NEW REFUEL</small><strong>給油データ入力</strong></span>
                  <b>{currentMonthFuelEntries.length} RECORDS / {currentMonthKey}</b>
                </header>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    recordFuelEntry();
                  }}
                >
                  <label>
                    <span>給油日</span>
                    <input
                      type="date"
                      value={fuelDraft.date}
                      onChange={(event) =>
                        setFuelDraft({ ...fuelDraft, date: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    <span>給油量</span>
                    <div><input
                      type="number"
                      inputMode="decimal"
                      min="0.01"
                      step="0.01"
                      placeholder="0.00"
                      value={fuelDraft.liters}
                      onChange={(event) =>
                        setFuelDraft({ ...fuelDraft, liters: event.target.value })
                      }
                    /><em>L</em></div>
                  </label>
                  <label>
                    <span>走行距離</span>
                    <div><input
                      type="number"
                      inputMode="decimal"
                      min="0"
                      step="0.1"
                      placeholder="0.0"
                      value={fuelDraft.distanceKm}
                      onChange={(event) =>
                        setFuelDraft({ ...fuelDraft, distanceKm: event.target.value })
                      }
                    /><em>km</em></div>
                  </label>
                  <label>
                    <span>給油金額</span>
                    <div><input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      step="1"
                      placeholder="0"
                      value={fuelDraft.amountYen}
                      onChange={(event) =>
                        setFuelDraft({ ...fuelDraft, amountYen: event.target.value })
                      }
                    /><em>円</em></div>
                  </label>
                  <div className="fuel-live-result" aria-live="polite">
                    <span><small>今回の燃費</small><strong>{currentFuelEconomy === null ? "—" : currentFuelEconomy.toFixed(1)}</strong><em>km/L</em></span>
                    <button type="submit" disabled={!fuelDraftIsValid}>記録する</button>
                  </div>
                </form>
              </section>

              <section className="fuel-history-card" aria-label="給油履歴">
                <header>
                  <span><small>FUEL HISTORY</small><strong>給油履歴</strong></span>
                  <b>{fuelEntries.length} TOTAL</b>
                </header>
                <div className="fuel-history-table">
                  {sortedFuelEntries.length === 0 ? (
                    <p>給油データはまだありません</p>
                  ) : (
                    sortedFuelEntries.map((entry) => (
                      <article key={entry.id}>
                        <time>{entry.date.replaceAll("-", ".")}</time>
                        <span><small>燃費</small><strong>{(entry.distanceKm / entry.liters).toFixed(1)}</strong><em>km/L</em></span>
                        <span><small>給油量</small><strong>{entry.liters.toFixed(1)}</strong><em>L</em></span>
                        <span><small>走行</small><strong>{entry.distanceKm.toFixed(1)}</strong><em>km</em></span>
                        <span><small>金額</small><strong>{Math.round(entry.amountYen).toLocaleString("ja-JP")}</strong><em>円</em></span>
                      </article>
                    ))
                  )}
                </div>
              </section>
            </div>
          </main>
        ) : null}

        <footer>
          安全運転を最優先してください
        </footer>

        {/* 音の実体。画面を切り替えても止まらないよう、ここに1つだけ置く。 */}
        <audio
          ref={audioRef}
          src={playUrl ?? undefined}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onEnded={() => playTrack(trackIndex + 1)}
          onError={() => setIsPlaying(false)}
          onTimeUpdate={(event) => setAudioTime(event.currentTarget.currentTime)}
          onLoadedMetadata={(event) => {
            const length = event.currentTarget.duration;
            setAudioDuration(Number.isFinite(length) ? length : 0);
            setAudioTime(0);
          }}
        />

        {/* メーター表示中でも消えないよう、画面の切り替えとは別のところに置く。
            ここで消すと iframe が作り直されて音が止まってしまう。 */}
        {carPlaying ? (
          <aside
            className={`car-player${carPlaying.collapsed ? " is-collapsed" : ""}`}
            aria-label="スマホから指定された音楽"
          >
            {/* 畳んでいる間も iframe は残す。消すと音まで止まってしまう。 */}
            <iframe
              key={carPlaying.reloadKey}
              src={`https://www.youtube.com/embed/videoseries?list=${carPlaying.playlistId}&autoplay=1&playsinline=1&rel=0&loop=1&controls=0&iv_load_policy=3&modestbranding=1&fs=0&disablekb=1`}
              title={`${carPlaying.label || "MUSIC"} プレイリスト`}
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
            />
            {carPlaying.collapsed ? (
              <button
                type="button"
                className="car-player-badge"
                aria-label={`再生中: ${carPlaying.label || "MUSIC"} の操作を開く`}
                onClick={() =>
                  setCarPlaying((current) =>
                    current ? { ...current, collapsed: false } : current,
                  )
                }
              >
                MUSIC
              </button>
            ) : (
              <>
                <span className="car-player-name">{carPlaying.label || "MUSIC"}</span>
                <div className="car-player-actions">
                  <button
                    type="button"
                    onClick={() =>
                      setCarPlaying((current) =>
                        current
                          ? { ...current, reloadKey: Date.now(), collapsed: true }
                          : current,
                      )
                    }
                  >
                    再生
                  </button>
                  <button type="button" onClick={() => setCarPlaying(null)}>
                    停止
                  </button>
                </div>
              </>
            )}
          </aside>
        ) : null}

      </div>

      <dialog ref={themeDialog} className="theme-dialog-shell">
        <div className="dialog-card meter-theme-dialog">
          <header>
            <span>
              <small>FULLSCREEN DISPLAY</small>
              <h2>METER THEME</h2>
            </span>
            <button
              type="button"
              onClick={() => themeDialog.current?.close()}
              aria-label="Close theme settings"
            >
              CLOSE
            </button>
          </header>
          <div className="meter-theme-options">
            <button
              type="button"
              className={settings.meterTheme === "green" ? "selected" : undefined}
              onClick={() => {
                setSettings({ ...settings, meterTheme: "green" });
                themeDialog.current?.close();
              }}
            >
              <i className="theme-preview green" aria-hidden="true">
                <span className="turquoise-label">TURQUOISE BLUE</span>
              </i>
              <span><b>TURQUOISE BLUE</b><small>TURQUOISE COCKPIT THEME</small></span>
              <em>{settings.meterTheme === "green" ? "ACTIVE" : "SELECT"}</em>
            </button>
            <button
              type="button"
              className={settings.meterTheme === "eva" ? "selected eva" : "eva"}
              onClick={() => {
                setSettings({ ...settings, meterTheme: "eva" });
                themeDialog.current?.close();
              }}
            >
              <i className="theme-preview eva" aria-hidden="true">
                <span>PATTERN ORANGE</span>
              </i>
              <span><b>PATTERN ORANGE</b><small>COMMAND ROOM COCKPIT</small></span>
              <em>{settings.meterTheme === "eva" ? "ACTIVE" : "SELECT"}</em>
            </button>
          </div>
        </div>
      </dialog>

      <dialog ref={destDialog}>
        <div className="dialog-card dest-card">
          <h2>目的地を選ぶ</h2>
          {navChoices.length ? (
            <div className="dest-choices">
              {navChoices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  className={choice.key === navTarget?.key ? "is-active" : undefined}
                  onClick={() => {
                    setNavTargetKey(choice.key);
                    destDialog.current?.close();
                  }}
                >
                  <b>{choice.label}</b>
                  <small>{choice.destination}</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="settings-hint">
              目的地がまだありません。スマホの設定「ナビ」から登録してください。
            </p>
          )}
          <div className="two-actions">
            <button onClick={() => destDialog.current?.close()}>閉じる</button>
          </div>
        </div>
      </dialog>

      <dialog ref={connectDialog}>
        <div className="dialog-card dest-card">
          <h2>接続</h2>
          <div className="dest-choices">
            <button
              type="button"
              onClick={() => {
                connectDialog.current?.close();
                void connectObd();
              }}
            >
              <b>車のOBD2につなぐ</b>
              <small>{obdDeviceName} · {obdStatusLabelEn}</small>
            </button>
            <button
              type="button"
              onClick={() => {
                connectDialog.current?.close();
                openPairing();
              }}
            >
              <b>スマホとつなぐ</b>
              <small>QRを出して、スマホのカメラで読み取ります</small>
            </button>
          </div>
          <div className="two-actions">
            <button onClick={() => connectDialog.current?.close()}>閉じる</button>
          </div>
        </div>
      </dialog>

      <dialog ref={settingsDialog} onClose={stopPairingTimer}>
        <div className="dialog-card sync-card">
          <h2>スマホと接続</h2>
          {pairingQr ? (
            <div className="pairing-qr">
              <img src={pairingQr} alt="接続用QRコード" width={720} height={720} />
              <p>スマホのカメラで読み取ってください</p>
              <p className="pairing-warn">他の人には見せないでください</p>
              <p className="pairing-countdown" role="status">
                あと {pairingLeft} 秒で閉じます
              </p>
            </div>
          ) : (
            <>
              <button
                type="button"
                className="pairing-start"
                onClick={() => void startPairing()}
              >
                QRを表示する
              </button>
              <p className="settings-hint">
                {pairingError
                  ? "QRを作れませんでした。もう一度押してください。"
                  : "QRを読み取ると、スマホからメーターの色・ナビの目的地・音楽を変えられます。"}
              </p>
            </>
          )}
          <div className="two-actions">
            <button onClick={closePairing}>閉じる</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
