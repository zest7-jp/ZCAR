"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "../google-maps";
import { distanceMeters, fetchParking, type ParkedCar } from "../parking";
import type { PlaceDraft } from "../place-import";

/** 車両位置を読み直す間隔(画面に戻ってきたときは、すぐ読み直す)。 */
const PARK_POLL_MS = 30_000;
/**
 * 車から最後に知らせが届いてからこの時間までは、車の電源が入っているとみなす
 * (車は止まっていても、GPS が使えなくても、1分おきに知らせてくる)。過ぎたら「駐車中」。
 */
const LIVE_MS = 3 * 60_000;
/** 地図の寄り具合(駐車場の中で車を探せるくらい)。 */
const PARK_MAP_ZOOM = 17;
/** 印を次の位置まで動かす時間(iPhone の GPS はおよそ1秒ごと)。 */
const MOVE_MS = 900;
/** これより遠くへ飛んだときは、動かさずにすぐ移す(m)。 */
const JUMP_METERS = 2000;
/** iPhone の GPS がこれより長く届かなければ使わない(ミリ秒)。 */
const PHONE_FIX_STALE_MS = 15_000;
/**
 * iPhone が車の中にあるとみなす距離(m)。車から届いた位置からの距離で決める。
 * 車は走っている間1分おきに送るので、届いてからの秒数ぶん(時速約140kmまで)広げる。
 */
const IN_CAR_BASE_METERS = 300;
const IN_CAR_METERS_PER_SECOND = 40;
/**
 * iPhone の GPS の速さで、走っているか止まっているかを決める境目(km/h)。
 * 走り出しはこれ以上、止まりはこれ以下。その間(のろのろ)は前のままにして、表示がちらつかないようにする。
 */
const PHONE_MOVING_KMH = 8;
const PHONE_STOPPED_KMH = 3;
/**
 * 「現在地を登録」で住所を使うのは、住所の場所がこれ(m)より近いときだけ。
 * 遠ければ(山道・河原など)緯度・経度のまま入れて、ナビでその場所へ正確に戻れるようにする。
 */
const ADDRESS_NEAR_METERS = 100;
/** 住所を調べるのを待つ長さ。間に合わなければ緯度・経度で登録する。 */
const ADDRESS_TIMEOUT_MS = 4000;

/**
 * 状態ごとの名前と、八卦の印。lines は上の線から順に、1 が切れ目のない線(陽)、0 が真ん中の切れた線(陰)。
 * 走行中は乾(☰ 天のように動き続ける)、停車中は艮(☶ 止まる)、駐車中は坤(☷ 地に休む)。
 * 切れ目のない線が 3本 → 1本 → 0本 と減るので、八卦を知らなくても勢いの強さで読める。
 */
const STATUS = {
  parked: { ja: "駐車中", en: "PARKED", lines: [0, 0, 0] },
  stopped: { ja: "停車中", en: "STOPPED", lines: [1, 0, 0] },
  driving: { ja: "走行中", en: "DRIVING", lines: [1, 1, 1] },
} as const;

type ParkStatus = keyof typeof STATUS;

/** 八卦の線(上から順に)。切れた線は、真ん中にすき間をあけた2本で描く。 */
const trigramRects = (lines: readonly number[]) =>
  lines.flatMap((solid, index) => {
    const y = Math.round((0.5 + index * 4.7) * 10) / 10;
    return solid
      ? [{ x: 0.5, y, width: 17 }]
      : [
          { x: 0.5, y, width: 7.2 },
          { x: 10.3, y, width: 7.2 },
        ];
  });

/** 八卦の印(線3本)。文字(☰☶☷)は iPhone では細くかすれるので、図形で描く。 */
const TrigramMark = ({ lines }: { lines: readonly number[] }) => (
  <svg className="zr-park-trigram" viewBox="0 0 18 13" aria-hidden="true">
    {trigramRects(lines).map((bar, index) => (
      <rect key={index} x={bar.x} y={bar.y} width={bar.width} height="2.6" rx="0.7" />
    ))}
  </svg>
);

/** 地図の上の車の印に入れる、同じ八卦の印(地図の部品は HTML の文字で作るため)。 */
const trigramSvg = (lines: readonly number[]) =>
  '<svg class="zr-park-trigram" viewBox="0 0 18 13" aria-hidden="true">' +
  trigramRects(lines)
    .map((bar) => `<rect x="${bar.x}" y="${bar.y}" width="${bar.width}" height="2.6" rx="0.7"/>`)
    .join("") +
  "</svg>";

type Rgb = [number, number, number];

/** 2つの色を混ぜた #rrggbb(amount は to の割合)。 */
const mixHex = (from: Rgb, to: Rgb, amount: number) =>
  `#${from
    .map((value, index) =>
      Math.round(value + (to[index] - value) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;

/** いまの配色の色(CSS の --zr-accent-rgb)。読めなければターコイズ。 */
const readAccent = (element: HTMLElement): Rgb => {
  const parts = getComputedStyle(element)
    .getPropertyValue("--zr-accent-rgb")
    .split(",")
    .map((part) => Number.parseFloat(part));
  return parts.length === 3 && parts.every((part) => Number.isFinite(part))
    ? [parts[0], parts[1], parts[2]]
    : [92, 230, 198];
};

/**
 * 車両位置の地図の色。暗い下地に、道を配色の色でうっすら光らせる。
 * お店や駅のアイコン・お店の名前は消して、車の印を目立たせる(駅の名前だけ残す)。
 */
const parkMapLook = (accent: Rgb) => {
  const tint = (base: Rgb, amount: number) => mixHex(base, accent, amount);
  const ground = tint([8, 12, 11], 0.05);
  return {
    ground,
    styles: [
      { elementType: "geometry", stylers: [{ color: ground }] },
      { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
      { elementType: "labels.text.fill", stylers: [{ color: tint([120, 136, 132], 0.25) }] },
      { elementType: "labels.text.stroke", stylers: [{ color: ground }, { weight: 3 }] },
      { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
      { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: tint([16, 22, 21], 0.07) }] },
      { featureType: "poi", stylers: [{ visibility: "off" }] },
      { featureType: "poi.park", elementType: "geometry", stylers: [{ visibility: "on" }, { color: tint([10, 18, 15], 0.12) }] },
      { featureType: "road", elementType: "geometry.fill", stylers: [{ color: tint([26, 33, 31], 0.12) }] },
      { featureType: "road", elementType: "geometry.stroke", stylers: [{ color: ground }] },
      { featureType: "road.arterial", elementType: "geometry.fill", stylers: [{ color: tint([30, 40, 37], 0.24) }] },
      { featureType: "road.highway", elementType: "geometry.fill", stylers: [{ color: tint([34, 46, 42], 0.36) }] },
      { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: tint([150, 162, 158], 0.3) }] },
      { featureType: "transit", stylers: [{ visibility: "off" }] },
      { featureType: "transit.station.rail", elementType: "labels.text", stylers: [{ visibility: "on" }] },
      { featureType: "water", elementType: "geometry", stylers: [{ color: tint([4, 14, 22], 0.1) }] },
      { featureType: "water", elementType: "labels", stylers: [{ visibility: "off" }] },
    ],
  };
};

/** 航空写真のときは写真のままにして、アイコンとお店だけ消す。 */
const SATELLITE_STYLES = [
  { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
];

type LatLng = { lat: number; lng: number };
type GMap = {
  panTo: (point: LatLng) => void;
  setCenter: (point: LatLng) => void;
  setZoom: (zoom: number) => void;
  setMapTypeId: (id: string) => void;
  setOptions: (options: Record<string, unknown>) => void;
  addListener: (eventName: string, handler: () => void) => unknown;
};
type GCircle = {
  setCenter: (point: LatLng) => void;
  setRadius: (meters: number) => void;
};
type GOverlay = {
  setMap: (map: GMap | null) => void;
  getPanes: () => { overlayMouseTarget: HTMLElement } | null;
  getProjection: () => {
    fromLatLngToDivPixel: (point: unknown) => { x: number; y: number } | null;
  } | null;
};
type GeocodeResult = {
  formatted_address?: string;
  types?: string[];
  geometry?: { location?: { lat: () => number; lng: () => number } };
};
type MapsApi = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GMap;
  LatLng: new (lat: number, lng: number) => unknown;
  OverlayView: new () => GOverlay;
  Circle: new (options: Record<string, unknown>) => GCircle;
  /** 住所を調べる部品(Google の Geocoding API が使えるときだけ答えが返る)。 */
  Geocoder?: new () => {
    geocode: (request: Record<string, unknown>) => Promise<{ results?: GeocodeResult[] }>;
  };
  event: {
    addListenerOnce: (instance: unknown, eventName: string, handler: () => void) => void;
  };
};
type CarPin = GOverlay & {
  moveTo: (point: LatLng) => void;
  /** 進む向き(北が0、時計回りの度)。null なら向きの印を隠す。 */
  setHeading: (degrees: number | null) => void;
  /** 真ん中の八卦と色を、いまの状態(走行中・停車中・駐車中)にする。 */
  setStatus: (status: ParkStatus) => void;
};

/**
 * 地図の上の車の印(HTML)。地図を動かしても、車両位置に付いて動く。
 * 真ん中には、いまの状態の八卦(走行中 ☰・停車中 ☶・駐車中 ☷)を出す。
 */
const createCarPin = (maps: MapsApi, position: LatLng): CarPin => {
  const element = document.createElement("div");
  element.className = "zr-park-pin";
  // 光る輪と影は span に付ける(iPhone では svg に付けると四角く出るため)。
  element.innerHTML =
    '<i class="zr-park-pin-ring"></i>' +
    '<i class="zr-park-pin-lock"></i>' +
    '<i class="zr-park-pin-dir"></i>' +
    '<span class="zr-park-pin-core"></span>';
  const core = element.querySelector(".zr-park-pin-core") as HTMLElement;
  const Base = maps.OverlayView as unknown as new () => GOverlay;
  class Pin extends Base {
    private point = position;
    onAdd() {
      this.getPanes()?.overlayMouseTarget.appendChild(element);
    }
    draw() {
      const pixel = this.getProjection()?.fromLatLngToDivPixel(
        new maps.LatLng(this.point.lat, this.point.lng),
      );
      if (!pixel) return;
      element.style.left = `${pixel.x}px`;
      element.style.top = `${pixel.y}px`;
    }
    onRemove() {
      element.remove();
    }
    moveTo(point: LatLng) {
      this.point = point;
      this.draw();
    }
    setHeading(degrees: number | null) {
      element.classList.toggle("has-heading", degrees !== null);
      if (degrees !== null) element.style.setProperty("--zr-heading", `${Math.round(degrees)}deg`);
    }
    setStatus(status: ParkStatus) {
      for (const name of Object.keys(STATUS)) element.classList.toggle(`is-${name}`, name === status);
      core.innerHTML = trigramSvg(STATUS[status].lines);
    }
  }
  return new Pin() as CarPin;
};

/** 日本時間の「18:32」。 */
const clockText = (ms: number) =>
  new Date(ms).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

/** 日本時間の「10/14(火)」。 */
const dateText = (ms: number) =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(new Date(ms));

/** たった時間を「2時間15分」のように、数字と単位に分けて返す。 */
const elapsedParts = (ms: number): [string, string][] => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return [["1", "分未満"]];
  if (minutes < 60) return [[`${minutes}`, "分"]];
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return minutes % 60 ? [[`${hours}`, "時間"], [`${minutes % 60}`, "分"]] : [[`${hours}`, "時間"]];
  }
  const days = Math.floor(hours / 24);
  return hours % 24 ? [[`${days}`, "日"], [`${hours % 24}`, "時間"]] : [[`${days}`, "日"]];
};

/**
 * Google の住所(日本、〒573-0065 大阪府枚方市出口３丁目１−１)を、目的地の欄の形
 * (〒573-0065 大阪府枚方市出口3丁目1-1)にする。
 */
const tidyAddress = (text: string) =>
  text
    .normalize("NFKC")
    .replace(/^日本[、,]\s*/, "")
    .replace(/[\u2010-\u2015\u2212]/g, "-")
    .replace(/(\d)ー(?=\d)/g, "$1-")
    .trim();

/**
 * その場所の住所。調べられない(Geocoding API が使えない・電波が悪い)ときや、
 * 近くに住所が無いときは null。
 */
const addressAt = async (maps: MapsApi, point: LatLng): Promise<string | null> => {
  if (!maps.Geocoder) return null;
  const lookup = new maps.Geocoder()
    .geocode({ location: point, language: "ja", region: "jp" })
    .catch(() => null);
  const timeout = new Promise<null>((resolve) => {
    window.setTimeout(() => resolve(null), ADDRESS_TIMEOUT_MS);
  });
  const response = await Promise.race([lookup, timeout]);
  // 「MH4C+QX」のような Plus Code は住所ではないので使わない。
  const result = response?.results?.find(
    (entry) => entry.formatted_address && !entry.types?.includes("plus_code"),
  );
  const location = result?.geometry?.location;
  if (!result?.formatted_address || !location) return null;
  if (distanceMeters({ lat: location.lat(), lng: location.lng() }, point) > ADDRESS_NEAR_METERS) {
    return null;
  }
  return tidyAddress(result.formatted_address) || null;
};

/** 案内の文。英語を大きく、日本語は小さく添える。 */
type Note = { en: string; ja: string };

/** iPhone の速さで決めた、走っているか止まっているかと、そうなった時刻(スマホの時計)。 */
type PhoneMotion = { moving: boolean; since: number };

/** iPhone の GPS の1回分。 */
type PhoneFix = LatLng & {
  accuracy: number;
  heading: number | null;
  kmh: number | null;
  /** 速さが分からなければ null(そのときは車から届いた状態を使う)。 */
  motion: PhoneMotion | null;
};

/**
 * スマホの「車両位置」。車載機が最後に送ってきた場所(停めた場所)を地図に出す。
 * 車の電源が入っている間(走行中・停車中)に iPhone が車の近くにあれば、iPhone の GPS で
 * 車の印を毎秒動かす(そのとき iPhone は車の中にあるため。車からの通信は増やさない)。
 * 車の電源が入っている間は、いまの場所を目的地の一覧(地点リスト)に登録できる。
 * 合言葉が変わったら作り直すので、呼ぶ側で key={合言葉} を付ける。
 */
export function CarLocationPanel({
  syncKey,
  mapsKey,
  onRegister,
  onOpenList,
}: {
  syncKey: string;
  mapsKey: string;
  /** 「現在地を登録」で作った場所を、目的地の一覧に足す。 */
  onRegister: (place: PlaceDraft) => void;
  /** 「地点リスト」: 目的地の一覧を開く。 */
  onOpenList: () => void;
}) {
  // まだ読んでいなければ null。offset は「サーバーの時計 - スマホの時計」。
  const [loaded, setLoaded] = useState<{ park: ParkedCar | null; offset: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // サーバーの時計での「いま」。何分前かを出すのに使う。
  const [clock, setClock] = useState(0);
  const [mapState, setMapState] = useState<"loading" | "ready" | "error">("loading");
  const [satellite, setSatellite] = useState(false);
  const mapElementRef = useRef<HTMLDivElement>(null);
  // styles は配色に合わせた地図の色(航空写真から戻すときに使う)。
  const mapRef = useRef<{ map: GMap; pin: CarPin; circle: GCircle; styles: unknown[] } | null>(null);
  const [mapCreated, setMapCreated] = useState(false);
  const satelliteRef = useRef(satellite);
  // iPhone の GPS(車の電源が入っている間だけ追う)。
  const [phoneFix, setPhoneFix] = useState<PhoneFix | null>(null);
  // 地図が車を追いかけているか(指で地図を動かしたら止め、照準のボタンで戻す)。
  const [following, setFollowing] = useState(true);
  const followRef = useRef(true);
  // いま地図に描いている印の位置(なめらかに動かすときの出発点)。
  const shownRef = useRef<LatLng | null>(null);
  // 「現在地を登録」で住所を調べているところ。
  const [registering, setRegistering] = useState(false);
  // 住所を調べ終わったときに、そのときの一覧へ足すため(調べている間に一覧が変わることがある)。
  const registerRef = useRef(onRegister);
  useEffect(() => {
    registerRef.current = onRegister;
  });

  // 開いたとき・30秒おき・画面に戻ってきたときに読む。
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await fetchParking(syncKey);
        if (!active) return;
        setLoaded({ park: result.park, offset: result.now - Date.now() });
        setClock(result.now);
        setFailed(false);
      } catch {
        // 圏外などは次の周期に任せる(前に読めた場所はそのまま出しておく)。
        if (active) setFailed(true);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), PARK_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [syncKey]);

  // 「何分前」を進める。
  const offset = loaded?.offset ?? 0;
  useEffect(() => {
    if (!loaded) return;
    const timer = window.setInterval(() => setClock(Date.now() + offset), 15_000);
    return () => window.clearInterval(timer);
  }, [loaded, offset]);

  const park = loaded?.park ?? null;
  const live = park !== null && clock > 0 && clock - park.heard <= LIVE_MS;

  // 車の電源が入っている間は、iPhone の GPS で車の位置を毎秒追う。
  // しばらく届かなければ(電波・許可が無いなど)使わず、車から届いた位置に戻す。
  useEffect(() => {
    if (!live || !navigator.geolocation) return;
    let stale = 0;
    let motion: PhoneMotion | null = null;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy, heading, speed } = position.coords;
        const kmh = speed !== null && Number.isFinite(speed) ? Math.max(0, speed * 3.6) : null;
        if (kmh !== null) {
          const moving = motion?.moving ? kmh > PHONE_STOPPED_KMH : kmh >= PHONE_MOVING_KMH;
          if (!motion || motion.moving !== moving) motion = { moving, since: Date.now() };
        }
        const headingKnown = kmh !== null && kmh > 1.8 && heading !== null && Number.isFinite(heading);
        setPhoneFix({
          lat: latitude,
          lng: longitude,
          accuracy,
          heading: headingKnown ? heading : null,
          kmh,
          motion,
        });
        window.clearTimeout(stale);
        stale = window.setTimeout(() => setPhoneFix(null), PHONE_FIX_STALE_MS);
      },
      () => setPhoneFix(null),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20_000 },
    );
    return () => {
      navigator.geolocation.clearWatch(watch);
      window.clearTimeout(stale);
    };
  }, [live]);

  // iPhone が車の近くにあれば(車の中にいる)、iPhone の GPS を車の位置にする。
  // 車の GPS がしばらく使えず位置が古いときも、広げるのは3分ぶんまで(遠くの iPhone を車とみなさない)。
  const phoneInCar =
    live &&
    phoneFix !== null &&
    park !== null &&
    distanceMeters(phoneFix, park) <=
      IN_CAR_BASE_METERS +
        (IN_CAR_METERS_PER_SECOND * Math.min(LIVE_MS, Math.max(0, clock - park.at))) / 1000;
  // 走っているか止まっているかも、iPhone が車の中にあれば iPhone の GPS の速さで決める
  // (車からは走っている間1分おきにしか届かないので、信号で止まった・走り出したがすぐには分からない)。
  const phoneMotion = phoneInCar ? phoneFix.motion : null;
  const moving = phoneMotion ? phoneMotion.moving : park?.moving === true;
  const status = !park ? null : live ? (moving ? "driving" : "stopped") : "parked";
  const shown = phoneInCar ? phoneFix : park;
  const shownLat = shown?.lat;
  const shownLng = shown?.lng;
  const shownAccuracy = shown?.accuracy ?? 0;
  const shownHeading = phoneInCar ? phoneFix.heading : null;
  const startRef = useRef<LatLng | null>(null);
  useEffect(() => {
    startRef.current = shownLat === undefined || shownLng === undefined ? null : { lat: shownLat, lng: shownLng };
  });

  // 地図は場所が届いてから作る(作るのは1回だけ。印を動かすのは下)。
  const hasPlace = park !== null;
  useEffect(() => {
    if (!hasPlace || !mapElementRef.current || mapRef.current) return;
    let cancelled = false;
    void loadGoogleMaps(mapsKey)
      .then((maps) => {
        const start = startRef.current;
        if (cancelled || !mapElementRef.current || mapRef.current || !start) return;
        const api = maps as MapsApi;
        const accent = readAccent(mapElementRef.current);
        const look = parkMapLook(accent);
        const map = new api.Map(mapElementRef.current, {
          center: start,
          zoom: PARK_MAP_ZOOM,
          mapTypeId: satelliteRef.current ? "hybrid" : "roadmap",
          styles: satelliteRef.current ? SATELLITE_STYLES : look.styles,
          backgroundColor: look.ground,
          disableDefaultUI: true,
          clickableIcons: false,
          gestureHandling: "greedy",
          keyboardShortcuts: false,
        });
        // 誤差の範囲(この円の中に車がある)。
        const circle = new api.Circle({
          map,
          center: start,
          radius: 0,
          clickable: false,
          strokeColor: mixHex(accent, [255, 255, 255], 0.3),
          strokeOpacity: 0.55,
          strokeWeight: 1,
          fillColor: mixHex(accent, [0, 0, 0], 0.2),
          fillOpacity: 0.12,
        });
        const pin = createCarPin(api, start);
        pin.setMap(map);
        // 指で地図を動かしたら、車を追いかけるのをやめる(照準のボタンで戻す)。
        map.addListener("dragstart", () => {
          followRef.current = false;
          setFollowing(false);
        });
        mapRef.current = { map, pin, circle, styles: look.styles };
        setMapCreated(true);
        api.event.addListenerOnce(map, "tilesloaded", () => setMapState("ready"));
      })
      .catch(() => {
        if (!cancelled) setMapState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [hasPlace, mapsKey]);

  // 印を新しい位置までなめらかに動かす。車を追いかけている間は、地図も一緒に動かす。
  useEffect(() => {
    const current = mapRef.current;
    if (!mapCreated || !current || shownLat === undefined || shownLng === undefined) return;
    const to = { lat: shownLat, lng: shownLng };
    const from = shownRef.current ?? to;
    const duration = distanceMeters(from, to) > JUMP_METERS ? 0 : MOVE_MS;
    current.circle.setRadius(shownAccuracy);
    current.pin.setHeading(shownHeading);
    let frame = 0;
    const begin = performance.now();
    const step = (time: number) => {
      const t = duration === 0 ? 1 : Math.min(1, (time - begin) / duration);
      const point = { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
      shownRef.current = point;
      current.pin.moveTo(point);
      current.circle.setCenter(point);
      if (followRef.current) current.map.setCenter(point);
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [mapCreated, shownLat, shownLng, shownAccuracy, shownHeading]);

  // 印の真ん中に、いまの状態(走行中・停車中・駐車中)の八卦を出す。
  useEffect(() => {
    if (mapCreated && status) mapRef.current?.pin.setStatus(status);
  }, [mapCreated, status]);

  // 航空写真と地図を切り替える。
  useEffect(() => {
    satelliteRef.current = satellite;
    const current = mapRef.current;
    if (!current) return;
    current.map.setOptions({ styles: satellite ? SATELLITE_STYLES : current.styles });
    current.map.setMapTypeId(satellite ? "hybrid" : "roadmap");
  }, [satellite]);

  /** 照準のボタン: 車の位置に戻して、また追いかける。 */
  const recenter = () => {
    const current = mapRef.current;
    const point = shownRef.current;
    if (!current || !point) return;
    followRef.current = true;
    setFollowing(true);
    current.map.panTo(point);
    current.map.setZoom(PARK_MAP_ZOOM);
  };

  /**
   * 「現在地を登録」: いまの車の位置を、目的地の一覧(地点リスト)に足す。車の DEST にも届く。
   * 名前は登録した時刻(地点19:46)。行き先は近くの住所、無ければ緯度・経度。
   */
  const registerHere = async () => {
    if (registering || !shown) return;
    const point = { lat: shown.lat, lng: shown.lng };
    const label = `地点${clockText(Date.now() + offset)}`;
    setRegistering(true);
    let address: string | null = null;
    try {
      address = await addressAt((await loadGoogleMaps(mapsKey)) as MapsApi, point);
    } catch {
      // 地図を読み込めないときも、緯度・経度で登録する。
    }
    setRegistering(false);
    registerRef.current({
      label,
      destination: address ?? `${point.lat.toFixed(6)},${point.lng.toFixed(6)}`,
    });
  };
  // 走っている間は走り出した時刻からの走行時間、止まっていれば停めた時刻から数える。
  // 走り出した時刻は車から届いたもの。まだ届いていなければ(走り出してすぐ)、iPhone が走り出しを見た時刻。
  // 車がまだ走っていると思っている間に止まったときも、iPhone が止まりを見た時刻から数える。
  // (走り出した時刻を送らない前の車の版では、最後に届いた時刻から数える)
  const phoneSince = phoneMotion ? phoneMotion.since + offset : null;
  const tripSince =
    status === "driving" ? (park?.tripSince ?? (phoneMotion?.moving ? phoneSince : null)) : null;
  const stoppedSince =
    status === "stopped" && phoneMotion && !phoneMotion.moving && park?.moving ? phoneSince : null;
  const shownAt = park
    ? status === "driving"
      ? (tripSince ?? park.at)
      : (stoppedSince ?? park.since)
    : 0;
  const shownLabel =
    status === "driving" ? (tripSince !== null ? "出発時刻" : "届いた時刻") : "停めた時刻";
  const elapsedLabel =
    status === "driving" ? (tripSince !== null ? "走行時間" : "何分前") : "停めてから";
  const sameDay = park !== null && clock > 0 && dateText(shownAt) === dateText(clock);
  const destination = park ? `${park.lat.toFixed(6)},${park.lng.toFixed(6)}` : "";
  // 地図の左上に小さく出す座標(北緯・東経)と、どこから来た位置か。
  const coords = shown
    ? [
        `${shown.lat < 0 ? "S" : "N"} ${Math.abs(shown.lat).toFixed(5)}°`,
        `${shown.lng < 0 ? "W" : "E"} ${Math.abs(shown.lng).toFixed(5)}°`,
      ]
    : null;
  const source = phoneInCar ? "LIVE · iPhone GPS" : live && park ? `CAR · ${clockText(park.at)}` : null;
  // 速さ(iPhone の GPS で追っている間だけ)。
  const kmh = phoneInCar ? phoneFix.kmh : null;

  // 地図の代わりに出す案内。
  const standby: Note | null = !loaded
    ? failed
      ? { en: "NO SIGNAL", ja: "読み込めませんでした。電波のよい所で開き直してください。" }
      : { en: "READING", ja: "車両位置を読み込んでいます" }
    : !park
      ? {
          en: "NO DATA YET",
          ja: "まだ車両位置が届いていません。車で Z CAR を開いて走ると、止まった場所がここに出ます。",
        }
      : mapState === "error"
        ? { en: "MAP UNAVAILABLE", ja: "地図を読み込めませんでした。下のボタンで地図アプリを開けます。" }
        : mapState === "loading"
          ? { en: "LOADING MAP", ja: "地図を読み込んでいます" }
          : null;

  return (
    <div className="zr-park">
      <section className="zr-park-card" aria-label="車両位置">
        <header className="zr-panel-head">
          <span>
            <small>CAR LOCATION</small>
            <b>車両位置</b>
          </span>
          {status ? (
            <em className={`zr-park-state is-${status}`}>
              <TrigramMark lines={STATUS[status].lines} />
              {STATUS[status].en}
              <small>{STATUS[status].ja}</small>
            </em>
          ) : null}
        </header>
        {/* 四隅の照準の枠は、地図の外側(すき間)に描く。地図の Google の表示に重ねないため。 */}
        <div className="zr-park-scope">
          <div className="zr-park-map">
            <div ref={mapElementRef} className="zr-park-canvas" />
            {standby ? (
              <p className="zr-park-standby" role="status">
                <b>{standby.en}</b>
                <small>{standby.ja}</small>
              </p>
            ) : (
              <>
                {coords ? (
                  <p className="zr-park-coords" aria-hidden="true">
                    <span>{coords[0]}</span>
                    <span>{coords[1]}</span>
                    {source ? <small className={phoneInCar ? "is-live" : undefined}>{source}</small> : null}
                  </p>
                ) : null}
                <div className="zr-park-tools">
                  <button
                    type="button"
                    aria-pressed={satellite}
                    onClick={() => setSatellite((value) => !value)}
                  >
                    {satellite ? "地図" : "航空写真"}
                  </button>
                  <button
                    type="button"
                    className={following ? undefined : "is-off"}
                    aria-label="車両位置を真ん中にして追いかける"
                    onClick={recenter}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <circle cx="12" cy="12" r="6.5" />
                      <circle cx="12" cy="12" r="2" className="is-fill" />
                      <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
                    </svg>
                  </button>
                </div>
              </>
            )}
            {failed && loaded ? <i className="zr-park-offline">NO SIGNAL</i> : null}
          </div>
        </div>
        {park ? (
          <div className="zr-park-facts">
            {/* 停めてからの時間は、給油の燃費と同じ大きな数字で出す。 */}
            <p className="zr-park-elapsed">
              <small>{elapsedLabel}</small>
              <strong>
                {clock > 0
                  ? elapsedParts(clock - shownAt).map(([value, unit]) => (
                      <span key={unit}>
                        {value}
                        <em>{unit}</em>
                      </span>
                    ))
                  : "—"}
              </strong>
            </p>
            <dl>
              <div>
                <dt>{shownLabel}</dt>
                <dd>
                  {clockText(shownAt)}
                  <small>{sameDay ? "今日" : dateText(shownAt)}</small>
                </dd>
              </div>
              {kmh !== null ? (
                <div>
                  <dt>速度</dt>
                  <dd>
                    {Math.round(kmh)}
                    <em>km/h</em>
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>誤差</dt>
                  <dd>
                    ±{Math.round(shownAccuracy)}
                    <em>m</em>
                  </dd>
                </div>
              )}
            </dl>
          </div>
        ) : null}
      </section>
      {live ? (
        // 車の電源が入っている間は、いまの場所を地点リスト(目的地の一覧)に登録できる。
        <div className="zr-park-go">
          <button
            type="button"
            className="zr-primary"
            aria-busy={registering}
            disabled={registering}
            onClick={() => void registerHere()}
          >
            <svg viewBox="0 0 24 24" className="is-line" aria-hidden="true">
              <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
              <path d="M12 7v6M9 10h6" />
            </svg>
            {registering ? "登録中…" : "現在地を登録"}
          </button>
          <button type="button" className="zr-ghost" onClick={onOpenList}>
            <svg viewBox="0 0 24 24" className="is-line" aria-hidden="true">
              <path d="M9.5 6.5h10M9.5 12h10M9.5 17.5h10" />
              <path className="is-dot" d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" />
            </svg>
            地点リスト
          </button>
        </div>
      ) : park ? (
        <div className="zr-park-go">
          <a
            className="zr-primary"
            href={`https://www.google.com/maps/dir/?api=1&destination=${destination}&travelmode=walking`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2.8 19.6 20.6 12 16.9 4.4 20.6Z" />
            </svg>
            Google マップで行く
          </a>
          <a
            className="zr-ghost"
            href={`https://maps.apple.com/?daddr=${destination}&dirflg=w`}
            target="_blank"
            rel="noopener noreferrer"
          >
            Apple マップ
          </a>
        </div>
      ) : null}
      <p className="zr-note">
        {phoneInCar
          ? "この iPhone の GPS で車の位置を動かしています。"
          : "車で Z CAR を開いている間に届いた、最後の場所です。"}
        {live ? "登録した場所は、目的地として車の DEST から選べます。" : null}
      </p>
    </div>
  );
}
