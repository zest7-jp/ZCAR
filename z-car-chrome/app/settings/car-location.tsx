"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps } from "../google-maps";
import { distanceMeters, fetchParking, type ParkedCar } from "../parking";

/** 車両位置を読み直す間隔(画面に戻ってきたときは、すぐ読み直す)。 */
const PARK_POLL_MS = 30_000;
/**
 * 最後に届いてからこの時間までは、車の電源が入っているとみなす
 * (車は止まっていても2分おきに送ってくる)。過ぎたら「駐車中」。
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

const STATUS = {
  parked: { ja: "駐車中", en: "PARKED" },
  stopped: { ja: "停車中", en: "STOPPED" },
  driving: { ja: "走行中", en: "DRIVING" },
} as const;

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
type MapsApi = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GMap;
  LatLng: new (lat: number, lng: number) => unknown;
  OverlayView: new () => GOverlay;
  Circle: new (options: Record<string, unknown>) => GCircle;
  event: {
    addListenerOnce: (instance: unknown, eventName: string, handler: () => void) => void;
  };
};
type CarPin = GOverlay & {
  moveTo: (point: LatLng) => void;
  /** 進む向き(北が0、時計回りの度)。null なら向きの印を隠す。 */
  setHeading: (degrees: number | null) => void;
};

/** 地図の上の車の印(HTML)。地図を動かしても、車両位置に付いて動く。 */
const createCarPin = (maps: MapsApi, position: LatLng): CarPin => {
  const element = document.createElement("div");
  element.className = "zr-park-pin";
  // 光る輪と影は span に付ける(iPhone では svg に付けると四角く出るため)。
  element.innerHTML =
    '<i class="zr-park-pin-ring"></i>' +
    '<i class="zr-park-pin-lock"></i>' +
    '<i class="zr-park-pin-dir"></i>' +
    '<span class="zr-park-pin-core">' +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path class="zr-park-pin-body" d="M4 12.6 6 7.3C6.3 6.5 7 6 7.8 6h8.4c.8 0 1.5.5 1.8 1.3l2 5.3V18a1 1 0 0 1-1 1h-1.2a1 1 0 0 1-1-1v-1H7.2v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>' +
    '<path class="zr-park-pin-cut" d="M6.5 11.6h11l-1.3-3.7a.8.8 0 0 0-.8-.5H8.6a.8.8 0 0 0-.8.5z"/>' +
    '<circle class="zr-park-pin-cut" cx="7.6" cy="14.4" r="1.2"/>' +
    '<circle class="zr-park-pin-cut" cx="16.4" cy="14.4" r="1.2"/>' +
    "</svg>" +
    "</span>";
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

/** 案内の文。英語を大きく、日本語は小さく添える。 */
type Note = { en: string; ja: string };

/** iPhone の GPS の1回分。 */
type PhoneFix = LatLng & { accuracy: number; heading: number | null; kmh: number | null };

/**
 * スマホの「車両位置」。車載機が最後に送ってきた場所(停めた場所)を地図に出す。
 * 車の電源が入っている間(走行中・停車中)に iPhone が車の近くにあれば、iPhone の GPS で
 * 車の印を毎秒動かす(そのとき iPhone は車の中にあるため。車からの通信は増やさない)。
 * 合言葉が変わったら作り直すので、呼ぶ側で key={合言葉} を付ける。
 */
export function CarLocationPanel({ syncKey, mapsKey }: { syncKey: string; mapsKey: string }) {
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
  const live = park !== null && clock > 0 && clock - park.at <= LIVE_MS;
  const status = !park ? null : live ? (park.moving ? "driving" : "stopped") : "parked";

  // 車の電源が入っている間は、iPhone の GPS で車の位置を毎秒追う。
  // しばらく届かなければ(電波・許可が無いなど)使わず、車から届いた位置に戻す。
  useEffect(() => {
    if (!live || !navigator.geolocation) return;
    let stale = 0;
    const watch = navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy, heading, speed } = position.coords;
        const moving = speed !== null && Number.isFinite(speed) && speed > 0.5;
        setPhoneFix({
          lat: latitude,
          lng: longitude,
          accuracy,
          heading: moving && heading !== null && Number.isFinite(heading) ? heading : null,
          kmh: speed !== null && Number.isFinite(speed) ? Math.max(0, speed * 3.6) : null,
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
  const phoneInCar =
    live &&
    phoneFix !== null &&
    park !== null &&
    distanceMeters(phoneFix, park) <=
      IN_CAR_BASE_METERS + IN_CAR_METERS_PER_SECOND * Math.max(0, (clock - park.at) / 1000);
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
  // 走っている間は走り出した時刻からの走行時間、止まっていれば停めた時刻から数える。
  // (走り出した時刻を送らない前の車の版では、最後に届いた時刻から数える)
  const tripSince = status === "driving" ? (park?.tripSince ?? null) : null;
  const shownAt = park ? (status === "driving" ? (tripSince ?? park.at) : park.since) : 0;
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
              <i aria-hidden="true" />
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
      {park ? (
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
          ? "車の電源が入っている間は、この iPhone の GPS で車の位置を動かしています。"
          : "車で Z CAR を開いている間に届いた、最後の場所です。"}
      </p>
    </div>
  );
}
