"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps, NIGHT_MAP_STYLES } from "../google-maps";
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
/** 車がこれ(m)以上動いたら、地図を車両位置へ寄せ直す(GPS の小さなぶれでは動かさない)。 */
const RECENTER_METERS = 30;

const STATUS = {
  parked: { ja: "駐車中", en: "PARKED" },
  stopped: { ja: "停車中", en: "STOPPED" },
  driving: { ja: "走行中", en: "DRIVING" },
} as const;

type LatLng = { lat: number; lng: number };
type GMap = {
  panTo: (point: LatLng) => void;
  setZoom: (zoom: number) => void;
  setMapTypeId: (id: string) => void;
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
type CarPin = GOverlay & { moveTo: (point: LatLng) => void };

/** 地図の上の車の印(HTML)。地図を動かしても、車両位置に付いて動く。 */
const createCarPin = (maps: MapsApi, position: LatLng): CarPin => {
  const element = document.createElement("div");
  element.className = "zr-park-pin";
  element.innerHTML =
    '<i class="zr-park-pin-ring"></i>' +
    '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<path class="zr-park-pin-body" d="M4 12.6 6 7.3C6.3 6.5 7 6 7.8 6h8.4c.8 0 1.5.5 1.8 1.3l2 5.3V18a1 1 0 0 1-1 1h-1.2a1 1 0 0 1-1-1v-1H7.2v1a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z"/>' +
    '<path class="zr-park-pin-cut" d="M6.5 11.6h11l-1.3-3.7a.8.8 0 0 0-.8-.5H8.6a.8.8 0 0 0-.8.5z"/>' +
    '<circle class="zr-park-pin-cut" cx="7.6" cy="14.4" r="1.2"/>' +
    '<circle class="zr-park-pin-cut" cx="16.4" cy="14.4" r="1.2"/>' +
    "</svg>";
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

/**
 * スマホの「車両位置」。車載機が最後に送ってきた場所(停めた場所)を地図に出す。
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
  // centered は最後に地図の真ん中に寄せた場所。
  const mapRef = useRef<{ map: GMap; pin: CarPin; circle: GCircle; centered: LatLng } | null>(null);
  const satelliteRef = useRef(satellite);

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
  const parkLat = park?.lat;
  const parkLng = park?.lng;
  const parkAccuracy = park?.accuracy ?? 0;

  // 地図は場所が届いてから作る。場所が変わったら、印を動かして真ん中に寄せる。
  useEffect(() => {
    if (parkLat === undefined || parkLng === undefined || !mapElementRef.current) return;
    let cancelled = false;
    const point = { lat: parkLat, lng: parkLng };
    void loadGoogleMaps(mapsKey)
      .then((maps) => {
        if (cancelled || !mapElementRef.current) return;
        const current = mapRef.current;
        if (current) {
          current.pin.moveTo(point);
          current.circle.setCenter(point);
          current.circle.setRadius(parkAccuracy);
          if (distanceMeters(current.centered, point) >= RECENTER_METERS) {
            current.map.panTo(point);
            current.centered = point;
          }
          return;
        }
        const api = maps as MapsApi;
        const map = new api.Map(mapElementRef.current, {
          center: point,
          zoom: PARK_MAP_ZOOM,
          mapTypeId: satelliteRef.current ? "hybrid" : "roadmap",
          styles: NIGHT_MAP_STYLES,
          backgroundColor: "#0b1210",
          disableDefaultUI: true,
          clickableIcons: false,
          gestureHandling: "greedy",
          keyboardShortcuts: false,
        });
        // 誤差の範囲(この円の中に車がある)。
        const circle = new api.Circle({
          map,
          center: point,
          radius: parkAccuracy,
          clickable: false,
          strokeColor: "#ffffff",
          strokeOpacity: 0.35,
          strokeWeight: 1,
          fillColor: "#ffffff",
          fillOpacity: 0.08,
        });
        const pin = createCarPin(api, point);
        pin.setMap(map);
        mapRef.current = { map, pin, circle, centered: point };
        api.event.addListenerOnce(map, "tilesloaded", () => setMapState("ready"));
      })
      .catch(() => {
        if (!cancelled) setMapState("error");
      });
    return () => {
      cancelled = true;
    };
  }, [parkLat, parkLng, parkAccuracy, mapsKey]);

  // 航空写真と地図を切り替える。
  useEffect(() => {
    satelliteRef.current = satellite;
    mapRef.current?.map.setMapTypeId(satellite ? "hybrid" : "roadmap");
  }, [satellite]);

  const recenter = () => {
    if (!park || !mapRef.current) return;
    const point = { lat: park.lat, lng: park.lng };
    mapRef.current.map.panTo(point);
    mapRef.current.map.setZoom(PARK_MAP_ZOOM);
    mapRef.current.centered = point;
  };

  const live = park !== null && clock > 0 && clock - park.at <= LIVE_MS;
  const status = !park ? null : live ? (park.moving ? "driving" : "stopped") : "parked";
  // 走っている間は「届いた時刻」、止まっていれば「停めた時刻」から数える。
  const shownAt = park ? (status === "driving" ? park.at : park.since) : 0;
  const sameDay = park !== null && clock > 0 && dateText(shownAt) === dateText(clock);
  const destination = park ? `${park.lat.toFixed(6)},${park.lng.toFixed(6)}` : "";

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
        <div className="zr-park-map">
          <div ref={mapElementRef} className="zr-park-canvas" />
          {standby ? (
            <p className="zr-park-standby" role="status">
              <b>{standby.en}</b>
              <small>{standby.ja}</small>
            </p>
          ) : (
            <div className="zr-park-tools">
              <button
                type="button"
                aria-pressed={satellite}
                onClick={() => setSatellite((value) => !value)}
              >
                {satellite ? "地図" : "航空写真"}
              </button>
              <button type="button" aria-label="車両位置を真ん中に" onClick={recenter}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="12" r="6.5" />
                  <circle cx="12" cy="12" r="2" className="is-fill" />
                  <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
                </svg>
              </button>
            </div>
          )}
          {failed && loaded ? <i className="zr-park-offline">NO SIGNAL</i> : null}
        </div>
        {park ? (
          <dl className="zr-hero-stats zr-park-facts">
            <div>
              <dt>{status === "driving" ? "届いた時刻" : "停めた時刻"}</dt>
              <dd>
                {clockText(shownAt)}
                <small>{sameDay ? "今日" : dateText(shownAt)}</small>
              </dd>
            </div>
            <div>
              <dt>{status === "driving" ? "何分前" : "停めてから"}</dt>
              <dd>
                {clock > 0
                  ? elapsedParts(clock - shownAt).map(([value, unit]) => (
                      <span key={unit}>
                        {value}
                        <em>{unit}</em>
                      </span>
                    ))
                  : "—"}
              </dd>
            </div>
            <div>
              <dt>誤差</dt>
              <dd>
                ±{Math.round(park.accuracy)}
                <em>m</em>
              </dd>
            </div>
          </dl>
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
        車で Z CAR を開いている間、止まった場所をここへ送ります。最後に届いた場所が、車を停めた場所です。
      </p>
    </div>
  );
}
