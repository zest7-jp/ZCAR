"use client";

import { Fragment, useEffect, useRef, useState, type CSSProperties } from "react";
import { useObd2, type ObdConnectionStatus } from "./hooks/use-obd2";
import {
  CAR_DEVICE_KEY,
  defaults,
  MAX_DESTINATION_LABEL,
  MAX_DESTINATION_TEXT,
  PHONE_LONG_EDGE_MAX,
  mergeFuelEntries,
  readSettings,
  SETTINGS_STORAGE_KEY,
  writeSettings,
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
  // マップ画面の 1〜5 のナビ目的地。設定ページから編集できる。
  const mapDestinations = settings.mapDestinations;
  // 案内開始で使う行き先。「目的地設定」から選ぶ。
  const [navTargetKey, setNavTargetKey] = useState("work");
  // 出発(店舗)・帰宅は設定した住所を使い、未入力なら1番・2番で代用する。
  const workDestination =
    settings.storeDest.trim() ||
    settings.storeName.trim() ||
    mapDestinations[0]?.destination ||
    "";
  const homeDestination =
    settings.homeDest.trim() || mapDestinations[1]?.destination || "";
  // 「目的地設定」で選べる候補。出発・帰宅と、登録済みの 1〜5。
  const navChoices = [
    { key: "work", label: "DEPART", note: "店舗へ", destination: workDestination },
    { key: "home", label: "RETURN", note: "自宅へ", destination: homeDestination },
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
  // このブラウザで全画面にできるか(できない端末ではボタンを出さない)。
  const [canFullscreen, setCanFullscreen] = useState(false);
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
  // 目的地ダイアログ: 「選ぶ」か「編集」か。編集中はどの場所かも覚える。
  const [destMode, setDestMode] = useState<"pick" | "edit">("pick");
  const [destEditKey, setDestEditKey] = useState<string | null>(null);
  const [destDraft, setDestDraft] = useState({ label: "", destination: "" });
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

  // 燃費画面へ移ると地図の器が外れるので、次に戻ったとき作り直す。
  useEffect(() => {
    if (!showFuel) return;
    greenGmapRef.current = null;
    setGreenMapReady(false);
  }, [showFuel]);

  useEffect(() => {
    if (showFuel || !mapsApiKey || !greenMapElementRef.current) return;
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
  }, [showFuel, location, mapsApiKey]);


  const hour = new Date().getHours();
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
  // メーターはどちらのテーマも四隅の操作だけで完結するので、操作用の
  // 上のバーは出さず、状態だけの細いバーにする。
  const hideTopbar = !showFuel;

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

  // 車の画面から直せる場所。出発・帰宅と、登録枠の1〜5。
  const destSlots = [
    {
      key: "work",
      label: "DEPART",
      note: "出発(店舗)",
      // 「選ぶ」側と同じ中身を出す(未入力なら1番・2番で代用している)。
      destination: workDestination,
      canRename: false,
    },
    {
      key: "home",
      label: "RETURN",
      note: "帰宅",
      destination: homeDestination,
      canRename: false,
    },
    ...mapDestinations.map((entry, index) => ({
      key: `dest-${index}`,
      label: entry.label.trim() || `${index + 1}番`,
      note: `${index + 1}番`,
      destination: entry.destination.trim(),
      canRename: true,
    })),
  ];

  const destEditSlot = destSlots.find((slot) => slot.key === destEditKey) ?? null;

  const openDestEditor = (slot: (typeof destSlots)[number]) => {
    setDestEditKey(slot.key);
    setDestDraft({
      label: slot.canRename ? slot.label : "",
      destination: slot.destination,
    });
  };

  /** 編集した場所を保存する。住所を空にすると、その枠は未登録に戻る。 */
  const saveDestDraft = (clear = false) => {
    const key = destEditKey;
    if (!key) return;
    const destination = clear
      ? ""
      : destDraft.destination.trim().slice(0, MAX_DESTINATION_TEXT);
    const label = clear
      ? ""
      : destDraft.label.trim().slice(0, MAX_DESTINATION_LABEL);

    setSettings((current) => {
      if (key === "work") return { ...current, storeDest: destination };
      if (key === "home") return { ...current, homeDest: destination };
      const index = Number.parseInt(key.slice("dest-".length), 10);
      if (!Number.isInteger(index)) return current;
      return {
        ...current,
        mapDestinations: current.mapDestinations.map((entry, position) =>
          position === index ? { label, destination } : entry,
        ),
      };
    });
    setDestEditKey(null);
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
              src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/z-car-launch-landscape.png`}
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
            {meterStatusItems.map((item) => (
              <span key={item.key} className={`meter-status-item is-${item.tone}`}>
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
                    <small>START GUIDE</small>
                    <b>{navTarget?.label ?? "NO DEST"}</b>
                  </button>
                  <button
                    type="button"
                    className={`gauge-corner gauge-corner-tr obd-${obdStatus}`}
                    onClick={() => void connectObd()}
                  >
                    <small>VEHICLE</small>
                    <b>OBD2</b>
                  </button>
                  <button
                    type="button"
                    className="gauge-corner gauge-corner-bl"
                    onClick={() => destDialog.current?.showModal()}
                  >
                    <small>CHANGE</small>
                    <b>DEST</b>
                  </button>
                  <button
                    type="button"
                    className="gauge-corner gauge-corner-br"
                    onClick={() => themeDialog.current?.showModal()}
                  >
                    <small>SWITCH</small>
                    <b>THEME</b>
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
                {/* 右下はGoogleマップの起動ボタン。行き先は「DEST」で選んだもの。 */}
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
                      ? `${navTarget.note}のナビをGoogleマップで開始する`
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
              <div className="dest-choices">
                {navChoices.map((choice) => (
                  <button
                    key={choice.key}
                    type="button"
                    className={choice.key === navTarget?.key ? "is-active" : undefined}
                    onClick={() => {
                      setNavTargetKey(choice.key);
                      closeDestDialog();
                    }}
                  >
                    <b>{choice.label}</b>
                    <small>{choice.destination}</small>
                  </button>
                ))}
              </div>
            ) : (
              <p className="settings-hint">
                目的地がまだありません。「場所を直す」から登録してください。
              </p>
            )
          ) : destEditSlot ? (
            <form
              className="dest-editor"
              onSubmit={(event) => {
                event.preventDefault();
                saveDestDraft();
              }}
            >
              <p className="settings-hint">{destEditSlot.note} の場所を直します</p>
              {destEditSlot.canRename ? (
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
              {destEditSlot.destination ? (
                <button
                  type="button"
                  className="dest-clear"
                  onClick={() => saveDestDraft(true)}
                >
                  この場所を消す
                </button>
              ) : null}
            </form>
          ) : (
            <div className="dest-choices">
              {destSlots.map((slot) => (
                <button
                  key={slot.key}
                  type="button"
                  onClick={() => openDestEditor(slot)}
                >
                  <b>
                    {slot.label}
                    <i>{slot.note}</i>
                  </b>
                  <small>{slot.destination || "未登録"}</small>
                </button>
              ))}
            </div>
          )}

          <div className="two-actions">
            <button onClick={closeDestDialog}>閉じる</button>
          </div>
        </div>
      </dialog>

    </div>
  );
}
