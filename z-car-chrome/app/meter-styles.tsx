"use client";

// 近未来のほかのテーマ(80年代のデジタル)の、メーターの画面。
// 1024x566 の板に描き、使える広さに合わせて拡大・縮小する(車載機ではほぼ等倍)。
// 下から「動かない絵(SVG)」「地図」「動く針や数字(SVG)」「押せる所(ボタン)」の順に重ねる。
// 地図(Google マップ)を作るのは app/page.tsx で、ここでは置き場所を用意するだけ。

import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { WEEKDAY_ELEMENT_COLORS } from "./workday-marks";
import type { MeterStyle } from "./settings-store";

const BOARD_W = 1024;
const BOARD_H = 566;
const RPM_MAX = 8000;
/** ここから上の回転は赤くする(近未来のメーターと同じ)。 */
const RPM_RED = 6500;

/** 天気(Open-Meteo の天気の番号)と、3時間・6時間後。 */
export type ClusterWeather = {
  temperature: number;
  code: number;
  isDay: boolean;
  hours: { temperature: number; code: number; isDay: boolean }[];
};

/** メーターに出す値。取れていない値は null。 */
export type ClusterData = {
  speed: number | null;
  rpm: number | null;
  coolant: number | null;
  voltage: number | null;
  /** 今の時刻 (HH:MM)。 */
  clock: string;
  year: number;
  month: number;
  day: number;
  /** 曜日(0 が日曜)。 */
  weekday: number;
  world: { name: string; time: string }[];
  weather: ClusterWeather | null;
  sunrise: string | null;
  sunset: string | null;
  todayKm: number;
  avgCruise: number | null;
  avgFuel: number | null;
  rangeKm: number;
  /** 残りの燃料(0〜100)。 */
  fuelPercent: number;
  /** 進んでいる向き(北が0、時計回りの度。360を超えることもある)。分からなければ null。 */
  heading: number | null;
  /** START の行き先の名前。無ければ null。 */
  destLabel: string | null;
  /** START の行き先が、今回だけの行き先(一覧に登録していない一度きりの所)か。 */
  destOnce: boolean;
  /** 今週(月曜〜日曜)でシフトのある曜日(0 が日曜)。曜日の札に五行の色を付ける。 */
  workDays: number[];
};

export type ClusterProps = {
  data: ClusterData;
  /** 燃費の記録を開く。 */
  onFuel: () => void;
  /** 目的地を選ぶ。 */
  onDest: () => void;
  /** ★の場所へナビを始める。行き先が無ければ null。 */
  onStart: (() => void) | null;
};

/** 地図のあるテーマ(80年代)に渡す、地図の置き場所。page.tsx がここに Google マップを作る。 */
type MapProps = {
  mapRef: RefObject<HTMLDivElement | null>;
  mapReady: boolean;
  /** 地図の縮尺: 1点(板の1px)が何mか、近くする・広くするキー(端まで来たら null)。 */
  zoom: { metersPerPx: number; onIn: (() => void) | null; onOut: (() => void) | null };
  /** 前方のオービス(無ければ null)。 */
  orbis: OrbisView | null;
  /** 前方の・いま中を走っている速度取締区間(無ければ null)。 */
  zone: ZoneView | null;
};

/** 地図に出すオービス。 */
export type OrbisView = {
  /** そこまでの距離(m)と、車から見て東・北へ何mか。 */
  distance: number;
  east: number;
  north: number;
  /** warn は 500m 以内(警告)。show は連続区間の次のオービスを 500m より先から出すとき(印だけ静かに)。 */
  level: "show" | "warn";
  /** 制限速度と今の速さ(km/h)。分からなければ null。 */
  limit: number | null;
  speed: number | null;
  /** OpenStreetMap の場所か(出典を書く)。 */
  osm: boolean;
  /** 連続区間なら、何か所目か・全部で何か所か(1か所だけなら null)。 */
  series: { index: number; total: number } | null;
  /** 画面にまだ触れていないので、声が出せない。 */
  muted: boolean;
};

/** 地図に出す速度取締区間。 */
export type ZoneView = {
  /** before は区間の手前(入口まで 500m 以内)、inside は区間の中。 */
  state: "before" | "inside";
  /** before は入口まで、inside は出口までの距離(m)。 */
  distance: number;
  /** 区間の長さ(m)。 */
  length: number;
  /** 入口と出口が、車から見て東・北へ何mか。 */
  entry: { east: number; north: number };
  exit: { east: number; north: number };
  /** 制限速度と今の速さ(km/h)。分からなければ null。 */
  limit: number | null;
  speed: number | null;
  /** 画面にまだ触れていないので、声が出せない。 */
  muted: boolean;
};

/** 線を箱(minX〜maxX・minY〜maxY)の中だけに切る。箱に入らなければ null。 */
const clipLine = (x1: number, y1: number, x2: number, y2: number, minX: number, minY: number, maxX: number, maxY: number) => {
  let from = 0;
  let to = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  for (const [p, q] of [
    [-dx, x1 - minX],
    [dx, maxX - x1],
    [-dy, y1 - minY],
    [dy, maxY - y1],
  ]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > to) return null;
      from = Math.max(from, t);
    } else {
      if (t < from) return null;
      to = Math.min(to, t);
    }
  }
  return { x1: x1 + from * dx, y1: y1 + from * dy, x2: x1 + to * dx, y2: y1 + to * dy };
};

const px2 = (value: number) => Math.round(value * 10) / 10;

/**
 * 地図の上の区間の線の場所(点数)。地図は北が上で、車が窓(w × h)の真ん中。東・北の距離を縮尺で割る。
 * 線は窓の少し外までに切る。札は入口・出口から、走る向きの右へ少し離して置く。round は丸い地図(近未来)。
 */
export const zoneOnMap = (zone: ZoneView, metersPerPx: number, w: number, h: number, round = false) => {
  const cx = w / 2;
  const cy = h / 2;
  const ax = cx + zone.entry.east / metersPerPx;
  const ay = cy - zone.entry.north / metersPerPx;
  const bx = cx + zone.exit.east / metersPerPx;
  const by = cy - zone.exit.north / metersPerPx;
  const length = Math.hypot(bx - ax, by - ay) || 1;
  // 走る向き(入口→出口)と、その右(画面は下が +y なので、北へ走るとき右は +x)。
  const ux = (bx - ax) / length;
  const uy = (by - ay) / length;
  const rightX = -uy;
  const rightY = ux;
  const pad = 30;
  const line = clipLine(ax, ay, bx, by, -pad, -pad, w + pad, h + pad);
  // 札や端の印を出すのは、窓(丸い地図なら円)の内側だけ。
  const inView = (x: number, y: number) =>
    round ? Math.hypot(x - cx, y - cy) < Math.min(cx, cy) - 16 : x > 12 && x < w - 12 && y > 12 && y < h - 12;
  const end = (x: number, y: number) => ({
    x: px2(x),
    y: px2(y),
    shown: inView(x, y),
    // 端の印(線に直角の短い線)と札の場所。
    tick: { x1: px2(x - rightX * 13), y1: px2(y - rightY * 13), x2: px2(x + rightX * 13), y2: px2(y + rightY * 13) },
    flag: { x: px2(x + rightX * 34), y: px2(y + rightY * 34) },
  });
  return {
    line: line && { x1: px2(line.x1), y1: px2(line.y1), x2: px2(line.x2), y2: px2(line.y2) },
    entry: end(ax, ay),
    exit: end(bx, by),
  };
};

/** 速度取締区間の印(盾)。 */
export const ZoneIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 2.8 19.5 5.6v5.6c0 4.6-3.1 8.6-7.5 10-4.4-1.4-7.5-5.4-7.5-10V5.6z" />
    <path d="M8.6 11.6l2.4 2.4 4.4-4.6" />
  </svg>
);

/** 区間の線(地図の絵の一部として、走査線の下に引く): 太い紫の点線と、入口・出口の短い線。 */
function ZoneLine({ zone, metersPerPx }: { zone: ZoneView; metersPerPx: number }) {
  const at = zoneOnMap(zone, metersPerPx, RETRO_CRT.w, RETRO_CRT.h);
  if (!at.line) return null;
  return (
    <svg className="ms-zone-line" viewBox={`0 0 ${RETRO_CRT.w} ${RETRO_CRT.h}`} aria-hidden="true">
      <line className="ms-zone-glow" {...at.line} />
      <line className="ms-zone-road" {...at.line} />
      {at.entry.shown ? <line className="ms-zone-tick" {...at.entry.tick} /> : null}
      {at.exit.shown ? <line className="ms-zone-tick" {...at.exit.tick} /> : null}
    </svg>
  );
}

/**
 * 区間の札: 入口に「取締」・出口に「終」、左上に「取締区間まで 300m」(中は「取締区間 あと 1.2km」)、
 * 右上に制限速度と今の速さ(制限より速いと赤)。オービスの帯が出ているときは、帯の下に下げる
 * (制限と速さは帯に出ているので、区間の分は出さない)。
 */
function ZoneTags({ zone, orbis, metersPerPx }: { zone: ZoneView; orbis: OrbisView | null; metersPerPx: number }) {
  const at = zoneOnMap(zone, metersPerPx, RETRO_CRT.w, RETRO_CRT.h);
  const distance = orbisDistance(zone.distance);
  const over = zone.limit !== null && zone.speed !== null && zone.speed > zone.limit;
  const low = orbis ? " is-low" : "";
  return (
    <>
      {at.entry.shown ? (
        <span className="ms-zone-flag is-entry" style={{ left: at.entry.flag.x, top: at.entry.flag.y }} aria-hidden="true">
          取締
        </span>
      ) : null}
      {at.exit.shown ? (
        <span className="ms-zone-flag is-exit" style={{ left: at.exit.flag.x, top: at.exit.flag.y }} aria-hidden="true">
          終
        </span>
      ) : null}
      <div className={`ms-zone-chip${low}`} role="status">
        <ZoneIcon />
        <b className="ms-zone-name">{zone.state === "before" ? "取締区間まで" : "取締区間 あと"}</b>
        <b className="ms-zone-num">
          {distance.value}
          <small> {distance.unit}</small>
        </b>
        {zone.muted && !orbis ? <small className="ms-zone-muted">画面に触れると声が出ます</small> : null}
      </div>
      {zone.limit !== null && orbis?.limit == null ? (
        <span className={`ms-zone-speed${low}`}>
          <i className="ms-orbis-limit" aria-label={`制限速度 ${zone.limit}`}>
            {zone.limit}
          </i>
          {zone.speed !== null ? (
            <b className={over ? "is-over" : undefined} aria-label={`いまの速さ ${zone.speed}`}>
              {zone.speed}
              <small>km/h</small>
            </b>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/** 帯に出す距離(1km 未満は 10m 単位、1km からは 0.1km 単位。連続区間の途中は 1km より先も出す)。 */
export const orbisDistance = (meters: number) =>
  meters >= 1000
    ? { value: (meters / 1000).toFixed(1), unit: "km" }
    : { value: String(Math.round(meters / 10) * 10), unit: "m" };

/**
 * 地図の上のオービス: 車(真ん中)からの点線と赤いカメラの印、上の帯(距離・制限と今の速さ)。
 * 地図はいつも北が上で車が真ん中なので、東・北の距離を縮尺で割れば印の場所になる。
 */
function OrbisOnMap({ orbis, metersPerPx }: { orbis: OrbisView; metersPerPx: number }) {
  const centerX = RETRO_CRT.w / 2;
  const centerY = RETRO_CRT.h / 2;
  const x = centerX + orbis.east / metersPerPx;
  const y = centerY - orbis.north / metersPerPx;
  const inView = x > 16 && x < RETRO_CRT.w - 16 && y > 16 && y < RETRO_CRT.h - 16;
  const over = orbis.limit !== null && orbis.speed !== null && orbis.speed > orbis.limit;
  const tone = orbis.level === "show" ? "is-show" : over ? "is-over" : "is-warn";
  const distance = orbisDistance(orbis.distance);
  return (
    <>
      <svg className="ms-orbis-line" viewBox={`0 0 ${RETRO_CRT.w} ${RETRO_CRT.h}`} aria-hidden="true">
        <line x1={centerX} y1={centerY} x2={x} y2={y} />
      </svg>
      {inView ? (
        <span className="ms-orbis-mark" style={{ left: x, top: y }} aria-hidden="true">
          <i>
            <svg viewBox="0 0 24 24">
              <rect x="3" y="7" width="13" height="10" rx="1.5" />
              <path d="M16 10.5 21 8v8l-5-2.5" />
              <circle cx="9.5" cy="12" r="2.2" />
            </svg>
          </i>
          <b>ORBIS</b>
        </span>
      ) : null}
      <div className={`ms-orbis-band ${tone}`} role="status">
        <b className="ms-orbis-name">ORBIS</b>
        <b className="ms-orbis-distance">
          {distance.value}
          <small> {distance.unit}</small>
        </b>
        {/* 連続区間: 全部で何か所かと、1 2 3 の札(通ったものは薄く、いまのものを光らせる)。 */}
        {orbis.series ? (
          <span className="ms-orbis-series" aria-label={`オービス連続区間 全${orbis.series.total}か所の${orbis.series.index}か所目`}>
            <i>連続区間 全{orbis.series.total}か所</i>
            <span>
              {Array.from({ length: orbis.series.total }, (_, i) => (
                <b
                  key={i}
                  className={
                    i + 1 === orbis.series?.index ? "is-now" : i + 1 < (orbis.series?.index ?? 0) ? "is-passed" : undefined
                  }
                >
                  {i + 1}
                </b>
              ))}
            </span>
          </span>
        ) : null}
        {orbis.muted ? <small className="ms-orbis-muted">画面に触れると声が出ます</small> : null}
        <span className="ms-orbis-speed">
          {orbis.limit !== null ? (
            <i className="ms-orbis-limit" aria-label={`制限速度 ${orbis.limit}`}>
              {orbis.limit}
            </i>
          ) : null}
          {orbis.speed !== null ? (
            <b aria-label={`いまの速さ ${orbis.speed}`}>{orbis.speed}</b>
          ) : null}
        </span>
        {orbis.osm ? <small className="ms-orbis-credit">© OpenStreetMap</small> : null}
      </div>
    </>
  );
}

/** 縮尺の目盛りの長さの候補(m)。板の上で 100px 以下になる、いちばん長いものを出す。 */
const SCALE_STEPS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const SCALE_MAX_PX = 100;
const mapScale = (metersPerPx: number) => {
  const meters = [...SCALE_STEPS].reverse().find((step) => step / metersPerPx <= SCALE_MAX_PX) ?? SCALE_STEPS[0];
  return { label: meters < 1000 ? `${meters} m` : `${meters / 1000} km`, width: Math.round(meters / metersPerPx) };
};

/**
 * 80年代のテーマの地図の色(Google マップの styles)と寄り。
 * 昔の車の緑の画面: 黒い下地に緑の道。文字は町の名前だけ。
 */
export const RETRO_MAP_LOOK: { zoom: number; background: string; styles: Record<string, unknown>[] } = {
  zoom: 13,
  background: "#021208",
  styles: [
    { elementType: "geometry", stylers: [{ color: "#021208" }] },
    { elementType: "labels", stylers: [{ visibility: "off" }] },
    { featureType: "administrative.locality", elementType: "labels.text", stylers: [{ visibility: "on" }] },
    { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#5dff8a" }] },
    { featureType: "administrative.locality", elementType: "labels.text.stroke", stylers: [{ color: "#021208" }, { weight: 3 }] },
    { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#04190c" }] },
    { featureType: "road.local", elementType: "geometry", stylers: [{ color: "#145c2c" }] },
    { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#2fc35a" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#62ff84" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#03301a" }] },
  ],
};

// --- 共通の道具 ---

const r2 = (value: number) => Math.round(value * 100) / 100;
const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const pad2 = (value: number) => String(value).padStart(2, "0");

type WeatherKind = "clear" | "partly" | "cloud" | "fog" | "rain" | "snow" | "storm";
const weatherKind = (code: number): WeatherKind => {
  if (code === 0) return "clear";
  if (code <= 2) return "partly";
  if (code === 3) return "cloud";
  if (code === 45 || code === 48) return "fog";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  return "cloud";
};
const WEATHER_WORD: Record<WeatherKind, string> = {
  clear: "CLEAR", partly: "PARTLY", cloud: "CLOUDY", fog: "FOG", rain: "RAIN", snow: "SNOW", storm: "STORM",
};
/** 曜日の名前(0 が日曜)。 */
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];
/** 曜日の札の並び(月曜はじまり)。 */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** 板(1024x566)を、置き場所の広さに合わせて拡大・縮小する。 */
function Board({ className, children }: { className: string; children: ReactNode }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) setScale(Math.min(width / BOARD_W, height / BOARD_H));
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={stageRef} className={`ms-stage ${className}`}>
      <div className="ms-board" style={{ transform: `translate(-50%, -50%) scale(${scale})` }}>
        {children}
      </div>
    </div>
  );
}

/** 板の上の、押せる所(見た目は下の絵にあり、ボタンは透明)。 */
function Hit({
  box: [left, top, width, height],
  label,
  onPress,
}: {
  box: [number, number, number, number];
  label: string;
  onPress: (() => void) | null;
}) {
  return (
    <button
      type="button"
      className="ms-hit"
      style={{ left, top, width, height }}
      aria-label={label}
      disabled={!onPress}
      onClick={onPress ?? undefined}
    />
  );
}

// ------------------------------------------------------------------
// 80年代のデジタル: 光る7セグメントの数字と、右に上がる棒の回転計。
// 本物の蛍光表示管のように、光る線は細い芯と広いにじみの二段で光り、前に細い網の目とガラスがある。
// 細かくざらついた黒い樹脂の板に、縁取った3つの表示窓(左・真ん中・右の列)を置く。
// ------------------------------------------------------------------

const RETRO = {
  cyan: "#52ffd6",
  amber: "#ffb02e",
  green: "#7dff4f",
  yellow: "#ffe23a",
  red: "#ff3c3c",
  label: "#7f9a96",
  soft: "#9fb8b3",
  line: "#1c2a2a",
};

/** 7セグメントの各けたで点く線。 */
const SEG_ON: Record<string, string> = {
  "0": "abcdef", "1": "bc", "2": "abged", "3": "abgcd", "4": "fgbc", "5": "afgcd",
  "6": "afgedc", "7": "abc", "8": "abcdefg", "9": "abcdfg", "-": "g", " ": "",
};
/** 1けたの7本の線の形(幅 w・高さ h・太さ t)。 */
const segShapes = (w: number, h: number, t: number) => {
  const g = t * 0.14;
  const x1 = t / 2 + g;
  const x2 = w - t / 2 - g;
  const across = (yc: number): [number, number][] => [
    [x1, yc], [x1 + t / 2, yc - t / 2], [x2 - t / 2, yc - t / 2], [x2, yc], [x2 - t / 2, yc + t / 2], [x1 + t / 2, yc + t / 2],
  ];
  const down = (xc: number, y1: number, y2: number): [number, number][] => [
    [xc, y1], [xc + t / 2, y1 + t / 2], [xc + t / 2, y2 - t / 2], [xc, y2], [xc - t / 2, y2 - t / 2], [xc - t / 2, y1 + t / 2],
  ];
  return {
    a: across(t / 2),
    g: across(h / 2),
    d: across(h - t / 2),
    f: down(t / 2, t / 2 + g, h / 2 - g),
    b: down(w - t / 2, t / 2 + g, h / 2 - g),
    e: down(t / 2, h / 2 + g, h - t / 2 - g),
    c: down(w - t / 2, h / 2 + g, h - t / 2 - g),
  } as Record<string, [number, number][]>;
};
/** 数字の幅(コロンは細く、小数点は幅を取らない)。 */
const segWidth = (text: string, h: number) => {
  const w = h * 0.5;
  const t = h * 0.12;
  const gap = h * 0.17;
  let width = 0;
  for (const ch of text) width += ch === ":" ? t + gap : ch === "." ? 0 : w + gap;
  return width - gap;
};

/** 7セグメントの数字。消えている線もうっすら見せる(本物の表示管と同じ)。液晶のときは glow を切る。 */
const SevenSeg = memo(function SevenSeg({
  text,
  x,
  y,
  h,
  color,
  align = "start",
  glow = true,
  ghost = 0.09,
}: {
  text: string;
  x: number;
  y: number;
  h: number;
  color: string;
  align?: "start" | "end";
  glow?: boolean;
  ghost?: number;
}) {
  const w = h * 0.5;
  const t = h * 0.12;
  const gap = h * 0.17;
  const shapes = segShapes(w, h, t);
  const lit: ReactNode[] = [];
  const dim: ReactNode[] = [];
  const points = (shape: [number, number][], left: number) =>
    shape.map(([px, py]) => `${r2(left + px)},${r2(y + py)}`).join(" ");
  let left = align === "end" ? x - segWidth(text, h) : x;
  [...text].forEach((ch, index) => {
    if (ch === ":") {
      lit.push(
        <rect key={`${index}u`} x={r2(left)} y={r2(y + h * 0.27)} width={r2(t)} height={r2(t)} />,
        <rect key={`${index}l`} x={r2(left)} y={r2(y + h * 0.63)} width={r2(t)} height={r2(t)} />,
      );
      left += t + gap;
      return;
    }
    if (ch === ".") {
      lit.push(<rect key={`${index}p`} x={r2(left - gap / 2 - t / 2)} y={r2(y + h - t)} width={r2(t)} height={r2(t)} />);
      return;
    }
    const on = SEG_ON[ch] ?? "";
    for (const segment of "abcdefg") {
      const node = <polygon key={`${index}${segment}`} points={points(shapes[segment], left)} />;
      if (on.includes(segment)) lit.push(node);
      else dim.push(node);
    }
    left += w + gap;
  });
  const base = r2(y + h);
  return (
    <g transform={`translate(0 ${base}) skewX(-7) translate(0 ${-base})`}>
      <g fill={color} opacity={ghost}>{dim}</g>
      <g fill={color} filter={glow ? "url(#ms-vfd)" : undefined}>{lit}</g>
    </g>
  );
});

/**
 * スマホの画面に出す7セグメントの数字(1つの小さな絵)。車の80年代の数字と同じ形で、
 * 消えている線もうっすら見せる。色は currentColor、光らせ方は CSS で決める。
 */
export function SegNumber({ text, h, className }: { text: string; h: number; className?: string }) {
  // ななめにした分だけ、右を広くとる。
  const width = r2(segWidth(text, h) + h * 0.13);
  return (
    <svg className={className} width={width} height={h} viewBox={`0 0 ${width} ${h}`} aria-hidden="true">
      <SevenSeg text={text} x={0} y={0} h={h} color="currentColor" glow={false} ghost={0.1} />
    </svg>
  );
}

/** 点で描いた天気の絵(12x10)。S は黄、C は白っぽい水色、R は雨、W は雪、. は消えている点。 */
const DOT_ICONS: Record<string, string[]> = {
  sun: [".....SS.....", ".S...SS...S.", "..S......S..", "....SSSS....", "SS.SSSSSS.SS", "SS.SSSSSS.SS", "....SSSS....", "..S......S..", ".S...SS...S.", ".....SS....."],
  moon: ["....SSS.....", "..SSS.......", ".SSS........", ".SS.........", "SSS.........", "SSS.........", ".SS......S..", ".SSS...SSS..", "..SSSSSSS...", "....SSS....."],
  partly: ["..S.........", "S..SS.......", "..SSSS......", ".SSSS.CCC...", "..SS.CCCCC..", "....CCCCCCC.", "...CCCCCCCCC", "...CCCCCCCCC", "....CCCCCCC.", "............"],
  partlyNight: ["..SS........", ".SS.........", "SS..........", "SS....CCC...", ".SS..CCCCC..", "..SSCCCCCCC.", "...CCCCCCCCC", "...CCCCCCCCC", "....CCCCCCC.", "............"],
  cloud: ["............", ".....CCC....", "....CCCCC...", "..CC.CCCCC..", ".CCCCCCCCCC.", "CCCCCCCCCCCC", "CCCCCCCCCCCC", ".CCCCCCCCCC.", "............", "............"],
  rain: [".....CCC....", "....CCCCC...", "..CC.CCCCC..", ".CCCCCCCCCC.", "CCCCCCCCCCCC", ".CCCCCCCCCC.", "............", "..R...R...R.", ".R...R...R..", "R...R...R..."],
  snow: [".....CCC....", "....CCCCC...", "..CC.CCCCC..", ".CCCCCCCCCC.", "CCCCCCCCCCCC", ".CCCCCCCCCC.", "............", ".W...W...W..", "WWW.WWW.WWW.", ".W...W...W.."],
  storm: [".....CCC....", "....CCCCC...", "..CC.CCCCC..", ".CCCCCCCCCC.", "CCCCCCCCCCCC", ".CCCCSSCCCC.", ".....SS.....", "....SSSS....", "......SS....", ".....S......"],
  fog: ["............", "CCCCCCCCCC..", "............", "..CCCCCCCCCC", "............", "CCCCCCCCCC..", "............", "..CCCCCCCCCC", "............", "............"],
};
const DOT_COLORS: Record<string, string> = { S: RETRO.amber, C: "#c8fff3", R: RETRO.cyan, W: "#ffffff" };
const dotIconName = (kind: WeatherKind, isDay: boolean) =>
  kind === "clear" ? (isDay ? "sun" : "moon") : kind === "partly" ? (isDay ? "partly" : "partlyNight") : kind;

const DotIcon = memo(function DotIcon({ name, x, y, size }: { name: string; x: number; y: number; size: number }) {
  const rows = DOT_ICONS[name] ?? DOT_ICONS.cloud;
  const off: ReactNode[] = [];
  const on: ReactNode[] = [];
  rows.forEach((row, j) =>
    [...row].forEach((cell, i) => {
      const rect = (
        <rect
          key={`${i}-${j}`}
          x={r2(x + i * size)}
          y={r2(y + j * size)}
          width={r2(size - 0.8)}
          height={r2(size - 0.8)}
          fill={DOT_COLORS[cell] ?? DOT_COLORS.C}
        />
      );
      if (cell === ".") off.push(rect);
      else on.push(rect);
    }),
  );
  return (
    <g>
      <g opacity={0.07}>{off}</g>
      <g filter="url(#ms-vfd)">{on}</g>
    </g>
  );
});

/** 板の上の文字(小さな説明)。 */
const label = (
  key: string,
  x: number,
  y: number,
  text: string,
  options: { color?: string; size?: number; anchor?: "start" | "middle" | "end"; spacing?: number } = {},
) => (
  <text
    key={key}
    x={x}
    y={y}
    fill={options.color ?? RETRO.label}
    fontSize={options.size ?? 8.5}
    textAnchor={options.anchor ?? "start"}
    letterSpacing={options.spacing ?? 1.6}
  >
    {text}
  </text>
);

/**
 * 真ん中の列: 上に回転計・速さ・平均(仕切りの線だけで分ける)、下に緑の画面(地図)。
 * 枠では囲まず、左右の端(GAUGE_L・GAUGE_R)を地図の端とそろえて、まとまって見せる。
 */
const GAUGE_L = 284;
const GAUGE_R = 753;
/** 回転計の棒の下の位置、速さ・平均の段の上の仕切り、速さと平均の間の仕切り。 */
const TACHO_BOTTOM = 108;
const GAUGE_ROW_TOP = 136;
const GAUGE_SPLIT = 524;
/**
 * 速さ・平均の段は低くして、地図を広くとる。数字の上の位置(GAUGE_ROW_Y)と、速さの数字の高さ。
 * 速さの説明(SPEED・km/h)は数字の右に、平均の2つ(巡航速度・燃費)は横に並べる。
 */
const GAUGE_ROW_Y = 146;
const SPEED_DIGIT_H = 60;
const SPEED_INFO_X = r2(GAUGE_L + segWidth("888", SPEED_DIGIT_H) + 12);
const AVG_CRUISE_X = GAUGE_SPLIT + 12;
const AVG_FUEL_X = AVG_CRUISE_X + 112;
/** 平均の数字の右の端(説明の文字の左から)。その 5 右に単位。 */
const AVG_VALUE_END = 70;

const TACHO_BARS = 32;
const TACHO_PITCH = (GAUGE_R - GAUGE_L - 11) / (TACHO_BARS - 1);
const tachoBar = (index: number) => {
  const rpm = (index + 1) * (RPM_MAX / TACHO_BARS);
  const height = 14 + (index / (TACHO_BARS - 1)) * 46;
  return {
    rpm,
    x: r2(GAUGE_L + index * TACHO_PITCH),
    y: r2(TACHO_BOTTOM - height),
    height: r2(height),
    color: rpm > RPM_RED ? RETRO.red : rpm > 5000 ? RETRO.yellow : RETRO.green,
  };
};
const BAR_SEGMENTS = 18;
/**
 * 緑の画面(地図)は、真ん中の列の下。
 * 右の列の BATTERY より下は、エコ運転の表示と、Google マップの小さな画面(ナビ中に重ねて出す)を
 * 置く箱。DEST・START はその箱の中。
 */
const RETRO_CRT = { x: 284, y: 220, w: 469, h: 322 };
/** Google マップの小さな画面(ナビ中に重ねて出す)を置く、縦長の箱。小さな画面が付く右下の角に寄せる。 */
const RETRO_MAP_BAY = { x: 834, y: 332, w: 166, h: 218 };
/** DEST・START は箱の中に同じ大きさで縦に並べる(ナビ中は、Google マップの小さな画面がこの上に重なる)。 */
const BAY_PAD = 12;
const KEY_GAP = 10;
const KEY_H = (RETRO_MAP_BAY.h - 16 - BAY_PAD - KEY_GAP) / 2;
const RETRO_DEST = { x: RETRO_MAP_BAY.x + BAY_PAD, y: RETRO_MAP_BAY.y + 16, w: RETRO_MAP_BAY.w - BAY_PAD * 2, h: KEY_H };
const RETRO_START = { ...RETRO_DEST, y: RETRO_DEST.y + KEY_H + KEY_GAP };
/**
 * キーの字(スマホの SET・LIST と同じ形): 1段目に印と英語の大きな字、2段目に小さく日本語。
 * DEST のキーは「LIST(目的地を選ぶ)」、START のキーは「START(ナビ開始)」。
 * 英語は等幅の字なので、字の数から幅を出して、印と合わせてキーの真ん中にそろえる。
 */
const KEY_ICON_W = 22;
const KEY_ICON_GAP = 9;
const keyWord = (box: typeof RETRO_DEST, word: string, note: string, color: string, icon: "list" | "go") => {
  const long = word.length > 4;
  const size = long ? 23 : 25;
  const spacing = long ? 1.2 : 3.4;
  const wordW = word.length * (size * 0.6 + spacing) - spacing;
  const left = box.x + (box.w - (KEY_ICON_W + KEY_ICON_GAP + wordW)) / 2;
  const base = box.y + 43;
  // 印の高さの真ん中 = 大きな字(大文字)の高さの真ん中。
  const mid = base - size * 0.36;
  return (
    <g>
      {icon === "list" ? (
        <g stroke={color} strokeWidth="2.6" strokeLinecap="round" fill="none">
          {[-7, 0, 7].map((dy) => (
            <g key={dy}>
              <line x1={left + 1.5} y1={mid + dy} x2={left + 1.6} y2={mid + dy} strokeWidth="3.8" />
              <line x1={left + 7.5} y1={mid + dy} x2={left + KEY_ICON_W} y2={mid + dy} />
            </g>
          ))}
        </g>
      ) : (
        <g stroke={color} strokeWidth="3" fill="none">
          {[0, 1, 2].map((i) => (
            <polyline
              key={i}
              points={`${left + i * 7.5},${mid - 6.5} ${left + i * 7.5 + 6.5},${mid} ${left + i * 7.5},${mid + 6.5}`}
            />
          ))}
        </g>
      )}
      <text x={left + KEY_ICON_W + KEY_ICON_GAP} y={base} fill={color} fontSize={size} fontWeight="700" letterSpacing={spacing}>
        {word}
      </text>
      <text
        x={box.x + box.w / 2}
        y={box.y + 66}
        fill={color}
        fontSize="11.5"
        fontWeight="700"
        textAnchor="middle"
        letterSpacing="1"
        className="ms-ja"
      >
        {note}
      </text>
    </g>
  );
};
/** START の下に出す、今回だけの行き先の名前の長さ(キーの幅に入る数)。長ければ最後を … にする。 */
const START_NOTE_CHARS = 9;
const startNote = (label: string) => {
  const chars = Array.from(label);
  return chars.length > START_NOTE_CHARS ? `${chars.slice(0, START_NOTE_CHARS - 1).join("")}…` : label;
};

/**
 * 今回だけの行き先のとき: START の下の字を行き先の名前にし、キーの上の線に「今回だけ」の札を付ける。
 * 下に消えている「ナビ開始」があるので、名前の所はキーの地の色で隠してから書く。
 */
const OnceStart = ({ label }: { label: string }) => {
  const box = RETRO_START;
  const cx = box.x + box.w / 2;
  return (
    <g className="ms-retro-once">
      <rect x={box.x + 7} y={box.y + 52} width={box.w - 14} height={20} fill="#020403" />
      <rect x={box.x + 7} y={box.y + 52} width={box.w - 14} height={20} fill={RETRO.cyan} fillOpacity=".04" />
      <g filter="url(#ms-vfd)">
        <text x={cx} y={box.y + 66} fill={RETRO.cyan} fontSize="11.5" fontWeight="700" textAnchor="middle" letterSpacing="1" className="ms-ja">
          {startNote(label)}
        </text>
      </g>
      <rect x={cx - 31} y={box.y - 7} width="62" height="15" rx="4" fill={RETRO.amber} />
      <text x={cx} y={box.y + 4.2} fill="#160b00" fontSize="10.5" fontWeight="900" textAnchor="middle" letterSpacing=".6" className="ms-ja">
        今回だけ
      </text>
    </g>
  );
};

/** 右の列の段(上から燃料・水温・電圧)の上の位置。少し詰めて、下に縦長の箱をとる。 */
const RETRO_RIGHT = { fuelBar: 36, range: 66, coolantBar: 130, coolant: 156, battery: 220 };

/** 箱の上と左の空き: エコ運転のランプ(箱の上)と縦の棒(箱の左)。 */
const RETRO_ECO = { x: 778, label: 282, lamp: 322, bar: { x: 786, y: 338, w: 32, h: 208 } };
const ECO_SEGMENTS = 12;
/**
 * この回転数以下で ECO が光る(軽自動車なので 2400)。棒は、そこから 1000 回転下で全部点き、
 * ちょうど ECO_RPM で半分。軽自動車は加速でどうしても回るので、上側はゆるやかに減らし、
 * 2000 回転上(4400)でやっと1つも点かなくなる。
 */
const ECO_RPM = 2400;
const ECO_FULL_RPM = ECO_RPM - 1000;
const ECO_EMPTY_RPM = ECO_RPM + 2000;
/** エコの度合い(0〜1)。走っていて回転数が低いほど大きい。止まっているとき(5 km/h 未満)は 0。 */
const ecoLevel = (rpm: number | null, speed: number | null) => {
  if (rpm === null || speed === null || speed < 5) return 0;
  return rpm <= ECO_RPM
    ? clamp01(0.5 + (0.5 * (ECO_RPM - rpm)) / (ECO_RPM - ECO_FULL_RPM))
    : clamp01(0.5 - (0.5 * (rpm - ECO_RPM)) / (ECO_EMPTY_RPM - ECO_RPM));
};
/** 縦の棒の i 段目(下から)。 */
const ecoSegment = (i: number) => {
  const pitch = RETRO_ECO.bar.h / ECO_SEGMENTS;
  return { x: RETRO_ECO.bar.x, y: r2(RETRO_ECO.bar.y + RETRO_ECO.bar.h - (i + 1) * pitch + (pitch - 13)), width: RETRO_ECO.bar.w, height: 13 };
};
const ecoLamp = (lit: boolean) => (
  <text
    x={RETRO_ECO.x}
    y={RETRO_ECO.lamp}
    fill={RETRO.green}
    opacity={lit ? undefined : 0.12}
    fontSize="30"
    fontWeight="700"
    letterSpacing="6"
    filter={lit ? "url(#ms-vfd)" : undefined}
  >
    ECO
  </text>
);

/** 光る管で縁取ったキー(LIST・START)。外の細い線と、内側の光る線の二重。 */
const retroKey = (key: typeof RETRO_DEST, color: string) => (
  <g>
    <rect x={key.x} y={key.y} width={key.w} height={key.h} rx="12" fill={color} fillOpacity=".04" stroke={color} strokeOpacity=".3" />
    <rect x={key.x + 4} y={key.y + 4} width={key.w - 8} height={key.h - 8} rx="9" fill="none" stroke={color} strokeWidth="1.6" filter="url(#ms-vfd)" />
  </g>
);

/** 表示窓(左の列・真ん中の列・右の列)。 */
const RETRO_WINDOWS = [
  { x: 10, y: 14, w: 248, h: 542 },
  { x: 268, y: 14, w: 496, h: 542 },
  { x: 772, y: 14, w: 242, h: 542 },
];

/** 80年代のデジタルの、動かない絵(樹脂の板と表示窓・仕切り・説明の文字・消えている棒)。 */
const RetroFace = memo(function RetroFace() {
  const labels: ReactNode[] = [
    label("time", 22, 26, "TIME · JST"),
    label("date", 22, 112, "DATE"),
    label("temp", 22, 201, "OUT TEMP"),
    label("world", 22, 363, "WORLD TIME"),
    label("today", 22, 488, "TODAY DISTANCE"),
    label("km", 222, 531, "km", { color: RETRO.green, size: 12, spacing: 0 }),
    label("engine", GAUGE_L, 26, "ENGINE ×1000 r/min"),
    label("speed", SPEED_INFO_X, GAUGE_ROW_Y + 12, "SPEED"),
    label("kmh", SPEED_INFO_X, GAUGE_ROW_Y + SPEED_DIGIT_H - 2, "km/h", { color: RETRO.cyan, size: 15, spacing: 0 }),
    label("cruise", AVG_CRUISE_X, GAUGE_ROW_Y + 12, "AVG CRUISE"),
    label("cruiseUnit", AVG_CRUISE_X + AVG_VALUE_END + 5, GAUGE_ROW_Y + 50, "km/h", { size: 9, spacing: 1 }),
    label("fuel", AVG_FUEL_X, GAUGE_ROW_Y + 12, "AVG FUEL"),
    label("fuelUnit", AVG_FUEL_X + AVG_VALUE_END + 5, GAUGE_ROW_Y + 50, "km/L", { size: 9, spacing: 1 }),
    label("tank", 778, RETRO_RIGHT.fuelBar - 12, "FUEL"),
    label("e", 778, RETRO_RIGHT.fuelBar + 15, "E", { color: RETRO.soft, size: 10, spacing: 0 }),
    label("f", 998, RETRO_RIGHT.fuelBar + 15, "F", { color: RETRO.soft, size: 10, anchor: "end", spacing: 0 }),
    label("range", 778, RETRO_RIGHT.range + 16, "SAFE RANGE"),
    label("rangeUnit", 966, RETRO_RIGHT.range + 29, "km", { color: RETRO.amber, size: 12, spacing: 0 }),
    label("coolant", 778, RETRO_RIGHT.coolantBar - 10, "COOLANT"),
    label("c", 778, RETRO_RIGHT.coolantBar + 15, "C", { color: RETRO.soft, size: 10, spacing: 0 }),
    label("h", 998, RETRO_RIGHT.coolantBar + 15, "H", { color: RETRO.soft, size: 10, anchor: "end", spacing: 0 }),
    label("coolantUnit", 966, RETRO_RIGHT.coolant + 29, "°C", { color: RETRO.cyan, size: 12, spacing: 0 }),
    label("battery", 778, RETRO_RIGHT.battery - 8, "BATTERY"),
    label("voltUnit", 968, RETRO_RIGHT.battery + 29, "V", { color: RETRO.green, size: 12, spacing: 0 }),
    label("eco", RETRO_ECO.x, RETRO_ECO.label, "ECO DRIVE"),
    label("ecoRpm", 1000, RETRO_ECO.lamp - 3, `≤${ECO_RPM} r/min`, { color: RETRO.soft, size: 9, anchor: "end", spacing: 1 }),
  ];
  for (let k = 0; k <= 8; k += 1) {
    labels.push(label(`n${k}`, r2(GAUGE_L + k * 4 * TACHO_PITCH - (k === 8 ? 3 : 0)), 124, String(k), { color: k >= 7 ? RETRO.red : RETRO.soft, size: 10, anchor: "middle", spacing: 0 }));
  }
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <defs>
        {/* 光る線: 細い芯と、広いにじみの二段(本物の蛍光表示管のように) */}
        <filter id="ms-vfd" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="0.9" result="core" />
          <feGaussianBlur in="SourceGraphic" stdDeviation="4.2" result="halo" />
          <feColorMatrix in="halo" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 .8 0" result="haloSoft" />
          <feMerge>
            <feMergeNode in="haloSoft" />
            <feMergeNode in="core" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        {/* 黒い樹脂の細かいざらつきと、表示窓の縁(左上が光る) */}
        <filter id="ms-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency=".85" numOctaves="2" seed="7" />
          <feColorMatrix type="matrix" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 .07 0" />
        </filter>
        <linearGradient id="ms-bezel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#6a7078" />
          <stop offset=".45" stopColor="#1c1e21" />
          <stop offset="1" stopColor="#3c4046" />
        </linearGradient>
        <filter id="ms-window-shade" x="-5%" y="-5%" width="110%" height="110%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
        {RETRO_WINDOWS.map((w, i) => (
          <clipPath key={i} id={`ms-window-${i}`}>
            <rect x={w.x} y={w.y} width={w.w} height={w.h} rx="14" />
          </clipPath>
        ))}
        <linearGradient id="ms-retro-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".06" />
          <stop offset=".28" stopColor="#fff" stopOpacity="0" />
          <stop offset=".72" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".035" />
        </linearGradient>
      </defs>
      <rect width={BOARD_W} height={BOARD_H} fill="#131416" />
      <rect width={BOARD_W} height={BOARD_H} filter="url(#ms-grain)" />
      {/* 表示窓: 光る縁と、黒いガラスの奥へ落ちる影 */}
      {RETRO_WINDOWS.map((w, i) => (
        <g key={i}>
          <rect x={w.x - 2} y={w.y - 2} width={w.w + 4} height={w.h + 4} rx="16" fill="url(#ms-bezel)" />
          <rect x={w.x} y={w.y} width={w.w} height={w.h} rx="14" fill="#030404" />
          <g clipPath={`url(#ms-window-${i})`}>
            <rect x={w.x} y={w.y} width={w.w} height={w.h} rx="14" fill="none" stroke="#000" strokeOpacity=".9" strokeWidth="12" filter="url(#ms-window-shade)" />
          </g>
        </g>
      ))}
      <rect width={BOARD_W} height={BOARD_H} fill="url(#ms-retro-sheen)" />
      {/* 回転計の下と、速さ・平均の間の仕切りの線。地図の画面の縁。 */}
      <g stroke={RETRO.line} strokeWidth="1.2">
        <line x1={GAUGE_L} y1={GAUGE_ROW_TOP} x2={GAUGE_R} y2={GAUGE_ROW_TOP} />
        <line x1={GAUGE_SPLIT} y1={GAUGE_ROW_TOP + 10} x2={GAUGE_SPLIT} y2={GAUGE_ROW_Y + SPEED_DIGIT_H} />
      </g>
      <rect x={RETRO_CRT.x - 3} y={RETRO_CRT.y - 3} width={RETRO_CRT.w + 6} height={RETRO_CRT.h + 6} rx="20" fill="#0b0f0f" stroke="#2a3534" strokeWidth="2" />
      {/* 上の3本の線(80年代の車の飾りの線)。 */}
      <rect y="0" width={BOARD_W} height="2" fill={RETRO.amber} opacity=".9" />
      <rect y="3" width={BOARD_W} height="1.5" fill="#ff6b2b" opacity=".85" />
      <rect y="6" width={BOARD_W} height="1" fill={RETRO.red} opacity=".7" />
      <g stroke={RETRO.line} strokeWidth="1.2">
        <line x1="22" y1="184" x2="248" y2="184" />
        <line x1="22" y1="346" x2="248" y2="346" />
        <line x1="22" y1="470" x2="248" y2="470" />
        <line x1="778" y1={RETRO_RIGHT.coolantBar - 26} x2="1002" y2={RETRO_RIGHT.coolantBar - 26} />
        <line x1="778" y1={RETRO_RIGHT.battery - 24} x2="1002" y2={RETRO_RIGHT.battery - 24} />
        <line x1="778" y1={RETRO_RIGHT.battery + 40} x2="1002" y2={RETRO_RIGHT.battery + 40} />
      </g>
      {/* 曜日の札(今日の札は動く絵の方で点ける)。 */}
      {WEEK_ORDER.map((dayIndex, i) => (
        <g key={dayIndex}>
          <rect x={22 + i * 32} y="150" width="27" height="19" rx="2" fill="none" stroke="#24302f" />
          <text x={35.5 + i * 32} y="164" textAnchor="middle" fontSize="12" fill="#2c3a39" className="ms-ja">
            {WEEKDAYS[dayIndex]}
          </text>
        </g>
      ))}
      {/* 日の出・日の入りの三角。 */}
      <polygon points="150,216 156,206 162,216" fill={RETRO.amber} filter="url(#ms-vfd)" />
      <polygon points="150,228 156,238 162,228" fill={RETRO.amber} opacity=".85" filter="url(#ms-vfd)" />
      {["NOW", "+3H", "+6H"].map((when, i) => label(`w${i}`, 26 + i * 78 + 20, 274, when, { size: 8, anchor: "middle" }))}
      {["CALIF.", "RUSSIA", "CHINA"].map((name, i) => label(`c${i}`, 22, 374 + i * 30 + 15, name, { color: RETRO.soft, size: 10, spacing: 1.4 }))}
      {labels}
      {/* 回転計の棒(消えている方)。 */}
      {Array.from({ length: TACHO_BARS }, (_, i) => {
        const bar = tachoBar(i);
        return <rect key={i} x={bar.x} y={bar.y} width="11" height={bar.height} fill={bar.color} opacity=".1" />;
      })}
      {/* 燃料と水温の棒(消えている方)。 */}
      {Array.from({ length: BAR_SEGMENTS }, (_, i) => (
        <g key={i}>
          <rect x={790 + i * 11} y={RETRO_RIGHT.fuelBar} width="8.5" height="18" fill={i < 3 ? RETRO.red : RETRO.amber} opacity=".1" />
          <rect x={790 + i * 11} y={RETRO_RIGHT.coolantBar} width="8.5" height="18" fill={RETRO.cyan} opacity=".1" />
        </g>
      ))}
      {/* エコ運転のランプと縦の棒(消えている方)。 */}
      {ecoLamp(false)}
      {Array.from({ length: ECO_SEGMENTS }, (_, i) => (
        <rect key={i} {...ecoSegment(i)} fill={RETRO.green} opacity=".1" />
      ))}
      {/* 右下の縦長の箱(Google マップの小さな画面を置く所)。名前の札は上の線に切り込む。中に LIST・START。 */}
      <rect x={RETRO_MAP_BAY.x} y={RETRO_MAP_BAY.y} width={RETRO_MAP_BAY.w} height={RETRO_MAP_BAY.h} rx="16" fill="#020403" stroke="#2a3534" strokeWidth="2" />
      <rect x={RETRO_MAP_BAY.x + 14} y={RETRO_MAP_BAY.y - 5} width="88" height="10" fill="#040506" />
      {label("bay", RETRO_MAP_BAY.x + 19, RETRO_MAP_BAY.y + 3, "GOOGLE MAPS", { size: 8, spacing: 2.4 })}
      {/* LIST(目的地を選ぶ = 地点リストを開く)と START(ナビ開始)。同じ大きさの、光る管で縁取ったキー。 */}
      {retroKey(RETRO_DEST, RETRO.amber)}
      <g filter="url(#ms-vfd)">{keyWord(RETRO_DEST, "LIST", "目的地を選ぶ", RETRO.amber, "list")}</g>
      {retroKey(RETRO_START, RETRO.cyan)}
      {/* START の字(消えている方。点いている方は、行き先があるときだけ上に重ねる)。 */}
      <g opacity=".1">{keyWord(RETRO_START, "START", "ナビ開始", RETRO.cyan, "go")}</g>
    </svg>
  );
});

/**
 * 表示管のガラス(いちばん上に重ねる): 光る線の前の細い網の目と、ななめの映り込み、まわりの暗がり。
 * 網の目は地図と右下の箱の上にはかけない。
 */
const RetroGlass = memo(function RetroGlass() {
  return (
    <svg className="ms-layer ms-static ms-retro-glass" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <defs>
        <pattern id="ms-mesh" width="3.2" height="3.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <path d="M0 0H3.2M0 0V3.2" stroke="#000" strokeWidth=".6" strokeOpacity=".6" />
        </pattern>
        <mask id="ms-mesh-mask">
          <rect width={BOARD_W} height={BOARD_H} fill="#fff" />
          <rect x={RETRO_CRT.x - 4} y={RETRO_CRT.y - 4} width={RETRO_CRT.w + 8} height={RETRO_CRT.h + 8} rx="20" fill="#000" />
          <rect x={RETRO_MAP_BAY.x - 2} y={RETRO_MAP_BAY.y - 2} width={RETRO_MAP_BAY.w + 4} height={RETRO_MAP_BAY.h + 4} rx="16" fill="#000" />
        </mask>
        <linearGradient id="ms-glass-band" x1="0" y1="0" x2="1" y2=".6">
          <stop offset="0" stopColor="#fff" stopOpacity=".08" />
          <stop offset=".3" stopColor="#fff" stopOpacity=".025" />
          <stop offset=".31" stopColor="#fff" stopOpacity=".05" />
          <stop offset=".46" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="ms-vignette" cx=".5" cy=".5" r=".75">
          <stop offset=".6" stopColor="#000" stopOpacity="0" />
          <stop offset="1" stopColor="#000" stopOpacity=".45" />
        </radialGradient>
      </defs>
      <rect width={BOARD_W} height={BOARD_H} fill="url(#ms-mesh)" mask="url(#ms-mesh-mask)" />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#ms-glass-band)" />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#ms-vignette)" />
    </svg>
  );
});

/** 燃料・水温の点いている棒。 */
const litSegments = (value: number, y: number, color: (index: number) => string) =>
  Array.from({ length: Math.round(clamp01(value) * BAR_SEGMENTS) }, (_, i) => (
    <rect key={i} x={790 + i * 11} y={y} width="8.5" height="18" fill={color(i)} />
  ));

/**
 * 地図の窓(80年代とサイバーで同じ): Google マップの置き場所・待ちの字・走査線・自分の車・北の印・オービス・縮尺と ＋・−。
 * badge は窓の左上に出す飾り(オービスの帯が出ると、その下に隠れる)。
 */
function CrtMap({
  data,
  mapRef,
  mapReady,
  zoom,
  orbis,
  zone,
  badge = null,
}: MapProps & { data: ClusterData; badge?: ReactNode }) {
  const scale = mapScale(zoom.metersPerPx);
  return (
    <div className="ms-retro-crt" style={{ left: RETRO_CRT.x, top: RETRO_CRT.y, width: RETRO_CRT.w, height: RETRO_CRT.h }}>
      <div ref={mapRef} className="ms-map-canvas" />
      {zone ? <ZoneLine zone={zone} metersPerPx={zoom.metersPerPx} /> : null}
      {!mapReady ? <span className="ms-retro-crt-wait">MAP LOADING</span> : null}
      <i className="ms-retro-scan" aria-hidden="true" />
      <svg
        className="ms-retro-cursor"
        viewBox="-12 -12 24 24"
        aria-hidden="true"
        style={{ transform: `translate(-50%, -50%) rotate(${Math.round(data.heading ?? 0)}deg)` }}
      >
        <polygon points="0,-10 -8,10 0,5 8,10" />
      </svg>
      {/* 北の印(地図はいつも北が上)。 */}
      <svg className="ms-retro-north" viewBox="-14 -20 28 34" aria-hidden="true">
        <polygon points="0,-19 -5,-11 5,-11" />
        <circle cx="0" cy="2" r="10.5" />
        <text x="0" y="6.5" textAnchor="middle">
          N
        </text>
      </svg>
      {/* 左上の飾りは、速度取締区間の札が出ている間は出さない(同じ場所に出る)。 */}
      {zone ? null : badge}
      {zone ? <ZoneTags zone={zone} orbis={orbis} metersPerPx={zoom.metersPerPx} /> : null}
      {orbis ? <OrbisOnMap orbis={orbis} metersPerPx={zoom.metersPerPx} /> : null}
      {/* 縮尺: 左下に目盛り、右下に近くする(＋)・広くする(−)キー。 */}
      <span className="ms-retro-scale" aria-hidden="true">
        {scale.label}
        <i style={{ width: scale.width }} />
      </span>
      <span className="ms-retro-zoom">
        <button type="button" aria-label="地図を近くする" disabled={!zoom.onIn} onClick={zoom.onIn ?? undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14M12 5v14" />
          </svg>
        </button>
        <button type="button" aria-label="地図を広くする" disabled={!zoom.onOut} onClick={zoom.onOut ?? undefined}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M5 12h14" />
          </svg>
        </button>
      </span>
    </div>
  );
}

/** 板の上の押せる所(80年代とサイバーで同じ場所): 燃費の記録を開く2か所と、LIST・START。 */
function ClusterHits({ data, onFuel, onDest, onStart }: ClusterProps) {
  return (
    <>
      <Hit box={[770, 10, 240, 92]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[AVG_FUEL_X - 8, GAUGE_ROW_TOP + 4, GAUGE_R - AVG_FUEL_X + 8, RETRO_CRT.y - GAUGE_ROW_TOP - 10]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[RETRO_DEST.x, RETRO_DEST.y, RETRO_DEST.w, RETRO_DEST.h]} label="目的地を選ぶ" onPress={onDest} />
      <Hit
        box={[RETRO_START.x, RETRO_START.y, RETRO_START.w, RETRO_START.h]}
        label={
          data.destLabel
            ? `${data.destOnce ? "今回だけの行き先 " : ""}${data.destLabel} へのナビをGoogleマップで開始する`
            : "目的地が設定されていません"
        }
        onPress={onStart}
      />
    </>
  );
}

export function RetroCluster({ data, mapRef, mapReady, zoom, orbis, zone, onFuel, onDest, onStart }: ClusterProps & MapProps) {
  const rpm = data.rpm === null ? null : Math.max(0, data.rpm);
  const weatherSlots = data.weather
    ? [
        { code: data.weather.code, isDay: data.weather.isDay },
        ...data.weather.hours.slice(0, 2).map((hour) => ({ code: hour.code, isDay: hour.isDay })),
      ]
    : [];
  const temperature = data.weather ? String(Math.round(data.weather.temperature)) : "--";
  const eco = ecoLevel(rpm, data.speed);
  return (
    <Board className="ms-retro">
      <RetroFace />
      <CrtMap data={data} mapRef={mapRef} mapReady={mapReady} zoom={zoom} orbis={orbis} zone={zone} />
      <svg className="ms-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
        <SevenSeg text={data.clock} x={22} y={34} h={52} color={RETRO.amber} />
        <SevenSeg text={`${pad2(data.month)}-${pad2(data.day)}`} x={22} y={118} h={22} color={RETRO.amber} />
        {label("year", 118, 137, String(data.year), { size: 10, spacing: 2 })}
        {/* 今日の札(琥珀色の枠)と、出勤日の札(五行の色) */}
        {WEEK_ORDER.map((dayIndex, i) => {
          const today = dayIndex === data.weekday;
          const work = data.workDays.includes(dayIndex);
          if (!today && !work) return null;
          const color = work ? WEEKDAY_ELEMENT_COLORS[dayIndex] : RETRO.amber;
          return (
            <g key={dayIndex} data-work={work ? "1" : undefined}>
              <rect x={22 + i * 32} y="150" width="27" height="19" rx="2" fill={color} fillOpacity={work && today ? 0.32 : 0.16} stroke={today ? RETRO.amber : color} />
              <text x={35.5 + i * 32} y="164" textAnchor="middle" fontSize="12" fill={color} filter="url(#ms-vfd)" className="ms-ja">
                {WEEKDAYS[dayIndex]}
              </text>
            </g>
          );
        })}
        <SevenSeg text={temperature} x={22} y={208} h={40} color={RETRO.cyan} />
        {label("deg", r2(22 + segWidth(temperature, 40) + 10), 246, "°C", { color: RETRO.cyan, size: 15, spacing: 0 })}
        <SevenSeg text={data.sunrise ?? "--:--"} x={168} y={204} h={12} color={RETRO.amber} />
        <SevenSeg text={data.sunset ?? "--:--"} x={168} y={226} h={12} color={RETRO.amber} />
        {weatherSlots.map((slot, i) => {
          const kind = weatherKind(slot.code);
          return (
            <g key={i}>
              <DotIcon name={dotIconName(kind, slot.isDay)} x={26 + i * 78 - 2} y={280} size={3.8} />
              {label(`word${i}`, 26 + i * 78 + 20, 332, WEATHER_WORD[kind], { size: 7.5, anchor: "middle", spacing: 1 })}
            </g>
          );
        })}
        {data.world.map((city, i) => (
          <SevenSeg key={city.name} text={city.time} x={248} y={374 + i * 30} h={18} color={RETRO.cyan} align="end" />
        ))}
        <SevenSeg text={Math.min(9999.9, data.todayKm).toFixed(1)} x={214} y={498} h={34} color={RETRO.green} align="end" />
        <SevenSeg text={rpm === null ? "----" : String(Math.round(rpm))} x={GAUGE_R} y={14} h={16} color={RETRO.cyan} align="end" />
        <g filter="url(#ms-vfd)">
          {Array.from({ length: TACHO_BARS }, (_, i) => {
            const bar = tachoBar(i);
            return rpm !== null && bar.rpm <= rpm ? (
              <rect key={i} x={bar.x} y={bar.y} width="11" height={bar.height} fill={bar.color} />
            ) : null;
          })}
        </g>
        <SevenSeg
          text={data.speed === null ? "---" : String(Math.round(data.speed)).padStart(3, " ")}
          x={GAUGE_L}
          y={GAUGE_ROW_Y}
          h={SPEED_DIGIT_H}
          color={RETRO.cyan}
        />
        <SevenSeg
          text={data.avgCruise === null ? "--" : String(Math.round(data.avgCruise))}
          x={AVG_CRUISE_X + AVG_VALUE_END}
          y={GAUGE_ROW_Y + 24}
          h={28}
          color={RETRO.amber}
          align="end"
        />
        <SevenSeg
          text={data.avgFuel === null ? "--.-" : data.avgFuel.toFixed(1)}
          x={AVG_FUEL_X + AVG_VALUE_END}
          y={GAUGE_ROW_Y + 24}
          h={28}
          color={RETRO.amber}
          align="end"
        />
        <g filter="url(#ms-vfd)">{litSegments(data.fuelPercent / 100, RETRO_RIGHT.fuelBar, (i) => (i < 3 ? RETRO.red : RETRO.amber))}</g>
        <SevenSeg text={String(Math.round(data.rangeKm))} x={960} y={RETRO_RIGHT.range} h={30} color={RETRO.amber} align="end" />
        <g filter="url(#ms-vfd)">
          {data.coolant === null ? null : litSegments((data.coolant - 50) / 70, RETRO_RIGHT.coolantBar, () => RETRO.cyan)}
        </g>
        <SevenSeg text={data.coolant === null ? "--" : String(Math.round(data.coolant))} x={960} y={RETRO_RIGHT.coolant} h={30} color={RETRO.cyan} align="end" />
        <SevenSeg text={data.voltage === null ? "--.-" : data.voltage.toFixed(1)} x={960} y={RETRO_RIGHT.battery} h={30} color={RETRO.green} align="end" />
        {onStart ? (
          <g className="ms-retro-start-lit" filter="url(#ms-vfd)">
            {keyWord(RETRO_START, "START", data.destOnce ? "" : "ナビ開始", RETRO.cyan, "go")}
          </g>
        ) : null}
        {onStart && data.destOnce && data.destLabel ? <OnceStart label={data.destLabel} /> : null}
        {eco >= 0.5 ? ecoLamp(true) : null}
        <g filter="url(#ms-vfd)">
          {Array.from({ length: Math.round(eco * ECO_SEGMENTS) }, (_, i) => (
            <rect key={i} {...ecoSegment(i)} fill={RETRO.green} />
          ))}
        </g>
      </svg>
      <RetroGlass />
      <ClusterHits data={data} onFuel={onFuel} onDest={onDest} onStart={onStart} />
    </Board>
  );
}

// ------------------------------------------------------------------
// 緑一色のサイバーパンク(送ってもらった緑のパックの絵に寄せる)。
// 80年代と同じ配置(地図・LIST・START・押せる所も同じ)で、見た目だけ替える。
// 太い平らな緑の線で囲む(角を切り、左上に見出しの札が一段高く出て、上の辺に太い張り出し)。
// ▶▶▶ と斜線を添え、光らせない。数字と大きな英字は横に広い Michroma、
// 小さな説明は縦長で字の間を広くとった Rajdhani(どちらも app/fonts に入れてある)。
// ------------------------------------------------------------------

const CYBER = {
  on: "#19f59b",
  hi: "#d4ffe8",
  mid: "#14c47c",
  dim: "#11583b",
  ground: "#070908",
  panel: "#020504",
  ink: "#00170c",
};
/** 消えている棒や札の濃さ。 */
const CYBER_OFF = 0.13;

/** サイバーの地図の色(Google マップの styles): 黒い下地に、明るさの違う緑の道。字は町の名前だけ。 */
export const CYBER_MAP_LOOK: typeof RETRO_MAP_LOOK = {
  zoom: RETRO_MAP_LOOK.zoom,
  background: "#010805",
  styles: [
    { elementType: "geometry", stylers: [{ color: "#010805" }] },
    { elementType: "labels", stylers: [{ visibility: "off" }] },
    { featureType: "administrative.locality", elementType: "labels.text", stylers: [{ visibility: "on" }] },
    { featureType: "administrative.locality", elementType: "labels.text.fill", stylers: [{ color: "#19f59b" }] },
    { featureType: "administrative.locality", elementType: "labels.text.stroke", stylers: [{ color: "#010805" }, { weight: 3 }] },
    { featureType: "administrative", elementType: "geometry", stylers: [{ visibility: "off" }] },
    { featureType: "poi", stylers: [{ visibility: "off" }] },
    { featureType: "transit", stylers: [{ visibility: "off" }] },
    { featureType: "landscape.man_made", elementType: "geometry", stylers: [{ color: "#03140b" }] },
    { featureType: "road.local", elementType: "geometry", stylers: [{ color: "#0d5234" }] },
    { featureType: "road.arterial", elementType: "geometry", stylers: [{ color: "#13a568" }] },
    { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#19f59b" }] },
    { featureType: "water", elementType: "geometry", stylers: [{ color: "#032a1b" }] },
  ],
};

/** 速さの数字の右の端と、その右の説明(SPEED・km/h)は 10 右から。回転数の字の下の位置(見出しの札の下)。 */
const SPEED_X = 466;
const CY_RPM_Y = 46;

/** 3つの窓の左上の見出しの札(字と札の幅)。 */
const CYBER_TABS = [
  { text: "TIME · JST", w: 100 },
  { text: "ENGINE ×1000 r/min", w: 156 },
  { text: "FUEL", w: 64 },
];
/** 角を切る大きさと、見出しの札の高さ(札の下で、上の辺が一段下がる)。 */
const CY_CUT = 12;
const CY_TAB_H = 14;
/** パックの枠の形: 左上に見出しの札(一段高い)、ほかの角は切る。step なら下の辺の左が一段上がる。 */
const cyberFrame = (box: { x: number; y: number; w: number; h: number }, tabW: number, step: boolean) => {
  const { x, y } = box;
  const r = x + box.w;
  const b = y + box.h;
  const c = CY_CUT;
  const t = CY_TAB_H;
  const bottom = step ? `H${x + 104}L${x + 94} ${b - 10}H${x + c}L${x} ${b - 10 - c}` : `H${x + c}L${x} ${b - c}`;
  return `M${x} ${y + c}L${x + c} ${y}H${x + tabW}L${x + tabW + t} ${y + t}H${r - c}L${r} ${y + t + c}V${b - c}L${r - c} ${b}${bottom}Z`;
};
/** 左上と右下の角を切った四角。 */
const cyberCut = (x: number, y: number, w: number, h: number, c: number) =>
  `M${x + c} ${y}H${x + w}V${y + h - c}L${x + w - c} ${y + h}H${x}V${y + c}Z`;
/** ▶▶▶(右向きの三角が3つ)。 */
const CyberArrows = ({ x, y, size }: { x: number; y: number; size: number }) => (
  <g fill={CYBER.on}>
    {[0, 1, 2].map((i) => {
      const left = x + i * (size + 2);
      return <polygon key={i} points={`${left},${r2(y - size / 1.6)} ${left + size},${y} ${left},${r2(y + size / 1.6)}`} />;
    })}
  </g>
);
/** 斜線の帯(//////)。 */
const CyberHatch = ({ x, y, count, h }: { x: number; y: number; count: number; h: number }) => (
  <g fill={CYBER.on}>
    {Array.from({ length: count }, (_, i) => (
      <polygon
        key={i}
        points={`${r2(x + i * 6 + h * 0.6)},${y} ${r2(x + i * 6 + h * 0.6 + 3)},${y} ${x + i * 6 + 3},${y + h} ${x + i * 6},${y + h}`}
      />
    ))}
  </g>
);
/** 太い張り出し(辺に沿った緑の台形)。 */
const cyberLedge = (x1: number, x2: number, y: number) => `${x1},${y} ${x2},${y} ${x2 - 5},${y + 5} ${x1 + 5},${y + 5}`;
/** 回転計の1本(右に傾けた細長い四角)。 */
const cyberTachoPoints = (bar: ReturnType<typeof tachoBar>) =>
  `${r2(bar.x + 3)},${bar.y} ${r2(bar.x + 11)},${bar.y} ${r2(bar.x + 8)},${TACHO_BOTTOM} ${bar.x},${TACHO_BOTTOM}`;
/** 燃料・水温の棒の i 本目(傾けた四角)。 */
const cyberSegPoints = (i: number, y: number) => {
  const x = 790 + i * 11;
  return `${x + 2.5},${y} ${x + 9},${y} ${x + 6.5},${y + 18} ${x},${y + 18}`;
};
/** エコ運転の縦の棒の i 段目(上向きの山形)。 */
const cyberEcoPoints = (i: number) => {
  const { x, w } = RETRO_ECO.bar;
  const { y } = ecoSegment(i);
  return `${x},${r2(y + 13)} ${x + w / 2},${r2(y + 4)} ${x + w},${r2(y + 13)} ${x + w},${r2(y + 8)} ${x + w / 2},${r2(y - 1)} ${x},${r2(y + 8)}`;
};
/** 曜日の札の形(左上と右下を切る)。 */
const cyberDayTag = (i: number) => cyberCut(22 + i * 32, 150, 27, 19, 5);

/** 板の上の字。num は数字の字(Michroma)、それ以外は説明の字(Rajdhani)。 */
const cyText = (
  key: string,
  x: number,
  y: number,
  text: string,
  options: { size?: number; anchor?: "start" | "middle" | "end"; fill?: string; spacing?: number; num?: boolean; opacity?: number } = {},
) => (
  <text
    key={key}
    x={x}
    y={y}
    className={options.num ? "cy-num" : undefined}
    fill={options.fill ?? CYBER.on}
    fontSize={options.size ?? 10}
    textAnchor={options.anchor ?? "start"}
    letterSpacing={options.spacing ?? (options.num ? 0.5 : 2.4)}
    opacity={options.opacity}
  >
    {text}
  </text>
);

/** LIST・START の英語の幅(Michroma で字の大きさの何倍か)。印と合わせてキーの真ん中にそろえる。 */
const CY_KEY_WORD_EM: Record<string, number> = { LIST: 3.08, START: 4.84 };
const CY_KEY_SIZE = 17;
/** キーの字: 1段目に印と英語、2段目に小さく日本語。 */
const cyberKeyWord = (box: typeof RETRO_DEST, word: string, note: string, icon: "list" | "go") => {
  const wordW = (CY_KEY_WORD_EM[word] ?? word.length) * CY_KEY_SIZE;
  const left = r2(box.x + (box.w - (KEY_ICON_W + KEY_ICON_GAP + wordW)) / 2);
  const base = box.y + 42;
  const mid = r2(base - CY_KEY_SIZE * 0.38);
  return (
    <g>
      {icon === "list" ? (
        <g stroke={CYBER.on} strokeWidth="2.6" fill="none">
          {[-7, 0, 7].map((dy) => (
            <g key={dy}>
              <line x1={left + 1} y1={mid + dy} x2={left + 3.5} y2={mid + dy} />
              <line x1={left + 7.5} y1={mid + dy} x2={left + KEY_ICON_W} y2={mid + dy} />
            </g>
          ))}
        </g>
      ) : (
        <g fill={CYBER.on}>
          {[0, 1, 2].map((i) => {
            const x = left + i * 7.5;
            return <polygon key={i} points={`${x},${mid - 7} ${x + 4},${mid - 7} ${x + 10},${mid} ${x + 4},${mid + 7} ${x},${mid + 7} ${x + 6},${mid}`} />;
          })}
        </g>
      )}
      {cyText("word", left + KEY_ICON_W + KEY_ICON_GAP, base, word, { size: CY_KEY_SIZE, num: true, spacing: 1 })}
      <text x={box.x + box.w / 2} y={box.y + 66} fill={CYBER.on} fontSize="11.5" fontWeight="700" textAnchor="middle" letterSpacing="1" className="ms-ja">
        {note}
      </text>
    </g>
  );
};
/** LIST・START のキーの枠: 角を切った太い線、上の辺に張り出し、右下に ▶▶▶。 */
const cyberKey = (box: typeof RETRO_DEST, fill: number) => (
  <g>
    <path d={cyberCut(box.x, box.y, box.w, box.h, 12)} fill={CYBER.on} fillOpacity={fill} stroke={CYBER.on} strokeWidth="2" />
    <polygon points={cyberLedge(box.x + 16, box.x + 60, box.y + 1)} fill={CYBER.on} />
    <CyberArrows x={box.x + box.w - 30} y={box.y + box.h - 10} size={5} />
  </g>
);

/**
 * 今回だけの行き先のとき: START の下の字を行き先の名前にし、キーの上の辺に「今回だけ」の緑の札を付ける。
 * 下に消えている「ナビ開始」があるので、名前の所はキーの地の色で隠してから書く。
 */
const CyberOnceStart = ({ label }: { label: string }) => {
  const box = RETRO_START;
  const cx = box.x + box.w / 2;
  return (
    <g className="ms-cyber-once">
      <rect x={box.x + 7} y={box.y + 52} width={box.w - 14} height={20} fill="#000" />
      <rect x={box.x + 7} y={box.y + 52} width={box.w - 14} height={20} fill={CYBER.on} fillOpacity=".1" />
      <text x={cx} y={box.y + 66} fill={CYBER.on} fontSize="11.5" fontWeight="700" textAnchor="middle" letterSpacing="1" className="ms-ja">
        {startNote(label)}
      </text>
      <polygon points={`${cx - 36},${box.y - 7} ${cx + 36},${box.y - 7} ${cx + 31},${box.y + 8} ${cx - 31},${box.y + 8}`} fill={CYBER.on} />
      <text x={cx} y={box.y + 4.5} fill={CYBER.ink} fontSize="10.5" fontWeight="900" textAnchor="middle" letterSpacing=".6" className="ms-ja">
        今回だけ
      </text>
    </g>
  );
};

/** 点で描いた天気の絵(サイバーは緑だけ。雲は少し暗い緑)。 */
const CyberDotIcon = memo(function CyberDotIcon({ name, x, y, size }: { name: string; x: number; y: number; size: number }) {
  const rows = DOT_ICONS[name] ?? DOT_ICONS.cloud;
  const off: ReactNode[] = [];
  const on: ReactNode[] = [];
  rows.forEach((row, j) =>
    [...row].forEach((cell, i) => {
      const rect = (
        <rect
          key={`${i}-${j}`}
          x={r2(x + i * size)}
          y={r2(y + j * size)}
          width={r2(size - 0.8)}
          height={r2(size - 0.8)}
          fill={cell === "C" ? CYBER.mid : CYBER.on}
        />
      );
      if (cell === ".") off.push(rect);
      else on.push(rect);
    }),
  );
  return (
    <g>
      <g opacity={0.08}>{off}</g>
      <g>{on}</g>
    </g>
  );
});

/** エコ運転のランプ(ECO)。 */
const cyberEcoLamp = (lit: boolean) => cyText("ecoLamp", RETRO_ECO.x, RETRO_ECO.lamp, "ECO", { size: 22, num: true, spacing: 3, opacity: lit ? undefined : CYBER_OFF });

/** サイバーの、動かない絵(枠・見出し・仕切り・説明の字・消えている棒)。 */
const CyberFace = memo(function CyberFace() {
  const label = (key: string, x: number, y: number, text: string) => cyText(key, x, y, text);
  const unit = (key: string, x: number, y: number, text: string, size = 14) => cyText(key, x, y, text, { size, spacing: 0.5 });
  const divider = (key: string, x1: number, x2: number, y: number) => (
    <g key={key}>
      <rect x={x1} y={y - 2} width="24" height="4" fill={CYBER.on} />
      <line x1={x1 + 30} y1={y} x2={x2} y2={y} stroke={CYBER.on} strokeOpacity=".45" strokeWidth="1.5" />
    </g>
  );
  const texts: ReactNode[] = [
    label("date", 22, 112, "DATE"),
    label("temp", 22, 202, "OUT TEMP"),
    label("world", 22, 364, "WORLD TIME"),
    label("today", 22, 489, "TODAY DISTANCE"),
    unit("km", 220, 531, "km"),
    unit("deg", 122, 245, "°C", 16),
    label("cruise", AVG_CRUISE_X, GAUGE_ROW_Y + 12, "AVG CRUISE"),
    label("fuel", AVG_FUEL_X, GAUGE_ROW_Y + 12, "AVG FUEL"),
    cyText("speed", SPEED_X + 10, GAUGE_ROW_Y + 14, "SPEED", { spacing: 1.8 }),
    unit("kmh", SPEED_X + 10, GAUGE_ROW_Y + SPEED_DIGIT_H - 2, "km/h", 15),
    unit("cruiseUnit", AVG_CRUISE_X + AVG_VALUE_END + 5, GAUGE_ROW_Y + 51, "km/h", 11),
    unit("fuelUnit", AVG_FUEL_X + AVG_VALUE_END + 4, GAUGE_ROW_Y + 51, "km/L", 11),
    cyText("rpm", GAUGE_R - 60, CY_RPM_Y, "RPM", { anchor: "end", spacing: 1.6 }),
    cyText("e", 778, RETRO_RIGHT.fuelBar + 14, "E", { size: 11, fill: CYBER.mid, spacing: 0 }),
    cyText("f", 1000, RETRO_RIGHT.fuelBar + 14, "F", { size: 11, fill: CYBER.mid, spacing: 0, anchor: "end" }),
    label("range", 778, RETRO_RIGHT.range + 18, "SAFE RANGE"),
    unit("rangeUnit", 966, RETRO_RIGHT.range + 31, "km"),
    label("coolant", 778, RETRO_RIGHT.coolantBar - 9, "COOLANT"),
    cyText("c", 778, RETRO_RIGHT.coolantBar + 14, "C", { size: 11, fill: CYBER.mid, spacing: 0 }),
    cyText("h", 1000, RETRO_RIGHT.coolantBar + 14, "H", { size: 11, fill: CYBER.mid, spacing: 0, anchor: "end" }),
    unit("coolantUnit", 966, RETRO_RIGHT.coolant + 29, "°C"),
    label("battery", 778, RETRO_RIGHT.battery - 7, "BATTERY"),
    unit("voltUnit", 968, RETRO_RIGHT.battery + 29, "V"),
    label("eco", RETRO_ECO.x, RETRO_ECO.label, "ECO DRIVE"),
    cyText("ecoRpm", 1000, RETRO_ECO.lamp - 3, `≤${ECO_RPM} r/min`, { size: 11, anchor: "end", spacing: 0.6 }),
  ];
  ["NOW", "+3H", "+6H"].forEach((when, i) => texts.push(cyText(`w${i}`, 46 + i * 78, 274, when, { anchor: "middle", spacing: 1.4 })));
  ["CALIF.", "RUSSIA", "CHINA"].forEach((name, i) =>
    texts.push(cyText(`c${i}`, 22, 390 + i * 30, name, { size: 12, fill: CYBER.mid, spacing: 1.8 })),
  );
  for (let k = 0; k <= 8; k += 1) {
    texts.push(
      cyText(`n${k}`, r2(GAUGE_L + k * 4 * TACHO_PITCH - (k === 8 ? 3 : 0) + 4), 124, String(k), {
        size: 11,
        anchor: "middle",
        spacing: 0,
        fill: k >= 7 ? CYBER.hi : CYBER.on,
      }),
    );
  }
  const bay = RETRO_MAP_BAY;
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <defs>
        <pattern id="cy-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="2.2" height="6" fill={CYBER.on} opacity=".28" />
        </pattern>
      </defs>
      <rect width={BOARD_W} height={BOARD_H} fill={CYBER.ground} />
      {/* 3つの窓: 太い線の枠(左上に見出しの札)、上の辺の張り出し、左の辺の太い所。左の窓だけ右下に ▶▶▶ と斜線。 */}
      {RETRO_WINDOWS.map((w, i) => {
        const right = w.x + w.w;
        const bottom = w.y + w.h;
        return (
          <g key={i}>
            <path d={cyberFrame(w, CYBER_TABS[i].w, i === 0)} fill={CYBER.panel} stroke={CYBER.on} strokeWidth="2" />
            {cyText(`tab${i}`, w.x + 16, w.y + 11, CYBER_TABS[i].text)}
            <polygon points={cyberLedge(right - CY_CUT - 74, right - CY_CUT - 8, w.y + CY_TAB_H)} fill={CYBER.on} />
            <polygon points={`${w.x},${w.y + 150} ${w.x + 5},${w.y + 155} ${w.x + 5},${w.y + 215} ${w.x},${w.y + 220}`} fill={CYBER.on} />
            {i === 0 ? (
              <>
                <CyberArrows x={right - 44} y={bottom - 13} size={7} />
                <CyberHatch x={w.x + 116} y={bottom - 9} count={7} h={6} />
              </>
            ) : null}
          </g>
        );
      })}
      {divider("d1", 22, 248, 184)}
      {divider("d2", 22, 248, 346)}
      {divider("d3", 22, 248, 470)}
      {divider("d4", 778, 1002, RETRO_RIGHT.coolantBar - 26)}
      {divider("d5", 778, 1002, RETRO_RIGHT.battery - 24)}
      {divider("d6", 778, 1002, RETRO_RIGHT.battery + 40)}
      {divider("d7", GAUGE_L, GAUGE_R, GAUGE_ROW_TOP)}
      <line x1={GAUGE_SPLIT} y1={GAUGE_ROW_TOP + 10} x2={GAUGE_SPLIT} y2={GAUGE_ROW_Y + SPEED_DIGIT_H} stroke={CYBER.on} strokeOpacity=".45" strokeWidth="1.5" />
      {/* 地図の窓の縁(地図そのものは CrtMap)。 */}
      <path d={cyberCut(RETRO_CRT.x - 4, RETRO_CRT.y - 4, RETRO_CRT.w + 8, RETRO_CRT.h + 8, 16)} fill="#000" stroke={CYBER.on} strokeWidth="2" />
      {/* 曜日の札(今日と出勤日は動く絵の方で点ける)。 */}
      {WEEK_ORDER.map((dayIndex, i) => (
        <g key={dayIndex}>
          <path d={cyberDayTag(i)} fill="none" stroke={CYBER.dim} strokeWidth="1.2" />
          <text x={35.5 + i * 32} y="164" textAnchor="middle" fontSize="12" fill={CYBER.dim} className="ms-ja">
            {WEEKDAYS[dayIndex]}
          </text>
        </g>
      ))}
      {/* 日の出・日の入りの三角。 */}
      <polygon points="150,216 156,206 162,216" fill={CYBER.on} />
      <polygon points="150,228 156,238 162,228" fill={CYBER.mid} />
      {texts}
      {/* 回転計の棒(消えている方)。赤の所(6500回転より上)は斜線。 */}
      {Array.from({ length: TACHO_BARS }, (_, i) => {
        const bar = tachoBar(i);
        return bar.rpm > RPM_RED ? (
          <polygon key={i} points={cyberTachoPoints(bar)} fill="url(#cy-hatch)" stroke={CYBER.on} strokeOpacity=".5" />
        ) : (
          <polygon key={i} points={cyberTachoPoints(bar)} fill={CYBER.on} opacity={CYBER_OFF} />
        );
      })}
      {/* 燃料と水温の棒(消えている方)。燃料の左の3本(空に近い所)は斜線。 */}
      {Array.from({ length: BAR_SEGMENTS }, (_, i) => (
        <g key={i}>
          {i < 3 ? (
            <polygon points={cyberSegPoints(i, RETRO_RIGHT.fuelBar)} fill="url(#cy-hatch)" stroke={CYBER.on} strokeOpacity=".4" />
          ) : (
            <polygon points={cyberSegPoints(i, RETRO_RIGHT.fuelBar)} fill={CYBER.on} opacity={CYBER_OFF} />
          )}
          <polygon points={cyberSegPoints(i, RETRO_RIGHT.coolantBar)} fill={CYBER.on} opacity={CYBER_OFF} />
        </g>
      ))}
      {cyberEcoLamp(false)}
      {Array.from({ length: ECO_SEGMENTS }, (_, i) => (
        <polygon key={i} points={cyberEcoPoints(i)} fill={CYBER.on} opacity={CYBER_OFF} />
      ))}
      {/* 右下の箱(Google マップの小さな画面を置く所): 左上に「GOOGLE MAPS」の札。中に LIST・START。 */}
      <path
        d={`M${bay.x} ${bay.y + 10}L${bay.x + 10} ${bay.y}H${bay.x + 92}L${bay.x + 102} ${bay.y + 10}H${bay.x + bay.w - 10}L${bay.x + bay.w} ${bay.y + 20}V${bay.y + bay.h - 10}L${bay.x + bay.w - 10} ${bay.y + bay.h}H${bay.x}Z`}
        fill="#000"
        stroke={CYBER.on}
        strokeWidth="2"
      />
      {cyText("bay", bay.x + 13, bay.y + 9, "GOOGLE MAPS", { size: 8.5, spacing: 1.6 })}
      {cyberKey(RETRO_DEST, 0.04)}
      {cyberKeyWord(RETRO_DEST, "LIST", "目的地を選ぶ", "list")}
      {cyberKey(RETRO_START, 0.1)}
      {/* START の字(消えている方。点いている方は、行き先があるときだけ上に重ねる)。 */}
      <g opacity={CYBER_OFF}>{cyberKeyWord(RETRO_START, "START", "ナビ開始", "go")}</g>
    </svg>
  );
});

export function CyberCluster({ data, mapRef, mapReady, zoom, orbis, zone, onFuel, onDest, onStart }: ClusterProps & MapProps) {
  const rpm = data.rpm === null ? null : Math.max(0, data.rpm);
  const weatherSlots = data.weather
    ? [
        { code: data.weather.code, isDay: data.weather.isDay },
        ...data.weather.hours.slice(0, 2).map((hour) => ({ code: hour.code, isDay: hour.isDay })),
      ]
    : [];
  const temperature = data.weather ? String(Math.round(data.weather.temperature)) : "--";
  const eco = ecoLevel(rpm, data.speed);
  const num = (key: string, x: number, y: number, text: string, size: number, anchor: "start" | "end" = "start", fill?: string) =>
    cyText(key, x, y, text, { size, anchor, num: true, fill });
  return (
    <Board className="ms-cyber">
      <CyberFace />
      <CrtMap
        data={data}
        mapRef={mapRef}
        mapReady={mapReady}
        zoom={zoom}
        orbis={orbis}
        zone={zone}
        badge={
          <svg className="ms-cy-loc" viewBox="0 0 112 22" aria-hidden="true">
            <path d="M1 1H111L104 21H1Z" fill="#000a05" fillOpacity=".88" stroke={CYBER.on} strokeWidth="1.5" />
            {cyText("loc", 8, 15, "LOCATION", { size: 11 })}
            {[80, 87, 94].map((x) => (
              <rect key={x} x={x} y="7.5" width="4" height="7" fill={CYBER.on} />
            ))}
          </svg>
        }
      />
      <svg className="ms-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
        {num("clock", 22, 84, data.clock, 54)}
        {num("date", 22, 140, `${pad2(data.month)}-${pad2(data.day)}`, 22)}
        {cyText("year", 132, 140, String(data.year), { size: 12, spacing: 2 })}
        {/* 今日の札(緑に塗る)と、出勤日の札(緑の枠と下の線) */}
        {WEEK_ORDER.map((dayIndex, i) => {
          const today = dayIndex === data.weekday;
          const work = data.workDays.includes(dayIndex);
          if (!today && !work) return null;
          return (
            <g key={dayIndex} data-work={work ? "1" : undefined}>
              <path d={cyberDayTag(i)} fill={today ? CYBER.on : "none"} stroke={CYBER.on} strokeWidth="1.5" />
              <text x={35.5 + i * 32} y="164" textAnchor="middle" fontSize="12" fontWeight="900" fill={today ? CYBER.ink : CYBER.on} className="ms-ja">
                {WEEKDAYS[dayIndex]}
              </text>
              {work ? <rect x={33.5 + i * 32} y="172" width="4" height="2" fill={CYBER.on} /> : null}
            </g>
          );
        })}
        {num("temp", 116, 246, temperature, 34, "end")}
        {num("sunrise", 168, 216, data.sunrise ?? "--:--", 11)}
        {num("sunset", 168, 238, data.sunset ?? "--:--", 11, "start", CYBER.mid)}
        {weatherSlots.map((slot, i) => {
          const kind = weatherKind(slot.code);
          return (
            <g key={i}>
              <CyberDotIcon name={dotIconName(kind, slot.isDay)} x={26 + i * 78 - 2} y={281} size={3.8} />
              {cyText(`word${i}`, 46 + i * 78, 334, WEATHER_WORD[kind], { size: 9.5, anchor: "middle", spacing: 1.2 })}
            </g>
          );
        })}
        {data.world.map((city, i) => num(`world${i}`, 248, 391 + i * 30, city.time, 17, "end"))}
        {num("todayKm", 212, 532, Math.min(9999.9, data.todayKm).toFixed(1), 30, "end")}
        {num("rpm", GAUGE_R, CY_RPM_Y, rpm === null ? "----" : String(Math.round(rpm)), 13, "end")}
        {Array.from({ length: TACHO_BARS }, (_, i) => {
          const bar = tachoBar(i);
          return rpm !== null && bar.rpm <= rpm ? (
            <polygon key={i} points={cyberTachoPoints(bar)} fill={bar.rpm > RPM_RED ? CYBER.hi : CYBER.on} />
          ) : null;
        })}
        {num("speed", SPEED_X, GAUGE_ROW_Y + SPEED_DIGIT_H, data.speed === null ? "---" : String(Math.round(data.speed)), 64, "end")}
        {num("cruise", AVG_CRUISE_X + AVG_VALUE_END, GAUGE_ROW_Y + 53, data.avgCruise === null ? "--" : String(Math.round(data.avgCruise)), 22, "end")}
        {num("avgFuel", AVG_FUEL_X + AVG_VALUE_END, GAUGE_ROW_Y + 53, data.avgFuel === null ? "--.-" : data.avgFuel.toFixed(1), 20, "end")}
        {Array.from({ length: Math.round(clamp01(data.fuelPercent / 100) * BAR_SEGMENTS) }, (_, i) => (
          <polygon key={i} points={cyberSegPoints(i, RETRO_RIGHT.fuelBar)} fill={CYBER.on} />
        ))}
        {num("range", 960, RETRO_RIGHT.range + 32, String(Math.round(data.rangeKm)), 26, "end")}
        {data.coolant === null
          ? null
          : Array.from({ length: Math.round(clamp01((data.coolant - 50) / 70) * BAR_SEGMENTS) }, (_, i) => (
              <polygon key={i} points={cyberSegPoints(i, RETRO_RIGHT.coolantBar)} fill={CYBER.on} />
            ))}
        {num("coolant", 960, RETRO_RIGHT.coolant + 30, data.coolant === null ? "--" : String(Math.round(data.coolant)), 26, "end")}
        {num("volt", 960, RETRO_RIGHT.battery + 30, data.voltage === null ? "--.-" : data.voltage.toFixed(1), 26, "end")}
        {onStart ? <g className="ms-cyber-start-lit">{cyberKeyWord(RETRO_START, "START", data.destOnce ? "" : "ナビ開始", "go")}</g> : null}
        {onStart && data.destOnce && data.destLabel ? <CyberOnceStart label={data.destLabel} /> : null}
        {eco >= 0.5 ? cyberEcoLamp(true) : null}
        {Array.from({ length: Math.round(eco * ECO_SEGMENTS) }, (_, i) => (
          <polygon key={i} points={cyberEcoPoints(i)} fill={CYBER.on} />
        ))}
      </svg>
      <ClusterHits data={data} onFuel={onFuel} onDest={onDest} onStart={onStart} />
    </Board>
  );
}

/**
 * 燃費の画面(80年代・サイバーのテーマのとき)の、平均燃費の枠に出す棒グラフ: 給油ごとの燃費(左が古く、右が新しい)。
 * 高さは出した中のいちばん低い・高い燃費に合わせる。サイバーは右に傾けた緑の棒(いちばん新しいものだけ濃く)、
 * 80年代は光る棒で、出した中で燃費の良い方から緑・黄・赤。2回分より少なければ出さない。
 */
export function FuelTrend({ values, look }: { values: number[]; look: "retro" | "cyber" }) {
  if (values.length < 2) return null;
  const w = 92;
  const h = 38;
  const low = Math.min(...values) - 1;
  const high = Math.max(...values) + 0.3;
  const pitch = w / values.length;
  return (
    <svg className="fuel-trend" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      {values.map((value, i) => {
        const rank = (value - low) / (high - low);
        const bar = r2(6 + rank * (h - 8));
        const x = r2(i * pitch);
        const opacity = i === values.length - 1 ? 1 : look === "cyber" ? 0.55 : 0.6;
        if (look === "cyber") {
          return (
            <polygon
              key={i}
              points={`${r2(x + 3)},${r2(h - bar)} ${r2(x + pitch - 1)},${r2(h - bar)} ${r2(x + pitch - 4)},${h} ${x},${h}`}
              fill={CYBER.on}
              opacity={opacity}
            />
          );
        }
        const color = rank > 0.66 ? RETRO.green : rank > 0.33 ? RETRO.yellow : RETRO.red;
        return (
          <rect
            key={i}
            x={r2(x + 1)}
            y={r2(h - bar)}
            width={r2(pitch - 3)}
            height={bar}
            fill={color}
            opacity={opacity}
            style={{ filter: `drop-shadow(0 0 3px ${color})` }}
          />
        );
      })}
    </svg>
  );
}

// ------------------------------------------------------------------
// テーマ選びに出す小さな見本の絵(車の THEME とスマホの THEME タブ)。
// ------------------------------------------------------------------

export function MeterStyleThumb({ style }: { style: MeterStyle }) {
  if (style === "cyber") {
    return (
      <svg viewBox="0 0 120 70" className="ms-thumb" aria-hidden="true">
        <rect width="120" height="70" fill={CYBER.ground} />
        <path d="M5 11L11 5H40L46 11H109L115 17V59L109 65H5Z" fill={CYBER.panel} stroke={CYBER.on} strokeWidth="1.6" />
        <polygon points="80,11 104,11 101,14 83,14" fill={CYBER.on} />
        {Array.from({ length: 14 }, (_, i) => (
          <polygon
            key={i}
            points={`${12 + i * 6.6 + 2},${r2(29 - i * 0.9)} ${12 + i * 6.6 + 5.6},${r2(29 - i * 0.9)} ${12 + i * 6.6 + 3.6},34 ${12 + i * 6.6},34`}
            fill={CYBER.on}
            opacity={i < 6 ? 1 : CYBER_OFF}
          />
        ))}
        <text x="12" y="57" fill={CYBER.on} fontSize="17" style={{ fontFamily: '"Michroma", sans-serif' }}>
          58
        </text>
        <text x="57" y="57" fill={CYBER.on} fontSize="8" fontWeight="700" style={{ fontFamily: '"Rajdhani", sans-serif' }}>
          km/h
        </text>
        <g fill={CYBER.on}>
          <polygon points="88,55 93,58 88,61" />
          <polygon points="95,55 100,58 95,61" />
          <polygon points="102,55 107,58 102,61" />
        </g>
      </svg>
    );
  }
  if (style === "retro") {
    return (
      <svg viewBox="0 0 120 70" className="ms-thumb" aria-hidden="true">
        <rect width="120" height="70" fill="#040506" />
        <rect width="120" height="1.6" fill={RETRO.amber} />
        <rect y="2.6" width="120" height="1" fill={RETRO.red} />
        {Array.from({ length: 16 }, (_, i) => (
          <rect key={i} x={8 + i * 6.6} y={24 - i * 0.9} width="4.6" height={4 + i * 0.9} fill={i > 13 ? RETRO.red : i > 10 ? RETRO.yellow : RETRO.green} opacity={i < 6 ? 1 : 0.14} />
        ))}
        <text x="10" y="60" fill={RETRO.cyan} fontSize="30" fontWeight="700" fontStyle="italic" fontFamily="monospace" letterSpacing="-1">
          58
        </text>
        <text x="64" y="60" fill={RETRO.cyan} fontSize="8" fontFamily="monospace">
          km/h
        </text>
        <rect x="88" y="34" width="24" height="26" rx="3" fill="#03200f" stroke="#2a3534" />
        <path d="M90 56 L110 38 M90 44 H110" stroke={RETRO.green} strokeWidth="1" opacity=".8" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 120 70" className="ms-thumb" aria-hidden="true">
      <rect width="120" height="70" fill="#021013" />
      <circle cx="60" cy="36" r="27" fill="none" stroke="#123c3e" strokeWidth="5" />
      <path d="M41 55 A27 27 0 1 1 87 36" fill="none" stroke="#27dce3" strokeWidth="5" strokeLinecap="round" />
      <circle cx="60" cy="36" r="18" fill="#04262a" />
      <text x="60" y="42" textAnchor="middle" fill="#e9fffd" fontSize="16" fontWeight="900">
        58
      </text>
    </svg>
  );
}
