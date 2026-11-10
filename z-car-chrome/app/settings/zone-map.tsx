"use client";

import { useEffect, useRef, useState } from "react";
import { loadGoogleMaps, NIGHT_MAP_STYLES } from "../google-maps";
import type { ZoneEnd } from "../settings-store";

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
type GLine = { setMap: (map: GMap | null) => void };
type MapsApi = {
  Map: new (element: HTMLElement, options: Record<string, unknown>) => GMap;
  LatLng: new (lat: number, lng: number) => unknown;
  LatLngBounds: new () => { extend: (point: LatLng) => void };
  OverlayView: new () => GOverlay;
  Polyline: new (options: Record<string, unknown>) => GLine;
  event: { addListenerOnce: (target: unknown, name: string, handler: () => void) => unknown };
};

/** 地図に引く区間(終わりがまだ決まっていなければ、始まりの札だけ)。 */
export type ZoneOnMap = { id: string; label: string; start: ZoneEnd; end: ZoneEnd | null };

/** 速度取締区間の色(車の地図と同じ紫。オービスの赤と見分ける)。 */
const ZONE_COLOR = "#9b87ff";
/** 全部が入る広さにするとき、これより寄らない(1か所だけのときの縮尺もこれ)。 */
const MAX_FIT_ZOOM = 16;
/** 地図のふちと線の間の空き(px)。 */
const FIT_PADDING = 40;

/** 地図の上の札(始・終・区1 など)。button なら押せる(その区間を直す欄を開く)。 */
const createTag = (
  maps: MapsApi,
  point: LatLng,
  className: string,
  text: string,
  onPress: (() => void) | null,
  label = "",
): GOverlay => {
  const element = document.createElement(onPress ? "button" : "span");
  element.className = className;
  element.textContent = text;
  if (onPress && element instanceof HTMLButtonElement) {
    element.type = "button";
    element.setAttribute("aria-label", label);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      onPress();
    });
  } else {
    element.setAttribute("aria-hidden", "true");
  }
  const Base = maps.OverlayView as unknown as new () => GOverlay;
  class Tag extends Base {
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
  return new Tag();
};

/**
 * 速度取締区間の地図。区間を紫の線(点線)で引き、始まりに「始」、終わりに「終」の札。
 * 一覧の地図(オービスのタブで「取締区間」を選んだとき)では、線の真ん中に一覧と同じ「区1」の札を出し、
 * 押すと直す欄が開く。足す欄の小さな地図(preview)は、選んだ始まりと終わりだけを出す。
 * 区間が変わったら、全部が入る広さに合わせ直す。地図を読めなくても、一覧と欄は使える。
 */
export function ZoneMap({
  zones,
  mapsKey,
  caption,
  onPick = null,
  preview = false,
}: {
  zones: ZoneOnMap[];
  mapsKey: string;
  /** 左上の札(例: 登録 2区間・長さ 1.5km)。 */
  caption: string;
  /** 区間の札を押したとき(その区間を直す欄を開く)。 */
  onPick?: ((id: string) => void) | null;
  /** 足す欄の小さな地図。 */
  preview?: boolean;
}) {
  const elementRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<{ api: MapsApi; map: GMap; parts: GLine[] } | null>(null);
  const [ready, setReady] = useState(false);
  const pickRef = useRef(onPick);
  const zonesRef = useRef(zones);
  useEffect(() => {
    pickRef.current = onPick;
    zonesRef.current = zones;
  });

  // 地図を作る(1回だけ)。
  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps(mapsKey)
      .then((loaded) => {
        if (cancelled || !elementRef.current || mapRef.current) return;
        const api = loaded as unknown as MapsApi;
        const first = zonesRef.current[0];
        const map = new api.Map(elementRef.current, {
          center: first ? first.start : { lat: 34.7, lng: 135.5 },
          zoom: 13,
          styles: NIGHT_MAP_STYLES,
          backgroundColor: "#03150b",
          disableDefaultUI: true,
          clickableIcons: false,
          // 1本指では画面を動かす(地図は2本指で動かす)。
          gestureHandling: "cooperative",
          keyboardShortcuts: false,
        });
        mapRef.current = { api, map, parts: [] };
        setReady(true);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mapsKey]);

  // 線と札を引き直して、全部が入る広さにする(区間の場所・数・名前が変わったとき)。
  const layout = zones
    .map((zone) => `${zone.id}:${zone.start.lat}:${zone.start.lng}:${zone.end?.lat}:${zone.end?.lng}:${zone.label}`)
    .join("|");
  useEffect(() => {
    const current = mapRef.current;
    if (!ready || !current) return;
    const { api, map } = current;
    for (const part of current.parts) part.setMap(null);
    const parts: GLine[] = [];
    const add = (part: GLine) => {
      part.setMap(map);
      parts.push(part);
    };
    const list = zonesRef.current;
    const points: LatLng[] = [];
    list.forEach((zone, index) => {
      points.push(zone.start);
      if (zone.end) {
        points.push(zone.end);
        const path = [zone.start, zone.end];
        // 下に太く薄い線(光り)、上に点線(線の色は透明にして、短い線を並べる)。
        add(new api.Polyline({ path, clickable: false, strokeColor: ZONE_COLOR, strokeOpacity: 0.25, strokeWeight: 14, zIndex: 1 }));
        add(
          new api.Polyline({
            path,
            clickable: false,
            strokeOpacity: 0,
            zIndex: 2,
            icons: [
              {
                icon: { path: "M 0,-1 0,1", strokeColor: ZONE_COLOR, strokeOpacity: 1, strokeWeight: 5, scale: 3 },
                offset: "0",
                repeat: "14px",
              },
            ],
          }),
        );
        add(createTag(api, zone.end, "zr-zone-tag is-end", "終", null));
        if (!preview) {
          const middle = { lat: (zone.start.lat + zone.end.lat) / 2, lng: (zone.start.lng + zone.end.lng) / 2 };
          add(
            createTag(api, middle, "zr-zone-tag is-num", `区${index + 1}`, () => pickRef.current?.(zone.id), `区${index + 1} ${zone.label || "取締区間"} を直す`),
          );
        }
      }
      add(createTag(api, zone.start, "zr-zone-tag is-start", "始", null));
    });
    current.parts = parts;
    if (points.length === 1) {
      map.setCenter(points[0]);
      map.setZoom(MAX_FIT_ZOOM);
    } else if (points.length > 1) {
      const bounds = new api.LatLngBounds();
      for (const point of points) bounds.extend(point);
      // 合わせている間だけ寄りすぎないようにする(合わせ終わったら、指で寄れる)。
      map.setOptions({ maxZoom: MAX_FIT_ZOOM });
      map.fitBounds(bounds, FIT_PADDING);
      api.event.addListenerOnce(map, "idle", () => map.setOptions({ maxZoom: null }));
    }
  }, [ready, layout, preview]);

  // 外すときは線と札も外す。
  useEffect(
    () => () => {
      for (const part of mapRef.current?.parts ?? []) part.setMap(null);
    },
    [],
  );

  return (
    <div className={`zr-orbis-map zr-zone-map${preview ? " is-preview" : ""}`}>
      <div ref={elementRef} className="zr-orbis-map-canvas" />
      <b className="zr-orbis-map-count">{caption}</b>
    </div>
  );
}
