"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { useObd2, type ObdConnectionStatus } from "./hooks/use-obd2";
import { useParkingReport } from "./hooks/use-parking-report";
import { useSharedSync } from "./hooks/use-shared-sync";
import {
  buildSyncHandoffUrl,
  CAR_DEVICE_KEY,
  defaults,
  generateSyncKey,
  listNavChoices,
  MAX_DESTINATION_LABEL,
  MAX_DESTINATION_TEXT,
  MAX_PLACES,
  METER_DESIGNS,
  meterDesignInfo,
  METER_STYLES,
  meterStyleInfo,
  METER_THEMES,
  meterThemeInfo,
  MIN_SYNC_KEY_LENGTH,
  NEW_PLACE_KEY,
  PHONE_LONG_EDGE_MAX,
  mergeFuelEntries,
  readSettings,
  resolveStartTarget,
  saveNavChoice,
  SETTINGS_STORAGE_KEY,
  writeSettings,
  type NavChoice,
  type Settings,
} from "./settings-store";
import { MeterDesignGauge, type GaugeValues } from "./meter-designs";
import {
  DayCluster,
  MeterStyleThumb,
  RETRO_MAP_LOOK,
  RetroCluster,
  type ClusterData,
} from "./meter-styles";
import { DEFAULT_GMAPS_KEY, loadGoogleMaps, NIGHT_MAP_STYLES } from "./google-maps";
import {
  addDays,
  nextShift,
  parseShiftFeed,
  SHIFT_REFRESH_MS,
  SHIFT_URL,
  shiftDayLabel,
  shiftTimeText,
  shiftWeek,
  shortDate,
  weekdayJa,
  workWeekdays,
  type ShiftFeed,
} from "./shifts";
import { WorkdayMarks } from "./workday-marks";
import { readCoords } from "./place-import";
import { StarMark } from "./star-mark";

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
// ターコイズメーターの円形窓用: 夜間配色に加えて、スポット等の
// アイコン類を非表示にしたレーダー向けスタイル。ラスター地図でのみ
// 有効(ベクター+Map IDの地図はクラウド側スタイルが優先される)。
const GREEN_METER_MAP_STYLES = [
  ...NIGHT_MAP_STYLES,
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "poi", elementType: "labels.text", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

const FUEL_LOG_STORAGE_KEY = "zcar-fuel-log-v1";
// 最後の給油から走った距離と、数え始めた時刻(その給油を記録した時刻)。
const FUEL_TRIP_KM_STORAGE_KEY = "zcar-fuel-trip-km";
const FUEL_TRIP_SINCE_STORAGE_KEY = "zcar-fuel-trip-since";
// スマホで変えた内容(給油記録・目的地・色)を取りに行く間隔。
const PHONE_SYNC_POLL_MS = 30000;
/**
 * 車とスマホの同期をやり直したとき、最初の1回だけは車の内容を正とする印。
 * (10/10 から車はスマホと切り離していたので、その間に車で直した目的地や
 *  色を、スマホに残っていた古い値で上書きしないため)
 */
const SHARED_SYNC_READY_KEY = "zcar-shared-sync-v2";
const readSharedSyncReady = () => {
  try {
    return localStorage.getItem(SHARED_SYNC_READY_KEY) === "1";
  } catch {
    return false;
  }
};
const markSharedSyncReady = () => {
  try {
    localStorage.setItem(SHARED_SYNC_READY_KEY, "1");
  } catch {
    // 保存できなくても、次回もう一度車を正として送るだけ。
  }
};

// 接続用QRを出しておく秒数。合言葉そのものなので出しっぱなしにしない。
const PAIRING_AUTO_CLOSE_S = 10;

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

/** Zポータルの更新時刻(ISO の形)を、日本時間の「10/22 01:30」に。読めなければそのまま。 */
const formatShiftUpdated = (value: string) => {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(time);
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

/** 曜日(Date の getDay と同じ並び: 0 が日曜)。時計の上の日付に使う。 */
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
/** 一週間の帯は月曜はじまりで並べる(WEEKDAYS_JA の番号)。 */
const WEEK_STRIP_ORDER = [1, 2, 3, 4, 5, 6, 0];

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
  // 出発・帰宅と目的地の一覧。車の DEST とスマホで同じ並び。
  const allNavChoices = listNavChoices(settings);
  // DEST の「選ぶ」に出す候補(住所があるものだけ)。
  const navChoices = allNavChoices.filter((entry) => entry.destination);
  // START で案内する行き先(★)。車とスマホのどちらで★を付けても同じになる。
  const navTarget = resolveStartTarget(allNavChoices, settings.startTarget);
  const [clock, setClock] = useState("--:--");
  const [californiaClock, setCaliforniaClock] = useState("--:--");
  const [russiaClock, setRussiaClock] = useState("--:--");
  const [chinaClock, setChinaClock] = useState("--:--");
  const [isOnline, setIsOnline] = useState(true);
  const [ready, setReady] = useState(false);
  // この端末が車載機か。車両位置を送るのは車載機だけ(スマホで車の画面を開いても送らない)。
  const [carDevice, setCarDevice] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // このブラウザで全画面にできるか(できない端末ではボタンを出さない)。
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [showFuel, setShowFuel] = useState(false);
  // 給油記録は設定と同じ入れ物に置き、スマホと共有する。
  const fuelEntries = settings.fuelEntries;
  // いちばん新しい給油を記録した時刻。スマホで記録した給油も、届いたらここが新しくなる。
  const latestRefuelAt = fuelEntries.reduce((latest, entry) => Math.max(latest, entry.createdAt), 0);
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
    autoState: obdAutoState,
  } = useObd2();
  const [displaySpeed, setDisplaySpeed] = useState<number | null>(null);
  // 最後の給油から走った距離(km)と、数え始めた時刻(その給油を記録した時刻)。
  // 数え始めより新しい給油が記録されたら(車でもスマホでも)、0から数え直す。
  const [fuelTrip, setFuelTrip] = useState({ km: 0, since: 0 });
  // 今日の走行。距離と、動いていた時間(止まっている時間は数えない)。
  const [dailyTrip, setDailyTrip] = useState({
    date: japanDateKey(),
    distanceKm: 0,
    movingSec: 0,
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
    /** GPS の速さ(km/h)。分からなければ null。 */
    speed: number | null;
  } | null>(null);
  const [locationStatus, setLocationStatus] = useState<
    "locating" | "ready" | "unavailable"
  >("locating");
  const [weather, setWeather] = useState<WeatherData | null>(null);
  const [weatherStatus, setWeatherStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const destDialog = useRef<HTMLDialogElement>(null);
  // 目的地ダイアログ: 「選ぶ」か「編集」か。編集中はどの場所かも覚える。
  const [destMode, setDestMode] = useState<"pick" | "edit">("pick");
  const [destEditKey, setDestEditKey] = useState<string | null>(null);
  const [destDraft, setDestDraft] = useState({ label: "", destination: "" });
  const themeDialog = useRef<HTMLDialogElement>(null);
  // Zポータルの確定シフト(上の帯に次のシフト、押すと1週間の画面)。
  const shiftDialog = useRef<HTMLDialogElement>(null);
  /** 近未来のテーマの一週間の帯(出勤日の札を上に重ねるため)。 */
  const weekStripRef = useRef<HTMLOListElement>(null);
  const [shiftFeed, setShiftFeed] = useState<ShiftFeed | null>(null);
  const [shiftStatus, setShiftStatus] = useState<"loading" | "ready" | "error">("loading");
  // スマホとつなぐためのQR(燃費画面から開く)。
  const pairingDialog = useRef<HTMLDialogElement>(null);
  const pairingTimerRef = useRef<number | null>(null);
  const [pairingLeft, setPairingLeft] = useState(0);
  const [pairingQr, setPairingQr] = useState<string | null>(null);
  const [pairingError, setPairingError] = useState(false);
  const fuelMotionRef = useRef<{
    speed: number | null;
    status: ObdConnectionStatus;
  }>({
    speed: null,
    status: "idle",
  });
  const latestRefuelRef = useRef(0);
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
  // メーターの真ん中を押して形を変えたとき、形の名前を少しだけ出す(数が変わるたびに出し直す)。
  const [designFlash, setDesignFlash] = useState(0);
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
        localStorage.getItem(FUEL_TRIP_KM_STORAGE_KEY) || "0",
      );
      // 前の版は数え始めた時刻を残していないので0にする(いちばん新しい給油から数え直す)。
      const savedFuelTripSince = Number(
        localStorage.getItem(FUEL_TRIP_SINCE_STORAGE_KEY) || "0",
      );
      setFuelTrip({
        km: Number.isFinite(savedFuelTrip) ? Math.max(0, savedFuelTrip) : 0,
        since: Number.isFinite(savedFuelTripSince) ? savedFuelTripSince : 0,
      });
      const savedDailyTrip = JSON.parse(
        localStorage.getItem(DAILY_TRIP_STORAGE_KEY) || "null",
      ) as { date?: unknown; distanceKm?: unknown; movingSec?: unknown } | null;
      const currentDate = japanDateKey();
      const sameDay = savedDailyTrip?.date === currentDate;
      const savedNumber = (value: unknown) =>
        sameDay && typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
      setDailyTrip({
        date: currentDate,
        distanceKm: savedNumber(savedDailyTrip?.distanceKm),
        movingSec: savedNumber(savedDailyTrip?.movingSec),
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
    // iPhone は大きい機種でもスマホなので覚えない(先読みの判定と同じ)。
    if (
      !/iPhone|iPod/.test(navigator.userAgent) &&
      Math.max(window.innerWidth, window.innerHeight) >= PHONE_LONG_EDGE_MAX
    ) {
      try {
        localStorage.setItem(CAR_DEVICE_KEY, "car");
      } catch {
        // 保存できない設定でも動作に支障はない。
      }
    }
    try {
      setCarDevice(
        localStorage.getItem(CAR_DEVICE_KEY) === "car" &&
          !/iPhone|iPad|iPod/.test(navigator.userAgent),
      );
    } catch {
      // 印を読めない端末は車として扱わない(場所を送らない)。
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

  // 容量不足などで、ブラウザがこのサイトのデータ(給油記録など)を
  // 勝手に消さないように頼んでおく。
  useEffect(() => {
    if (!ready) return;
    const storage = navigator.storage;
    if (storage && typeof storage.persist === "function") {
      void storage.persist().catch(() => false);
    }
  }, [ready]);

  // --- スマホとの同期 ---
  // 給油記録・目的地・メーターの色を、車とスマホのどちらからでも変えられる。
  // 中身は use-shared-sync(スマホの設定ページと同じ仕組み)。
  const phoneSync = useSharedSync({
    settings,
    setSettings,
    ready,
    pollMs: PHONE_SYNC_POLL_MS,
    // 切り離していた後の最初の1回は車を正とする。それ以降は時刻の新しい方。
    keepLocalOnFirstSync: (serverUpdatedAt, local) =>
      !(readSharedSyncReady() && serverUpdatedAt > local.syncedAt),
    onInSync: () => {
      if (!readSharedSyncReady()) markSharedSyncReady();
    },
  });

  // --- 車両位置 ---
  // 止まったときなどに場所を送り、スマホの「車両位置」に停めた場所を出す。
  const parkingKey = settings.syncKey.trim();
  useParkingReport({
    enabled: ready && carDevice && parkingKey.length >= MIN_SYNC_KEY_LENGTH,
    syncKey: parkingKey,
    location,
    // OBD の速さは、いま届いているときだけ使う(切れたまま残った古い値で、走っているのに
    // 止まっているとしないため)。届いていなければ GPS で決める。
    obdSpeed: obdStatus === "live" ? obdData.speed : null,
  });

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
    latestRefuelRef.current = latestRefuelAt;
  }, [latestRefuelAt]);

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
      // 数え始めより新しい給油(スマホで記録して届いた給油など)があれば、そこから数え直す。
      const refuelAt = latestRefuelRef.current;
      setFuelTrip((current) =>
        refuelAt > current.since
          ? { km: travelledKm, since: refuelAt }
          : { ...current, km: current.km + travelledKm },
      );
      const currentDate = japanDateKey();
      const movedSec = elapsedMs / 1000;
      setDailyTrip((current) =>
        current.date === currentDate
          ? {
              date: currentDate,
              distanceKm: current.distanceKm + travelledKm,
              movingSec: current.movingSec + movedSec,
            }
          : { date: currentDate, distanceKm: travelledKm, movingSec: movedSec },
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (ready) {
      localStorage.setItem(FUEL_TRIP_KM_STORAGE_KEY, fuelTrip.km.toFixed(4));
      localStorage.setItem(FUEL_TRIP_SINCE_STORAGE_KEY, String(fuelTrip.since));
    }
  }, [fuelTrip, ready]);

  useEffect(() => {
    if (ready) {
      localStorage.setItem(DAILY_TRIP_STORAGE_KEY, JSON.stringify(dailyTrip));
    }
  }, [dailyTrip, ready]);

  useEffect(() => {
    const syncFullscreen = () =>
      setIsFullscreen(Boolean(document.fullscreenElement));
    setCanFullscreen(Boolean(document.fullscreenEnabled));
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
          const gpsSpeed = position.coords.speed;
          return {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracy: position.coords.accuracy,
            heading,
            speed:
              gpsSpeed !== null && Number.isFinite(gpsSpeed) ? gpsSpeed * 3.6 : null,
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

  // 全画面にする。画面に触れたときしか頼めないので、必ずボタンから呼ぶ。
  const goFullscreen = () => {
    if (document.fullscreenElement) return;
    void document.documentElement.requestFullscreen().catch(() => {
      // 全画面にできないブラウザでも、そのまま使える。
    });
  };

  // Zのボタンを押したらメーターへ。全画面もここで頼む。
  const launchZCar = () => {
    setHasStarted(true);
    goFullscreen();
  };

  // 「戻る」でメーターに帰れるよう、最初の履歴に印を付けておく。
  useEffect(() => {
    window.history.replaceState(
      { ...(window.history.state || {}), zcarView: "meter" },
      "",
    );
  }, []);

  // Zポータルのシフトを読む。開いたとき・30分ごと・画面に戻ったとき。
  // 読めなかったときは前に読めた分をそのまま出す(一度も読めていなければ「取得できません」)。
  useEffect(() => {
    let active = true;
    const loadShifts = async () => {
      try {
        const response = await fetch(SHIFT_URL, { cache: "no-store" });
        if (!response.ok) throw new Error("shift request failed");
        const feed = parseShiftFeed(await response.json());
        if (!feed) throw new Error("invalid shift data");
        if (!active) return;
        setShiftFeed(feed);
        setShiftStatus("ready");
      } catch {
        if (active) setShiftStatus((current) => (current === "ready" ? current : "error"));
      }
    };
    void loadShifts();
    const timer = window.setInterval(loadShifts, SHIFT_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void loadShifts();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
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
  // 地図はメーター(近未来のどちらの形と、80年代のテーマに地図がある)を出しているときだけ作る。
  // 地図の器はテーマ(近未来なら形)ごとに違う。デイライトのテーマには地図を置かない。
  const meterStyleId = meterStyleInfo(settings.meterStyle).id;
  const mapHost = showFuel
    ? null
    : meterStyleId === "future"
      ? meterDesignInfo(settings.meterDesign).id
      : meterStyleId === "retro"
        ? "retro"
        : null;

  // 燃費画面や別の形へ移ると、地図の器が外れる(または別の器になる)ので作り直す。
  useEffect(() => {
    greenGmapRef.current = null;
    setGreenMapReady(false);
  }, [mapHost]);

  useEffect(() => {
    if (!mapHost || !mapsApiKey || !greenMapElementRef.current) return;
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
          // 80年代のテーマは、昔の車の緑の画面ふうの地図にする。
          const look =
            mapHost === "retro"
              ? RETRO_MAP_LOOK
              : {
                  zoom: GREEN_METER_MAP_ZOOM,
                  styles: GREEN_METER_MAP_STYLES,
                  background: GREEN_METER_MAP_BACKGROUND,
                };
          const map = new mapsApi.Map(greenMapElementRef.current, {
            center: focusPoint,
            zoom: look.zoom,
            styles: look.styles,
            // タイル未読込の間に出る既定の明るい下地(#e5e3df)が、
            // メーターのフィルタを通ると白く光ってしまうので暗色にする。
            backgroundColor: look.background,
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
  }, [mapHost, location, mapsApiKey]);


  const hour = new Date().getHours();
  const today = japanDateKey();
  const upcomingShift = shiftFeed ? nextShift(shiftFeed, today, clock) : null;
  // 今週(月曜〜日曜)でシフトのある曜日(0 が日曜)。一週間の帯の札に五行の色を付ける。
  const workDays = shiftFeed ? [...workWeekdays(shiftFeed, today)].sort((a, b) => a - b) : [];
  // 1週間の画面で、今日から7日のうちにシフトがないときに出す、その先の次のシフト。
  const laterShift = shiftFeed && upcomingShift && upcomingShift.date > addDays(today, 6) ? upcomingShift : null;
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
  const dailyMovingSec = dailyTrip.date === today ? dailyTrip.movingSec : 0;
  // 平均巡行速度: 今日走った距離 ÷ 動いていた時間。1分走るまでは出さない。
  const averageCruiseKmh =
    dailyMovingSec >= 60 ? dailyTripKm / (dailyMovingSec / 3600) : null;
  // 時計の上に出す今日の日付(例: 10/11（日）)。
  const [todayYear, todayMonth, todayDay] = today.split("-").map(Number);
  const todayMonthDay = `${todayMonth}/${todayDay}`;
  const todayWeekdayIndex = new Date(Date.UTC(todayYear, todayMonth - 1, todayDay)).getUTCDay();
  const todayWeekday = WEEKDAYS_JA[todayWeekdayIndex];
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
  // OBD2がつながっている間だけ、機器の名前を角に出す。
  const obdConnected =
    obdStatus === "live" ||
    obdStatus === "connected" ||
    obdStatus === "initializing";
  // メーターはどの色も四隅の操作だけで完結するので、操作用の
  // 上のバーは出さず、状態だけの細いバーにする。
  const hideTopbar = !showFuel;
  const activeTheme = meterThemeInfo(settings.meterTheme);
  const activeDesign = meterDesignInfo(settings.meterDesign);
  // テーマ。近未来のときだけ、上の色と形を使う。
  const activeStyle = meterStyleInfo(settings.meterStyle);
  const isFuture = activeStyle.id === "future";

  // 上のバーに出す4つの状態。
  // 見た目は前のオレンジ計器と同じ「日本語 + 英語」の二段組み。
  // 上段が何の状態か(回線 NET など)、下段がいまの状態(接続 LINK ACTIVE など)。
  // tone は色(ok=通っている / warn=途中 / off=つながっていない)。
  const meterStatusItems: {
    key: string;
    nameJa: string;
    nameEn: string;
    stateJa: string;
    stateEn: string;
    tone: "ok" | "warn" | "off";
    /** 押せる項目だけ。押したときに何をするかの説明(読み上げ用)。 */
    pressLabel?: string;
  }[] = [
    {
      key: "net",
      nameJa: "回線",
      nameEn: "NET",
      stateJa: isOnline ? "接続" : "圏外",
      stateEn: isOnline ? "ONLINE" : "OFFLINE",
      tone: isOnline ? "ok" : "off",
    },
    {
      key: "obd",
      nameJa: "車両",
      nameEn: "OBD2",
      stateJa:
        obdStatus === "live"
          ? "受信中"
          : obdStatus === "connected" || obdStatus === "initializing"
            ? "起動中"
            : obdStatus === "connecting" || obdStatus === "requesting"
              ? "接続中"
              : obdStatus === "unsupported"
                ? "非対応"
                : obdStatus === "error" || obdStatus === "disconnected"
                  ? "信号消失"
                  : obdAutoState === "unsupported"
                    ? "手動"
                    : obdAutoState === "no-device"
                      ? "未登録"
                      : obdAutoState === "retrying"
                        ? "再試行"
                        : "待機",
      stateEn:
        obdStatus === "live"
          ? "LIVE DATA"
          : obdStatus === "connected" || obdStatus === "initializing"
            ? "INIT"
            : obdStatus === "connecting" || obdStatus === "requesting"
              ? "LINKING"
              : obdStatus === "unsupported"
                ? "NOT AVAIL"
                : obdStatus === "error" || obdStatus === "disconnected"
                  ? "NO SIGNAL"
                  : obdAutoState === "unsupported"
                    ? "MANUAL ONLY"
                    : obdAutoState === "no-device"
                      ? "NOT PAIRED"
                      : obdAutoState === "retrying"
                        ? "AUTO RETRY"
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
      // 前はメーターの右上にあった「OBD2 につなぐ」。
      pressLabel: "OBD2 につなぐ",
    },
    {
      key: "gps",
      nameJa: "測位",
      nameEn: "GPS",
      stateJa:
        locationStatus === "ready"
          ? "測位"
          : locationStatus === "locating"
            ? "捕捉中"
            : "未測位",
      stateEn:
        locationStatus === "ready"
          ? "GPS LOCK"
          : locationStatus === "locating"
            ? "SEARCHING"
            : "NO FIX",
      tone:
        locationStatus === "ready"
          ? "ok"
          : locationStatus === "locating"
            ? "warn"
            : "off",
    },
    {
      // 前はメーターの右下にあった「メーターの色を選ぶ」。近未来のほかのテーマでは、テーマの名前。
      key: "theme",
      nameJa: isFuture ? "配色" : "テーマ",
      nameEn: isFuture ? "COLOR" : "THEME",
      stateJa: isFuture ? activeTheme.shortJa : activeStyle.shortJa,
      stateEn: isFuture ? activeTheme.shortEn : activeStyle.shortEn,
      tone: "ok",
      pressLabel: "メーターのテーマと色を選ぶ",
    },
    {
      // Zポータルの次のシフト(今日のシフトは終わるまで今日)。押すと1週間のシフト。
      key: "shift",
      nameJa: "シフト",
      nameEn: "SHIFT",
      stateJa: shiftFeed
        ? upcomingShift
          ? shiftDayLabel(upcomingShift.date, today)
          : "予定なし"
        : shiftStatus === "loading"
          ? "確認中"
          : "取得できません",
      stateEn: shiftFeed
        ? upcomingShift
          ? upcomingShift.startTime
            ? shiftTimeText(upcomingShift, "-")
            : "WORK"
          : "NO SHIFT"
        : shiftStatus === "loading"
          ? "LOADING"
          : "NO DATA",
      tone: shiftFeed ? "ok" : shiftStatus === "loading" ? "warn" : "off",
      pressLabel: "1週間のシフトを見る",
    },
  ];

  /** 上のステータスバーの項目を押したとき。OBD2 はつなぐ、色は選ぶ画面を開く。 */
  const pressStatusItem = (key: string) => {
    if (key === "obd") void connectObd();
    if (key === "theme") themeDialog.current?.showModal();
    if (key === "shift") shiftDialog.current?.showModal();
  };

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
      setFuelTrip({ km: 0, since: Date.now() });
      setFuelResetting(false);
      fuelResetTimerRef.current = null;
      navigator.vibrate?.(60);
    }, 900);
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
    pairingDialog.current?.close();
  };

  /** 表示してからの残り秒を数え、0になったら自動で閉じる。 */
  const armPairingTimer = () => {
    stopPairingTimer();
    setPairingLeft(PAIRING_AUTO_CLOSE_S);
    pairingTimerRef.current = window.setInterval(() => {
      setPairingLeft((left) => {
        if (left <= 1) {
          stopPairingTimer();
          pairingDialog.current?.close();
          return 0;
        }
        return left - 1;
      });
    }, 1000);
  };

  /**
   * スマホとつなぐQRを出す。合言葉がまだ無ければここで作る。
   * 合言葉は「#」より後ろに置くのでサーバーには送信されない。
   * QRの生成は使うときだけ読み込む(車載機の起動を重くしないため)。
   */
  const startPairing = async () => {
    setPairingError(false);
    let key = settings.syncKey.trim();
    if (key.length < MIN_SYNC_KEY_LENGTH) {
      key = generateSyncKey();
      const newKey = key;
      setSettings((current) => ({ ...current, syncKey: newKey, syncedAt: 0 }));
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

  const openPairing = () => {
    setPairingQr(null);
    setPairingError(false);
    pairingDialog.current?.showModal();
    void startPairing();
  };

  // 燃費画面と目的地ダイアログに出す、スマホとの同期の状態。
  const phoneSyncState = phoneSync.state;
  const phoneSyncLabel =
    phoneSyncState === "off"
      ? "LINK PHONE"
      : phoneSyncState === "error"
        ? "SYNC ERROR"
        : phoneSync.at
          ? `PHONE SYNC ${new Date(phoneSync.at).toLocaleTimeString("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}`
          : "SYNCING";
  // 目的地の画面の PHONE LINK ボタンの下段に出す、同期の状態。
  const phoneLinkStatus =
    phoneSyncState === "off" ? "NOT LINKED" : phoneSyncLabel.replace(/^PHONE /, "");

  // 「場所を直す」で開いている行き先。null は新しい目的地を足すとき。
  const destEditChoice =
    destEditKey === NEW_PLACE_KEY
      ? null
      : allNavChoices.find((choice) => choice.key === destEditKey) ?? null;

  const openDestEditor = (choice: NavChoice | null) => {
    setDestEditKey(choice ? choice.key : NEW_PLACE_KEY);
    setDestDraft({
      label: choice && !choice.fixed ? choice.label : "",
      destination: choice ? choice.destination : "",
    });
  };

  /** 直した(足した)場所を保存する。clear のときは、その場所を消す。 */
  const saveDestDraft = (clear = false) => {
    const key = destEditKey;
    if (!key) return;
    setSettings((current) =>
      saveNavChoice(
        current,
        key === NEW_PLACE_KEY ? null : key,
        clear ? { label: "", destination: "" } : destDraft,
      ),
    );
    setDestEditKey(null);
  };

  const openDestDialog = () => {
    destDialog.current?.showModal();
    // ★の場所が一覧の下のほうにあっても、開いたときに見えるようにする。
    destDialog.current
      ?.querySelector(".dest-choices.is-pick .is-active")
      ?.scrollIntoView({ block: "nearest" });
  };

  const closeDestDialog = () => {
    destDialog.current?.close();
    setDestMode("pick");
    setDestEditKey(null);
  };

  const beginNavigation = async (
    destination: string,
    destinationLabel: RouteEta["destination"],
  ) => {
    const apiKey = settings.googleRoutesApiKey.trim() || DEFAULT_GMAPS_KEY;
    const destinationPoint = readCoords(destination);
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
              // 「現在地を登録」した地点などの緯度・経度は、住所としてではなく場所として渡す。
              destination: destinationPoint
                ? {
                    location: {
                      latLng: { latitude: destinationPoint.lat, longitude: destinationPoint.lng },
                    },
                  }
                : { address: destination },
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
  // 最後の給油から走った距離。数え始めより新しい給油が届いていれば(スマホで記録した給油など)、
  // まだ走っていないので0。走り出すと、その給油から数え直す。
  const fuelTripKm = latestRefuelAt > fuelTrip.since ? 0 : fuelTrip.km;
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

  // 80年代のデジタル・デイライトのテーマに渡す値(近未来のメーターと同じ値)。
  const clusterData: ClusterData = {
    speed: greenCenterSpeed,
    rpm: obdData.rpm ?? null,
    coolant: obdData.coolant ?? null,
    voltage: obdData.voltage ?? null,
    clock,
    year: todayYear,
    month: todayMonth,
    day: todayDay,
    weekday: todayWeekdayIndex,
    world: [
      { name: "CALIFORNIA", time: californiaClock },
      { name: "RUSSIA", time: russiaClock },
      { name: "CHINA", time: chinaClock },
    ],
    weather,
    sunrise: solarSunrise,
    sunset: solarSunset,
    todayKm: dailyTripKm,
    avgCruise: averageCruiseKmh,
    avgFuel: estimatedAverageFuelEconomy,
    rangeKm: fuelRangeKm,
    fuelPercent,
    lowFuel: estimatedRemainingLiters !== null && estimatedRemainingLiters <= FUEL_RESERVE_L,
    // 360度に丸めない向き(北をまたいでも、車の印が逆向きに一回りしないように)。
    heading: location?.heading ?? null,
    destLabel: navTarget ? navTarget.label : null,
    workDays,
  };
  const startNavigation = navTarget
    ? () => void beginNavigation(navTarget.destination, "DESTINATION")
    : null;

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
    setFuelTrip({ km: 0, since: now });
    navigator.vibrate?.(60);
    setFuelDraft({
      date: japanDateKey(),
      liters: "",
      distanceKm: "",
      amountYen: "",
    });
  };

  if (!hasStarted) {
    return (
      <div className="screen-shell">
        <main className="launch-screen">
          <button
            type="button"
            className="launch-button"
            onClick={launchZCar}
            aria-label="Z CARを起動"
          >
            <img
              className="launch-landscape"
              src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/z-car-launch-landscape.webp`}
              alt=""
            />
            <span className="launch-vignette" aria-hidden="true" />
            <span className="launch-hint" aria-hidden="true">TOUCH TO START</span>
            {BUILD_STAMP ? (
              <span className="build-stamp" aria-hidden="true">
                {BUILD_STAMP}
              </span>
            ) : null}
          </button>
        </main>
      </div>
    );
  }

  // 円の外側に余る下の二隅に、よく見る数字を置く(どの形のメーターでも同じ)。
  // 左下 平均巡行速度 / 右下 平均燃費(押すと燃費の記録を開く)。
  const gaugeCorners = (
    <div className="gauge-corners" aria-label="メーターの下の隅">
      <div className="gauge-corner gauge-corner-bl is-readout">
        <small>AVG CRUISE · TODAY</small>
        <span className="gauge-corner-value">
          <b>{averageCruiseKmh === null ? "—" : Math.round(averageCruiseKmh)}</b>
          <em>km/h</em>
        </span>
      </div>
      <button
        type="button"
        className="gauge-corner gauge-corner-br"
        onClick={toggleFuelView}
        aria-label="燃費の記録・確認を開く"
      >
        <small>AVG FUEL</small>
        <span className="gauge-corner-value">
          <b>
            {estimatedAverageFuelEconomy === null
              ? "—"
              : estimatedAverageFuelEconomy.toFixed(1)}
          </b>
          <em>km/L</em>
        </span>
      </button>
    </div>
  );
  // ORBIT NAVI の輪と文字に渡す値(北の印は地図と同じ角度で回す)。
  const gaugeValues: GaugeValues = {
    speed: greenCenterSpeed,
    rpm: obdData.rpm ?? null,
    heading: greenHeading === null ? null : greenMeterHeading,
  };
  // メーターの真ん中を押すと、次の形に変える(最後の次は最初の地図つきに戻る)。
  const designIndex = METER_DESIGNS.findIndex((design) => design.id === activeDesign.id);
  const cycleDesign = () => {
    const next = METER_DESIGNS[(designIndex + 1) % METER_DESIGNS.length];
    setSettings((current) => ({ ...current, meterDesign: next.id }));
    setDesignFlash((count) => count + 1);
  };
  const gaugeSwitch = (
    <>
      <button
        type="button"
        className="gauge-switch"
        onClick={cycleDesign}
        aria-label={`メーターの形を変える(今は ${activeDesign.name})`}
      />
      {designFlash > 0 ? (
        <span key={designFlash} className="gauge-design-flash" aria-live="polite">
          <small>DESIGN {designIndex + 1}/{METER_DESIGNS.length}</small>
          <b>{activeDesign.name}</b>
        </span>
      ) : null}
    </>
  );

  return (
    <div className="screen-shell">
      <div
        id="app"
        className={`${showFuel ? "" : "is-fullscreen "}${isFullscreen ? "browser-fullscreen " : ""}${
          // 80年代・デイライトのテーマでは、近未来の色の決まり(filter など)をかけない。
          // 燃費画面は今まで通り、近未来の色で出す。
          isFuture || showFuel
            ? `meter-theme-${activeTheme.id}${activeTheme.tinted ? ` meter-tinted zt-${activeTheme.id}` : ""}`
            : `meter-style-${activeStyle.id}`
        }`}
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
          <header
            className={`meter-status${canFullscreen && !isFullscreen ? " has-full" : ""}`}
            aria-label="接続の状態"
          >
            {/* ナビから戻ると全画面が解除されるので、押して戻せるようにする。
                すでに全画面なら出さない。 */}
            {canFullscreen && !isFullscreen ? (
              <button
                type="button"
                className="meter-full-button"
                onClick={goFullscreen}
                aria-label="画面を最大化する"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M9 4H4v5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
                </svg>
                <span>FULL</span>
              </button>
            ) : null}
            {/* 帯の空いているところに、OBD2のいまの中身をそのまま出す。
                つながらないときの手がかりにする。 */}
            <span className="meter-status-detail" aria-hidden="true">
              {obdConnected ? `${obdDeviceName} · ` : ""}
              {obdConnectionLabel}
              {obdErrorMessage ? ` · ${obdErrorMessage}` : ""}
            </span>
            {/* OBD2・メーターの色・シフトは押せる(OBD2 はつなぐ、色は選ぶ画面、シフトは1週間の画面を開く)。 */}
            {meterStatusItems.map((item) => {
              const content = (
                <>
                  <i aria-hidden="true" />
                  <span className="meter-status-text">
                    <small>
                      {item.nameJa}
                      <span>{item.nameEn}</span>
                    </small>
                    <b>
                      {item.stateJa}
                      <span>{item.stateEn}</span>
                    </b>
                  </span>
                </>
              );
              return item.pressLabel ? (
                <button
                  key={item.key}
                  type="button"
                  className={`meter-status-item is-button is-${item.tone}`}
                  onClick={() => pressStatusItem(item.key)}
                  aria-label={item.pressLabel}
                >
                  {content}
                </button>
              ) : (
                <span key={item.key} className={`meter-status-item is-${item.tone}`}>
                  {content}
                </span>
              );
            })}
            {/* アプリとして入れるとブラウザの更新ボタンが無いので、帯の右端に置く。
                押すと読み込み直す(新しい版が公開されていれば入れ替わる)。下段は今の版の時刻。 */}
            <span className="meter-status-end">
              <button
                type="button"
                className="meter-reload"
                onClick={() => window.location.reload()}
                aria-label="読み込み直す(新しい版があれば入れ替わる)"
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
                  <path d="M19.5 3.6v4.6h-4.6" />
                </svg>
                <span className="meter-status-text">
                  <small>
                    更新<span>RELOAD</span>
                  </small>
                  {BUILD_STAMP ? <b>{BUILD_STAMP}</b> : null}
                </span>
              </button>
            </span>
          </header>
        )}

        {!showFuel && activeStyle.id === "retro" ? (
          <main className="fullscreen-obd" aria-label="CARISTA OBD2 vehicle monitor">
            <RetroCluster
              data={clusterData}
              mapRef={greenMapElementRef}
              mapReady={greenMapReady}
              onFuel={toggleFuelView}
              onDest={openDestDialog}
              onStart={startNavigation}
            />
          </main>
        ) : null}
        {!showFuel && activeStyle.id === "day" ? (
          <main className="fullscreen-obd" aria-label="CARISTA OBD2 vehicle monitor">
            <DayCluster
              data={clusterData}
              onFuel={toggleFuelView}
              onDest={openDestDialog}
              onStart={startNavigation}
            />
          </main>
        ) : null}

        {!showFuel && isFuture && (
          <main className="fullscreen-obd future-obd" aria-label="CARISTA OBD2 vehicle monitor">
              <section className="performance-cluster green-nav-cluster" style={greenCockpitStyle}>
              <aside className="performance-side performance-left green-instrument-rail">
                <article className={`performance-date solar-clock-card ${weather?.isDay ? "day" : "night"}`}>
                  {/* 日の出・日の入りの弧はカードのいちばん上。日付と時計は下にまとめる。 */}
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
                  {/* 今日の日付。曜日は光る札にして、下に一週間の帯(月曜はじまり・今日だけ点く)を添える。 */}
                  <div
                    className="solar-clock-today"
                    aria-label={`今日 ${todayMonthDay}（${todayWeekday}）`}
                  >
                    <span className="solar-clock-day">
                      <i aria-hidden="true">{todayWeekday}</i>
                      <strong>{todayMonthDay}</strong>
                    </span>
                    <small aria-hidden="true">{todayYear}</small>
                  </div>
                  <ol ref={weekStripRef} className="solar-clock-week" aria-hidden="true">
                    {WEEK_STRIP_ORDER.map((dayIndex) => (
                      <li
                        key={dayIndex}
                        data-day={dayIndex}
                        className={
                          [dayIndex === todayWeekdayIndex ? "is-today" : "", workDays.includes(dayIndex) ? "is-work" : ""].filter(Boolean).join(" ") ||
                          undefined
                        }
                      >
                        {WEEKDAYS_JA[dayIndex]}
                      </li>
                    ))}
                  </ol>
                  <div className="solar-clock-heading">
                    <small>LOCAL TIME · JST</small>
                    <time>{clock}</time>
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

              {activeDesign.id === "navi" ? (
                <article className="performance-main-gauge green-map-gauge" aria-label="Map integrated tachometer and speedometer">
                  {gaugeCorners}
                  {gaugeSwitch}
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
              ) : (
                // 大きな丸い地図(NAVI と同じ作り方)の上に、回転計の輪を重ねる。
                <article className="meter-design-gauge is-orbit" aria-label={activeDesign.name}>
                  {gaugeCorners}
                  {gaugeSwitch}
                  <div className="orbit-map-window">
                    <div ref={greenMapElementRef} className="green-nav-map-canvas" aria-hidden="true" />
                    <div
                      className={`green-map-standby${greenMapReady ? " is-ready" : ""}`}
                      aria-hidden="true"
                    >
                      <i className="green-map-standby-sweep" />
                      <b>ACQUIRING MAP</b>
                    </div>
                    <div className="orbit-map-shade" aria-hidden="true" />
                  </div>
                  <MeterDesignGauge design="orbit" values={gaugeValues} liveMap />
                </article>
              )}

              <aside className="performance-side performance-right green-drive-panel green-instrument-rail">
                {/* 走行可能距離も、右下の平均燃費と同じく押すと燃費の記録を開く。 */}
                <article
                  className="green-range-card is-pressable"
                  role="button"
                  tabIndex={0}
                  onClick={toggleFuelView}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      toggleFuelView();
                    }
                  }}
                  aria-label={`走行可能距離 ${Math.round(fuelRangeKm)} km。押すと燃費の記録を開く`}
                >
                  <small>SAFE EST. RANGE</small>
                  <span><strong>{Math.round(fuelRangeKm)}</strong><em>km</em></span>
                  <div className="green-range-scale" aria-hidden="true">
                    <b>F</b><div><i style={{ width: `${fuelPercent}%` }} /></div><b>E</b>
                  </div>
                  <small>AUTO RESET · REFUEL LOG</small>
                </article>
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
                {/* 目的地を選ぶ・直す。★の場所が下の START の行き先になる。 */}
                <div className="green-rail-actions">
                  <button type="button" className="green-rail-action" onClick={openDestDialog}>
                    <small>CHANGE</small>
                    <b>DEST</b>
                  </button>
                </div>
                {/* 右下はGoogleマップの起動ボタン。行き先は★の場所(DEST で選ぶ)。 */}
                <button
                  type="button"
                  className="green-navi-card green-card-button"
                  onClick={() =>
                    navTarget &&
                    void beginNavigation(navTarget.destination, "DESTINATION")
                  }
                  disabled={!navTarget}
                  aria-label={
                    navTarget
                      ? `${navTarget.label} へのナビをGoogleマップで開始する`
                      : "目的地が設定されていません"
                  }
                >
                  <span className="green-navi-mark" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="M12 21.5s6.6-6.1 6.6-10.7a6.6 6.6 0 1 0-13.2 0c0 4.6 6.6 10.7 6.6 10.7z" />
                      <circle cx="12" cy="10.6" r="2.4" />
                    </svg>
                  </span>
                  <span className="green-navi-text">
                    <small>START</small>
                    <strong>{navTarget ? navTarget.label : "NO DEST"}</strong>
                  </span>
                  <span className="green-navi-go" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d="m9 5 7 7-7 7" />
                    </svg>
                  </span>
                </button>
              </aside>
              </section>
              {/* 出勤日の曜日の札(五行の色)。色を変える filter の外から帯の上に重ねる */}
              <WorkdayMarks stripRef={weekStripRef} days={workDays} today={todayWeekdayIndex} labels={WEEKDAYS_JA} />
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
                  <div className="fuel-sync">
                    {/* スマホとの同期の状態。押すとスマホとつなぐQRが出る。 */}
                    <button
                      type="button"
                      className={`fuel-sync-button is-${phoneSyncState}`}
                      onClick={openPairing}
                      aria-label="スマホとつなぐQRを出す"
                    >
                      <i aria-hidden="true" />
                      {phoneSyncLabel}
                    </button>
                    <b>{fuelEntries.length} TOTAL</b>
                  </div>
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
          {/* テーマ(画面全体の雰囲気)。近未来では、下の8色と、メーターの真ん中を押して変える形を使う。 */}
          <div className="meter-style-options">
            {METER_STYLES.map((style) => {
              const selected = activeStyle.id === style.id;
              return (
                <button
                  key={style.id}
                  type="button"
                  className={`is-${style.id}${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setSettings((current) => ({ ...current, meterStyle: style.id }));
                    themeDialog.current?.close();
                  }}
                >
                  <i aria-hidden="true">
                    <MeterStyleThumb style={style.id} />
                  </i>
                  <span><b>{style.name}</b><small>{style.captionEn}</small></span>
                  <em>{selected ? "ACTIVE" : "SELECT"}</em>
                </button>
              );
            })}
          </div>
          <p className="meter-theme-subhead">FUTURE COLOR<small>近未来のテーマの色</small></p>
          {/* 8色。どれも同じ盤面で、ターコイズとオレンジは専用の CSS、
              ほかは globals.css の .zt-<名前> の色を共通の決まりで使う。
              形はここでは選ばず、メーターの真ん中を押して変える。色を選ぶと近未来のテーマになる。 */}
          <div className="meter-theme-options">
            {METER_THEMES.map((theme) => {
              const selected = isFuture && activeTheme.id === theme.id;
              const tint = theme.tinted ? ` is-tinted zt-${theme.id}` : "";
              return (
                <button
                  key={theme.id}
                  type="button"
                  className={`${theme.id}${tint}${selected ? " selected" : ""}`}
                  aria-pressed={selected}
                  onClick={() => {
                    setSettings((current) => ({ ...current, meterTheme: theme.id, meterStyle: "future" }));
                    themeDialog.current?.close();
                  }}
                >
                  <i className={`theme-preview ${theme.id}${tint}`} aria-hidden="true">
                    <span>{theme.name}</span>
                  </i>
                  <span><b>{theme.name}</b><small>{theme.captionEn}</small></span>
                  <em>{selected ? "ACTIVE" : "SELECT"}</em>
                </button>
              );
            })}
          </div>
        </div>
      </dialog>

      {/* Zポータルの1週間のシフト(上の帯の「シフト」を押すと開く)。 */}
      <dialog ref={shiftDialog} className="theme-dialog-shell">
        <div className="dialog-card meter-theme-dialog shift-dialog">
          <header>
            <span>
              <small>Z PORTAL{shiftFeed?.displayName ? ` · ${shiftFeed.displayName}` : ""}</small>
              <h2>SHIFT</h2>
            </span>
            <button type="button" onClick={() => shiftDialog.current?.close()} aria-label="シフトを閉じる">
              CLOSE
            </button>
          </header>
          {shiftFeed ? (
            <ol className="shift-week">
              {shiftWeek(shiftFeed, today).map((day) => (
                <li key={day.date} className={`${day.shifts.length ? "is-work" : ""}${day.date === today ? " is-today" : ""}`}>
                  <span className="shift-day">
                    <b>{shortDate(day.date)}</b>
                    <small>{day.date === today ? "今日" : weekdayJa(day.date)}</small>
                  </span>
                  {day.shifts.length ? (
                    <span className="shift-list">
                      {day.shifts.map((shift) => (
                        <span key={shift.id} className="shift-item">
                          <b>{shiftTimeText(shift)}</b>
                          <small>{[shift.storeName, shift.workType].filter(Boolean).join(" · ")}</small>
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="shift-off">休み</span>
                  )}
                </li>
              ))}
            </ol>
          ) : (
            <p className="shift-empty">
              {shiftStatus === "loading" ? "シフトを確認しています" : "シフトを取得できません。ネットにつながると読み直します。"}
            </p>
          )}
          {laterShift ? (
            <p className="shift-later">
              次のシフト {shiftDayLabel(laterShift.date, today)} {shiftTimeText(laterShift)}
            </p>
          ) : null}
          {shiftFeed ? (
            <p className="shift-updated">
              {[
                shiftFeed.updatedAt ? `Zポータルの更新 ${formatShiftUpdated(shiftFeed.updatedAt)}` : "",
                shiftFeed.received ? `届いたシフト ${shiftFeed.received}件` : "Zポータルに確定シフトがありません",
                shiftFeed.unreadable ? `読めない形 ${shiftFeed.unreadable}件` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ) : null}
        </div>
      </dialog>

      <dialog ref={destDialog}>
        <div className="dialog-card dest-card">
          <h2>目的地</h2>
          <div className="dest-tabs">
            <button
              type="button"
              className={destMode === "pick" ? "is-active" : undefined}
              onClick={() => {
                setDestMode("pick");
                setDestEditKey(null);
              }}
            >
              選ぶ
            </button>
            <button
              type="button"
              className={destMode === "edit" ? "is-active" : undefined}
              onClick={() => setDestMode("edit")}
            >
              場所を直す
            </button>
          </div>

          {destMode === "pick" ? (
            navChoices.length ? (
              <div className="dest-choices is-pick">
                {/* ★が START の行き先。押した場所に★が移る(スマホにも届く)。 */}
                {navChoices.map((choice) => {
                  const starred = choice.key === navTarget?.key;
                  return (
                    <button
                      key={choice.key}
                      type="button"
                      className={starred ? "is-active" : undefined}
                      aria-pressed={starred}
                      onClick={() => {
                        setSettings((current) => ({ ...current, startTarget: choice.key }));
                        closeDestDialog();
                      }}
                    >
                      <StarMark filled={starred} />
                      <b>{choice.label}</b>
                      <small>{choice.destination}</small>
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="settings-hint">
                目的地がまだありません。「場所を直す」から登録してください。
              </p>
            )
          ) : destEditKey === NEW_PLACE_KEY || destEditChoice ? (
            <form
              className="dest-editor"
              onSubmit={(event) => {
                event.preventDefault();
                saveDestDraft();
              }}
            >
              <p className="settings-hint">
                {destEditChoice
                  ? `${destEditChoice.note || destEditChoice.label} の場所を直します`
                  : "新しい目的地を足します"}
              </p>
              {!destEditChoice?.fixed ? (
                <label>
                  名前({MAX_DESTINATION_LABEL}文字まで)
                  <input
                    type="text"
                    value={destDraft.label}
                    maxLength={MAX_DESTINATION_LABEL}
                    placeholder="例: 鳥"
                    onChange={(event) =>
                      setDestDraft((current) => ({
                        ...current,
                        label: event.target.value,
                      }))
                    }
                  />
                </label>
              ) : null}
              <label>
                住所、または場所の名前
                <input
                  type="text"
                  value={destDraft.destination}
                  maxLength={MAX_DESTINATION_TEXT}
                  placeholder="例: 大阪府枚方市出口3丁目1-1"
                  onChange={(event) =>
                    setDestDraft((current) => ({
                      ...current,
                      destination: event.target.value,
                    }))
                  }
                />
              </label>
              <div className="two-actions">
                <button type="button" onClick={() => setDestEditKey(null)}>
                  やめる
                </button>
                <button type="submit" disabled={!destDraft.destination.trim()}>
                  保存する
                </button>
              </div>
              {destEditChoice?.destination ? (
                <button
                  type="button"
                  className="dest-clear"
                  onClick={() => saveDestDraft(true)}
                >
                  {destEditChoice.fixed ? "この住所を消す" : "この目的地を消す"}
                </button>
              ) : null}
            </form>
          ) : (
            <div className="dest-choices">
              {allNavChoices.map((choice) => (
                <button
                  key={choice.key}
                  type="button"
                  onClick={() => openDestEditor(choice)}
                >
                  <b>
                    {choice.label}
                    {choice.note ? <i>{choice.note}</i> : null}
                  </b>
                  <small>{choice.destination || "未登録"}</small>
                </button>
              ))}
              {settings.places.length < MAX_PLACES ? (
                <button type="button" className="dest-add" onClick={() => openDestEditor(null)}>
                  <b>+ ADD PLACE</b>
                  <small>目的地を追加</small>
                </button>
              ) : null}
            </div>
          )}

          <div className="two-actions dest-actions">
            {/* 目的地はスマホからも直せる。同期の状態と、つなぐためのQR。 */}
            <button
              type="button"
              className={`fuel-sync-button dest-pair-button is-${phoneSyncState}`}
              onClick={() => {
                closeDestDialog();
                openPairing();
              }}
              aria-label="スマホとつなぐQRを出す"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
                <path className="is-fill" d="M14 14h2.5v2.5H14zM17.5 17.5H20V20h-2.5zM14 17.5h2.5V20H14zM17.5 14H20v2.5h-2.5z" />
              </svg>
              <span>
                <b>PHONE LINK</b>
                <small>
                  <i aria-hidden="true" />
                  {phoneLinkStatus}
                </small>
              </span>
            </button>
            <button onClick={closeDestDialog}>閉じる</button>
          </div>
        </div>
      </dialog>

      <dialog ref={pairingDialog} onClose={stopPairingTimer}>
        <div className="dialog-card sync-card">
          <h2>スマホとつなぐ</h2>
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
                  : "読み取ると、給油記録・目的地・メーターの色を、スマホからも変えられるようになります。"}
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
