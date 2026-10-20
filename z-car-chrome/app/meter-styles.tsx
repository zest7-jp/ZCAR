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
/** DEST はねらいの印(点線の輪と4本の目盛り)、START は3つの矢印(行き先があると、光が左から右へ流れる)。 */
const DEST_CX = RETRO_DEST.x + RETRO_DEST.w / 2;
const DEST_CY = RETRO_DEST.y + RETRO_DEST.h / 2;
const START_CX = RETRO_START.x + RETRO_START.w / 2 + 3;
const START_CY = RETRO_START.y + RETRO_START.h / 2;
const startChevron = (i: number) =>
  `${START_CX - 33 + i * 24},${START_CY - 17} ${START_CX - 15 + i * 24},${START_CY} ${START_CX - 33 + i * 24},${START_CY + 17}`;
/** 右の列の段(上から燃料・水温・電圧)の上の位置。少し詰めて、下に縦長の箱をとる。 */
const RETRO_RIGHT = { fuelBar: 36, range: 66, coolantBar: 130, coolant: 156, battery: 220 };

/** 箱の上と左の空き: エコ運転のランプ(箱の上)と縦の棒(箱の左)。 */
const RETRO_ECO = { x: 778, label: 282, lamp: 322, bar: { x: 786, y: 338, w: 32, h: 208 } };
const ECO_SEGMENTS = 12;
/** 回転数がこれ以下なら棒が全部点き、ECO_EMPTY_RPM 以上なら1つも点かない(真ん中の 2000 で ECO が光る)。 */
const ECO_FULL_RPM = 1000;
const ECO_EMPTY_RPM = 3000;
/** エコの度合い(0〜1)。走っていて回転数が低いほど大きい。止まっているとき(5 km/h 未満)は 0。 */
const ecoLevel = (rpm: number | null, speed: number | null) =>
  rpm === null || speed === null || speed < 5 ? 0 : clamp01((ECO_EMPTY_RPM - rpm) / (ECO_EMPTY_RPM - ECO_FULL_RPM));
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

/** 光る管で縁取ったキー(DEST・START)。外の細い線と、内側の光る線の二重。 */
const retroKey = (key: typeof RETRO_DEST, color: string) => (
  <g>
    <rect x={key.x} y={key.y} width={key.w} height={key.h} rx="12" fill={color} fillOpacity=".04" stroke={color} strokeOpacity=".3" />
    <rect x={key.x + 4} y={key.y + 4} width={key.w - 8} height={key.h - 8} rx="9" fill="none" stroke={color} strokeWidth="1.6" filter="url(#ms-vfd)" />
  </g>
);

/** 80年代のデジタルの、動かない絵(下地・仕切り・説明の文字・消えている棒)。 */
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
    label("ecoRpm", 1000, RETRO_ECO.lamp - 3, "≤2000 r/min", { color: RETRO.soft, size: 9, anchor: "end", spacing: 1 }),
  ];
  for (let k = 0; k <= 8; k += 1) {
    labels.push(label(`n${k}`, r2(GAUGE_L + k * 4 * TACHO_PITCH - (k === 8 ? 3 : 0)), 124, String(k), { color: k >= 7 ? RETRO.red : RETRO.soft, size: 10, anchor: "middle", spacing: 0 }));
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
      {/* エコ運転のランプと縦の棒(消えている方)。 */}
      {ecoLamp(false)}
      {Array.from({ length: ECO_SEGMENTS }, (_, i) => (
        <rect key={i} {...ecoSegment(i)} fill={RETRO.green} opacity=".1" />
      ))}
      {/* 右下の縦長の箱(Google マップの小さな画面を置く所)。名前の札は上の線に切り込む。中に DEST・START。 */}
      <rect x={RETRO_MAP_BAY.x} y={RETRO_MAP_BAY.y} width={RETRO_MAP_BAY.w} height={RETRO_MAP_BAY.h} rx="16" fill="#020403" stroke="#2a3534" strokeWidth="2" />
      <rect x={RETRO_MAP_BAY.x + 14} y={RETRO_MAP_BAY.y - 5} width="88" height="10" fill="#040506" />
      {label("bay", RETRO_MAP_BAY.x + 19, RETRO_MAP_BAY.y + 3, "GOOGLE MAPS", { size: 8, spacing: 2.4 })}
      {/* DEST(ねらいの印)と START(3つの矢印)。同じ大きさの、光る管で縁取ったキー。 */}
      {retroKey(RETRO_DEST, RETRO.amber)}
      <g stroke={RETRO.amber} fill="none" filter="url(#ms-vfd)">
        <circle cx={DEST_CX} cy={DEST_CY} r="20" strokeWidth="3.2" strokeDasharray="7.6 5" />
        {[0, 90, 180, 270].map((angle) => (
          <line key={angle} x1={DEST_CX} y1={DEST_CY - 25} x2={DEST_CX} y2={DEST_CY - 33} strokeWidth="3" transform={`rotate(${angle} ${DEST_CX} ${DEST_CY})`} />
        ))}
        <circle cx={DEST_CX} cy={DEST_CY} r="4.5" fill={RETRO.amber} stroke="none" />
      </g>
      {retroKey(RETRO_START, RETRO.cyan)}
      {/* START の矢印(消えている方。光が流れる方は動く絵で、行き先があるときだけ出す)。 */}
      <g stroke={RETRO.cyan} fill="none" strokeWidth="7" opacity=".1">
        {[0, 1, 2].map((i) => (
          <polyline key={i} points={startChevron(i)} />
        ))}
      </g>
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
  const eco = ecoLevel(rpm, data.speed);
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
        {/* 北の印(地図はいつも北が上)。 */}
        <svg className="ms-retro-north" viewBox="-14 -20 28 34" aria-hidden="true">
          <polygon points="0,-19 -5,-11 5,-11" />
          <circle cx="0" cy="2" r="10.5" />
          <text x="0" y="6.5" textAnchor="middle">
            N
          </text>
        </svg>
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
          <g className="ms-retro-flow" stroke={RETRO.cyan} fill="none" strokeWidth="7" filter="url(#ms-vfd)">
            {[0, 1, 2].map((i) => (
              <polyline key={i} points={startChevron(i)} />
            ))}
          </g>
        ) : null}
        {eco >= 0.5 ? ecoLamp(true) : null}
        <g filter="url(#ms-vfd)">
          {Array.from({ length: Math.round(eco * ECO_SEGMENTS) }, (_, i) => (
            <rect key={i} {...ecoSegment(i)} fill={RETRO.green} />
          ))}
        </g>
      </svg>
      <i className="ms-retro-mesh" aria-hidden="true" />
      <Hit box={[770, 10, 240, 92]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[AVG_FUEL_X - 8, GAUGE_ROW_TOP + 4, GAUGE_R - AVG_FUEL_X + 8, RETRO_CRT.y - GAUGE_ROW_TOP - 10]} label="燃費の記録・確認を開く" onPress={onFuel} />
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
// 本物の針のメーター: 金属の縁のクリーム色の文字盤(ヴィンテージ)と、本物のように動く針。
// ------------------------------------------------------------------

const CLASSIC = {
  ink: "#f1e7d4",
  muted: "#a8977f",
  needle: "#ff6a24",
  stitch: "#6d5843",
  red: "#c53a22",
  /** クリーム色の文字盤とボタンの上の、文字・目盛り・針の色。 */
  dialInk: "#1d1813",
  dialMuted: "#7a6853",
  dialRed: "#c0321c",
  plateInk: "#2b2118",
};
/**
 * 三連のメーター。左に回転計、真ん中に大きな速度計、右に時計。左右は少し小さく、少し高い所に置き、
 * 真ん中の金属の縁の後ろに少し隠れる。下の左右の板に、天気と、電圧・目的地・START。
 */
const SX = 512;
const SY = 283;
const SPEED_R = 218;
const TX = 170;
const TY = 196;
const CX = 854;
const CY = 196;
const SIDE_R = 130;

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
    <radialGradient id="ms-cream" cx=".5" cy=".4" r=".7">
      <stop offset="0" stopColor="#f8f1e2" />
      <stop offset=".7" stopColor="#eae0c9" />
      <stop offset="1" stopColor="#cdbd9e" />
    </radialGradient>
    <linearGradient id="ms-ivory" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#f6eedc" />
      <stop offset="1" stopColor="#d5c7aa" />
    </linearGradient>
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

/** 金属の縁とクリーム色の文字盤(細い同心の輪の模様と、縁の内側の細い線)。 */
const Dial = ({ cx, cy, r, ring }: { cx: number; cy: number; r: number; ring: number }) => {
  const rings = Math.max(6, Math.round(r / 4));
  return (
    <g>
      <circle cx={cx} cy={cy} r={r + ring} fill="url(#ms-metal)" filter="url(#ms-shadow)" />
      <circle cx={cx} cy={cy} r={r + 1.2} fill="#000" />
      <circle cx={cx} cy={cy} r={r} fill="url(#ms-cream)" />
      <g fill="none" stroke="#000" strokeOpacity=".045" strokeWidth={r2(Math.max(0.5, r / 260))}>
        {Array.from({ length: rings }, (_, i) => (
          <circle key={i} cx={cx} cy={cy} r={r2((r * (i + 1)) / rings)} />
        ))}
      </g>
      <circle cx={cx} cy={cy} r={r2(r * 0.97)} fill="none" stroke={CLASSIC.dialInk} strokeOpacity=".55" strokeWidth={r2(Math.max(0.8, r / 140))} />
    </g>
  );
};

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
  /** 目盛りの広がり(度)。ふつうは 270(-135度〜135度)。 */
  sweep?: number;
};
/** 目盛りの角度。ふつうは -135度〜135度(sweep を決めると、そのぶん真上を中心に広がる)。 */
const scaleAngle = (o: Pick<ScaleOptions, "from" | "to" | "sweep">, value: number) => {
  const sweep = o.sweep ?? 270;
  return -sweep / 2 + (sweep * (Math.max(o.from, Math.min(o.to, value)) - o.from)) / (o.to - o.from);
};
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
        stroke={o.red !== undefined && v >= o.red ? CLASSIC.dialRed : CLASSIC.dialInk}
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
        fill={o.red !== undefined && v >= o.red ? CLASSIC.dialRed : CLASSIC.dialInk}
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

const APERTURES = {
  cruise: { x: SX - 116, y: SY + 132, w: 74, h: 40 },
  speed: { x: SX - 36, y: SY + 138, w: 72, h: 44 },
  fuel: { x: SX + 42, y: SY + 132, w: 74, h: 40 },
};
type ApertureKey = keyof typeof APERTURES;
const APERTURE_KEYS: ApertureKey[] = ["cruise", "speed", "fuel"];
const APERTURE_LABEL: Record<ApertureKey, string> = { cruise: "CRUISE km/h", speed: "SPEED km/h", fuel: "FUEL km/L" };
/** 速度計の下の値は、回るドラム(1つの値に3つ)。燃費は最後のドラムが小数(白いドラム)。 */
const VDRUM = { w: 15, gap: 2, h: 22 };
const vdrumX = (a: { x: number; w: number }) => a.x + (a.w - (VDRUM.w * 3 + VDRUM.gap * 2)) / 2;
const vdrumY = (a: { y: number }) => a.y + 16;
const isDecimalDrum = (k: ApertureKey, j: number) => k === "fuel" && j === 2;

/** 速度計の下の3つのドラムの枠と、上の説明(動かない所)。 */
const ApertureDrums = () => (
  <g>
    {APERTURE_KEYS.map((k) => {
      const a = APERTURES[k];
      const x = vdrumX(a);
      const y = vdrumY(a);
      return (
        <g key={k}>
          <text x={a.x + a.w / 2} y={a.y + 10} textAnchor="middle" fill={CLASSIC.plateInk} fontSize="7" fontWeight="700" letterSpacing="1">
            {APERTURE_LABEL[k]}
          </text>
          <rect x={x - 3} y={y - 3} width={VDRUM.w * 3 + VDRUM.gap * 2 + 6} height={VDRUM.h + 6} rx="3" fill="#141210" stroke="url(#ms-metal)" strokeWidth="1.8" />
          {[0, 1, 2].map((j) => (
            <rect key={j} x={x + j * (VDRUM.w + VDRUM.gap)} y={y} width={VDRUM.w} height={VDRUM.h} rx="1.5" fill={isDecimalDrum(k, j) ? "url(#ms-drum-light)" : "url(#ms-drum)"} />
          ))}
          {k === "fuel" ? <circle cx={x + 2 * (VDRUM.w + VDRUM.gap) - VDRUM.gap / 2} cy={y + VDRUM.h - 3} r="1.3" fill={CLASSIC.ink} /> : null}
        </g>
      );
    })}
  </g>
);

/** ドラムの数字(動く所)。値がないときは「---」。 */
const ApertureDigits = ({ values }: { values: Record<ApertureKey, string | null> }) => (
  <g>
    {APERTURE_KEYS.map((k) => {
      const a = APERTURES[k];
      const value = values[k];
      const digits = (value === null ? "---" : value.replace(".", "")).padStart(3, " ").slice(-3).split("");
      return digits.map((digit, j) => (
        <text
          key={`${k}${j}`}
          x={vdrumX(a) + j * (VDRUM.w + VDRUM.gap) + VDRUM.w / 2}
          y={vdrumY(a) + 16}
          textAnchor="middle"
          fill={isDecimalDrum(k, j) ? "#1a1612" : CLASSIC.ink}
          fontSize="14"
          fontWeight="700"
        >
          {digit}
        </text>
      ));
    })}
  </g>
);

/** 今日の距離(速度計の中の、回るドラム5つ)。 */
const ODO = { drums: 5, w: 16, gap: 2, h: 24, y: SY + 64 };
const ODO_X = SX - (ODO.drums * ODO.w + (ODO.drums - 1) * ODO.gap) / 2;
/** 回転計の目盛りは少し狭く(240度)して、下の空いた所に燃料と水温の小さなメーターを入れる。 */
const TACHO_SWEEP = 240;
const MINI = [
  { key: "fuel", cx: TX - 32, cy: TY + 88, lo: "E", hi: "F" },
  { key: "temp", cx: TX + 32, cy: TY + 88, lo: "C", hi: "H" },
] as const;
const MINI_R = 22;
/** 時計の中の、世界の3つの時刻の小さな時計。 */
const WORLD = [
  { name: "CALIF.", x: CX - 52, y: CY + 52 },
  { name: "RUSSIA", x: CX, y: CY + 66 },
  { name: "CHINA", x: CX + 52, y: CY + 52 },
];
const WORLD_R = 18;
/** 下の左右の板と、右の板の中の電圧・目的地・START。 */
const PANELS = [
  { x: 16, y: 352, w: 268, h: 196 },
  { x: 740, y: 352, w: 268, h: 196 },
];
const BATTERY_BOX = { x: 756, y: 366, w: 236, h: 36 };
const DEST_BTN = { x: 756, y: 410, w: 236, h: 44 };
const START_BTN = { x: 756, y: 462, w: 236, h: 72 };

/** 本物の針のメーターの、動かない絵。 */
const ClassicFace = memo(function ClassicFace() {
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <ClassicDefs />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#ms-leather)" />
      <rect width={BOARD_W} height={BOARD_H} filter="url(#ms-grain)" opacity=".16" />
      {/* 下の左右の板(縫い目入り) */}
      {PANELS.map((panel) => (
        <g key={panel.x}>
          <rect x={panel.x} y={panel.y} width={panel.w} height={panel.h} rx="16" fill="url(#ms-panel)" stroke="#2e261d" filter="url(#ms-shadow)" />
          <rect x={panel.x + 6} y={panel.y + 6} width={panel.w - 12} height={panel.h - 12} rx="11" fill="none" stroke={CLASSIC.stitch} strokeDasharray="4 3.5" opacity=".75" />
        </g>
      ))}
      {/* 左: 回転計(中に回転数の窓と、燃料・水温の小さなメーター) */}
      <Dial cx={TX} cy={TY} r={SIDE_R} ring={10} />
      <Scale cx={TX} cy={TY} r={SIDE_R - 6} from={0} to={8} major={1} mid={0.5} minor={0.25} label={1} labelR={96} font={17} red={RPM_RED / 1000} sweep={TACHO_SWEEP} />
      <rect x={TX - 26} y={TY - 62} width="52" height="18" rx="3" fill="#050505" stroke="url(#ms-metal-soft)" />
      <text x={TX} y={TY - 30} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="7" letterSpacing="1.6">
        ×1000 r/min
      </text>
      {MINI.map((g) => {
        const [lx, ly] = pol(g.cx, g.cy, MINI_R + 5, -60);
        const [hx, hy] = pol(g.cx, g.cy, MINI_R + 5, 60);
        return (
          <g key={g.key}>
            {Array.from({ length: 5 }, (_, i) => {
              const [x1, y1] = pol(g.cx, g.cy, MINI_R, -60 + i * 30);
              const [x2, y2] = pol(g.cx, g.cy, i % 2 === 0 ? MINI_R - 6 : MINI_R - 4, -60 + i * 30);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.dialInk} strokeWidth={i % 2 === 0 ? 1.6 : 0.9} />;
            })}
            <text x={lx} y={ly + 3} textAnchor="middle" fill={g.key === "fuel" ? CLASSIC.dialRed : CLASSIC.dialInk} fontSize="8" fontWeight="700">
              {g.lo}
            </text>
            <text x={hx} y={hy + 3} textAnchor="middle" fill={g.key === "temp" ? CLASSIC.dialRed : CLASSIC.dialInk} fontSize="8" fontWeight="700">
              {g.hi}
            </text>
          </g>
        );
      })}
      {/* 右: 時計(中に曜日・日付と、世界の3つの時刻の小さな時計) */}
      <Dial cx={CX} cy={CY} r={SIDE_R} ring={10} />
      {Array.from({ length: 60 }, (_, i) => {
        const major = i % 5 === 0;
        const [x1, y1] = pol(CX, CY, SIDE_R - 4, i * 6);
        const [x2, y2] = pol(CX, CY, major ? SIDE_R - 18 : SIDE_R - 10, i * 6);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.dialInk} strokeWidth={major ? (i === 0 ? 4.6 : 3.2) : 1.1} />;
      })}
      <text x={CX} y={CY - 60} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="7" letterSpacing="1.8">
        LOCAL TIME · JST
      </text>
      <rect x={CX + 40} y={CY - 10} width="28" height="20" rx="2" fill="#f4ecdc" stroke="url(#ms-metal-soft)" />
      <rect x={CX - 68} y={CY - 10} width="28" height="20" rx="2" fill="#0b0b0b" stroke="url(#ms-metal-soft)" />
      {WORLD.map((city) => (
        <g key={city.name}>
          <Dial cx={city.x} cy={city.y} r={WORLD_R} ring={2.5} />
          {Array.from({ length: 12 }, (_, k) => {
            const [x1, y1] = pol(city.x, city.y, WORLD_R - 2, k * 30);
            const [x2, y2] = pol(city.x, city.y, k % 3 === 0 ? WORLD_R - 6 : WORLD_R - 4, k * 30);
            return <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.dialInk} strokeWidth={k % 3 === 0 ? 1.3 : 0.7} />;
          })}
          <text x={city.x} y={city.y + WORLD_R + 10} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="5.8" letterSpacing=".8">
            {city.name}
          </text>
        </g>
      ))}
      {/* 真ん中: 速度計(左右より手前。中に今日の距離と、平均・速さのドラム) */}
      <Dial cx={SX} cy={SY} r={SPEED_R} ring={14} />
      <Scale cx={SX} cy={SY} r={SPEED_R - 12} from={0} to={SPEED_MAX} major={20} mid={10} minor={2} label={20} labelR={156} font={22} />
      <text x={SX} y={SY - 70} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="12" letterSpacing="3">
        km/h
      </text>
      <text x={SX} y={SY + 50} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="15" fontStyle="italic" fontWeight="700" letterSpacing="3" className="ms-serif" opacity=".8">
        Z CAR
      </text>
      <rect x={ODO_X - 4} y={ODO.y - 4} width={ODO.drums * ODO.w + (ODO.drums - 1) * ODO.gap + 8} height={ODO.h + 8} rx="4" fill="#141210" stroke="url(#ms-metal)" strokeWidth="1.8" />
      {Array.from({ length: ODO.drums }, (_, i) => (
        <rect key={i} x={ODO_X + i * (ODO.w + ODO.gap)} y={ODO.y} width={ODO.w} height={ODO.h} rx="1.5" fill={i === ODO.drums - 1 ? "url(#ms-drum-light)" : "url(#ms-drum)"} />
      ))}
      <text x={ODO_X - 10} y={ODO.y + 16} textAnchor="end" fill={CLASSIC.plateInk} fontSize="7" fontWeight="700" letterSpacing="1">
        TODAY
      </text>
      <text x={ODO_X + ODO.drums * ODO.w + (ODO.drums - 1) * ODO.gap + 10} y={ODO.y + 16} fill={CLASSIC.plateInk} fontSize="8" fontWeight="700">
        km
      </text>
      <ApertureDrums />
      {/* 左下の板: 天気と日の出・日の入り */}
      <text x="150" y="388" fill={CLASSIC.muted} fontSize="7.5" letterSpacing="1.6">
        OUTSIDE
      </text>
      <line x1="34" y1="448" x2="266" y2="448" stroke="#3a3027" />
      <g fill="none" stroke={CLASSIC.muted} strokeWidth="1.2">
        <path d="M36 496 h20 M40 492 a6 6 0 0 1 12 0" />
        <path d="M46 484 v3 M38 487 l2 2 M54 487 l-2 2" />
        <path d="M168 496 h20 M172 492 a6 6 0 0 1 12 0" />
      </g>
      <line x1="102" y1="493" x2="162" y2="493" stroke={CLASSIC.stitch} strokeDasharray="2 3" />
      {/* 右下の板: 電圧・目的地・START(金属の縁の、ねじ留めのクリーム色の板) */}
      <rect x={BATTERY_BOX.x} y={BATTERY_BOX.y} width={BATTERY_BOX.w} height={BATTERY_BOX.h} rx="10" fill="#0b0a09" stroke="url(#ms-metal-soft)" strokeWidth="1.6" />
      <text x={BATTERY_BOX.x + 16} y={BATTERY_BOX.y + 22} fill={CLASSIC.muted} fontSize="8" letterSpacing="2">
        BATTERY
      </text>
      {[DEST_BTN, START_BTN].map((b) => (
        <g key={b.y}>
          <rect x={b.x} y={b.y} width={b.w} height={b.h} rx="12" fill="url(#ms-metal)" filter="url(#ms-shadow)" />
          <rect x={b.x + 3} y={b.y + 3} width={b.w - 6} height={b.h - 6} rx="9" fill="url(#ms-ivory)" />
          {[
            [b.x + 11, b.y + 11],
            [b.x + b.w - 11, b.y + 11],
            [b.x + 11, b.y + b.h - 11],
            [b.x + b.w - 11, b.y + b.h - 11],
          ].map(([sx, sy]) => (
            <g key={`${sx}-${sy}`}>
              <circle cx={sx} cy={sy} r="3" fill="url(#ms-metal-soft)" stroke="#6d5f4c" strokeWidth=".6" />
              <line x1={sx - 2} y1={sy - 1} x2={sx + 2} y2={sy + 1} stroke="#4a3f33" strokeWidth=".8" />
            </g>
          ))}
        </g>
      ))}
      <text x={DEST_BTN.x + DEST_BTN.w / 2} y={DEST_BTN.y + 18} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="7.5" letterSpacing="2">
        CHANGE
      </text>
      <text x={DEST_BTN.x + DEST_BTN.w / 2} y={DEST_BTN.y + 35} textAnchor="middle" fill={CLASSIC.plateInk} fontSize="14" fontWeight="700" letterSpacing="3">
        DEST
      </text>
      <circle cx={START_BTN.x + 40} cy={START_BTN.y + START_BTN.h / 2} r="16" fill="none" stroke={CLASSIC.needle} strokeWidth="1.8" />
      <path
        d={`M${START_BTN.x + 40} ${START_BTN.y + START_BTN.h / 2 + 10} s6.5-6 6.5-10.8 a6.5 6.5 0 1 0-13 0 c0 4.8 6.5 10.8 6.5 10.8z`}
        fill="none"
        stroke={CLASSIC.plateInk}
        strokeWidth="1.6"
      />
      <text x={START_BTN.x + 68} y={START_BTN.y + 28} fill={CLASSIC.dialMuted} fontSize="8" letterSpacing="2.4">
        START
      </text>
      <path d={`M${START_BTN.x + START_BTN.w - 28} ${START_BTN.y + 27} l9 9 -9 9`} fill="none" stroke={CLASSIC.plateInk} strokeWidth="2" />
    </svg>
  );
});

/** 天気の小さな絵(線で描く)。 */
const ClassicWeatherIcon = ({ kind, isDay, x, y }: { kind: WeatherKind; isDay: boolean; x: number; y: number }) => {
  const cloud = (
    <path d="M-14 6 a8 8 0 0 1 8-8 a10 10 0 0 1 19 3 a6 6 0 0 1 0 12 h-22 a6 6 0 0 1-5-7z" fill="#1a1612" stroke={CLASSIC.ink} strokeWidth="1.6" />
  );
  const sun = isDay ? (
    <circle cx="-4" cy="-6" r="9" fill="none" stroke="#ffb15a" strokeWidth="1.8" />
  ) : (
    <path d="M-2 -15 a9 9 0 1 0 9 12 a7 7 0 0 1 -9 -12z" fill="none" stroke="#ffd79a" strokeWidth="1.6" />
  );
  return (
    <g transform={`translate(${x} ${y})`}>
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
  const rpmDeg = scaleAngle({ from: 0, to: 8, sweep: TACHO_SWEEP }, (data.rpm ?? 0) / 1000);
  const miniDeg = {
    fuel: -60 + 120 * clamp01(data.fuelPercent / 100),
    temp: -60 + 120 * clamp01(data.coolant === null ? 0 : (data.coolant - 50) / 70),
  };
  const miniValue = {
    fuel: { value: String(Math.round(data.rangeKm)), unit: "km" },
    temp: { value: data.coolant === null ? "—" : String(Math.round(data.coolant)), unit: "°C" },
  };
  const odometer = String(Math.min(99999, Math.round(data.todayKm * 10))).padStart(ODO.drums, "0").split("");
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
        {/* 左: 回転計 */}
        <text x={TX} y={TY - 48.5} textAnchor="middle" fill={CLASSIC.ink} fontSize="11" fontWeight="700">
          {data.rpm === null ? "—" : Math.round(data.rpm)}
        </text>
        {MINI.map((g) => (
          <g key={g.key}>
            <Needle cx={g.cx} cy={g.cy} len={MINI_R - 3} tail={4} width={3.2} deg={miniDeg[g.key]} />
            <Hub cx={g.cx} cy={g.cy} r={3.6} />
            <text x={g.cx} y={g.cy + 15} textAnchor="middle" fill={CLASSIC.dialInk} fontSize="9" fontWeight="700">
              {miniValue[g.key].value}
              <tspan fontSize="6.5" fill={CLASSIC.dialMuted}>
                {` ${miniValue[g.key].unit}`}
              </tspan>
            </text>
          </g>
        ))}
        <Needle cx={TX} cy={TY} len={112} tail={20} width={6.5} deg={rpmDeg} />
        <Hub cx={TX} cy={TY} r={10} />
        {/* 右: 時計と世界の時刻 */}
        <text x={CX + 54} y={CY + 5} textAnchor="middle" fill="#1a1612" fontSize="13" fontWeight="700">
          {data.day}
        </text>
        <text x={CX - 54} y={CY + 5} textAnchor="middle" fill={CLASSIC.needle} fontSize="12" fontWeight="700" className="ms-ja">
          {WEEKDAYS[data.weekday]}
        </text>
        <text x={CX} y={CY - 44} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="8" letterSpacing="2">
          {`${data.year}.${pad2(data.month)}.${pad2(data.day)}`}
        </text>
        {data.world.map((city, i) => {
          const { h, m } = readHm(city.time);
          const spot = WORLD[i] ?? WORLD[0];
          return (
            <g key={city.name}>
              <line x1={spot.x} y1={spot.y} x2={spot.x} y2={spot.y - 9} stroke={CLASSIC.dialInk} strokeWidth="1.9" strokeLinecap="round" transform={`rotate(${((h % 12) + m / 60) * 30} ${spot.x} ${spot.y})`} />
              <line x1={spot.x} y1={spot.y} x2={spot.x} y2={spot.y - 13.5} stroke={CLASSIC.dialInk} strokeWidth="1.2" strokeLinecap="round" transform={`rotate(${m * 6} ${spot.x} ${spot.y})`} />
              <circle cx={spot.x} cy={spot.y} r="1.7" fill={CLASSIC.needle} />
              <text x={spot.x} y={spot.y + WORLD_R + 19} textAnchor="middle" fill={CLASSIC.dialInk} fontSize="7.5" fontWeight="700">
                {city.time}
              </text>
            </g>
          );
        })}
        <g filter="url(#ms-shadow)">
          <polygon points="-5,9 0,-72 5,9" fill={CLASSIC.dialInk} transform={`translate(${CX} ${CY}) rotate(${r2(hands.hour)})`} />
          <polygon points="-3.8,11 0,-108 3.8,11" fill={CLASSIC.dialInk} transform={`translate(${CX} ${CY}) rotate(${r2(hands.minute)})`} />
          <g transform={`translate(${CX} ${CY}) rotate(${hands.second})`}>
            <line x1="0" y1="20" x2="0" y2="-116" stroke={CLASSIC.needle} strokeWidth="1.5" />
            <circle r="3.6" fill={CLASSIC.needle} />
          </g>
        </g>
        <Hub cx={CX} cy={CY} r={6} />
        {/* 真ん中: 速度計 */}
        {odometer.map((digit, i) => (
          <text
            key={i}
            x={ODO_X + i * (ODO.w + ODO.gap) + ODO.w / 2}
            y={ODO.y + 18}
            textAnchor="middle"
            fill={i === ODO.drums - 1 ? "#1a1612" : CLASSIC.ink}
            fontSize="16"
            fontWeight="700"
          >
            {digit}
          </text>
        ))}
        <ApertureDigits
          values={{
            cruise: data.avgCruise === null ? null : String(Math.round(data.avgCruise)),
            speed: data.speed === null ? null : String(Math.round(data.speed)),
            fuel: data.avgFuel === null ? null : data.avgFuel.toFixed(1),
          }}
        />
        <Needle cx={SX} cy={SY} len={196} tail={32} width={9} deg={speedDeg} />
        <Hub cx={SX} cy={SY} r={15} />
        {/* 左下の板: 天気と日の出・日の入り */}
        {kind && data.weather ? <ClassicWeatherIcon kind={kind} isDay={data.weather.isDay} x={52} y={404} /> : null}
        <text x="80" y="412" fill={CLASSIC.ink} fontSize="34" fontWeight="700" className="ms-serif">
          {data.weather ? Math.round(data.weather.temperature) : "—"}
          <tspan fontSize="14" dx="1">
            °C
          </tspan>
        </text>
        <text x="150" y="404" fill={CLASSIC.ink} fontSize="10.5" fontWeight="700" className="ms-ja">
          {kind ? WEATHER_JA[kind] : "天気を読み込み中"}
        </text>
        <text x="150" y="420" fill={CLASSIC.muted} fontSize="8.5">
          {forecast}
        </text>
        <text x="62" y="497" fill={CLASSIC.ink} fontSize="11" fontWeight="700">
          {data.sunrise ?? "--:--"}
        </text>
        <text x="194" y="497" fill={CLASSIC.ink} fontSize="11" fontWeight="700">
          {data.sunset ?? "--:--"}
        </text>
        {/* 右下の板: 電圧と START の行き先 */}
        <text x={BATTERY_BOX.x + BATTERY_BOX.w - 16} y={BATTERY_BOX.y + 24} textAnchor="end" fill={CLASSIC.ink} fontSize="17" fontWeight="700">
          {data.voltage === null ? "—" : data.voltage.toFixed(1)}
          <tspan fontSize="9" fill={CLASSIC.muted} dx="2">
            V
          </tspan>
        </text>
        <text x={START_BTN.x + 68} y={START_BTN.y + 51} fill={CLASSIC.plateInk} fontSize={dest.length <= 5 ? 20 : 16} fontWeight="700" className="ms-ja">
          {dest}
        </text>
      </svg>
      <Hit box={[MINI[0].cx - MINI_R - 4, MINI[0].cy - MINI_R - 4, MINI_R * 2 + 8, MINI_R + 26]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[APERTURES.fuel.x, APERTURES.fuel.y, APERTURES.fuel.w, APERTURES.fuel.h]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[DEST_BTN.x, DEST_BTN.y, DEST_BTN.w, DEST_BTN.h]} label="目的地を選ぶ" onPress={onDest} />
      <Hit
        box={[START_BTN.x, START_BTN.y, START_BTN.w, START_BTN.h]}
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
        <circle cx="60" cy="38" r="28" fill="#efe5cf" />
        {Array.from({ length: 15 }, (_, i) => {
          const [x1, y1] = pol(60, 38, 26, -135 + i * (270 / 14));
          const [x2, y2] = pol(60, 38, i % 2 ? 23.5 : 21.5, -135 + i * (270 / 14));
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.dialInk} strokeWidth={i % 2 ? 0.8 : 1.6} />;
        })}
        <line x1="60" y1="38" x2={nx} y2={ny} stroke={CLASSIC.needle} strokeWidth="2" strokeLinecap="round" />
        <circle cx="60" cy="38" r="3.4" fill="url(#ms-thumb-metal)" />
        <circle cx="19" cy="24" r="12" fill="url(#ms-thumb-metal)" />
        <circle cx="19" cy="24" r="10.5" fill="#efe5cf" />
        <line x1="19" y1="24" x2="25" y2="20" stroke={CLASSIC.needle} strokeWidth="1.4" />
        <circle cx="101" cy="24" r="12" fill="url(#ms-thumb-metal)" />
        <circle cx="101" cy="24" r="10.5" fill="#efe5cf" />
        <line x1="101" y1="24" x2="101" y2="16" stroke={CLASSIC.dialInk} strokeWidth="1.2" />
        <line x1="101" y1="24" x2="106" y2="27" stroke={CLASSIC.dialInk} strokeWidth="1.2" />
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
