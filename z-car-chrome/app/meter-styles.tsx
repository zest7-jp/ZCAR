"use client";

// 近未来のほかのテーマ(80年代のデジタル・本物の針・デイライト・八卦)の、メーターの画面。
// どれも 1024x566 の板に描き、使える広さに合わせて拡大・縮小する(車載機ではほぼ等倍)。
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
    label("ecoRpm", 1000, RETRO_ECO.lamp - 3, `≤${ECO_RPM} r/min`, { color: RETRO.soft, size: 9, anchor: "end", spacing: 1 }),
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
 * 三連のメーター。左に回転計、真ん中に大きな速度計、右に時計(曜日・日付だけ)。左右は少し小さく、少し高い所に置き、
 * 真ん中の金属の縁と重ならないように少しすき間をあける。それぞれの上に、縫い目入りの革のフード(日よけ)をかぶせる。
 * 下の左右の板に、天気と、電圧・目的地・START。
 */
const SX = 512;
const SY = 283;
const SPEED_R = 218;
const TX = 149;
const TY = 188;
const CX = 875;
const CY = 188;
const SIDE_R = 122;

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
    <linearGradient id="ms-hood" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#57463a" />
      <stop offset=".45" stopColor="#30261e" />
      <stop offset="1" stopColor="#15110d" />
    </linearGradient>
    <filter id="ms-grain-in" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="3" />
      <feColorMatrix type="matrix" values="0 0 0 0 .62  0 0 0 0 .5  0 0 0 0 .38  0 0 0 -1.2 .62" />
      <feComposite in2="SourceGraphic" operator="in" />
    </filter>
  </defs>
);

/** 金属の縁(外側にギザギザ)とクリーム色の文字盤(細い同心の輪の模様と、縁の内側の細い線)。 */
const Dial = ({ cx, cy, r, ring }: { cx: number; cy: number; r: number; ring: number }) => {
  const rings = Math.max(6, Math.round(r / 4));
  const outer = r + ring;
  const knurls = 2 * Math.round(outer * 0.8);
  const knurl = (odd: number) =>
    Array.from({ length: knurls / 2 }, (_, i) => {
      const deg = ((2 * i + odd) * 360) / knurls;
      return `M${pol(cx, cy, outer - 0.5, deg).join(" ")}L${pol(cx, cy, outer - ring * 0.42, deg).join(" ")}`;
    }).join("");
  return (
    <g>
      <circle cx={cx} cy={cy} r={outer} fill="url(#ms-metal)" filter="url(#ms-shadow)" />
      <path d={knurl(0)} stroke="#000" strokeOpacity=".4" strokeWidth="1.3" />
      <path d={knurl(1)} stroke="#fff" strokeOpacity=".35" strokeWidth="1.3" />
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

/** 速度計の下の、平均燃費の回るドラム(3つ。最後の白いドラムが小数)。 */
const FUEL_DRUM = { x: SX - 37, y: SY + 132, w: 74, h: 40 };
const VDRUM = { w: 15, gap: 2, h: 22 };
const VDRUM_X = FUEL_DRUM.x + (FUEL_DRUM.w - (VDRUM.w * 3 + VDRUM.gap * 2)) / 2;
const VDRUM_Y = FUEL_DRUM.y + 16;

/** 燃費のドラムの枠と、上の説明(動かない所)。 */
const FuelDrumFace = () => (
  <g>
    <text x={FUEL_DRUM.x + FUEL_DRUM.w / 2} y={FUEL_DRUM.y + 10} textAnchor="middle" fill={CLASSIC.plateInk} fontSize="7" fontWeight="700" letterSpacing="1">
      AVG FUEL km/L
    </text>
    <rect x={VDRUM_X - 3} y={VDRUM_Y - 3} width={VDRUM.w * 3 + VDRUM.gap * 2 + 6} height={VDRUM.h + 6} rx="3" fill="#141210" stroke="url(#ms-metal)" strokeWidth="1.8" />
    {[0, 1, 2].map((j) => (
      <rect key={j} x={VDRUM_X + j * (VDRUM.w + VDRUM.gap)} y={VDRUM_Y} width={VDRUM.w} height={VDRUM.h} rx="1.5" fill={j === 2 ? "url(#ms-drum-light)" : "url(#ms-drum)"} />
    ))}
    <circle cx={VDRUM_X + 2 * (VDRUM.w + VDRUM.gap) - VDRUM.gap / 2} cy={VDRUM_Y + VDRUM.h - 3} r="1.3" fill={CLASSIC.ink} />
  </g>
);

/** 燃費のドラムの数字(動く所)。値がないときは「---」。 */
const FuelDrumDigits = ({ value }: { value: string | null }) => (
  <g>
    {(value === null ? "---" : value.replace(".", ""))
      .padStart(3, " ")
      .slice(-3)
      .split("")
      .map((digit, j) => (
        <text
          key={j}
          x={VDRUM_X + j * (VDRUM.w + VDRUM.gap) + VDRUM.w / 2}
          y={VDRUM_Y + 16}
          textAnchor="middle"
          fill={j === 2 ? "#1a1612" : CLASSIC.ink}
          fontSize="14"
          fontWeight="700"
        >
          {digit}
        </text>
      ))}
  </g>
);

/** 今日の距離(速度計の中の、回るドラム5つ)。 */
const ODO = { drums: 5, w: 16, gap: 2, h: 24, y: SY + 64 };
const ODO_X = SX - (ODO.drums * ODO.w + (ODO.drums - 1) * ODO.gap) / 2;
/**
 * 小さなメーター: 燃料は回転計の下、水温は時計の下(どちらも真ん中)。
 * 回転計の目盛りは少し狭く(240度)して、下に燃料のメーターの場所をとる。
 */
const TACHO_SWEEP = 240;
const MINI = [
  { key: "fuel", cx: TX, cy: TY + 81, lo: "E", hi: "F" },
  { key: "temp", cx: CX, cy: CY + 81, lo: "C", hi: "H" },
] as const;
const MINI_R = 22;
type MiniGauge = (typeof MINI)[number];
/** 小さなメーターの目盛りと E・F(C・H)の文字(動かない所)。空に近い側・熱い側は赤。 */
const MiniGaugeFace = ({ g }: { g: MiniGauge }) => {
  const [lx, ly] = pol(g.cx, g.cy, MINI_R + 5, -60);
  const [hx, hy] = pol(g.cx, g.cy, MINI_R + 5, 60);
  return (
    <g>
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
};
/** 下の左右の板と、右の板の中の電圧・目的地・START。 */
const PANELS = [
  { x: 16, y: 352, w: 268, h: 196 },
  { x: 740, y: 352, w: 268, h: 196 },
];
const BATTERY_BOX = { x: 756, y: 366, w: 236, h: 36 };
const DEST_BTN = { x: 756, y: 410, w: 236, h: 44 };
const START_BTN = { x: 756, y: 462, w: 236, h: 72 };
/** 3つのメーター(フードとガラスに使う)。span はフードの両はしの角度、thick はフードの真上の厚さ。 */
const GAUGES = [
  { cx: TX, cy: TY, r: SIDE_R, ring: 10, span: 56, thick: 20 },
  { cx: CX, cy: CY, r: SIDE_R, ring: 10, span: 56, thick: 20 },
  { cx: SX, cy: SY, r: SPEED_R, ring: 14, span: 46, thick: 26 },
];
type Gauge = (typeof GAUGES)[number];

/**
 * 上が厚く両はしが細くなる三日月の形。内側は半径 ri の円(メーターの縁に沿う)、外側は両はしと
 * 「真上で厚さ t」の点を通る円(中心は oy、半径は ro)。span はメーターの中心から見た両はしの角度。
 */
const crescent = (cx: number, cy: number, ri: number, t: number, span: number) => {
  const cos = Math.cos((span * Math.PI) / 180);
  const shift = (-t * (2 * ri + t)) / (2 * (ri * (1 - cos) + t));
  const ro = r2(shift + ri + t);
  const [x0, y0] = pol(cx, cy, ri, -span);
  const [x1, y1] = pol(cx, cy, ri, span);
  const large = -ri * cos > shift ? 1 : 0;
  return { x0, y0, x1, y1, ro, oy: cy + shift, large, d: `M${x0} ${y0}A${ri} ${ri} 0 0 1 ${x1} ${y1}A${ro} ${ro} 0 ${large} 0 ${x0} ${y0}Z` };
};
/** メーターの上にかぶさる革のフード(日よけ)。上の縁に光、真ん中に縫い目。 */
const Hood = ({ g }: { g: Gauge }) => {
  const ri = g.r + g.ring + 3;
  const hood = crescent(g.cx, g.cy, ri, g.thick, g.span);
  // 縫い目は厚さの半分の所を通る円の上。両はしの細い所は縫わない。
  const mid = crescent(g.cx, g.cy, ri, g.thick / 2, g.span);
  const tip = (Math.atan2(mid.x1 - g.cx, mid.oy - mid.y1) * 180) / Math.PI;
  const [s0x, s0y] = pol(g.cx, mid.oy, mid.ro, -tip * 0.8);
  const [s1x, s1y] = pol(g.cx, mid.oy, mid.ro, tip * 0.8);
  return (
    <g>
      <path d={hood.d} fill="url(#ms-hood)" stroke="#0a0806" filter="url(#ms-shadow)" />
      <path d={hood.d} filter="url(#ms-grain-in)" opacity=".22" />
      <path d={`M${hood.x1} ${hood.y1}A${hood.ro} ${hood.ro} 0 ${hood.large} 0 ${hood.x0} ${hood.y0}`} fill="none" stroke="#ffe8cc" strokeOpacity=".28" strokeWidth="1.2" />
      <path d={`M${s0x} ${s0y}A${mid.ro} ${mid.ro} 0 0 1 ${s1x} ${s1y}`} fill="none" stroke="#a88a66" strokeDasharray="4 3.5" opacity=".8" />
    </g>
  );
};
/** ガラスの映り込みの三日月(左上が一番太い)。文字盤と同じ大きさの円を、右下へ少しずらした円でくりぬく。 */
const glarePath = (g: Gauge) => {
  const a = r2(g.r * 0.975);
  const shift = g.r * 0.2;
  const u = Math.SQRT1_2;
  const mx = g.cx + (shift / 2) * u;
  const my = g.cy + (shift / 2) * u;
  const h = Math.sqrt(a * a - (shift * shift) / 4) * u;
  const [x1, y1, x2, y2] = [r2(mx - h), r2(my + h), r2(mx + h), r2(my - h)];
  return `M${x1} ${y1}A${a} ${a} 0 1 1 ${x2} ${y2}A${a} ${a} 0 0 0 ${x1} ${y1}Z`;
};
/** 文字盤のガラス(針より上に描く)。上にフードの影、縁の内側の影、左上の映り込み。 */
const ClassicGlass = memo(function ClassicGlass() {
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <defs>
        <linearGradient id="ms-hood-shade" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#000" stopOpacity=".5" />
          <stop offset=".3" stopColor="#000" stopOpacity=".14" />
          <stop offset=".5" stopColor="#000" stopOpacity="0" />
        </linearGradient>
        <radialGradient id="ms-glass-edge" cx=".5" cy=".5" r=".5">
          <stop offset=".8" stopColor="#000" stopOpacity="0" />
          <stop offset=".94" stopColor="#000" stopOpacity=".1" />
          <stop offset="1" stopColor="#000" stopOpacity=".32" />
        </radialGradient>
        <linearGradient id="ms-glare" x1="0" y1="0" x2=".8" y2=".8">
          <stop offset="0" stopColor="#fff" stopOpacity=".62" />
          <stop offset=".42" stopColor="#fff" stopOpacity=".2" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="ms-glare-line" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".45" stopColor="#fff" stopOpacity=".6" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {GAUGES.map((g, i) => (
          <clipPath key={i} id={`ms-glass-clip-${i}`}>
            <circle cx={g.cx} cy={g.cy} r={g.r} />
          </clipPath>
        ))}
      </defs>
      {GAUGES.map((g, i) => {
        const line = r2(g.r * 0.9);
        return (
          <g key={i} clipPath={`url(#ms-glass-clip-${i})`}>
            <rect x={g.cx - g.r} y={g.cy - g.r} width={g.r * 2} height={g.r * 2} fill="url(#ms-hood-shade)" />
            <circle cx={g.cx} cy={g.cy} r={g.r} fill="url(#ms-glass-edge)" />
            <path d={glarePath(g)} fill="url(#ms-glare)" />
            <path
              d={`M${pol(g.cx, g.cy, line, -78).join(" ")}A${line} ${line} 0 0 1 ${pol(g.cx, g.cy, line, -18).join(" ")}`}
              fill="none"
              stroke="url(#ms-glare-line)"
              strokeWidth={r2(g.r / 70)}
              strokeLinecap="round"
            />
          </g>
        );
      })}
    </svg>
  );
});

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
      {GAUGES.map((g) => (
        <Hood key={g.cx} g={g} />
      ))}
      {/* 左: 回転計(中に回転数の窓と、燃料の小さなメーター) */}
      <Dial cx={TX} cy={TY} r={SIDE_R} ring={10} />
      <Scale cx={TX} cy={TY} r={SIDE_R - 6} from={0} to={8} major={1} mid={0.5} minor={0.25} label={1} labelR={90} font={16} red={RPM_RED / 1000} sweep={TACHO_SWEEP} />
      <rect x={TX - 26} y={TY - 62} width="52" height="18" rx="3" fill="#050505" stroke="url(#ms-metal-soft)" />
      <text x={TX} y={TY - 30} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="7" letterSpacing="1.6">
        ×1000 r/min
      </text>
      <MiniGaugeFace g={MINI[0]} />
      {/* 右: 時計(中に曜日と日付の小窓、上に LOCAL TIME と年月日、下に水温の小さなメーター) */}
      <Dial cx={CX} cy={CY} r={SIDE_R} ring={10} />
      {Array.from({ length: 60 }, (_, i) => {
        const major = i % 5 === 0;
        const [x1, y1] = pol(CX, CY, SIDE_R - 4, i * 6);
        const [x2, y2] = pol(CX, CY, major ? SIDE_R - 18 : SIDE_R - 10, i * 6);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={CLASSIC.dialInk} strokeWidth={major ? (i === 0 ? 4.6 : 3.2) : 1.1} />;
      })}
      <text x={CX} y={CY - 58} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="8" letterSpacing="2.2">
        LOCAL TIME · JST
      </text>
      <MiniGaugeFace g={MINI[1]} />
      <rect x={CX + 40} y={CY - 10} width="28" height="20" rx="2" fill="#f4ecdc" stroke="url(#ms-metal-soft)" />
      <rect x={CX - 68} y={CY - 10} width="28" height="20" rx="2" fill="#0b0b0b" stroke="url(#ms-metal-soft)" />
      {/* 真ん中: 速度計(中に今日の距離と、平均・速さのドラム) */}
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
      <FuelDrumFace />
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

/** 時計の秒針のため、1秒ごとに今の時刻を読む(読めるまでは data.clock の時・分)。 */
const useClockTime = (clock: string) => {
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
  return now ?? { ...readHm(clock), s: 0 };
};
/** 3時間後・6時間後の気温(「+3H 20° · +6H 19°」)。 */
const forecastText = (weather: ClusterWeather | null) =>
  (weather?.hours ?? [])
    .slice(0, 2)
    .map((hour, i) => `${i === 0 ? "+3H" : "+6H"} ${Math.round(hour.temperature)}°`)
    .join(" · ");

export function ClassicCluster({ data, onFuel, onDest, onStart }: ClusterProps) {
  const time = useClockTime(data.clock);
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
  const forecast = forecastText(data.weather);
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
        <Needle cx={TX} cy={TY} len={105} tail={19} width={6.5} deg={rpmDeg} />
        <Hub cx={TX} cy={TY} r={10} />
        {/* 右: 時計 */}
        <text x={CX + 54} y={CY + 5} textAnchor="middle" fill="#1a1612" fontSize="13" fontWeight="700">
          {data.day}
        </text>
        <text x={CX - 54} y={CY + 5} textAnchor="middle" fill={CLASSIC.needle} fontSize="12" fontWeight="700" className="ms-ja">
          {WEEKDAYS[data.weekday]}
        </text>
        <text x={CX} y={CY - 42} textAnchor="middle" fill={CLASSIC.dialMuted} fontSize="8.5" letterSpacing="2.2">
          {`${data.year}.${pad2(data.month)}.${pad2(data.day)}`}
        </text>
        <g filter="url(#ms-shadow)">
          <polygon points="-5,9 0,-68 5,9" fill={CLASSIC.dialInk} transform={`translate(${CX} ${CY}) rotate(${r2(hands.hour)})`} />
          <polygon points="-3.8,11 0,-101 3.8,11" fill={CLASSIC.dialInk} transform={`translate(${CX} ${CY}) rotate(${r2(hands.minute)})`} />
          <g transform={`translate(${CX} ${CY}) rotate(${hands.second})`}>
            <line x1="0" y1="20" x2="0" y2="-109" stroke={CLASSIC.needle} strokeWidth="1.5" />
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
        <FuelDrumDigits value={data.avgFuel === null ? null : data.avgFuel.toFixed(1)} />
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
      <ClassicGlass />
      <Hit box={[MINI[0].cx - MINI_R - 4, MINI[0].cy - MINI_R - 4, MINI_R * 2 + 8, MINI_R + 26]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[FUEL_DRUM.x, FUEL_DRUM.y, FUEL_DRUM.w, FUEL_DRUM.h]} label="燃費の記録・確認を開く" onPress={onFuel} />
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
// デイライト: 昼間の日差しの中でも読みやすい、白い文字盤の三連メーター。
// 並びは本物の針のテーマと同じ(左に回転計、真ん中に速度計、右に時計、下の左右に板)。
// 明るいアルミの板に、クロムの縁・白い文字盤・影の落ちる針・液晶の小窓を、本物のメーターに似せて描く。
// ------------------------------------------------------------------

const DAY = {
  ink: "#121315",
  soft: "#3d4044",
  muted: "#6b6f74",
  red: "#d7261e",
  blue: "#1d5fc4",
  lcdInk: "#1b2019",
};
type Box = { x: number; y: number; w: number; h: number };
/** 速度計の中の液晶(速さ)と、その下の液晶(今日の距離・平均燃費)。 */
const DAY_SPEED_LCD: Box = { x: SX - 75, y: SY + 32, w: 150, h: 64 };
const DAY_INFO_LCD: Box = { x: SX - 86, y: SY + 124, w: 172, h: 38 };
/** 回転計の中の液晶(回転数)。 */
const DAY_RPM_LCD: Box = { x: TX - 31, y: TY - 64, w: 62, h: 26 };
/** 時計の中の、曜日と日付の小窓。 */
const DAY_WEEK_WIN: Box = { x: CX - 72, y: CY - 13, w: 34, h: 26 };
const DAY_DATE_WIN: Box = { x: CX + 38, y: CY - 13, w: 34, h: 26 };
/** 左下の天気の液晶と、右下の電圧の液晶。 */
const DAY_WEATHER_LCD: Box = { x: PANELS[0].x + 10, y: PANELS[0].y + 10, w: PANELS[0].w - 20, h: PANELS[0].h - 20 };
const DAY_LCDS = [DAY_SPEED_LCD, DAY_INFO_LCD, DAY_RPM_LCD, DAY_WEATHER_LCD, BATTERY_BOX];

const DayDefs = () => (
  <defs>
    <linearGradient id="md-alu" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#e1e3e5" />
      <stop offset=".55" stopColor="#cfd2d5" />
      <stop offset="1" stopColor="#babec2" />
    </linearGradient>
    {/* アルミの細いヘアライン(横の筋) */}
    <filter id="md-brush" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency=".0016 .7" numOctaves="2" seed="5" />
      <feColorMatrix type="matrix" values="1 0 0 0 0  1 0 0 0 0  1 0 0 0 0  0 0 0 0 .2" />
    </filter>
    <linearGradient id="md-chrome" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#ffffff" />
      <stop offset=".2" stopColor="#a3a9ae" />
      <stop offset=".45" stopColor="#f6f7f8" />
      <stop offset=".7" stopColor="#5b6065" />
      <stop offset="1" stopColor="#dcdfe2" />
    </linearGradient>
    <linearGradient id="md-chrome-v" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#f4f5f6" />
      <stop offset=".5" stopColor="#8a8f94" />
      <stop offset="1" stopColor="#d8dbde" />
    </linearGradient>
    <radialGradient id="md-face" cx=".5" cy=".42" r=".62">
      <stop offset="0" stopColor="#ffffff" />
      <stop offset=".72" stopColor="#fafaf7" />
      <stop offset="1" stopColor="#e8e7e2" />
    </radialGradient>
    <linearGradient id="md-lcd" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#b5bdac" />
      <stop offset=".16" stopColor="#cbd2c3" />
      <stop offset="1" stopColor="#c3cbba" />
    </linearGradient>
    <linearGradient id="md-plastic" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#3b3e42" />
      <stop offset="1" stopColor="#1e2023" />
    </linearGradient>
    <linearGradient id="md-key" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#ffffff" />
      <stop offset="1" stopColor="#d9dbdd" />
    </linearGradient>
    <linearGradient id="md-key-orange" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#ff7b30" />
      <stop offset="1" stopColor="#dc4c06" />
    </linearGradient>
    <filter id="md-shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#000" floodOpacity=".45" />
    </filter>
    <filter id="md-soft" x="-20%" y="-30%" width="140%" height="170%">
      <feDropShadow dx="0" dy="2" stdDeviation="1.6" floodColor="#000" floodOpacity=".35" />
    </filter>
  </defs>
);

/** クロムの縁(板との間に黒いすき間)と、白い文字盤(縁との間に黒いゴム)。 */
const DayDial = ({ g }: { g: Gauge }) => (
  <g>
    <circle cx={g.cx} cy={g.cy} r={g.r + g.ring + 3} fill="#2a2c2f" />
    <circle cx={g.cx} cy={g.cy} r={g.r + g.ring} fill="url(#md-chrome)" filter="url(#md-shadow)" />
    <circle cx={g.cx} cy={g.cy} r={r2(g.r + g.ring - 1.2)} fill="none" stroke="#fff" strokeOpacity=".6" strokeWidth="1.2" />
    <circle cx={g.cx} cy={g.cy} r={g.r + 1.8} fill="#0b0c0d" />
    <circle cx={g.cx} cy={g.cy} r={g.r} fill="url(#md-face)" />
  </g>
);

/** 白い文字盤に刷った目盛りと数字(太く、はっきり)。外まわりに細い線。red から上は赤い帯と赤。 */
const DayScale = (o: ScaleOptions) => {
  const nodes: ReactNode[] = [];
  const steps = Math.round((o.to - o.from) / o.minor);
  for (let i = 0; i <= steps; i += 1) {
    const v = o.from + i * o.minor;
    const major = near(v, o.major);
    const mid = near(v, o.mid);
    const len = major ? o.r * 0.12 : mid ? o.r * 0.08 : o.r * 0.05;
    const width = major ? Math.max(3, o.r * 0.019) : mid ? Math.max(2, o.r * 0.012) : Math.max(1.3, o.r * 0.007);
    const deg = scaleAngle(o, v);
    const [x1, y1] = pol(o.cx, o.cy, o.r, deg);
    const [x2, y2] = pol(o.cx, o.cy, o.r - len, deg);
    const hot = o.red !== undefined && v >= o.red;
    nodes.push(<line key={`t${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={hot ? DAY.red : DAY.ink} strokeWidth={r2(width)} />);
  }
  const labels = Math.round((o.to - o.from) / o.label);
  for (let i = 0; i <= labels; i += 1) {
    const v = o.from + i * o.label;
    const [x, y] = pol(o.cx, o.cy, o.labelR, scaleAngle(o, v));
    nodes.push(
      <text
        key={`l${i}`}
        x={x}
        y={r2(y + o.font * 0.36)}
        textAnchor="middle"
        className="md-num"
        fill={o.red !== undefined && v >= o.red ? DAY.red : DAY.ink}
        fontSize={o.font}
        fontWeight="700"
      >
        {v}
      </text>,
    );
  }
  const [ax, ay] = pol(o.cx, o.cy, o.r, scaleAngle(o, o.from));
  const [bx, by] = pol(o.cx, o.cy, o.r, scaleAngle(o, o.to));
  let red: ReactNode = null;
  if (o.red !== undefined) {
    const rr = r2(o.r * 0.97);
    const [x0, y0] = pol(o.cx, o.cy, rr, scaleAngle(o, o.red));
    const [x1, y1] = pol(o.cx, o.cy, rr, scaleAngle(o, o.to));
    red = <path d={`M${x0} ${y0}A${rr} ${rr} 0 0 1 ${x1} ${y1}`} fill="none" stroke={DAY.red} strokeWidth={r2(o.r * 0.06)} />;
  }
  return (
    <g>
      {red}
      <path d={`M${ax} ${ay}A${o.r} ${o.r} 0 1 1 ${bx} ${by}`} fill="none" stroke={DAY.ink} strokeWidth="1.4" />
      {nodes}
    </g>
  );
};

/** 液晶の小窓の枠(黒いふち・少し沈んだ緑がかった液晶)。 */
const LcdFrame = ({ box, rx = 5 }: { box: Box; rx?: number }) => (
  <g>
    <rect x={box.x - 3} y={box.y - 3} width={box.w + 6} height={box.h + 6} rx={rx + 2} fill="#1c1e21" />
    <rect x={box.x} y={box.y} width={box.w} height={box.h} rx={rx} fill="url(#md-lcd)" />
    <rect x={box.x + 0.75} y={box.y + 0.75} width={box.w - 1.5} height={box.h - 1.5} rx={rx} fill="none" stroke="#000" strokeOpacity=".3" strokeWidth="1.5" />
  </g>
);

/** 小さなメーター(燃料・水温)の目盛り・文字・絵(動かない所)。空に近い側・熱い側は赤、冷たい側は青。 */
const DayMiniFace = ({ g }: { g: MiniGauge }) => {
  const r = MINI_R + 2;
  const [lx, ly] = pol(g.cx, g.cy, r + 8, -60);
  const [hx, hy] = pol(g.cx, g.cy, r + 8, 60);
  const hot = g.key === "fuel" ? [-60, -40] : [40, 60];
  const [h0x, h0y] = pol(g.cx, g.cy, r - 1.5, hot[0]);
  const [h1x, h1y] = pol(g.cx, g.cy, r - 1.5, hot[1]);
  return (
    <g>
      <path d={`M${h0x} ${h0y}A${r - 1.5} ${r - 1.5} 0 0 1 ${h1x} ${h1y}`} fill="none" stroke={DAY.red} strokeWidth="4" />
      {Array.from({ length: 5 }, (_, i) => {
        const [x1, y1] = pol(g.cx, g.cy, r, -60 + i * 30);
        const [x2, y2] = pol(g.cx, g.cy, i % 2 === 0 ? r - 8 : r - 5, -60 + i * 30);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={DAY.ink} strokeWidth={i % 2 === 0 ? 2.6 : 1.6} />;
      })}
      <text x={lx} y={ly + 4} textAnchor="middle" fill={g.key === "fuel" ? DAY.red : DAY.blue} fontSize="11" fontWeight="700">
        {g.lo}
      </text>
      <text x={hx} y={hy + 4} textAnchor="middle" fill={g.key === "temp" ? DAY.red : DAY.ink} fontSize="11" fontWeight="700">
        {g.hi}
      </text>
      {g.key === "fuel" ? (
        <g transform={`translate(${g.cx} ${g.cy + 13})`} fill="none" stroke={DAY.soft} strokeWidth="1.3">
          <rect x="-5" y="-5" width="7" height="10" rx="1" fill={DAY.soft} stroke="none" />
          <rect x="-3.6" y="-3.6" width="4.2" height="3" fill="#fff" stroke="none" />
          <path d="M2 -3 l3 2.5 v4.5 a1.1 1.1 0 0 0 2.2 0 v-6 l-2 -2" />
        </g>
      ) : (
        <g transform={`translate(${g.cx} ${g.cy + 13})`} fill="none" stroke={DAY.soft} strokeWidth="1.4" strokeLinecap="round">
          <path d="M0 -6 v7" />
          <circle cy="3" r="2.4" fill={DAY.soft} stroke="none" />
          <path d="M-7 7 q1.75 -1.4 3.5 0 t3.5 0 t3.5 0 t3.5 0" />
        </g>
      )}
    </g>
  );
};

/** デイライトの動かない絵: アルミの板・下の左右の板・3つのメーターの文字盤・液晶の枠・ボタン。 */
const DayFace = memo(function DayFace() {
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <DayDefs />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#md-alu)" />
      <rect width={BOARD_W} height={BOARD_H} filter="url(#md-brush)" />
      {PANELS.map((panel) => (
        <rect key={panel.x} x={panel.x} y={panel.y} width={panel.w} height={panel.h} rx="16" fill="url(#md-plastic)" filter="url(#md-shadow)" />
      ))}
      {GAUGES.map((g) => (
        <DayDial key={g.cx} g={g} />
      ))}
      {/* 左: 回転計(中に回転数の液晶と、燃料の小さなメーター) */}
      <DayScale cx={TX} cy={TY} r={SIDE_R - 4} from={0} to={8} major={1} mid={0.5} minor={0.25} label={1} labelR={84} font={23} red={RPM_RED / 1000} sweep={TACHO_SWEEP} />
      <LcdFrame box={DAY_RPM_LCD} rx={3} />
      <text x={TX} y={TY + 34} textAnchor="middle" fill={DAY.soft} fontSize="8.5" fontWeight="700" letterSpacing="1.4">
        ×1000 r/min
      </text>
      <DayMiniFace g={MINI[0]} />
      {/* 右: 時計(中に曜日と日付の小窓、下に水温の小さなメーター。6時のまわりは水温の数字のため目盛りを刷らない) */}
      {Array.from({ length: 60 }, (_, i) => {
        if (i >= 28 && i <= 32) return null;
        const major = i % 5 === 0;
        const [x1, y1] = pol(CX, CY, SIDE_R - 4, i * 6);
        const [x2, y2] = pol(CX, CY, major ? SIDE_R - 20 : SIDE_R - 10, i * 6);
        return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={DAY.ink} strokeWidth={major ? (i === 0 ? 6 : 4.6) : 1.6} />;
      })}
      {[
        [12, 0],
        [3, 90],
        [9, 270],
      ].map(([n, deg]) => {
        const [x, y] = pol(CX, CY, SIDE_R - 34, deg);
        return (
          <text key={n} x={x} y={y + 8} textAnchor="middle" className="md-num" fill={DAY.ink} fontSize="23" fontWeight="700">
            {n}
          </text>
        );
      })}
      <text x={CX} y={CY - 52} textAnchor="middle" fill={DAY.muted} fontSize="7.5" fontWeight="700" letterSpacing="2">
        LOCAL TIME · JST
      </text>
      <rect x={DAY_WEEK_WIN.x - 2} y={DAY_WEEK_WIN.y - 2} width={DAY_WEEK_WIN.w + 4} height={DAY_WEEK_WIN.h + 4} rx="4" fill="url(#md-chrome-v)" />
      <rect x={DAY_WEEK_WIN.x} y={DAY_WEEK_WIN.y} width={DAY_WEEK_WIN.w} height={DAY_WEEK_WIN.h} rx="2.5" fill="#161719" />
      <rect x={DAY_DATE_WIN.x - 2} y={DAY_DATE_WIN.y - 2} width={DAY_DATE_WIN.w + 4} height={DAY_DATE_WIN.h + 4} rx="4" fill="url(#md-chrome-v)" />
      <rect x={DAY_DATE_WIN.x} y={DAY_DATE_WIN.y} width={DAY_DATE_WIN.w} height={DAY_DATE_WIN.h} rx="2.5" fill="#ffffff" />
      <DayMiniFace g={MINI[1]} />
      {/* 真ん中: 速度計(中に速さの液晶と、今日の距離・平均燃費の液晶) */}
      <DayScale cx={SX} cy={SY} r={SPEED_R - 10} from={0} to={SPEED_MAX} major={20} mid={10} minor={5} label={20} labelR={150} font={30} />
      <text x={SX} y={SY - 74} textAnchor="middle" fill={DAY.soft} fontSize="15" fontWeight="700">
        km/h
      </text>
      <text x={SX} y={SY - 52} textAnchor="middle" fill={DAY.muted} fontSize="10" fontStyle="italic" fontWeight="700" letterSpacing="3">
        Z CAR
      </text>
      <LcdFrame box={DAY_SPEED_LCD} rx={6} />
      <LcdFrame box={DAY_INFO_LCD} rx={5} />
      {/* 左下: 天気の液晶 */}
      <LcdFrame box={DAY_WEATHER_LCD} rx={8} />
      {/* 右下: 電圧の液晶と、DEST・START のボタン */}
      <LcdFrame box={BATTERY_BOX} rx={5} />
      <text x={BATTERY_BOX.x + 12} y={BATTERY_BOX.y + 22} fill={DAY.lcdInk} fontSize="9" fontWeight="700" letterSpacing="2" opacity=".75">
        BATTERY
      </text>
      <rect x={DEST_BTN.x} y={DEST_BTN.y} width={DEST_BTN.w} height={DEST_BTN.h} rx="10" fill="url(#md-key)" filter="url(#md-soft)" />
      <rect x={DEST_BTN.x + 0.75} y={DEST_BTN.y + 0.75} width={DEST_BTN.w - 1.5} height={DEST_BTN.h - 1.5} rx="9.5" fill="none" stroke="#fff" strokeWidth="1.5" />
      <text x={DEST_BTN.x + 18} y={DEST_BTN.y + 28} fill={DAY.soft} fontSize="11" fontWeight="700">
        目的地
        <tspan dx="8" fill={DAY.ink} fontSize="19" letterSpacing="1.5">
          DEST
        </tspan>
      </text>
      <path d={`M${DEST_BTN.x + DEST_BTN.w - 28} ${DEST_BTN.y + 14} l8 8 -8 8`} fill="none" stroke={DAY.ink} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <rect x={START_BTN.x} y={START_BTN.y} width={START_BTN.w} height={START_BTN.h} rx="12" fill="url(#md-key-orange)" filter="url(#md-soft)" />
      <rect x={START_BTN.x + 0.75} y={START_BTN.y + 0.75} width={START_BTN.w - 1.5} height={START_BTN.h - 1.5} rx="11.5" fill="none" stroke="#ffb98c" strokeWidth="1.5" />
      <circle cx={START_BTN.x + 34} cy={START_BTN.y + 36} r="19" fill="#fff" opacity=".18" />
      <path
        d={`M${START_BTN.x + 34} ${START_BTN.y + 49} c-7 -8 -10 -12.5 -10 -17 a10 10 0 0 1 20 0 c0 4.5 -3 9 -10 17z`}
        fill="none"
        stroke="#fff"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <circle cx={START_BTN.x + 34} cy={START_BTN.y + 31.5} r="3.4" fill="#fff" />
      <text x={START_BTN.x + 64} y={START_BTN.y + 26} fill="#fff" fontSize="9" fontWeight="700" letterSpacing="2.4" opacity=".9">
        START
      </text>
      <path d={`M${START_BTN.x + START_BTN.w - 28} ${START_BTN.y + 26} l10 10 -10 10`} fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
});

/** 立体の針(左半分が明るく、右半分が暗い。根元のおもりは黒)。右下に影を落とす。少しの時間をかけて動く。 */
const DayNeedle = ({ cx, cy, len, tail, width, deg }: { cx: number; cy: number; len: number; tail: number; width: number; deg: number }) => {
  const half = width / 2;
  const tip = Math.max(0.8, width * 0.1);
  const body = (ox: number, oy: number) =>
    `${r2(cx + ox - half)},${r2(cy + oy)} ${r2(cx + ox - tip)},${r2(cy + oy - len)} ${r2(cx + ox + tip)},${r2(cy + oy - len)} ${r2(cx + ox + half)},${r2(cy + oy)}`;
  const shade = { x: r2(width * 0.35), y: r2(width * 0.5) };
  const rotate = { transform: `rotate(${r2(deg)}deg)` };
  return (
    <g>
      <g className="ms-needle" style={{ ...rotate, transformOrigin: `${r2(cx + shade.x)}px ${r2(cy + shade.y)}px` }}>
        <polygon points={body(shade.x, shade.y)} fill="#000" opacity=".22" />
      </g>
      <g className="ms-needle" style={{ ...rotate, transformOrigin: `${cx}px ${cy}px` }}>
        <polygon points={`${r2(cx - half * 1.1)},${cy} ${r2(cx - half * 1.3)},${cy + tail} ${r2(cx + half * 1.3)},${cy + tail} ${r2(cx + half * 1.1)},${cy}`} fill="#18191b" />
        <polygon points={`${r2(cx - half)},${cy} ${r2(cx - tip)},${cy - len} ${cx},${r2(cy - len - 1)} ${cx},${cy}`} fill="#ff6b35" />
        <polygon points={`${cx},${cy} ${cx},${r2(cy - len - 1)} ${r2(cx + tip)},${cy - len} ${r2(cx + half)},${cy}`} fill="#d93a0b" />
      </g>
    </g>
  );
};

/** 時計の針(黒。影つき)。 */
const DayHand = ({ points, deg, shade }: { points: string; deg: number; shade: number }) => (
  <g>
    <polygon points={points} fill="#000" opacity=".2" transform={`translate(${CX + shade * 0.7} ${CY + shade}) rotate(${r2(deg)})`} />
    <polygon points={points} fill={DAY.ink} transform={`translate(${CX} ${CY}) rotate(${r2(deg)})`} />
  </g>
);

/** 液晶の天気の絵(液晶の色の線で描く)。 */
const LcdWeatherIcon = ({ kind, isDay, x, y }: { kind: WeatherKind; isDay: boolean; x: number; y: number }) => {
  const cloud = <path d="M-14 6 a8 8 0 0 1 8-8 a10 10 0 0 1 19 3 a6 6 0 0 1 0 12 h-22 a6 6 0 0 1-5-7z" fill="none" />;
  const sun = isDay ? (
    <g>
      <circle cx="-5" cy="-7" r="7" />
      <path d="M-5 -19 v3 M-17 -7 h3 M-13.5 -15.5 l2 2 M3.5 -15.5 l-2 2" />
    </g>
  ) : (
    <path d="M-3 -16 a8 8 0 1 0 8 11 a6.5 6.5 0 0 1 -8 -11z" />
  );
  return (
    <g transform={`translate(${x} ${y})`} fill="none" stroke={DAY.lcdInk} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {kind === "clear" ? (
        isDay ? (
          <g>
            <circle r="8" />
            <path d="M0 -15 v4 M0 11 v4 M-15 0 h4 M11 0 h4 M-10.6 -10.6 l3 3 M7.6 7.6 l3 3 M10.6 -10.6 l-3 3 M-7.6 7.6 l-3 3" />
          </g>
        ) : (
          <path d="M-2 -12 a11 11 0 1 0 12 14 a9 9 0 0 1 -12 -14z" />
        )
      ) : (
        <>
          {kind === "partly" ? sun : null}
          {kind === "fog" ? <path d="M-16 -6 h28 M-12 2 h28 M-16 10 h28" /> : cloud}
          {kind === "rain" ? <path d="M-8 22 l-2 5 M0 22 l-2 5 M8 22 l-2 5" /> : null}
          {kind === "snow" ? <path d="M-8 24 h4 M0 24 h4 M8 24 h4" /> : null}
          {kind === "storm" ? <path d="M0 18 l-4 7 h4 l-2 6 7-9 h-4 l2-4z" fill={DAY.lcdInk} stroke="none" /> : null}
        </>
      )}
    </g>
  );
};

/** 日の出・日の入りの小さな印(液晶の色)。 */
const LcdSunMark = ({ x, y, up }: { x: number; y: number; up: boolean }) => (
  <g fill="none" stroke={DAY.lcdInk} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d={`M${x} ${y} h16 M${x + 3} ${y - 2} a5 5 0 0 1 10 0`} />
    <path d={`M${x + 8} ${y - 9} v-6 M${x + 5} ${y - 12} l3 ${up ? -3 : 3} 3 ${up ? 3 : -3}`} />
  </g>
);

/** デイライトの、針の軸のふた・ガラス(針より上)。縁の内側の影、左上の映り込み、液晶の映り込み。 */
const DayGlass = memo(function DayGlass() {
  const caps = [
    { cx: TX, cy: TY, r: 11 },
    { cx: CX, cy: CY, r: 7 },
    { cx: SX, cy: SY, r: 17 },
    ...MINI.map((g) => ({ cx: g.cx, cy: g.cy, r: 4.5 })),
  ];
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <defs>
        <radialGradient id="md-cap" cx=".36" cy=".3" r=".75">
          <stop offset="0" stopColor="#80848a" />
          <stop offset=".35" stopColor="#2a2c2f" />
          <stop offset="1" stopColor="#050506" />
        </radialGradient>
        <filter id="md-cap-shadow" x="-40%" y="-40%" width="180%" height="190%">
          <feDropShadow dx="0" dy="2" stdDeviation="1.8" floodColor="#000" floodOpacity=".4" />
        </filter>
        <radialGradient id="md-glass-edge" cx=".5" cy=".5" r=".5">
          <stop offset=".82" stopColor="#000" stopOpacity="0" />
          <stop offset=".95" stopColor="#000" stopOpacity=".08" />
          <stop offset="1" stopColor="#000" stopOpacity=".24" />
        </radialGradient>
        <linearGradient id="md-glare" x1="0" y1="0" x2=".8" y2=".8">
          <stop offset="0" stopColor="#fff" stopOpacity=".55" />
          <stop offset=".42" stopColor="#fff" stopOpacity=".14" />
          <stop offset="1" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="md-lcd-glare" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#fff" stopOpacity=".3" />
          <stop offset=".48" stopColor="#fff" stopOpacity=".07" />
          <stop offset=".5" stopColor="#fff" stopOpacity="0" />
        </linearGradient>
        {GAUGES.map((g, i) => (
          <clipPath key={i} id={`md-glass-clip-${i}`}>
            <circle cx={g.cx} cy={g.cy} r={g.r} />
          </clipPath>
        ))}
      </defs>
      {caps.map((cap) => (
        <g key={`${cap.cx},${cap.cy}`} filter="url(#md-cap-shadow)">
          <circle cx={cap.cx} cy={cap.cy} r={cap.r} fill="url(#md-cap)" />
          <ellipse cx={r2(cap.cx - cap.r * 0.22)} cy={r2(cap.cy - cap.r * 0.38)} rx={r2(cap.r * 0.46)} ry={r2(cap.r * 0.24)} fill="#fff" opacity=".22" />
        </g>
      ))}
      {GAUGES.map((g, i) => (
        <g key={i} clipPath={`url(#md-glass-clip-${i})`}>
          <circle cx={g.cx} cy={g.cy} r={g.r} fill="url(#md-glass-edge)" />
          <path d={glarePath(g)} fill="url(#md-glare)" />
        </g>
      ))}
      {DAY_LCDS.map((box) => (
        <rect key={`${box.x},${box.y}`} x={box.x} y={box.y} width={box.w} height={box.h} rx="5" fill="url(#md-lcd-glare)" />
      ))}
    </svg>
  );
});

export function DayCluster({ data, onFuel, onDest, onStart }: ClusterProps) {
  const time = useClockTime(data.clock);
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
  const kind = data.weather ? weatherKind(data.weather.code) : null;
  const forecast = forecastText(data.weather);
  const dest = data.destLabel ?? "目的地なし";
  const speed = data.speed === null ? "--" : String(Math.round(Math.max(0, data.speed)));
  const info = [
    { x: DAY_INFO_LCD.x + 12, label: "TODAY", value: data.todayKm.toFixed(1), unit: "km" },
    { x: DAY_INFO_LCD.x + 92, label: "AVG", value: data.avgFuel === null ? "--.-" : data.avgFuel.toFixed(1), unit: "km/L" },
  ];
  const lcd = DAY_WEATHER_LCD;
  const outside = data.weather ? String(Math.round(data.weather.temperature)) : "--";
  return (
    <Board className="ms-day">
      <DayFace />
      <svg className="ms-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
        {/* 左: 回転計 */}
        <SevenSeg
          text={data.rpm === null ? "----" : String(Math.round(data.rpm))}
          x={DAY_RPM_LCD.x + DAY_RPM_LCD.w - 7}
          y={DAY_RPM_LCD.y + 5}
          h={16}
          color={DAY.lcdInk}
          align="end"
          glow={false}
          ghost={0.07}
        />
        {MINI.map((g) => (
          <g key={g.key}>
            <DayNeedle cx={g.cx} cy={g.cy} len={MINI_R - 2} tail={4} width={3.4} deg={miniDeg[g.key]} />
            <text x={g.cx} y={g.cy + 33} textAnchor="middle" fill={DAY.ink} fontSize="13" fontWeight="700">
              {miniValue[g.key].value}
              <tspan fontSize="8.5" fill={DAY.soft}>
                {` ${miniValue[g.key].unit}`}
              </tspan>
            </text>
          </g>
        ))}
        <DayNeedle cx={TX} cy={TY} len={104} tail={20} width={7.5} deg={rpmDeg} />
        {/* 右: 時計 */}
        <text x={DAY_WEEK_WIN.x + DAY_WEEK_WIN.w / 2} y={DAY_WEEK_WIN.y + 19} textAnchor="middle" fill="#fff" fontSize="15" fontWeight="700" className="ms-ja">
          {WEEKDAYS[data.weekday]}
        </text>
        <text x={DAY_DATE_WIN.x + DAY_DATE_WIN.w / 2} y={DAY_DATE_WIN.y + 19} textAnchor="middle" fill={DAY.ink} fontSize="16" fontWeight="700" className="md-num">
          {data.day}
        </text>
        <text x={CX} y={CY - 38} textAnchor="middle" fill={DAY.muted} fontSize="8.5" fontWeight="700" letterSpacing="1.6">
          {`${data.year}.${pad2(data.month)}.${pad2(data.day)}`}
        </text>
        <DayHand points="-5.5,10 -3,-40 0,-68 3,-40 5.5,10" deg={hands.hour} shade={3} />
        <DayHand points="-4,12 -2.2,-60 0,-102 2.2,-60 4,12" deg={hands.minute} shade={3.5} />
        <g transform={`translate(${CX} ${CY}) rotate(${hands.second})`}>
          <line x1="0" y1="22" x2="0" y2="-108" stroke={DAY.red} strokeWidth="1.8" />
          <circle cy="16" r="3.6" fill={DAY.red} />
        </g>
        {/* 真ん中: 速度計 */}
        <SevenSeg text={speed} x={DAY_SPEED_LCD.x + 108} y={DAY_SPEED_LCD.y + 9} h={46} color={DAY.lcdInk} align="end" glow={false} ghost={0.07} />
        <text x={DAY_SPEED_LCD.x + 114} y={DAY_SPEED_LCD.y + 54} fill={DAY.lcdInk} fontSize="11" fontWeight="700">
          km/h
        </text>
        {info.map((item) => (
          <g key={item.label}>
            <text x={item.x} y={DAY_INFO_LCD.y + 14} fill={DAY.lcdInk} fontSize="7.5" fontWeight="700" letterSpacing="1.6" opacity=".75">
              {item.label}
            </text>
            <text x={item.x} y={DAY_INFO_LCD.y + 32} fill={DAY.lcdInk} fontSize="16" fontWeight="700">
              {item.value}
              <tspan fontSize="9" dx="2">
                {item.unit}
              </tspan>
            </text>
          </g>
        ))}
        <DayNeedle cx={SX} cy={SY} len={196} tail={26} width={10} deg={speedDeg} />
        {/* 左下: 天気の液晶 */}
        {kind && data.weather ? <LcdWeatherIcon kind={kind} isDay={data.weather.isDay} x={lcd.x + 32} y={lcd.y + 38} /> : null}
        <SevenSeg text={outside} x={lcd.x + 66} y={lcd.y + 16} h={40} color={DAY.lcdInk} glow={false} ghost={0.07} />
        <text x={r2(lcd.x + 66 + segWidth(outside, 40) + 8)} y={lcd.y + 54} fill={DAY.lcdInk} fontSize="16" fontWeight="700">
          °C
        </text>
        <text x={lcd.x + 162} y={lcd.y + 34} fill={DAY.lcdInk} fontSize="12" fontWeight="700">
          {forecast.split(" · ")[0] ?? ""}
        </text>
        <text x={lcd.x + 162} y={lcd.y + 54} fill={DAY.lcdInk} fontSize="12" fontWeight="700">
          {forecast.split(" · ")[1] ?? ""}
        </text>
        <text x={lcd.x + 16} y={lcd.y + 94} fill={DAY.lcdInk} fontSize="17" fontWeight="700" className="ms-ja">
          {kind ? WEATHER_JA[kind] : "天気を読み込み中"}
        </text>
        <line x1={lcd.x + 16} y1={lcd.y + 112} x2={lcd.x + lcd.w - 16} y2={lcd.y + 112} stroke={DAY.lcdInk} strokeOpacity=".35" />
        <LcdSunMark x={lcd.x + 16} y={lcd.y + 148} up />
        <text x={lcd.x + 38} y={lcd.y + 148} fill={DAY.lcdInk} fontSize="17" fontWeight="700">
          {data.sunrise ?? "--:--"}
        </text>
        <LcdSunMark x={lcd.x + 128} y={lcd.y + 148} up={false} />
        <text x={lcd.x + 150} y={lcd.y + 148} fill={DAY.lcdInk} fontSize="17" fontWeight="700">
          {data.sunset ?? "--:--"}
        </text>
        {/* 右下: 電圧と START の行き先 */}
        <text x={BATTERY_BOX.x + BATTERY_BOX.w - 14} y={BATTERY_BOX.y + 25} textAnchor="end" fill={DAY.lcdInk} fontSize="19" fontWeight="700">
          {data.voltage === null ? "—" : data.voltage.toFixed(1)}
          <tspan fontSize="10" dx="2">
            V
          </tspan>
        </text>
        <text x={START_BTN.x + 64} y={START_BTN.y + 52} fill="#fff" fontSize={dest.length <= 5 ? 22 : 17} fontWeight="700" className="ms-ja">
          {dest}
        </text>
      </svg>
      <DayGlass />
      <Hit box={[MINI[0].cx - MINI_R - 4, MINI[0].cy - MINI_R - 4, MINI_R * 2 + 8, MINI_R + 40]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[DAY_INFO_LCD.x, DAY_INFO_LCD.y, DAY_INFO_LCD.w, DAY_INFO_LCD.h]} label="燃費の記録・確認を開く" onPress={onFuel} />
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
// 八卦: 速さの勢いを八卦で表すネオンのメーター。
// 八角に並べた8つの卦(24本の線)が、止まっている坤(☷)から、速さに合わせて陽の線が増える順に
// 乾(☰)まで光っていく。外の輪が回転、真ん中に大きな速さ。車両位置の八卦の印と同じ考え方。
// ------------------------------------------------------------------

const BAGUA = {
  gold: "#ffc94a",
  red: "#ff3b2f",
  cyan: "#4df0ff",
  ink: "#ffe9c2",
  dim: "#6f5a3d",
  off: "#2a1d12",
  line: "#3a2614",
  panel: "#0d0605",
};
/** 八卦(線は上から、1 が陽・0 が陰)。坤(陽0本)から乾(陽3本)へ、速さの順に並べる。 */
const TRIGRAMS = [
  { name: "坤", mean: "地", lines: [0, 0, 0] },
  { name: "艮", mean: "山", lines: [1, 0, 0] },
  { name: "坎", mean: "水", lines: [0, 1, 0] },
  { name: "巽", mean: "風", lines: [1, 1, 0] },
  { name: "震", mean: "雷", lines: [0, 0, 1] },
  { name: "離", mean: "火", lines: [1, 0, 1] },
  { name: "兌", mean: "沢", lines: [0, 1, 1] },
  { name: "乾", mean: "天", lines: [1, 1, 1] },
] as const;
/** 八角の真ん中と大きさ。卦は下(坤)から時計回りに45度ずつ。 */
const BX = 512;
const BY = 283;
const B_OCT_R = 262;
const B_RPM_R = 228;
const B_RPM_SEGS = 32;
const B_LINE = { r: 196, gap: 15, t: 9, w: 92 };
/** ここから上の卦(兌・乾)は赤く光る(105km/h〜)。 */
const B_HOT = 6;
/** 1つの卦の速さの幅(140km/h を8つに分ける)。 */
const B_BAND_KMH = SPEED_MAX / TRIGRAMS.length;
/** 右下の DEST・START(80年代のテーマと同じ、Google マップの小窓が重なる所)。 */
const B_DEST = { x: 834, y: 332, w: 174, h: 96 };
const B_START = { x: 834, y: 440, w: 174, h: 108 };
const B_FUEL_PANEL = { x: 16, y: 288, w: 220, h: 260 };

const octagonPoints = (cx: number, cy: number, r: number) =>
  Array.from({ length: 8 }, (_, i) => pol(cx, cy, r, 22.5 + i * 45).join(",")).join(" ");
/** 卦の1本の線(陰はまん中を切った2本)。中心から r、上の線ほど外。k は上から0・1・2。 */
const trigramLine = (cx: number, cy: number, line: { r: number; gap: number; t: number; w: number }, k: number, yang: number, key: string) => {
  const y = r2(cy - line.r - (1 - k) * line.gap - line.t / 2);
  const x = r2(cx - line.w / 2);
  if (yang) return <rect key={key} x={x} y={y} width={line.w} height={line.t} rx={r2(line.t * 0.22)} />;
  const half = r2((line.w * 0.78) / 2);
  return (
    <g key={key}>
      <rect x={x} y={y} width={half} height={line.t} rx={r2(line.t * 0.22)} />
      <rect x={r2(cx + line.w / 2 - half)} y={y} width={half} height={line.t} rx={r2(line.t * 0.22)} />
    </g>
  );
};
/** 光る順の線(24本)。卦ごとに内(下の線)から外へ。 */
const B_LINES = TRIGRAMS.flatMap((tri, i) =>
  [2, 1, 0].map((k) => ({ index: i * 3 + (2 - k), tri: i, k, yang: tri.lines[k], deg: 180 + i * 45 })),
);
/** 回転の輪の1つ分(弧)。 */
const rpmSegment = (i: number) => {
  const d0 = -135 + (i * 270) / B_RPM_SEGS;
  const d1 = d0 + 270 / B_RPM_SEGS - 1.6;
  const [ax, ay] = pol(BX, BY, B_RPM_R, d0);
  const [bx, by] = pol(BX, BY, B_RPM_R, d1);
  return `M${ax} ${ay}A${B_RPM_R} ${B_RPM_R} 0 0 1 ${bx} ${by}`;
};
const B_RPM_HOT = Math.round((RPM_RED / RPM_MAX) * B_RPM_SEGS);
/** 小さな卦の印(右の、遅い→速いの並び)。 */
const B_LEGEND = TRIGRAMS.map((tri, i) => ({ ...tri, x: 824 + (i % 4) * 50, y: 90 + Math.floor(i / 4) * 110 }));
const B_LEGEND_LINE = { r: 0, gap: 9, t: 5, w: 30 };

/** 八卦の動かない絵: 下地・八角・消えている線と回転の輪・名前・左右の札。 */
const BaguaFace = memo(function BaguaFace() {
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <defs>
        <radialGradient id="mb-bg" cx=".5" cy=".55" r=".7">
          <stop offset="0" stopColor="#1a0806" />
          <stop offset="1" stopColor="#030202" />
        </radialGradient>
        <filter id="mb-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="2.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <rect width={BOARD_W} height={BOARD_H} fill="url(#mb-bg)" />
      <polygon points={octagonPoints(BX, BY, B_OCT_R)} fill="none" stroke={BAGUA.dim} strokeWidth="1.5" />
      <polygon points={octagonPoints(BX, BY, B_OCT_R - 8)} fill="none" stroke={BAGUA.line} />
      {Array.from({ length: B_RPM_SEGS }, (_, i) => (
        <path key={i} d={rpmSegment(i)} fill="none" stroke={i >= B_RPM_HOT ? "#3a0d0a" : "#0b2a2e"} strokeWidth="10" />
      ))}
      <g fill={BAGUA.off}>
        {TRIGRAMS.map((tri, i) => (
          <g key={tri.name} transform={`rotate(${180 + i * 45} ${BX} ${BY})`}>
            {tri.lines.map((yang, k) => trigramLine(BX, BY, B_LINE, k, yang, String(k)))}
          </g>
        ))}
      </g>
      <text x={BX} y={BY + 66} textAnchor="middle" fill={BAGUA.dim} fontSize="15" fontWeight="700" letterSpacing="3">
        km/h
      </text>
      {/* 左の札(時計・天気・今日の距離)と、燃料・水温・電圧 */}
      <rect x="16" y="16" width="220" height="260" rx="12" fill={BAGUA.panel} stroke={BAGUA.line} />
      <line x1="36" y1="112" x2="216" y2="112" stroke={BAGUA.line} />
      <rect x={B_FUEL_PANEL.x} y={B_FUEL_PANEL.y} width={B_FUEL_PANEL.w} height={B_FUEL_PANEL.h} rx="12" fill={BAGUA.panel} stroke={BAGUA.line} />
      {[
        ["燃料", 322],
        ["水温", 402],
        ["電圧", 482],
      ].map(([label, y]) => (
        <text key={label} x="36" y={y} fill={BAGUA.dim} fontSize="12" fontWeight="700" letterSpacing="2">
          {label}
        </text>
      ))}
      {/* 右の札: 八卦の順(遅い→速い) */}
      <rect x="788" y="16" width="220" height="300" rx="12" fill={BAGUA.panel} stroke={BAGUA.line} />
      <text x="808" y="46" fill={BAGUA.dim} fontSize="11" fontWeight="700" letterSpacing="1">
        八卦の順(遅い → 速い)
      </text>
      <rect x={B_DEST.x} y={B_DEST.y} width={B_DEST.w} height={B_DEST.h} rx="12" fill={BAGUA.panel} stroke={BAGUA.gold} strokeWidth="1.6" />
      <text x={B_DEST.x + 18} y={B_DEST.y + 32} fill={BAGUA.dim} fontSize="12" fontWeight="700">
        目的地
      </text>
      <text x={B_DEST.x + 18} y={B_DEST.y + 72} fill={BAGUA.gold} fontSize="26" fontWeight="700" letterSpacing="2" filter="url(#mb-glow)">
        DEST
      </text>
      <rect x={B_START.x} y={B_START.y} width={B_START.w} height={B_START.h} rx="12" fill={BAGUA.panel} stroke={BAGUA.red} strokeWidth="1.6" />
      <text x={B_START.x + 18} y={B_START.y + 32} fill={BAGUA.red} fontSize="12" fontWeight="700" letterSpacing="2">
        START
      </text>
    </svg>
  );
});

export function BaguaCluster({ data, onFuel, onDest, onStart }: ClusterProps) {
  const speed = Math.max(0, data.speed ?? 0);
  const litLines = Math.min(24, Math.floor((speed / SPEED_MAX) * 24));
  const band = Math.min(TRIGRAMS.length - 1, Math.floor(speed / B_BAND_KMH));
  const now = TRIGRAMS[band];
  const litRpm = Math.min(B_RPM_SEGS, Math.round(((data.rpm ?? 0) / RPM_MAX) * B_RPM_SEGS));
  const kind = data.weather ? weatherKind(data.weather.code) : null;
  const dest = data.destLabel ?? "目的地なし";
  const glow = "url(#mb-glow)";
  return (
    <Board className="ms-bagua">
      <BaguaFace />
      <svg className="ms-layer" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
        {/* 回転の輪(光っている分だけ) */}
        <g fill="none" strokeWidth="10" filter={glow}>
          {Array.from({ length: litRpm }, (_, i) => (
            <path key={i} d={rpmSegment(i)} stroke={i >= B_RPM_HOT ? BAGUA.red : BAGUA.cyan} />
          ))}
        </g>
        {/* 八卦の線(速さの分だけ、坤から順に光る) */}
        <g filter={glow}>
          {B_LINES.filter((line) => line.index < litLines).map((line) => (
            <g key={line.index} transform={`rotate(${line.deg} ${BX} ${BY})`} fill={line.tri >= B_HOT ? BAGUA.red : BAGUA.gold}>
              {trigramLine(BX, BY, B_LINE, line.k, line.yang, "l")}
            </g>
          ))}
        </g>
        {TRIGRAMS.map((tri, i) => {
          const [x, y] = pol(BX, BY, 140, 180 + i * 45);
          const current = i === band;
          return (
            <text key={tri.name} x={x} y={y + 7} textAnchor="middle" fill={current ? BAGUA.gold : BAGUA.dim} fontSize="20" fontWeight="700" className="mb-serif" filter={current ? glow : undefined}>
              {tri.name}
            </text>
          );
        })}
        {/* 真ん中: 今の卦・大きな速さ・回転数 */}
        <text x={BX} y={BY - 64} textAnchor="middle" fill={BAGUA.gold} fontSize="18" fontWeight="700" letterSpacing="4" className="mb-serif" filter={glow}>
          {`${now.name}・${now.mean}`}
        </text>
        <text x={BX} y={BY + 38} textAnchor="middle" fill={BAGUA.ink} fontSize="120" fontWeight="700" fontStyle="italic" filter={glow}>
          {data.speed === null ? "--" : Math.round(speed)}
        </text>
        <text x={BX} y={BY + 96} textAnchor="middle" fill={BAGUA.cyan} fontSize="13" fontWeight="700" letterSpacing="2">
          {data.rpm === null ? "— r/min" : `${Math.round(data.rpm)} r/min`}
        </text>
        {/* 左の札 */}
        <text x="36" y="66" fill={BAGUA.ink} fontSize="44" fontWeight="700">
          {data.clock}
        </text>
        <text x="36" y="92" fill={BAGUA.dim} fontSize="13" fontWeight="700">
          {`${data.month}/${data.day}(${WEEKDAYS[data.weekday]})`}
        </text>
        <text x="36" y="162" fill={BAGUA.ink} fontSize="42" fontWeight="700">
          {data.weather ? `${Math.round(data.weather.temperature)}°` : "—"}
        </text>
        <text x="116" y="146" fill={BAGUA.ink} fontSize="13" fontWeight="700" className="ms-ja">
          {kind ? WEATHER_JA[kind] : "天気を読み込み中"}
        </text>
        <text x="116" y="164" fill={BAGUA.dim} fontSize="11" fontWeight="700">
          {forecastText(data.weather)}
        </text>
        <text x="36" y="210" fill={BAGUA.ink} fontSize="16" fontWeight="700">
          {`今日 ${data.todayKm.toFixed(1)} km`}
        </text>
        <text x="36" y="242" fill={BAGUA.ink} fontSize="16" fontWeight="700">
          {`平均 ${data.avgFuel === null ? "--.-" : data.avgFuel.toFixed(1)} km/L`}
        </text>
        <text x="36" y="362" fill={BAGUA.ink} fontSize="36" fontWeight="700">
          {Math.round(data.rangeKm)}
          <tspan fontSize="13" fill={BAGUA.dim} dx="10">
            km
          </tspan>
        </text>
        <text x="36" y="442" fill={BAGUA.ink} fontSize="36" fontWeight="700">
          {data.coolant === null ? "—" : Math.round(data.coolant)}
          <tspan fontSize="13" fill={BAGUA.dim} dx="10">
            °C
          </tspan>
        </text>
        <text x="36" y="522" fill={BAGUA.ink} fontSize="36" fontWeight="700">
          {data.voltage === null ? "—" : data.voltage.toFixed(1)}
          <tspan fontSize="13" fill={BAGUA.dim} dx="6">
            V
          </tspan>
        </text>
        {/* 右の札: 今の卦までが光る */}
        {B_LEGEND.map((tri, i) => {
          const on = i <= band;
          return (
            <g key={tri.name}>
              <g fill={on ? (i >= B_HOT ? BAGUA.red : BAGUA.gold) : BAGUA.off} filter={on ? glow : undefined}>
                {tri.lines.map((yang, k) => trigramLine(tri.x, tri.y, B_LEGEND_LINE, k, yang, String(k)))}
              </g>
              <text x={tri.x} y={tri.y + 40} textAnchor="middle" fill={on ? BAGUA.ink : BAGUA.dim} fontSize="15" fontWeight="700" className="mb-serif">
                {tri.name}
              </text>
              <text x={tri.x} y={tri.y + 58} textAnchor="middle" fill={BAGUA.dim} fontSize="10" fontWeight="700">
                {tri.mean}
              </text>
            </g>
          );
        })}
        <text x={B_START.x + 18} y={B_START.y + 78} fill={BAGUA.ink} fontSize={dest.length <= 5 ? 26 : 19} fontWeight="700" className="ms-ja">
          {dest}
        </text>
      </svg>
      <Hit box={[B_FUEL_PANEL.x, B_FUEL_PANEL.y, B_FUEL_PANEL.w, B_FUEL_PANEL.h]} label="燃費の記録・確認を開く" onPress={onFuel} />
      <Hit box={[B_DEST.x, B_DEST.y, B_DEST.w, B_DEST.h]} label="目的地を選ぶ" onPress={onDest} />
      <Hit
        box={[B_START.x, B_START.y, B_START.w, B_START.h]}
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
        <circle cx="17" cy="22" r="12" fill="url(#ms-thumb-metal)" />
        <circle cx="17" cy="22" r="10.5" fill="#efe5cf" />
        <line x1="17" y1="22" x2="23" y2="18" stroke={CLASSIC.needle} strokeWidth="1.4" />
        <circle cx="103" cy="22" r="12" fill="url(#ms-thumb-metal)" />
        <circle cx="103" cy="22" r="10.5" fill="#efe5cf" />
        <line x1="103" y1="22" x2="103" y2="14" stroke={CLASSIC.dialInk} strokeWidth="1.2" />
        <line x1="103" y1="22" x2="108" y2="25" stroke={CLASSIC.dialInk} strokeWidth="1.2" />
        {/* 革のフード */}
        <g fill="none" stroke="#57463a" strokeLinecap="round">
          <path d={`M${pol(60, 38, 34, -50).join(" ")}A34 34 0 0 1 ${pol(60, 38, 34, 50).join(" ")}`} strokeWidth="3" />
          <path d={`M${pol(17, 22, 14.5, -55).join(" ")}A14.5 14.5 0 0 1 ${pol(17, 22, 14.5, 55).join(" ")}`} strokeWidth="2" />
          <path d={`M${pol(103, 22, 14.5, -55).join(" ")}A14.5 14.5 0 0 1 ${pol(103, 22, 14.5, 55).join(" ")}`} strokeWidth="2" />
        </g>
      </svg>
    );
  }
  if (style === "bagua") {
    return (
      <svg viewBox="0 0 120 70" className="ms-thumb" aria-hidden="true">
        <rect width="120" height="70" fill="#070303" />
        <polygon points={octagonPoints(60, 35, 31)} fill="none" stroke={BAGUA.dim} />
        {TRIGRAMS.map((tri, i) => (
          <g key={tri.name} transform={`rotate(${180 + i * 45} 60 35)`} fill={i < 3 ? BAGUA.gold : BAGUA.off}>
            {tri.lines.map((yang, k) => trigramLine(60, 35, { r: 22, gap: 2.6, t: 1.6, w: 11 }, k, yang, String(k)))}
          </g>
        ))}
        <text x="60" y="41" textAnchor="middle" fill={BAGUA.ink} fontSize="15" fontWeight="700" fontStyle="italic">
          58
        </text>
      </svg>
    );
  }
  if (style === "day") {
    const [nx, ny] = pol(60, 38, 25, -40);
    return (
      <svg viewBox="0 0 120 70" className="ms-thumb" aria-hidden="true">
        <defs>
          <linearGradient id="ms-thumb-chrome" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset=".45" stopColor="#8f959a" />
            <stop offset="1" stopColor="#e4e6e8" />
          </linearGradient>
        </defs>
        <rect width="120" height="70" fill="#cfd2d5" />
        {[
          [17, 22, 12],
          [103, 22, 12],
          [60, 38, 31],
        ].map(([x, y, r]) => (
          <g key={x}>
            <circle cx={x} cy={y} r={r + 1.2} fill="#2a2c2f" />
            <circle cx={x} cy={y} r={r} fill="url(#ms-thumb-chrome)" />
            <circle cx={x} cy={y} r={r2(r * 0.88)} fill="#ffffff" />
          </g>
        ))}
        {Array.from({ length: 15 }, (_, i) => {
          const [x1, y1] = pol(60, 38, 26.5, -135 + i * (270 / 14));
          const [x2, y2] = pol(60, 38, i % 2 ? 23.5 : 21, -135 + i * (270 / 14));
          return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={DAY.ink} strokeWidth={i % 2 ? 0.9 : 1.8} />;
        })}
        <rect x="51" y="45" width="18" height="9" rx="1.5" fill="#c6cdbd" stroke="#1c1e21" strokeWidth="1" />
        <line x1="60" y1="38" x2={nx} y2={ny} stroke="#ff5a1f" strokeWidth="2.2" strokeLinecap="round" />
        <circle cx="60" cy="38" r="3.6" fill="#18191b" />
        <line x1="17" y1="22" x2="23" y2="18" stroke="#ff5a1f" strokeWidth="1.5" />
        <line x1="103" y1="22" x2="103" y2="14" stroke={DAY.ink} strokeWidth="1.4" />
        <line x1="103" y1="22" x2="108" y2="25" stroke={DAY.ink} strokeWidth="1.4" />
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
