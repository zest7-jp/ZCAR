"use client";

// 近未来のほかのテーマ(80年代のデジタル・デイライト)の、メーターの画面。
// どれも 1024x566 の板に描き、使える広さに合わせて拡大・縮小する(車載機ではほぼ等倍)。
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
/** 速度計の目盛りの上限(km/h)。 */
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
  /** 燃料が予備の分まで減った(給油の記録から分かるときだけ true)。 */
  lowFuel: boolean;
  /** 進んでいる向き(北が0、時計回りの度。360を超えることもある)。分からなければ null。 */
  heading: number | null;
  /** START の行き先の名前。無ければ null。 */
  destLabel: string | null;
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
 * スマホの画面に出す7セグメントの数字(1つの小さな絵)。車の80年代・デイライトの数字と同じ形で、
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
      <RetroGlass />
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
// 三連メーターの並び(デイライトで使う): 左に回転計、真ん中に大きな速度計、右に時計、下の左右に板。
// ------------------------------------------------------------------
/**
 * 三連のメーター。左に回転計、真ん中に大きな速度計、右に時計。左右は少し小さく、少し高い所に置き、
 * 真ん中の縁と重ならないように少しすき間をあける。下の左右の板に、天気と、電圧・目的地・START。
 */
const SX = 512;
const SY = 283;
const SPEED_R = 218;
const TX = 149;
const TY = 188;
const CX = 875;
const CY = 188;
const SIDE_R = 122;

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
/** 下の左右の板と、右の板の中の電圧・目的地・START。 */
const PANELS = [
  { x: 16, y: 352, w: 268, h: 196 },
  { x: 740, y: 352, w: 268, h: 196 },
];
const BATTERY_BOX = { x: 756, y: 366, w: 236, h: 36 };
const DEST_BTN = { x: 756, y: 410, w: 236, h: 44 };
const START_BTN = { x: 756, y: 462, w: 236, h: 72 };
/** 3つのメーター(縁とガラスに使う)。ring は縁の太さ。 */
const GAUGES = [
  { cx: TX, cy: TY, r: SIDE_R, ring: 10 },
  { cx: CX, cy: CY, r: SIDE_R, ring: 10 },
  { cx: SX, cy: SY, r: SPEED_R, ring: 14 },
];
type Gauge = (typeof GAUGES)[number];

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

// ------------------------------------------------------------------
// デイライト: 昼間の日差しの中でも読みやすい、白い文字盤の三連メーター。
// 並びは三連メーター(左に回転計、真ん中に速度計、右に時計、下の左右に板)。
// 黒いカーボンの板に、クロムの縁・白い文字盤・影の落ちる針・液晶の小窓を、本物のメーターに似せて描く。
// 文字盤は筒の奥にある(上の縁に筒の影が落ち、ガラスのふちが光る)。針は浮いていて、影のふちがぼける。
// 針の根元には丸いおもり、軸にはクロムのふた。速度計の下に警告灯(異常のときだけ光る)。
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
    {/* カーボンの板の編み目: 縦に光る目と横に光る目を、市松に並べる */}
    <linearGradient id="md-carbon-v" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stopColor="#34383d" />
      <stop offset=".5" stopColor="#1b1d20" />
      <stop offset="1" stopColor="#0d0e10" />
    </linearGradient>
    <linearGradient id="md-carbon-h" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stopColor="#2c3034" />
      <stop offset=".5" stopColor="#16181a" />
      <stop offset="1" stopColor="#0a0b0c" />
    </linearGradient>
    <pattern id="md-carbon" width="10" height="10" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="#0a0b0c" />
      <rect x=".4" y=".4" width="4.2" height="4.2" fill="url(#md-carbon-v)" />
      <rect x="5.4" y="5.4" width="4.2" height="4.2" fill="url(#md-carbon-v)" />
      <rect x="5.4" y=".4" width="4.2" height="4.2" fill="url(#md-carbon-h)" />
      <rect x=".4" y="5.4" width="4.2" height="4.2" fill="url(#md-carbon-h)" />
    </pattern>
    {/* 上から当たる光(上はうっすら明るく、下と端は暗く) */}
    <radialGradient id="md-sheen" cx=".5" cy="-.1" r=".9">
      <stop offset="0" stopColor="#fff" stopOpacity=".13" />
      <stop offset=".6" stopColor="#fff" stopOpacity=".03" />
      <stop offset="1" stopColor="#000" stopOpacity=".35" />
    </radialGradient>
    {/* 本物のクロム: 空(白)・地平線(黒い線)・地面(灰)を映した帯 */}
    <linearGradient id="md-chrome" x1=".15" y1="0" x2=".85" y2="1">
      <stop offset="0" stopColor="#ffffff" />
      <stop offset=".18" stopColor="#e9ecef" />
      <stop offset=".3" stopColor="#9aa0a6" />
      <stop offset=".38" stopColor="#2e3236" />
      <stop offset=".46" stopColor="#b8bdc2" />
      <stop offset=".62" stopColor="#f4f5f6" />
      <stop offset=".8" stopColor="#7b8187" />
      <stop offset="1" stopColor="#d5d8db" />
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
    {/* 縁の内側の斜面(文字盤へ下りていく所。左上は陰、右下は光) */}
    <linearGradient id="md-chrome-in" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#1d1f22" />
      <stop offset=".5" stopColor="#6d7278" />
      <stop offset="1" stopColor="#eef0f2" />
    </linearGradient>
    {/* 文字盤は筒の奥にあるので、上の縁の近くに筒の影が落ちる */}
    <radialGradient id="md-tube" cx=".5" cy=".64" r=".64">
      <stop offset=".72" stopColor="#000" stopOpacity="0" />
      <stop offset=".9" stopColor="#000" stopOpacity=".14" />
      <stop offset="1" stopColor="#000" stopOpacity=".42" />
    </radialGradient>
    <filter id="md-blur" x="-10%" y="-10%" width="120%" height="120%">
      <feGaussianBlur stdDeviation="2" />
    </filter>
    {GAUGES.map((g, i) => (
      <clipPath key={i} id={`md-face-clip-${i}`}>
        <circle cx={g.cx} cy={g.cy} r={g.r} />
      </clipPath>
    ))}
  </defs>
);

/** 文字盤に落ちる筒の影(上の縁ほど濃い)と、縁のすぐ内側の濃い影。針より下、目盛りより上。 */
const DayTubeShade = () => (
  <g>
    {GAUGES.map((g, i) => (
      <g key={i} clipPath={`url(#md-face-clip-${i})`}>
        <circle cx={g.cx} cy={g.cy} r={g.r} fill="url(#md-tube)" />
        <circle cx={g.cx} cy={g.cy} r={g.r} fill="none" stroke="#000" strokeOpacity=".55" strokeWidth="5" filter="url(#md-blur)" />
      </g>
    ))}
  </g>
);

/** 警告灯の窓(速度計の下)。消えているときは、黒い窓の中にうっすら見えるだけ。 */
const TELLTALE_BOX: Box = { x: SX - 60, y: SY + 172, w: 120, h: 26 };
const TELLTALES = [
  { key: "battery", x: TELLTALE_BOX.x + 22, color: "#ff3b30" },
  { key: "temp", x: TELLTALE_BOX.x + 60, color: "#ff3b30" },
  { key: "fuel", x: TELLTALE_BOX.x + 98, color: "#ffb000" },
] as const;
const TelltaleIcon = ({ kind, x, y, color, weight = 1.6 }: { kind: (typeof TELLTALES)[number]["key"]; x: number; y: number; color: string; weight?: number }) => (
  <g transform={`translate(${x} ${y})`} fill="none" stroke={color} strokeWidth={weight} strokeLinecap="round" strokeLinejoin="round">
    {kind === "battery" ? (
      <g>
        <rect x="-8" y="-5" width="16" height="11" rx="1.2" />
        <path d="M-5 -5 v-2 M5 -5 v-2 M-5.5 0.5 h3 M2.5 0.5 h3 M4 -1 v3" />
      </g>
    ) : kind === "temp" ? (
      <g>
        <path d="M0 -8 v8" />
        <circle cy="2.5" r="2.2" fill={color} stroke="none" />
        <path d="M0 -6 h3 M0 -3 h3" />
        <path d="M-8 7 q2 -1.6 4 0 t4 0 t4 0 t4 0" />
      </g>
    ) : (
      <g>
        <rect x="-6" y="-7" width="8" height="13" rx="1" />
        <path d="M-4.5 -4.5 h5 v3 h-5z" />
        <path d="M2 -4 l3 2.5 v5 a1.2 1.2 0 0 0 2.4 0 v-6.5 l-2.2 -2.2" />
      </g>
    )}
  </g>
);

/** クロムの縁(板との間に黒いすき間。内側は文字盤へ下りる斜面)と、白い文字盤(縁との間に黒いゴム)。 */
const DayDial = ({ g }: { g: Gauge }) => (
  <g>
    <circle cx={g.cx} cy={g.cy} r={g.r + g.ring + 3} fill="#050506" />
    <circle cx={g.cx} cy={g.cy} r={g.r + g.ring} fill="url(#md-chrome)" filter="url(#md-shadow)" />
    <circle cx={g.cx} cy={g.cy} r={r2(g.r + g.ring - 1.2)} fill="none" stroke="#fff" strokeOpacity=".6" strokeWidth="1.2" />
    <circle cx={g.cx} cy={g.cy} r={r2(g.r + 3.4)} fill="none" stroke="url(#md-chrome-in)" strokeWidth="3.2" />
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

/** デイライトの動かない絵: カーボンの板・下の左右の板・3つのメーターの文字盤・液晶の枠・ボタン。 */
const DayFace = memo(function DayFace() {
  return (
    <svg className="ms-layer ms-static" viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} aria-hidden="true">
      <DayDefs />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#md-carbon)" />
      <rect width={BOARD_W} height={BOARD_H} fill="url(#md-sheen)" />
      {/* 下の左右の板は、黒い板の上で形が分かるように、ふちを細く光らせる */}
      {PANELS.map((panel) => (
        <rect key={panel.x} x={panel.x} y={panel.y} width={panel.w} height={panel.h} rx="16" fill="url(#md-plastic)" stroke="#fff" strokeOpacity=".12" strokeWidth="1.2" filter="url(#md-shadow)" />
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
      <rect x={TELLTALE_BOX.x - 2} y={TELLTALE_BOX.y - 2} width={TELLTALE_BOX.w + 4} height={TELLTALE_BOX.h + 4} rx="7" fill="#2a2c2f" />
      <rect x={TELLTALE_BOX.x} y={TELLTALE_BOX.y} width={TELLTALE_BOX.w} height={TELLTALE_BOX.h} rx="5.5" fill="#0d0e10" />
      {TELLTALES.map((lamp) => (
        <TelltaleIcon key={lamp.key} kind={lamp.key} x={lamp.x} y={TELLTALE_BOX.y + 13} color="#2b2e32" />
      ))}
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
      <DayTubeShade />
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
  // 根元のおもり(丸い)と、針の真ん中の明るい筋。
  const weight = r2(width * 1.05);
  const stripe = Math.max(0.5, width * 0.11);
  // 影のふち(針が文字盤から浮いているので、影のまわりがぼける)。
  const blur = (ox: number, oy: number, grow: number) =>
    `${r2(cx + ox - half - grow)},${r2(cy + oy + grow)} ${r2(cx + ox - tip - grow * 0.5)},${r2(cy + oy - len - grow)} ${r2(cx + ox + tip + grow * 0.5)},${r2(cy + oy - len - grow)} ${r2(cx + ox + half + grow)},${r2(cy + oy + grow)}`;
  return (
    <g>
      <g className="ms-needle" style={{ ...rotate, transformOrigin: `${r2(cx + shade.x)}px ${r2(cy + shade.y)}px` }}>
        <polygon points={blur(shade.x, shade.y, Math.max(1.2, width * 0.22))} fill="#000" opacity=".1" />
        <polygon points={body(shade.x, shade.y)} fill="#000" opacity=".2" />
        <circle cx={r2(cx + shade.x)} cy={r2(cy + shade.y + tail)} r={weight} fill="#000" opacity=".2" />
      </g>
      <g className="ms-needle" style={{ ...rotate, transformOrigin: `${cx}px ${cy}px` }}>
        <polygon points={`${r2(cx - half * 1.1)},${cy} ${r2(cx - half * 1.3)},${cy + tail} ${r2(cx + half * 1.3)},${cy + tail} ${r2(cx + half * 1.1)},${cy}`} fill="#18191b" />
        <circle cx={cx} cy={cy + tail} r={weight} fill="#18191b" />
        <polygon points={`${r2(cx - half)},${cy} ${r2(cx - tip)},${cy - len} ${cx},${r2(cy - len - 1)} ${cx},${cy}`} fill="#ff6b35" />
        <polygon points={`${cx},${cy} ${cx},${r2(cy - len - 1)} ${r2(cx + tip)},${cy - len} ${r2(cx + half)},${cy}`} fill="#d93a0b" />
        <polygon
          points={`${r2(cx - stripe)},${r2(cy - len * 0.2)} ${r2(cx - stripe * 0.4)},${r2(cy - len * 0.93)} ${r2(cx + stripe * 0.4)},${r2(cy - len * 0.93)} ${r2(cx + stripe)},${r2(cy - len * 0.2)}`}
          fill="#ffe1cf"
          opacity=".9"
        />
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
        {/* 磨いたクロムの軸のふた(左上に光が当たる) */}
        <radialGradient id="md-cap" cx=".38" cy=".32" r=".8">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset=".22" stopColor="#e3e6e9" />
          <stop offset=".55" stopColor="#8d9298" />
          <stop offset=".85" stopColor="#3a3e42" />
          <stop offset="1" stopColor="#1c1e20" />
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
          <circle cx={cap.cx} cy={cap.cy} r={r2(cap.r + 1.4)} fill="#0b0c0d" />
          <circle cx={cap.cx} cy={cap.cy} r={cap.r} fill="url(#md-cap)" />
          <ellipse cx={r2(cap.cx - cap.r * 0.22)} cy={r2(cap.cy - cap.r * 0.38)} rx={r2(cap.r * 0.46)} ry={r2(cap.r * 0.24)} fill="#fff" opacity=".5" />
        </g>
      ))}
      {GAUGES.map((g, i) => {
        // ガラスのふちの光(左上は強く、右下は弱く映る)。
        const arc = (from: number, to: number, r: number) => {
          const [x0, y0] = pol(g.cx, g.cy, r, from);
          const [x1, y1] = pol(g.cx, g.cy, r, to);
          return `M${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}`;
        };
        return (
          <g key={i} clipPath={`url(#md-glass-clip-${i})`}>
            <circle cx={g.cx} cy={g.cy} r={g.r} fill="url(#md-glass-edge)" />
            <path d={glarePath(g)} fill="url(#md-glare)" />
            <g fill="none" stroke="#fff" strokeLinecap="round">
              <path d={arc(-80, -16, r2(g.r - 3.5))} strokeOpacity=".6" strokeWidth="2.2" />
              <path d={arc(102, 164, r2(g.r - 4))} strokeOpacity=".16" strokeWidth="3" />
            </g>
          </g>
        );
      })}
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
  // 警告灯: 電圧が 12V より低い(充電されていない)・水温が 105℃ 以上・燃料が予備まで減った。
  const lamps = {
    battery: data.voltage !== null && data.voltage < 12,
    temp: data.coolant !== null && data.coolant >= 105,
    fuel: data.lowFuel,
  };
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
        {/* 警告灯: 電圧が低い・水温が高い・燃料が少ないときだけ光る */}
        {TELLTALES.map((lamp) =>
          lamps[lamp.key] ? (
            <g key={lamp.key} className={`md-lamp is-${lamp.key}`}>
              <g opacity=".4">
                <TelltaleIcon kind={lamp.key} x={lamp.x} y={TELLTALE_BOX.y + 13} color={lamp.color} weight={4} />
              </g>
              <TelltaleIcon kind={lamp.key} x={lamp.x} y={TELLTALE_BOX.y + 13} color={lamp.color} />
            </g>
          ) : null,
        )}
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
          <pattern id="ms-thumb-carbon" width="4" height="4" patternUnits="userSpaceOnUse">
            <rect width="4" height="4" fill="#0b0c0e" />
            <rect width="2" height="2" fill="#26292d" />
            <rect x="2" y="2" width="2" height="2" fill="#26292d" />
          </pattern>
        </defs>
        <rect width="120" height="70" fill="url(#ms-thumb-carbon)" />
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
