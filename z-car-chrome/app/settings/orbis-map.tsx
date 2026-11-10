"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps, NIGHT_MAP_STYLES } from "../google-maps";
import type { OrbisPoint } from "../settings-store";

type LatLng = { lat: number; lng: number };
type GMap = {
  fitBounds: (bounds: unknown, padding?: number) => void;
  setCenter: (point: LatLng) => void;
  setZoom: (zoom: number) => void;
  setOptions: (options: Record<string, unknown>) => void;
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
  LatLngBounds: new () => { extend: (point: LatLng) => void };
  OverlayView: new () => GOverlay;
  event: { addListenerOnce: (target: unknown, name: string, handler: () => void) => unknown };
};

/** 全部が入る広さにするとき、これより寄らない(1か所だけのときの縮尺もこれ)。 */
const MAX_FIT_ZOOM = 15;
/** 地図のふちと印の間の空き(px)。 */
const FIT_PADDING = 44;
/** 印の赤いカメラ(車の地図のオービスの印と同じ形)。 */
const CAMERA_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="7" width="13" height="10" rx="1.5"></rect>' +
  '<path d="M16 10.5 21 8v8l-5-2.5"></path><circle cx="9.5" cy="12" r="2.2"></circle></svg>';

/**
 * 地図の上のオービスの印(赤いカメラと番号。走る向きが決まっていれば、その向きの琥珀色の矢印)。
 * 押すと、その場所を直す欄を開く。
 */
const createMark = (
  maps: MapsApi,
  point: OrbisPoint,
  number: number,
  onPick: (point: OrbisPoint) => void,
): GOverlay => {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "zr-orbis-mark";
  element.setAttribute("aria-label", `${number}番 ${point.label || "オービス"} を直す`);
  if (point.direction !== null) {
    const way = document.createElement("i");
    way.className = "zr-orbis-mark-way";
    way.style.setProperty("--zr-way", `${point.direction}deg`);
    element.appendChild(way);
  }
  const ring = document.createElement("b");
  ring.innerHTML = CAMERA_SVG;
  const badge = document.createElement("em");
  badge.textContent = String(number);
  element.append(ring, badge);
  element.addEventListener("click", (event) => {
    event.stopPropagation();
    onPick(point);
  });
  const Base = maps.OverlayView as unknown as new () => GOverlay;
  class Mark extends Base {
    onAdd() {
      this.getPanes()?.overlayMouseTarget.appendChild(element);
    }
    draw() {
      const pixel = this.getProjection()?.fromLatLngToDivPixel(new maps.LatLng(point.lat, point.lng));
      if (!pixel) return;
      element.style.left = `${pixel.x}px`;
      element.style.top = `${pixel.y}px`;
    }
    onRemove() {
      element.remove();
    }
  }
  return new Mark();
};

/**
 * 登録したオービスを全部出した地図(下のタブの「オービス」の一番上)。番号は一覧の行と同じ。
 * 登録が変わったら、全部が入る広さに合わせ直す。地図を読めなくても、一覧は使える。
 */
export function OrbisMap({
  points,
  mapsKey,
  onPick,
}: {
  points: OrbisPoint[];
  mapsKey: string;
  /** 印を押したとき(その場所を直す欄を開く)。 */
  onPick: (point: OrbisPoint) => void;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ api: MapsApi; map: GMap; marks: GOverlay[] } | null>(null);
  const [ready, setReady] = useState(false);
  const pickRef = useRef(onPick);
  const pointsRef = useRef(points);
  useEffect(() => {
    pickRef.current = onPick;
    pointsRef.current = points;
  });

  // 地図を作る(1回だけ)。
  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps(mapsKey)
      .then((loaded) => {
        if (cancelled || !elementRef.current || mapRef.current) return;
        const api = loaded as unknown as MapsApi;
        const first = pointsRef.current[0];
        const map = new api.Map(elementRef.current, {
          center: first ? { lat: first.lat, lng: first.lng } : { lat: 34.7, lng: 135.5 },
          zoom: 12,
          styles: NIGHT_MAP_STYLES,
          backgroundColor: "#03150b",
          disableDefaultUI: true,
          clickableIcons: false,
          // 1本指では画面を動かす(地図は2本指で動かす)。
          gestureHandling: "cooperative",
          keyboardShortcuts: false,
        });
        mapRef.current = { api, map, marks: [] };
        setReady(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mapsKey]);

  // 印を置き直して、全部が入る広さにする(登録の場所・向き・数が変わったとき)。
  const layout = points.map((point) => `${point.id}:${point.lat}:${point.lng}:${point.direction}:${point.label}`).join("|");
  useEffect(() => {
    const current = mapRef.current;
    if (!ready || !current) return;
    const { api, map } = current;
    for (const mark of current.marks) mark.setMap(null);
    const list = pointsRef.current;
    current.marks = list.map((point, index) => {
      const mark = createMark(api, point, index + 1, (picked) => pickRef.current(picked));
      mark.setMap(map);
      return mark;
    });
    if (list.length === 1) {
      map.setCenter({ lat: list[0].lat, lng: list[0].lng });
      map.setZoom(MAX_FIT_ZOOM);
    } else if (list.length > 1) {
      const bounds = new api.LatLngBounds();
      for (const point of list) bounds.extend({ lat: point.lat, lng: point.lng });
      // 合わせている間だけ寄りすぎないようにする(合わせ終わったら、指で寄れる)。
      map.setOptions({ maxZoom: MAX_FIT_ZOOM });
      map.fitBounds(bounds, FIT_PADDING);
      api.event.addListenerOnce(map, "idle", () => map.setOptions({ maxZoom: null }));
    }
  }, [ready, layout]);

  // 外すときは印も外す。
  useEffect(
    () => () => {
      for (const mark of mapRef.current?.marks ?? []) mark.setMap(null);
    },
    [],
  );

  return (
    <div className="zr-orbis-map">
      <div ref={elementRef} className="zr-orbis-map-canvas" />
      <b className="zr-orbis-map-count">登録 {points.length}か所</b>
    </div>
  );
}
