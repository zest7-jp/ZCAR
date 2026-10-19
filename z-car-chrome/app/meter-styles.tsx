"use client";

// 近未来のほかのテーマ(80年代のデジタル・本物の針)の、メーターの画面。
// どちらも 1024x566 の板に描き、使える広さに合わせて拡大・縮小する(車載機ではほぼ等倍)。
// 下から「動かない絵(SVG)」「地図」「動く針や数字(SVG)」「押せる所(ボタン)」の順に重ねる。
// 地図(Google マップ)を作るのは app/page.tsx で、ここでは置き場所を用意するだけ。

import { memo, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type { MeterStyle } from "./settings-store";

const BOARD_W = 1024;
const BOARD_H = 566;
const RPM_MAX = 8000;
/** ここから上の回転は赤くする(近未来のメーターと同じ)。 */
const RPM_RED = 6500;
/** 本物の針の速度計の目盛りの上限(km/h)。 */
const SPEED_MAX = 140;

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
};

/**
 * 80年代のテーマの地図の色(Google マップの styles)と寄り。
 * 昔の車の緑の画面: 黒い下地に緑の道。文字は町の名前だけ。
 * (本物の針のテーマには地図を置かない)
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
/** 12時を0度・時計回りの角度で、中心から r の点。 */
const pol = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const rad = (deg * Math.PI) / 180;
  return [r2(cx + r * Math.sin(rad)), r2(cy - r * Math.cos(rad))];
};
/** 「HH:MM」を時と分に。読めなければ 0:00。 */
const readHm = (text: string) => {
  const match = /^(\d{1,2}):(\d{2})/.exec(text);
  return match ? { h: Number(match[1]), m: Number(match[2]) } : { h: 0, m: 0 };
};

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
const WEATHER_JA: Record<WeatherKind, string> = {
  clear: "晴れ", partly: "晴れ時々くもり", cloud: "くもり", fog: "霧", rain: "雨", snow: "雪", storm: "雷雨",
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

/** 光る7セグメントの数字。消えている線もうっすら見せる(本物の表示管と同じ)。 */
const SevenSeg = memo(function SevenSeg({
  text,
  x,
  y,
  h,
  color,
  align = "start",
}: {
  text: string;
  x: number;
  y: number;
  h: number;
  color: string;
  align?: "start" | "end";
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
      <g fill={color} opacity={0.09}>{dim}</g>
      <g fill={color} filter="url(#ms-vfd)">{lit}</g>
    </g>
  );
});

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

const TACHO_BARS = 32;
const tachoBar = (index: number) => {
  const rpm = (index + 1) * (RPM_MAX / TACHO_BARS);
  const height = 16 + (index / (TACHO_BARS - 1)) * 52;
  return {
    rpm,
    x: r2(284 + index * 14.25),
    y: r2(106 - height),
    height: r2(height),
    color: rpm > RPM_RED ? RETRO.red : rpm > 5000 ? RETRO.yellow : RETRO.green,
  };
};
const BAR_SEGMENTS = 18;
/**
 * 緑の画面(地図)と、DEST・START の場所。右の列の BATTERY より下は、
 * Google マップの小さな画面(ナビ中に重ねて出す)のために空けておく。
 */
const RETRO_CRT = { x: 284, y: 328, w: 320, h: 214 };
const RETRO_DEST = { x: 616, y: 325, w: 137, h: 56 };
const RETRO_START = { x: 616, y: 391, w: 137, h: 154 };
/** 右の列の段(上から燃料・水温・電圧)の上の位置。少し詰めて、下に縦長の箱をとる。 */
const RETRO_RIGHT = { fuelBar: 36, range: 66, coolantBar: 130, coolant: 156, battery: 220 };
/** Google マップの小さな画面(ナビ中に重ねて出す)を置く、縦長の箱。 */
const RETRO_MAP_BAY = { x: 784, y: 272, w: 216, h: 278 };

/** 80年代のデジタルの、動かない絵(下地・仕切り・説明の文字・消えている棒)。 */
const RetroFace = memo(function RetroFace() {
  const labels: ReactNode[] = [
    label("time", 22, 26, "TIME · JST"),
    label("date", 22, 112, "DATE"),
    label("temp", 22, 201, "OUT TEMP"),
    label("world", 22, 363, "WORLD TIME"),
    label("today", 22, 488, "TODAY DISTANCE"),
    label("km", 222, 531, "km", { color: RETRO.green, size: 12, spacing: 0 }),
    label("engine", 284, 26, "ENGINE ×1000 r/min"),
    label("speed", 284, 154, "SPEED"),
    label("kmh", 566, 296, "km/h", { color: RETRO.cyan, size: 18, spacing: 0 }),
    label("cruise", 636, 174, "AVG CRUISE"),
    label("cruiseUnit", 740, 228, "km/h", { anchor: "end", size: 9, spacing: 1 }),
    label("fuel", 636, 248, "AVG FUEL"),
    label("fuelUnit", 740, 302, "km/L", { anchor: "end", size: 9, spacing: 1 }),
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
    label("change", RETRO_DEST.x + RETRO_DEST.w / 2, RETRO_DEST.y + 20, "CHANGE", { anchor: "middle", size: 8, spacing: 2.4 }),
    label("gmaps", RETRO_START.x + 14, RETRO_START.y + RETRO_START.h - 16, "GOOGLE MAPS", { size: 7.5, spacing: 1.8 }),
  ];
  for (let k = 0; k <= 8; k += 1) {
    labels.push(label(`n${k}`, r2(284 + k * 4 * 14.25 - (k === 8 ? 3 : 0)), 122, String(k), { color: k >= 7 ? RETRO.red : RETRO.soft, size: 10, anchor: "middle", spacing: 0 }));
  }
  return (
    <svg className="ms-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <defs>
        <filter id="ms-vfd" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="1.6" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <linearGradient id="ms-retro-sheen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".06" />
          <stop offset=".28" stopColor="#fff" stopOpacity="0" />
          <stop offset=".72" stopColor="#fff" stopOpacity="0" />
          <stop offset="1" stopColor="#fff" stopOpacity=".035" />
        </linearGradient>
      </defs>
      <rect width={BOARD_W} height={BOARD_H} fill="#040506" />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#ms-retro-sheen)" />
      {/* 上の3本の線(80年代の車の飾りの線)。 */}
      <rect y="0" width={BOARD_W} height="2" fill={RETRO.amber} opacity=".9" />
      <rect y="3" width={BOARD_W} height="1.5" fill="#ff6b2b" opacity=".85" />
      <rect y="6" width={BOARD_W} height="1" fill={RETRO.red} opacity=".7" />
      <g stroke={RETRO.line} strokeWidth="1.2">
        <line x1="262" y1="16" x2="262" y2="548" />
        <line x1="762" y1="16" x2="762" y2="548" />
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
      {/* 右下の縦長の箱(Google マップの小さな画面を置く所。中は何も描かない)。 */}
      <rect x={RETRO_MAP_BAY.x} y={RETRO_MAP_BAY.y} width={RETRO_MAP_BAY.w} height={RETRO_MAP_BAY.h} rx="16" fill="#020403" stroke="#2a3534" strokeWidth="2" />
      {label("bay", RETRO_MAP_BAY.x + 16, RETRO_MAP_BAY.y + 24, "GOOGLE MAPS", { color: "#3f6f5a", size: 8, spacing: 2.4 })}
      {/* 地図の画面の枠と、その右の DEST・START のボタンの枠。 */}
      <rect x={RETRO_CRT.x - 3} y={RETRO_CRT.y - 3} width={RETRO_CRT.w + 6} height={RETRO_CRT.h + 6} rx="20" fill="#0b0f0f" stroke="#2a3534" strokeWidth="2" />
      <rect x={RETRO_DEST.x} y={RETRO_DEST.y} width={RETRO_DEST.w} height={RETRO_DEST.h} rx="4" fill={RETRO.amber} fillOpacity=".06" stroke={RETRO.amber} strokeOpacity=".75" strokeWidth="1.6" />
      <text x={RETRO_DEST.x + RETRO_DEST.w / 2} y={RETRO_DEST.y + 44} textAnchor="middle" fill={RETRO.amber} fontSize="19" letterSpacing="5" filter="url(#ms-vfd)">
        DEST
      </text>
      <rect x={RETRO_START.x} y={RETRO_START.y} width={RETRO_START.w} height={RETRO_START.h} rx="4" fill={RETRO.cyan} fillOpacity=".07" stroke={RETRO.cyan} strokeOpacity=".85" strokeWidth="2" />
      <text x={RETRO_START.x + 14} y={RETRO_START.y + 28} fill={RETRO.cyan} fontSize="13" letterSpacing="4" filter="url(#ms-vfd)">
        START
      </text>
      <polygon
        points={`${RETRO_START.x + 110},${RETRO_START.y + 14} ${RETRO_START.x + 126},${RETRO_START.y + 24} ${RETRO_START.x + 110},${RETRO_START.y + 34}`}
        fill={RETRO.cyan}
        filter="url(#ms-vfd)"
      />
    </svg>
  );
});

/** 燃料・水温の点いている棒。 */
const litSegments = (value: number, y: number, color: (index: number) => string) =>
  Array.from({ length: Math.round(clamp01(value) * BAR_SEGMENTS) }, (_, i) => (
    <rect key={i} x={790 + i * 11} y={y} width="8.5" height="18" fill={color(i)} />
  ));

export function RetroCluster({ data, mapRef, mapReady, onFuel, onDest, onStart }: ClusterProps & MapProps) {
  const rpm = data.rpm === null ? null : Math.max(0, data.rpm);
  const weatherSlots = data.weather
    ? [
        { code: data.weather.code, isDay: data.weather.isDay },
        ...data.weather.hours.slice(0, 2).map((hour) => ({ code: hour.code, isDay: hour.isDay })),
      ]
    : [];
  const temperature = data.weather ? String(Math.round(data.weather.temperature)) : "--";
  const dest = data.destLabel ?? "NO DEST";
  // ボタンの幅(約108px)に収まる大きさ。
  const destSize = Math.min(34, Math.floor(108 / Math.max(1, [...dest].length)));
  return (
    <Board className="ms-retro">
      <RetroFace />
      <div className="ms-retro-crt" style={{ left: RETRO_CRT.x, top: RETRO_CRT.y, width: RETRO_CRT.w, height: RETRO_CRT.h }}>
        <div ref={mapRef} className="ms-map-canvas" />
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
        <b className="ms-retro-crt-label" aria-hidden="true">NAVI ▲N</b>
      </div>
      <svg className="ms-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
        <SevenSeg text={data.clock} x={22} y={34} h={52} color={RETRO.amber} />
        <SevenSeg text={`${pad2(data.month)}-${pad2(data.day)}`} x={22} y={118} h={22} color={RETRO.amber} />
        {label("year", 118, 137, String(data.year), { size: 10, spacing: 2 })}
        {WEEK_ORDER.map((dayIndex, i) =>
          dayIndex === data.weekday ? (
            <g key={dayIndex}>
              <rect x={22 + i * 32} y="150" width="27" height="19" rx="2" fill={RETRO.amber} fillOpacity=".16" stroke={RETRO.amber} />
              <text x={35.5 + i * 32} y="164" textAnchor="middle" fontSize="12" fill={RETRO.amber} filter="url(#ms-vfd)" className="ms-ja">
                {WEEKDAYS[dayIndex]}
              </text>
            </g>
          ) : null,
        )}
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
        <SevenSeg text={rpm === null ? "----" : String(Math.round(rpm))} x={740} y={14} h={16} color={RETRO.cyan} align="end" />
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
          x={290}
          y={160}
          h={138}
          color={RETRO.cyan}
        />
        <SevenSeg text={data.avgCruise === null ? "--" : String(Math.round(data.avgCruise))} x={740} y={182} h={30} color={RETRO.amber} align="end" />
        <SevenSeg text={data.avgFuel === null ? "--.-" : data.avgFuel.toFixed(1)} x={740} y={256} h={30} color={RETRO.amber} align="end" />
        <g filter="url(#ms-vfd)">{litSegments(data.fuelPercent / 100, RETRO_RIGHT.fuelBar, (i) => (i < 3 ? RETRO.red : RETRO.amber))}</g>
        <SevenSeg text={String(Math.round(data.rangeKm))} x={960} y={RETRO_RIGHT.range} h={30} color={RETRO.amber} align="end" />
        <g filter="url(#ms-vfd)">
          {data.coolant === null ? null : litSegments((data.coolant - 50) / 70, RETRO_RIGHT.coolantBar, () => RETRO.cyan)}
        </g>
        <SevenSeg text={data.coolant === null ? "--" : String(Math.round(data.coolant))} x={960} y={RETRO_RIGHT.coolant} h={30} color={RETRO.cyan} align="end" />
        <SevenSeg text={data.voltage === null ? "--.-" : data.voltage.toFixed(1)} x={960} y={RETRO_RIGHT.battery} h={30} color={RETRO.green} align="end" />
        <text x={RETRO_START.x + 14} y={RETRO_START.y + 96} fill={RETRO.cyan} fontSize={destSize} fontWeight="700" filter="url(#ms-vfd)" className="ms-ja">
          {dest}
        </text>
      </svg>
      <i className="ms-retro-mesh" aria-hidden="true" />
      <Hit box={[770, 10, 240, 92]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[626, 236, 124, 76]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[RETRO_DEST.x, RETRO_DEST.y, RETRO_DEST.w, RETRO_DEST.h]} label="目的地を選ぶ" onPress={onDest} />
      <Hit
        box={[RETRO_START.x, RETRO_START.y, RETRO_START.w, RETRO_START.h]}
        label={data.destLabel ? `${data.destLabel} へのナビをGoogleマップで開始する` : "目的地が設定されていません"}
        onPress={onStart}
      />
    </Board>
  );
}

// ------------------------------------------------------------------
// 本物の針のメーター: 金属の縁の文字盤と、本物のように動く針。
// ------------------------------------------------------------------

const CLASSIC = {
  ink: "#f1e7d4",
  muted: "#a8977f",
  needle: "#ff6a24",
  stitch: "#6d5843",
  red: "#c53a22",
};
/** 速度計の真ん中。 */
const SX = 512;
const SY = 282;
/** 時計と回転計の真ん中。 */
const CX = 134;
const CY = 128;
const TX = 890;
const TY = 132;

const ClassicDefs = () => (
  <defs>
    <linearGradient id="ms-metal" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#fdfdfd" />
      <stop offset=".2" stopColor="#8e8e8e" />
      <stop offset=".46" stopColor="#f2f2f2" />
      <stop offset=".72" stopColor="#555" />
      <stop offset="1" stopColor="#d6d6d6" />
    </linearGradient>
    <linearGradient id="ms-metal-soft" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#d9d9d9" />
      <stop offset=".5" stopColor="#7a7a7a" />
      <stop offset="1" stopColor="#c4c4c4" />
    </linearGradient>
    <radialGradient id="ms-dial" cx=".5" cy=".4" r=".65">
      <stop offset="0" stopColor="#26262a" />
      <stop offset=".65" stopColor="#0e0e10" />
      <stop offset="1" stopColor="#040405" />
    </radialGradient>
    <radialGradient id="ms-leather" cx=".5" cy=".45" r=".75">
      <stop offset="0" stopColor="#231c15" />
      <stop offset=".7" stopColor="#110d0a" />
      <stop offset="1" stopColor="#070605" />
    </radialGradient>
    <linearGradient id="ms-panel" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#1b1611" />
      <stop offset="1" stopColor="#110e0b" />
    </linearGradient>
    <linearGradient id="ms-needle" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#c8400c" />
      <stop offset=".5" stopColor="#ff7a36" />
      <stop offset="1" stopColor="#c8400c" />
    </linearGradient>
    <linearGradient id="ms-drum" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#000" />
      <stop offset=".25" stopColor="#2a2a2a" />
      <stop offset=".5" stopColor="#3a3a3a" />
      <stop offset=".75" stopColor="#2a2a2a" />
      <stop offset="1" stopColor="#000" />
    </linearGradient>
    <linearGradient id="ms-drum-light" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#8a8173" />
      <stop offset=".5" stopColor="#f3ecdf" />
      <stop offset="1" stopColor="#8a8173" />
    </linearGradient>
    <filter id="ms-shadow" x="-30%" y="-30%" width="160%" height="160%">
      <feDropShadow dx="1.5" dy="3" stdDeviation="2.4" floodColor="#000" floodOpacity=".75" />
    </filter>
    <filter id="ms-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" />
      <feColorMatrix type="matrix" values="0 0 0 0 .62  0 0 0 0 .5  0 0 0 0 .38  0 0 0 -1.2 .62" />
    </filter>
  </defs>
);

/** 金属の縁と黒い文字盤(放射状のすじ入り)。 */
const Dial = ({ cx, cy, r, ring }: { cx: number; cy: number; r: number; ring: number }) => (
  <g>
    <circle cx={cx} cy={cy} r={r + ring} fill="url(#ms-metal)" filter="url(#ms-shadow)" />
    <circle cx={cx} cy={cy} r={r + 1.2} fill="#000" />
    <circle cx={cx} cy={cy} r={r} fill="url(#ms-dial)" />
    <g strokeWidth={r2(r / 60)}>
      {Array.from({ length: 180 }, (_, i) => {
        const [x1, y1] = pol(cx, cy, r * 0.05, i * 2);
        const [x2, y2] = pol(cx, cy, r, i * 2);
        return (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={i % 2 ? "#fff" : "#000"} strokeOpacity={i % 2 ? 0.035 : 0.12} />
        );
      })}
    </g>
  </g>
);

type ScaleOptions = {
  cx: number;
  cy: number;
  r: number;
  from: number;
  to: number;
  major: number;
  mid: number;
  minor: number;
  label: number;
  labelR: number;
  font: number;
  red?: number;
};
/** -135度〜135度に割り当てた目盛りの角度。 */
const scaleAngle = (o: Pick<ScaleOptions, "from" | "to">, value: number) =>
  -135 + (270 * (Math.max(o.from, Math.min(o.to, value)) - o.from)) / (o.to - o.from);
const near = (value: number, step: number) => Math.abs(value / step - Math.round(value / step)) < 1e-6;
/** 目盛りと数字。red から上は赤。 */
const Scale = (o: ScaleOptions) => {
  const ticks: ReactNode[] = [];
  const steps = Math.round((o.to - o.from) / o.minor);
  for (let i = 0; i <= steps; i += 1) {
    const v = o.from + i * o.minor;
    const major = near(v, o.major);
    const mid = near(v, o.mid);
    const len = major ? o.r * 0.1 : mid ? o.r * 0.065 : o.r * 0.04;
    const [x1, y1] = pol(o.cx, o.cy, o.r, scaleAngle(o, v));
    const [x2, y2] = pol(o.cx, o.cy, o.r - len, scaleAngle(o, v));
    ticks.push(
      <line
        key={`t${i}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={o.red !== undefined && v >= o.red ? "#ff6a4a" : CLASSIC.ink}
        strokeWidth={r2(major ? o.r * 0.018 : mid ? o.r * 0.011 : o.r * 0.007)}
      />,
    );
  }
  const labels = Math.round((o.to - o.from) / o.label);
  for (let i = 0; i <= labels; i += 1) {
    const v = o.from + i * o.label;
    const [x, y] = pol(o.cx, o.cy, o.labelR, scaleAngle(o, v));
    ticks.push(
      <text
        key={`l${i}`}
        x={x}
        y={r2(y + o.font * 0.36)}
        textAnchor="middle"
        fill={o.red !== undefined && v >= o.red ? "#ff7a5a" : CLASSIC.ink}
        fontSize={o.font}
        fontWeight="700"
        letterSpacing="-.5"
      >
        {v}
      </text>,
    );
  }
  let red: ReactNode = null;
  if (o.red !== undefined) {
    const [x0, y0] = pol(o.cx, o.cy, o.r - 3, scaleAngle(o, o.red));
    const [x1, y1] = pol(o.cx, o.cy, o.r - 3, scaleAngle(o, o.to));
    red = <path d={`M${x0} ${y0} A${o.r - 3} ${o.r - 3} 0 0 1 ${x1} ${y1}`} fill="none" stroke={CLASSIC.red} strokeWidth="5" />;
  }
  return (
    <g>
      {red}
      {ticks}
    </g>
  );
};

const Hub = ({ cx, cy, r }: { cx: number; cy: number; r: number }) => (
  <g>
    <circle cx={cx} cy={cy} r={r} fill="url(#ms-metal)" filter="url(#ms-shadow)" />
    <circle cx={cx} cy={cy} r={r2(r * 0.42)} fill="#111" />
  </g>
);

/** 針(先が細い)。角度が変わると、少しの時間をかけて動く。 */
const Needle = ({ cx, cy, len, tail, width, deg }: { cx: number; cy: number; len: number; tail: number; width: number; deg: number }) => (
  <g className="ms-needle" style={{ transform: `rotate(${r2(deg)}deg)`, transformOrigin: `${cx}px ${cy}px` }}>
    <g filter="url(#ms-shadow)">
      <polygon
        points={`${r2(cx - width / 2)},${cy + tail} ${r2(cx - width * 0.18)},${cy - len} ${r2(cx + width * 0.18)},${cy - len} ${r2(cx + width / 2)},${cy + tail}`}
        fill="url(#ms-needle)"
      />
      <line x1={cx} y1={cy + tail - 2} x2={cx} y2={cy - len + 3} stroke="#ffd2b0" strokeWidth={r2(width * 0.14)} opacity=".7" />
    </g>
  </g>
);

/** 文字盤に開けた黒い小窓の枠と、上の説明。 */
const ApertureFrame = ({ x, y, w, h, top }: { x: number; y: number; w: number; h: number; top: string }) => (
  <g>
    <rect x={x} y={y} width={w} height={h} rx="5" fill="#050505" stroke="url(#ms-metal-soft)" strokeWidth="1.6" />
    <text x={x + w / 2} y={y + 12} textAnchor="middle" fill={CLASSIC.muted} fontSize="7.5" letterSpacing="1.4">
      {top}
    </text>
  </g>
);
const ApertureValue = ({ x, y, w, h, value, unit }: { x: number; y: number; w: number; h: number; value: string; unit: string }) => (
  <text x={x + w / 2} y={y + h - 8} textAnchor="middle" fill={CLASSIC.ink} fontSize="16" fontWeight="700">
    {value}
    <tspan fontSize="8.5" fill={CLASSIC.muted} fontWeight="400" dx="2">
      {unit}
    </tspan>
  </text>
);
const APERTURES = {
  cruise: { x: SX - 116, y: SY + 160, w: 74, h: 40 },
  speed: { x: SX - 36, y: SY + 166, w: 72, h: 44 },
  fuel: { x: SX + 42, y: SY + 160, w: 74, h: 40 },
};
const WORLD_X = [56, 134, 212];
const WORLD_Y = 372;
const FANS = [
  { cx: 834, cy: 290, lo: "E", hi: "F", name: "FUEL · RANGE" },
  { cx: 946, cy: 290, lo: "C", hi: "H", name: "COOLANT TEMP" },
];
const DRUMS = 5;

/** 本物の針のメーターの、地図より下の動かない絵。 */
const ClassicFace = memo(function ClassicFace() {
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <ClassicDefs />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#ms-leather)" />
      <rect width={BOARD_W} height={BOARD_H} filter="url(#ms-grain)" opacity=".16" />
      {[12, 768].map((x) => (
        <g key={x}>
          <rect x={x} y="8" width="244" height="548" rx="16" fill="url(#ms-panel)" stroke="#2e261d" filter="url(#ms-shadow)" />
          <rect x={x + 6} y="14" width="232" height="536" rx="11" fill="none" stroke={CLASSIC.stitch} strokeDasharray="4 3.5" opacity=".75" />
        </g>
      ))}
      {/* 速度計 */}
      <Dial cx={SX} cy={SY} r={226} ring={14} />
      <Scale cx={SX} cy={SY} r={212} from={0} to={SPEED_MAX} major={20} mid={10} minor={2} label={20} labelR={160} font={22} />
      <text x={SX} y={SY - 66} textAnchor="middle" fill={CLASSIC.muted} fontSize="12" letterSpacing="3">
        km/h
      </text>
      <text x={SX} y={SY + 70} textAnchor="middle" fill={CLASSIC.muted} fontSize="15" fontStyle="italic" fontWeight="700" letterSpacing="3" className="ms-serif" opacity=".8">
        Z CAR
      </text>
      <ApertureFrame {...APERTURES.cruise} top="AVG CRUISE" />
      <ApertureFrame {...APERTURES.speed} top="SPEED" />
      <ApertureFrame {...APERTURES.fuel} top="AVG FUEL" />
      {/* 時計 */}
      <text x={CX} y="30" textAnchor="middle" fill={CLASSIC.muted} fontSize="8.5" letterSpacing="2.4">
        LOCAL TIME · JST
      </text>
      <Dial cx={CX} cy={CY} r={84} ring={8} />
      {Array.from({ length: 60 }, (_, i) => {
        const major = i % 5 === 0;
        const [x1, y1] = pol(CX, CY, 80, i * 6);
        const [x2, y2] = pol(CX, CY, major ? 66 : 75, i * 6);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.ink} strokeWidth={major ? (i === 0 ? 4.2 : 3) : 1} />;
      })}
      <rect x={CX + 34} y={CY - 9} width="26" height="18" rx="2" fill="#f4ecdc" stroke="url(#ms-metal-soft)" />
      <rect x={CX - 60} y={CY - 9} width="26" height="18" rx="2" fill="#0b0b0b" stroke="url(#ms-metal-soft)" />
      {/* 日の出・日の入り */}
      <g fill="none" stroke={CLASSIC.muted} strokeWidth="1.2">
        <path d="M40 246 h20 M44 242 a6 6 0 0 1 12 0" />
        <path d="M50 234 v3 M42 237 l2 2 M58 237 l-2 2" />
        <path d="M170 246 h20 M174 242 a6 6 0 0 1 12 0" />
      </g>
      <line x1="104" y1="243" x2="164" y2="243" stroke={CLASSIC.stitch} strokeDasharray="2 3" />
      <g stroke="#3a3027">
        <line x1="30" y1="262" x2="238" y2="262" />
        <line x1="30" y1="332" x2="238" y2="332" />
        <line x1="30" y1="442" x2="238" y2="442" />
      </g>
      <text x="136" y="287" fill={CLASSIC.muted} fontSize="7.5" letterSpacing="1.6">
        OUTSIDE
      </text>
      {/* 世界の時刻の小さな時計 */}
      {WORLD_X.map((x, i) => (
        <g key={x}>
          <Dial cx={x} cy={WORLD_Y} r={24} ring={3.5} />
          {Array.from({ length: 12 }, (_, k) => {
            const [x1, y1] = pol(x, WORLD_Y, 21, k * 30);
            const [x2, y2] = pol(x, WORLD_Y, k % 3 === 0 ? 16 : 18.5, k * 30);
            return <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.ink} strokeWidth={k % 3 === 0 ? 1.6 : 0.8} />;
          })}
          <text x={x} y={WORLD_Y + 40} textAnchor="middle" fill={CLASSIC.muted} fontSize="7" letterSpacing="1.2">
            {["CALIFORNIA", "RUSSIA", "CHINA"][i]}
          </text>
        </g>
      ))}
      {/* 今日の距離(回るドラム) */}
      <text x={CX} y="464" textAnchor="middle" fill={CLASSIC.muted} fontSize="8" letterSpacing="2.4">
        TODAY DISTANCE
      </text>
      {Array.from({ length: DRUMS }, (_, i) => (
        <rect key={i} x={66 + i * 23} y="474" width="20" height="30" rx="2" fill={i === DRUMS - 1 ? "url(#ms-drum-light)" : "url(#ms-drum)"} stroke="#555" strokeWidth=".8" />
      ))}
      <rect x="60" y="470" width={DRUMS * 23 + 8} height="38" rx="4" fill="none" stroke="url(#ms-metal-soft)" strokeWidth="1.6" />
      <text x={66 + DRUMS * 23 + 4} y="495" fill={CLASSIC.muted} fontSize="10">
        km
      </text>
      {/* 回転計 */}
      <text x={TX} y="28" textAnchor="middle" fill={CLASSIC.muted} fontSize="8.5" letterSpacing="2.4">
        ENGINE · ×1000 r/min
      </text>
      <Dial cx={TX} cy={TY} r={80} ring={7} />
      <Scale cx={TX} cy={TY} r={76} from={0} to={8} major={1} mid={0.5} minor={0.25} label={1} labelR={55} font={14} red={RPM_RED / 1000} />
      <rect x={TX - 24} y={TY + 33} width="48" height="18" rx="3" fill="#050505" stroke="url(#ms-metal-soft)" />
      {/* 燃料・水温(扇形の小さなメーター) */}
      {FANS.map((fan) => {
        const [lx, ly] = pol(fan.cx, fan.cy, 30, -60);
        const [hx, hy] = pol(fan.cx, fan.cy, 30, 60);
        return (
          <g key={fan.name}>
            <rect x={fan.cx - 52} y={fan.cy - 62} width="104" height="92" rx="12" fill="#0b0a09" stroke="url(#ms-metal-soft)" strokeWidth="1.6" />
            {Array.from({ length: 9 }, (_, i) => {
              const [x1, y1] = pol(fan.cx, fan.cy, 46, -60 + i * 15);
              const [x2, y2] = pol(fan.cx, fan.cy, i % 4 === 0 ? 37 : 41, -60 + i * 15);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.ink} strokeWidth={i % 4 === 0 ? 2.2 : 1.1} />;
            })}
            <text x={lx} y={ly + 4} textAnchor="middle" fill={CLASSIC.ink} fontSize="10" fontWeight="700">
              {fan.lo}
            </text>
            <text x={hx} y={hy + 4} textAnchor="middle" fill={CLASSIC.ink} fontSize="10" fontWeight="700">
              {fan.hi}
            </text>
            <text x={fan.cx} y={fan.cy + 47} textAnchor="middle" fill={CLASSIC.muted} fontSize="7" letterSpacing="1.2">
              {fan.name}
            </text>
          </g>
        );
      })}
      {/* 電圧 */}
      <rect x="782" y="352" width="216" height="40" rx="10" fill="#0b0a09" stroke="url(#ms-metal-soft)" strokeWidth="1.6" />
      <text x="800" y="376" fill={CLASSIC.muted} fontSize="8" letterSpacing="2">
        BATTERY
      </text>
      {/* 目的地を選ぶ・START(金属の縁のボタン) */}
      {[
        [782, 404, 216, 46],
        [782, 460, 216, 74],
      ].map(([x, y, w, h]) => (
        <g key={y}>
          <rect x={x} y={y} width={w} height={h} rx="12" fill="url(#ms-metal)" filter="url(#ms-shadow)" />
          <rect x={x + 3} y={y + 3} width={w - 6} height={h - 6} rx="9" fill="#141210" />
        </g>
      ))}
      <text x="890" y="423" textAnchor="middle" fill={CLASSIC.muted} fontSize="7.5" letterSpacing="2">
        CHANGE
      </text>
      <text x="890" y="440" textAnchor="middle" fill={CLASSIC.ink} fontSize="14" fontWeight="700" letterSpacing="3">
        DEST
      </text>
      <circle cx="818" cy="497" r="17" fill="none" stroke={CLASSIC.needle} strokeWidth="1.6" />
      <path d="M818 508 s7-6.5 7-11.5 a7 7 0 1 0-14 0 c0 5 7 11.5 7 11.5z" fill="none" stroke={CLASSIC.needle} strokeWidth="1.6" />
      <text x="846" y="489" fill={CLASSIC.muted} fontSize="8" letterSpacing="2.4">
        START
      </text>
      <path d="M972 488 l9 9 -9 9" fill="none" stroke={CLASSIC.ink} strokeWidth="2" />
    </svg>
  );
});

/** 天気の小さな絵(線で描く)。 */
const ClassicWeatherIcon = ({ kind, isDay }: { kind: WeatherKind; isDay: boolean }) => {
  const cloud = (
    <path d="M-14 6 a8 8 0 0 1 8-8 a10 10 0 0 1 19 3 a6 6 0 0 1 0 12 h-22 a6 6 0 0 1-5-7z" fill="#1a1612" stroke={CLASSIC.ink} strokeWidth="1.6" />
  );
  const sun = isDay ? (
    <circle cx="-4" cy="-6" r="9" fill="none" stroke="#ffb15a" strokeWidth="1.8" />
  ) : (
    <path d="M-2 -15 a9 9 0 1 0 9 12 a7 7 0 0 1 -9 -12z" fill="none" stroke="#ffd79a" strokeWidth="1.6" />
  );
  return (
    <g transform="translate(46 296)">
      {kind === "clear" ? (
        isDay ? (
          <g fill="none" stroke="#ffb15a" strokeWidth="1.8">
            <circle r="8" />
            <path d="M0 -15 v4 M0 11 v4 M-15 0 h4 M11 0 h4 M-10.6 -10.6 l3 3 M7.6 7.6 l3 3 M10.6 -10.6 l-3 3 M-7.6 7.6 l-3 3" />
          </g>
        ) : (
          <path d="M-2 -12 a11 11 0 1 0 12 14 a9 9 0 0 1 -12 -14z" fill="none" stroke="#ffd79a" strokeWidth="1.8" />
        )
      ) : (
        <>
          {kind === "partly" ? sun : null}
          {kind === "fog" ? (
            <path d="M-16 -6 h28 M-12 2 h28 M-16 10 h28" stroke={CLASSIC.ink} strokeWidth="1.8" strokeLinecap="round" />
          ) : (
            cloud
          )}
          {kind === "rain" ? <path d="M-8 22 l-2 5 M0 22 l-2 5 M8 22 l-2 5" stroke="#8fb8d8" strokeWidth="1.6" /> : null}
          {kind === "snow" ? <path d="M-8 24 h4 M0 24 h4 M8 24 h4" stroke={CLASSIC.ink} strokeWidth="2" /> : null}
          {kind === "storm" ? <path d="M0 18 l-4 7 h4 l-2 6 7-9 h-4 l2-4z" fill="#ffb15a" /> : null}
        </>
      )}
    </g>
  );
};

/** 時計の針の角度(時・分・秒)。 */
const clockAngles = (h: number, m: number, s: number) => ({
  hour: ((h % 12) + m / 60) * 30,
  minute: (m + s / 60) * 6,
  second: s * 6,
});

export function ClassicCluster({ data, onFuel, onDest, onStart }: ClusterProps) {
  // 時計の秒針のため、1秒ごとに今の時刻を読む(分までは data.clock と同じ)。
  const [now, setNow] = useState<{ h: number; m: number; s: number } | null>(null);
  useEffect(() => {
    const tick = () => {
      const date = new Date();
      setNow({ h: date.getHours(), m: date.getMinutes(), s: date.getSeconds() });
    };
    const first = window.setTimeout(tick, 0);
    const timer = window.setInterval(tick, 1000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, []);
  const time = now ?? { ...readHm(data.clock), s: 0 };
  const hands = clockAngles(time.h, time.m, time.s);
  const speedDeg = scaleAngle({ from: 0, to: SPEED_MAX }, data.speed ?? 0);
  const rpmDeg = scaleAngle({ from: 0, to: 8 }, (data.rpm ?? 0) / 1000);
  const fuelDeg = -60 + 120 * clamp01(data.fuelPercent / 100);
  const tempDeg = -60 + 120 * clamp01(data.coolant === null ? 0 : (data.coolant - 50) / 70);
  const odometer = String(Math.min(99999, Math.round(data.todayKm * 10))).padStart(DRUMS, "0").split("");
  const kind = data.weather ? weatherKind(data.weather.code) : null;
  const later = data.weather?.hours ?? [];
  const forecast = later
    .slice(0, 2)
    .map((hour, i) => `${i === 0 ? "+3H" : "+6H"} ${Math.round(hour.temperature)}°`)
    .join(" · ");
  const dest = data.destLabel ?? "目的地なし";
  return (
    <Board className="ms-classic">
      <ClassicFace />
      <svg className="ms-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
        {/* 速度計 */}
        <ApertureValue {...APERTURES.cruise} value={data.avgCruise === null ? "—" : String(Math.round(data.avgCruise))} unit="km/h" />
        <ApertureValue {...APERTURES.speed} value={data.speed === null ? "—" : String(Math.round(data.speed))} unit="km/h" />
        <ApertureValue {...APERTURES.fuel} value={data.avgFuel === null ? "—" : data.avgFuel.toFixed(1)} unit="km/L" />
        <Needle cx={SX} cy={SY} len={206} tail={34} width={9} deg={speedDeg} />
        <Hub cx={SX} cy={SY} r={15} />
        {/* 時計 */}
        <text x={CX + 47} y={CY + 5} textAnchor="middle" fill="#1a1612" fontSize="12.5" fontWeight="700">
          {data.day}
        </text>
        <text x={CX - 47} y={CY + 5} textAnchor="middle" fill={CLASSIC.needle} fontSize="11.5" fontWeight="700" className="ms-ja">
          {WEEKDAYS[data.weekday]}
        </text>
        <text x={CX} y={CY + 44} textAnchor="middle" fill={CLASSIC.muted} fontSize="8" letterSpacing="2">
          {`${data.year}.${pad2(data.month)}.${pad2(data.day)}`}
        </text>
        <g filter="url(#ms-shadow)">
          <polygon points="-4.5,8 0,-48 4.5,8" fill="url(#ms-metal)" transform={`translate(${CX} ${CY}) rotate(${r2(hands.hour)})`} />
          <polygon points="-3.6,10 0,-72 3.6,10" fill="url(#ms-metal)" transform={`translate(${CX} ${CY}) rotate(${r2(hands.minute)})`} />
          <g transform={`translate(${CX} ${CY}) rotate(${hands.second})`}>
            <line x1="0" y1="16" x2="0" y2="-76" stroke={CLASSIC.needle} strokeWidth="1.4" />
            <circle r="3.2" fill={CLASSIC.needle} />
          </g>
        </g>
        <Hub cx={CX} cy={CY} r={5} />
        {/* 日の出・日の入り・天気 */}
        <text x="64" y="247" fill={CLASSIC.ink} fontSize="11" fontWeight="700">
          {data.sunrise ?? "--:--"}
        </text>
        <text x="194" y="247" fill={CLASSIC.ink} fontSize="11" fontWeight="700">
          {data.sunset ?? "--:--"}
        </text>
        {kind && data.weather ? <ClassicWeatherIcon kind={kind} isDay={data.weather.isDay} /> : null}
        <text x="70" y="302" fill={CLASSIC.ink} fontSize="34" fontWeight="700" className="ms-serif">
          {data.weather ? Math.round(data.weather.temperature) : "—"}
          <tspan fontSize="14" dx="1">
            °C
          </tspan>
        </text>
        <text x="136" y="302" fill={CLASSIC.ink} fontSize="10.5" fontWeight="700" className="ms-ja">
          {kind ? WEATHER_JA[kind] : "天気を読み込み中"}
        </text>
        <text x="136" y="316" fill={CLASSIC.muted} fontSize="8.5">
          {forecast}
        </text>
        {/* 世界の時刻 */}
        {data.world.map((city, i) => {
          const { h, m } = readHm(city.time);
          const x = WORLD_X[i] ?? WORLD_X[0];
          return (
            <g key={city.name}>
              <line x1={x} y1={WORLD_Y} x2={x} y2={WORLD_Y - 12} stroke={CLASSIC.ink} strokeWidth="2.2" strokeLinecap="round" transform={`rotate(${((h % 12) + m / 60) * 30} ${x} ${WORLD_Y})`} />
              <line x1={x} y1={WORLD_Y} x2={x} y2={WORLD_Y - 18} stroke={CLASSIC.ink} strokeWidth="1.4" strokeLinecap="round" transform={`rotate(${m * 6} ${x} ${WORLD_Y})`} />
              <circle cx={x} cy={WORLD_Y} r="2" fill={CLASSIC.needle} />
              <text x={x} y={WORLD_Y + 53} textAnchor="middle" fill={CLASSIC.ink} fontSize="10.5" fontWeight="700">
                {city.time}
              </text>
            </g>
          );
        })}
        {/* 今日の距離 */}
        {odometer.map((digit, i) => (
          <text key={i} x={66 + i * 23 + 10} y="495" textAnchor="middle" fill={i === DRUMS - 1 ? "#1a1612" : CLASSIC.ink} fontSize="17" fontWeight="700">
            {digit}
          </text>
        ))}
        {/* 回転計 */}
        <text x={TX} y={TY + 46.5} textAnchor="middle" fill={CLASSIC.ink} fontSize="11" fontWeight="700">
          {data.rpm === null ? "—" : Math.round(data.rpm)}
        </text>
        <Needle cx={TX} cy={TY} len={70} tail={15} width={6} deg={rpmDeg} />
        <Hub cx={TX} cy={TY} r={9} />
        {/* 燃料・水温 */}
        {[
          { fan: FANS[0], deg: fuelDeg, value: String(Math.round(data.rangeKm)), unit: "km" },
          { fan: FANS[1], deg: tempDeg, value: data.coolant === null ? "—" : String(Math.round(data.coolant)), unit: "°C" },
        ].map(({ fan, deg, value, unit }) => (
          <g key={fan.name}>
            <Needle cx={fan.cx} cy={fan.cy} len={44} tail={6} width={4.2} deg={deg} />
            <Hub cx={fan.cx} cy={fan.cy} r={5.5} />
            <text x={fan.cx} y={fan.cy + 21} textAnchor="middle" fill={CLASSIC.ink} fontSize="12" fontWeight="700">
              {value}
              <tspan fontSize="8" fill={CLASSIC.muted}>
                {` ${unit}`}
              </tspan>
            </text>
          </g>
        ))}
        {/* 電圧・START の行き先 */}
        <text x="982" y="379" textAnchor="end" fill={CLASSIC.ink} fontSize="17" fontWeight="700">
          {data.voltage === null ? "—" : data.voltage.toFixed(1)}
          <tspan fontSize="9" fill={CLASSIC.muted} dx="2">
            V
          </tspan>
        </text>
        <text x="846" y="512" fill={CLASSIC.ink} fontSize={dest.length <= 5 ? 20 : 16} fontWeight="700" className="ms-ja">
          {dest}
        </text>
      </svg>
      <Hit box={[APERTURES.fuel.x, APERTURES.fuel.y, APERTURES.fuel.w, APERTURES.fuel.h]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[782, 226, 216, 116]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[782, 404, 216, 46]} label="目的地を選ぶ" onPress={onDest} />
      <Hit
        box={[782, 460, 216, 74]}
        label={data.destLabel ? `${data.destLabel} へのナビをGoogleマップで開始する` : "目的地が設定されていません"}
        onPress={onStart}
      />
    </Board>
  );
}

// ------------------------------------------------------------------
// テーマ選びに出す小さな見本の絵(車の THEME とスマホの THEME タブ)。
// ------------------------------------------------------------------

export function MeterStyleThumb({ style }: { style: MeterStyle }) {
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
  if (style === "classic") {
    const [nx, ny] = pol(60, 38, 25, -23);
    return (
      <svg viewBox="0 0 120 70" className="ms-thumb" aria-hidden="true">
        <defs>
          <linearGradient id="ms-thumb-metal" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#fdfdfd" />
            <stop offset=".46" stopColor="#8e8e8e" />
            <stop offset="1" stopColor="#e0e0e0" />
          </linearGradient>
        </defs>
        <rect width="120" height="70" fill="#15110d" />
        <circle cx="60" cy="38" r="31" fill="url(#ms-thumb-metal)" />
        <circle cx="60" cy="38" r="28" fill="#0c0c0e" />
        {Array.from({ length: 15 }, (_, i) => {
          const [x1, y1] = pol(60, 38, 26, -135 + i * (270 / 14));
          const [x2, y2] = pol(60, 38, i % 2 ? 23.5 : 21.5, -135 + i * (270 / 14));
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.ink} strokeWidth={i % 2 ? 0.8 : 1.6} />;
        })}
        <line x1="60" y1="38" x2={nx} y2={ny} stroke={CLASSIC.needle} strokeWidth="2" strokeLinecap="round" />
        <circle cx="60" cy="38" r="3.4" fill="url(#ms-thumb-metal)" />
        <circle cx="19" cy="24" r="12" fill="url(#ms-thumb-metal)" />
        <circle cx="19" cy="24" r="10.5" fill="#0c0c0e" />
        <line x1="19" y1="24" x2="19" y2="16" stroke={CLASSIC.ink} strokeWidth="1.2" />
        <line x1="19" y1="24" x2="24" y2="27" stroke={CLASSIC.ink} strokeWidth="1.2" />
        <circle cx="101" cy="24" r="12" fill="url(#ms-thumb-metal)" />
        <circle cx="101" cy="24" r="10.5" fill="#0c0c0e" />
        <line x1="101" y1="24" x2="95" y2="20" stroke={CLASSIC.needle} strokeWidth="1.4" />
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
