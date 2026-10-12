"use client";

// 真ん中のメーターの形(ARC / HUD FRAME / HALO RING / SPORT DIAL / ANALOG NEEDLE /
// TACHO RING)を SVG で描く。地図の入った今の形(NAVI)は app/page.tsx にある。
//
// 色はすべて計器の部品と同じ「緑」で塗る(globals.css の .dg の変数)。
// 計器全体に filter がかかっているので、8色のどれを選んでもその色になる。
// 下の二隅(平均巡行速度・平均燃費)の文字が重ならないよう、絵は二隅を空けてある。

import { useEffect, useId, useState } from "react";
import type { MeterDesign } from "./settings-store";

/** 形の絵に渡す値。取れていない値は null。 */
export type GaugeValues = {
  /** 速度(km/h)。 */
  speed: number | null;
  rpm: number | null;
  /** 水温(°C)。 */
  coolant: number | null;
  /** 電圧(V)。 */
  voltage: number | null;
  /** 燃料の残り(0〜100)。 */
  fuelPercent: number;
  /** 走れる距離(km)。 */
  rangeKm: number;
  /** 今日走った距離(km)。 */
  tripKm: number;
  /** 今の時刻(例: 13:21)。 */
  clock: string;
  /** 今日の日付(例: 10/11 SUN)。 */
  dateLabel: string;
};

/** 形選びの見本に出す値。 */
export const SAMPLE_GAUGE_VALUES: GaugeValues = {
  speed: 58,
  rpm: 2400,
  coolant: 83,
  voltage: 14.1,
  fuelPercent: 72,
  rangeKm: 483,
  tripKm: 12.4,
  clock: "13:21",
  dateLabel: "10/11 SUN",
};

const SPEED_MAX = 160;
const RPM_MAX = 8000;
/** ここから上の回転は目盛りの色を変える。 */
const RPM_RED = 6500;

/** 注意を出す境目。 */
const COOLANT_HOT = 105;
const VOLTAGE_LOW = 11.8;
const VOLTAGE_HIGH = 15.2;
const FUEL_LOW = 12;

type Point = readonly [number, number];

/** 角度は 0 = 真上、時計回り。 */
const at = (cx: number, cy: number, r: number, deg: number): Point => {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(rad), cy - r * Math.cos(rad)];
};

const n2 = (value: number) => Number(value.toFixed(2));

/** from から to へ時計回りに回る円弧。 */
const arcPath = (cx: number, cy: number, r: number, from: number, to: number) => {
  const [x1, y1] = at(cx, cy, r, from);
  const [x2, y2] = at(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${n2(x1)} ${n2(y1)} A ${r} ${r} 0 ${large} 1 ${n2(x2)} ${n2(y2)}`;
};

/** 円弧の帯(内側 r1・外側 r2)。区切った目盛りの1こま。 */
const bandPath = (cx: number, cy: number, r1: number, r2: number, from: number, to: number) => {
  const [ax, ay] = at(cx, cy, r2, from);
  const [bx, by] = at(cx, cy, r2, to);
  const [cx2, cy2] = at(cx, cy, r1, to);
  const [dx, dy] = at(cx, cy, r1, from);
  const large = to - from > 180 ? 1 : 0;
  return (
    `M ${n2(ax)} ${n2(ay)} A ${r2} ${r2} 0 ${large} 1 ${n2(bx)} ${n2(by)} ` +
    `L ${n2(cx2)} ${n2(cy2)} A ${r1} ${r1} 0 ${large} 0 ${n2(dx)} ${n2(dy)} Z`
  );
};

/** 0〜1 にそろえた割合。値が無ければ 0。 */
const ratio = (value: number | null, max: number) =>
  value === null || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value / max));

const show = (value: number | null, digits = 0) =>
  value === null || !Number.isFinite(value) ? "—" : value.toFixed(digits);

/** 同じ絵が画面に2つあっても、色の指定(グラデーション)の名前がぶつからないようにする。 */
const useSvgId = () => `dg${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

/** 中心から外へ向かう目盛りの線。 */
const Tick = ({
  cx,
  cy,
  r1,
  r2,
  deg,
  className,
}: {
  cx: number;
  cy: number;
  r1: number;
  r2: number;
  deg: number;
  className: string;
}) => {
  const [x1, y1] = at(cx, cy, r1, deg);
  const [x2, y2] = at(cx, cy, r2, deg);
  return <line x1={n2(x1)} y1={n2(y1)} x2={n2(x2)} y2={n2(y2)} className={className} />;
};

/**
 * 光る管のような円弧。外側の淡い光・中くらいの光・芯の3枚を重ねる。
 * 長さは pathLength=100 にそろえ、割合(0〜100)だけ描く。
 */
const GlowArc = ({
  d,
  percent,
  width,
  stroke,
}: {
  d: string;
  percent: number;
  width: number;
  stroke: string;
}) => {
  const dash = `${n2(percent)} 100`;
  const hidden = percent < 0.4 ? " is-empty" : "";
  return (
    <g className={`dg-glow-arc${hidden}`}>
      <path d={d} pathLength={100} strokeDasharray={dash} strokeWidth={width * 2.8} className="dg-glow-far" style={{ stroke }} />
      <path d={d} pathLength={100} strokeDasharray={dash} strokeWidth={width * 1.7} className="dg-glow-near" style={{ stroke }} />
      <path d={d} pathLength={100} strokeDasharray={dash} strokeWidth={width} className="dg-glow-core" style={{ stroke }} />
      <path d={d} pathLength={100} strokeDasharray={dash} strokeWidth={Math.max(1, width * 0.22)} className="dg-glow-line" />
    </g>
  );
};

/** 速度の大きな数字(少し斜め)。 */
const BigSpeed = ({ x, y, size, value }: { x: number; y: number; size: number; value: number | null }) => (
  <text
    transform={`translate(${x} ${y}) skewX(-6)`}
    className="dg-speed"
    style={{ fontSize: size }}
    textAnchor="middle"
  >
    {show(value)}
  </text>
);

/* ------------------------------------------------------------------ */
/* ARC GAUGE: 太く光る弧と大きな数字。左上に回転数、右上に水温。          */
/* ------------------------------------------------------------------ */
function ArcDesign({ v }: { v: GaugeValues }) {
  const id = useSvgId();
  const START = -135;
  const END = 135;
  const speed = ratio(v.speed, SPEED_MAX);
  const angle = START + (END - START) * speed;
  const track = arcPath(200, 200, 158, START, END);
  const [tipX, tipY] = at(200, 200, 158, angle);
  const [needleX1, needleY1] = at(200, 200, 136, angle);
  const [needleX2, needleY2] = at(200, 200, 180, angle);
  return (
    <svg viewBox="0 0 400 400" className="dg dg-arc" role="img" aria-label={`速度 ${show(v.speed)} km/h`}>
      <defs>
        <linearGradient id={`${id}v`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" className="dg-stop-deep" />
          <stop offset=".45" className="dg-stop-hi" />
          <stop offset="1" className="dg-stop-ink" />
        </linearGradient>
        <radialGradient id={`${id}f`} cx=".5" cy=".5" r=".5">
          <stop offset=".55" className="dg-stop-face" />
          <stop offset="1" className="dg-stop-edge" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="194" className="dg-face" style={{ fill: `url(#${id}f)` }} />
      <path d={arcPath(200, 200, 190, -40, 128)} className="dg-ring-bright" />
      <path d={arcPath(200, 200, 190, 150, 300)} className="dg-ring-soft" />
      <circle cx="200" cy="200" r="181" className="dg-ring-dots" />
      <path d={track} className="dg-track" strokeWidth={16} />
      <GlowArc d={track} percent={speed * 100} width={13} stroke={`url(#${id}v)`} />
      {Array.from({ length: 33 }, (_, index) => {
        const deg = START + ((END - START) * index) / 32;
        const major = index % 4 === 0;
        return (
          <Tick
            key={index}
            cx={200}
            cy={200}
            r1={major ? 128 : 133}
            r2={140}
            deg={deg}
            className={deg <= angle && speed > 0 ? "dg-tick is-lit" : major ? "dg-tick is-major" : "dg-tick"}
          />
        );
      })}
      <line x1={n2(needleX1)} y1={n2(needleY1)} x2={n2(needleX2)} y2={n2(needleY2)} className="dg-needle-glow" />
      <line x1={n2(needleX1)} y1={n2(needleY1)} x2={n2(needleX2)} y2={n2(needleY2)} className="dg-needle-line" />
      <circle cx={n2(tipX)} cy={n2(tipY)} r="11" className="dg-tip-halo" />
      <circle cx={n2(tipX)} cy={n2(tipY)} r="5" className="dg-tip" />
      <circle cx="200" cy="200" r="92" className="dg-disc-ring" />
      <circle cx="200" cy="200" r="84" className="dg-disc" />
      <text x="114" y="104" className="dg-mini-label" textAnchor="middle">RPM</text>
      <text x="114" y="128" className="dg-mini-value" textAnchor="middle">{show(v.rpm)}</text>
      <text x="286" y="104" className="dg-mini-label" textAnchor="middle">TEMP °C</text>
      <text x="286" y="128" className="dg-mini-value" textAnchor="middle">{show(v.coolant)}</text>
      <text x="200" y="166" className="dg-caption" textAnchor="middle">SPEED</text>
      <text x="200" y="224" className="dg-speed-thin" textAnchor="middle">{show(v.speed)}</text>
      <text x="200" y="250" className="dg-unit" textAnchor="middle">km/h</text>
      <text x="200" y="330" className="dg-foot" textAnchor="middle">
        VOLT {show(v.voltage, 1)} V
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* HUD FRAME: 角を落とした四角い枠。左は回転数の柱、中は区切った速度の輪。 */
/* ------------------------------------------------------------------ */
function FrameDesign({ v }: { v: GaugeValues }) {
  const id = useSvgId();
  const cx = 206;
  const cy = 180;
  const START = -135;
  const END = 135;
  const SEGMENTS = 30;
  const step = (END - START) / SEGMENTS;
  const speed = ratio(v.speed, SPEED_MAX);
  const lit = Math.round(speed * SEGMENTS);
  const angle = START + (END - START) * speed;
  const rpm = ratio(v.rpm, RPM_MAX);
  const BARS = 16;
  const litBars = Math.round(rpm * BARS);
  const [needleX1, needleY1] = at(cx, cy, 96, angle);
  const [needleX2, needleY2] = at(cx, cy, 148, angle);
  const frame =
    "M 48 16 H 334 L 384 66 V 300 L 358 326 H 292 L 278 346 H 122 L 108 326 H 40 L 16 302 V 48 Z";
  return (
    <svg viewBox="0 0 400 400" className="dg dg-frame" role="img" aria-label={`速度 ${show(v.speed)} km/h`}>
      <defs>
        <pattern id={`${id}s`} width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4.5" height="9" className="dg-stripe" />
        </pattern>
        <linearGradient id={`${id}b`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" className="dg-stop-deep" />
          <stop offset="1" className="dg-stop-hi" />
        </linearGradient>
      </defs>
      <path d={frame} className="dg-frame-glow" />
      <path d={frame} className="dg-frame-fill" />
      <path d="M 54 26 H 328 L 374 72 V 294 L 352 316 H 46 L 26 296 V 54 Z" className="dg-frame-inner" />
      {/* 右上の斜めの縞と、右の縦の縞 */}
      <path d="M 232 22 H 330 L 344 36 H 246 Z" className="dg-stripes" style={{ fill: `url(#${id}s)` }} />
      <path d="M 366 92 H 376 V 168 H 366 Z" className="dg-stripes" style={{ fill: `url(#${id}s)` }} />
      <path d="M 334 16 L 384 66" className="dg-frame-accent" />
      {/* 右の物差し */}
      {Array.from({ length: 13 }, (_, index) => (
        <line
          key={index}
          x1={index % 3 === 0 ? 358 : 363}
          x2="370"
          y1={186 + index * 9}
          y2={186 + index * 9}
          className="dg-ruler"
        />
      ))}
      {/* 左の回転数の柱 */}
      <text x="40" y="58" className="dg-mini-label" textAnchor="middle">RPM</text>
      {Array.from({ length: BARS }, (_, index) => {
        const y = 296 - index * 14;
        const on = index < litBars;
        const red = index >= BARS * (RPM_RED / RPM_MAX);
        return (
          <rect
            key={index}
            x="31"
            y={y}
            width="18"
            height="10"
            rx="1.5"
            className={on ? "dg-bar is-lit" : "dg-bar"}
            style={on ? { fill: red ? "var(--dg-alt)" : `url(#${id}b)` } : undefined}
          />
        );
      })}
      <text x="60" y="82" className="dg-scale-small">8</text>
      <text x="60" y="194" className="dg-scale-small">4</text>
      <text x="60" y="306" className="dg-scale-small">0</text>
      {/* 速度の輪 */}
      <path d={arcPath(cx, cy, 147, START, END)} className="dg-ring-soft" />
      <path d={arcPath(cx, cy, 154, -60, 60)} className="dg-ring-bright" />
      <path
        d={arcPath(cx, cy, 127, START, END)}
        pathLength={100}
        strokeDasharray={`${n2(lit * (100 / SEGMENTS))} 100`}
        className="dg-seg-glow"
      />
      {Array.from({ length: SEGMENTS }, (_, index) => {
        const from = START + step * index + 0.9;
        const to = START + step * (index + 1) - 0.9;
        const on = index < lit;
        const head = on && index === lit - 1;
        return (
          <path
            key={index}
            d={bandPath(cx, cy, 116, 138, from, to)}
            className={head ? "dg-seg is-head" : on ? "dg-seg is-lit" : "dg-seg"}
          />
        );
      })}
      <circle cx={cx} cy={cy} r="104" className="dg-ring-dash" />
      <circle cx={cx} cy={cy} r="92" className="dg-disc" />
      <line x1={n2(needleX1)} y1={n2(needleY1)} x2={n2(needleX2)} y2={n2(needleY2)} className="dg-needle-glow" />
      <line x1={n2(needleX1)} y1={n2(needleY1)} x2={n2(needleX2)} y2={n2(needleY2)} className="dg-needle-line" />
      <text x={cx} y={cy - 40} className="dg-caption" textAnchor="middle">SPEED</text>
      <BigSpeed x={cx} y={cy + 24} size={70} value={v.speed} />
      <text x={cx} y={cy + 50} className="dg-unit" textAnchor="middle">km/h</text>
      {/* 右下: OBD2 の受信の強さ(つながっていれば4本) */}
      {[0, 1, 2, 3].map((index) => (
        <rect
          key={index}
          x={322 + index * 8}
          y={304 - index * 6}
          width="5"
          height={8 + index * 6}
          className={v.rpm !== null || index === 0 ? "dg-signal is-lit" : "dg-signal"}
        />
      ))}
      <text x="200" y="341" className="dg-foot" textAnchor="middle">
        TRIP {show(v.tripKm, 1)} km
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* HALO RING: 重なった光の輪。真ん中は角の丸い枠に速度。               */
/* ------------------------------------------------------------------ */
function HaloDesign({ v }: { v: GaugeValues }) {
  const id = useSvgId();
  const START = -150;
  const END = 150;
  const speed = ratio(v.speed, SPEED_MAX);
  const track = arcPath(200, 200, 172, START, END);
  return (
    <svg viewBox="0 0 400 400" className="dg dg-halo" role="img" aria-label={`速度 ${show(v.speed)} km/h`}>
      <defs>
        <linearGradient id={`${id}v`} x1="0" y1="1" x2="0" y2="0">
          <stop offset="0" className="dg-stop-deep" />
          <stop offset="1" className="dg-stop-hi" />
        </linearGradient>
        <linearGradient id={`${id}r`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" className="dg-stop-hi" />
          <stop offset=".5" className="dg-stop-deep" />
          <stop offset="1" className="dg-stop-alt" />
        </linearGradient>
      </defs>
      <circle cx="200" cy="200" r="194" className="dg-face" />
      <circle cx="200" cy="200" r="190" className="dg-ring-soft" />
      <path d={track} className="dg-track" strokeWidth={4} />
      <GlowArc d={track} percent={speed * 100} width={15} stroke={`url(#${id}v)`} />
      <circle cx="200" cy="200" r="153" className="dg-ring-dash-wide" />
      {Array.from({ length: 48 }, (_, index) => (
        <Tick
          key={index}
          cx={200}
          cy={200}
          r1={index % 4 === 0 ? 132 : 136}
          r2={141}
          deg={index * 7.5}
          className={index % 4 === 0 ? "dg-tick is-major" : "dg-tick"}
        />
      ))}
      <circle cx="200" cy="200" r="120" className="dg-ring-grad-glow" style={{ stroke: `url(#${id}r)` }} />
      <circle cx="200" cy="200" r="120" className="dg-ring-grad" style={{ stroke: `url(#${id}r)` }} />
      <circle cx="200" cy="200" r="106" className="dg-ring-soft" />
      <circle cx="200" cy="200" r="100" className="dg-disc" />
      <path d="M 188 150 L 200 139 L 212 150" className="dg-chevron" />
      <path d="M 188 252 L 200 263 L 212 252" className="dg-chevron" />
      <text x="200" y="128" className="dg-caption" textAnchor="middle">SPEED</text>
      <rect x="124" y="168" width="152" height="66" rx="33" className="dg-pill-glow" />
      <rect x="124" y="168" width="152" height="66" rx="33" className="dg-pill" />
      <text x="200" y="219" className="dg-speed-mono" textAnchor="middle">{show(v.speed)}</text>
      <text x="200" y="284" className="dg-unit" textAnchor="middle">km/h</text>
      <text x="200" y="377" className="dg-foot is-strong" textAnchor="middle">
        {show(v.rpm)} RPM
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* SPORT DIAL: 下の開いた半円の目盛り。下に水温・電圧・燃料のランプ。   */
/* ------------------------------------------------------------------ */
const ThermoIcon = () => (
  <path d="M -2.5 -9 a 2.5 2.5 0 0 1 5 0 v 9.5 a 5 5 0 1 1 -5 0 Z M -6 -6 h 3 M -6 -2 h 3" />
);
const BatteryIcon = () => (
  <path d="M -9 -5 h 18 v 12 h -18 Z M -6 -8 v 3 M 6 -8 v 3 M -6 1 h 4 M 3 1 h 4 M 5 -1 v 4" />
);
const FuelIcon = () => (
  <path d="M -7 8 v -15 a 2 2 0 0 1 2 -2 h 6 a 2 2 0 0 1 2 2 v 15 Z M -5 -4 h 6 M 3 -2 l 4 3 v 5 a 1.5 1.5 0 0 0 3 0 v -9 l -3 -3" />
);

function SportDesign({ v }: { v: GaugeValues }) {
  const id = useSvgId();
  const START = -120;
  const END = 120;
  // 出てきたときに、本物の車のように目盛りをいちばん上まで振り切ってから戻す。
  // 0: 始め(0) → 1: 振り切り(いちばん上) → 2: 本当の値。
  const [sweep, setSweep] = useState<0 | 1 | 2>(0);
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSweep(1));
    const timer = window.setTimeout(() => setSweep(2), 800);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, []);
  const realSpeed = ratio(v.speed, SPEED_MAX);
  const realRpm = ratio(v.rpm, RPM_MAX);
  const speed = sweep === 0 ? 0 : sweep === 1 ? 1 : realSpeed;
  const rpm = sweep === 0 ? 0 : sweep === 1 ? 1 : realRpm;
  const angle = START + (END - START) * speed;
  const track = arcPath(200, 200, 176, START, END);
  const rpmTrack = arcPath(200, 200, 108, START, END);
  const redFrom = START + (END - START) * (140 / SPEED_MAX);
  const lamps = [
    {
      key: "temp",
      icon: <ThermoIcon />,
      label: `${show(v.coolant)}°`,
      warn: v.coolant !== null && v.coolant >= COOLANT_HOT,
    },
    {
      key: "volt",
      icon: <BatteryIcon />,
      label: `${show(v.voltage, 1)}V`,
      warn: v.voltage !== null && (v.voltage < VOLTAGE_LOW || v.voltage > VOLTAGE_HIGH),
    },
    {
      key: "fuel",
      icon: <FuelIcon />,
      label: `${Math.round(v.rangeKm)}km`,
      warn: v.fuelPercent <= FUEL_LOW,
    },
  ];
  return (
    <svg viewBox="0 0 400 400" className="dg dg-sport" role="img" aria-label={`速度 ${show(v.speed)} km/h`}>
      <defs>
        <linearGradient id={`${id}v`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" className="dg-stop-deep" />
          <stop offset=".6" className="dg-stop-hi" />
          <stop offset="1" className="dg-stop-alt" />
        </linearGradient>
        <radialGradient id={`${id}g`} cx=".5" cy=".5" r=".5">
          <stop offset="0" className="dg-stop-glow" />
          <stop offset="1" className="dg-stop-none" />
        </radialGradient>
      </defs>
      {/* 背景の光は、速いほど強くする。 */}
      <circle
        cx="200"
        cy="200"
        r="196"
        className="dg-sport-glow"
        style={{ fill: `url(#${id}g)`, opacity: n2(0.55 + 0.45 * speed) }}
      />
      {/* 外枠: 細い輪と、上の方だけ光る縁 */}
      <circle cx="200" cy="200" r="198" className="dg-bezel" />
      <path d={arcPath(200, 200, 198, -48, 48)} className="dg-bezel-light" />
      <path d={arcPath(200, 200, 190, START, END)} className="dg-ring-dashed" />
      <path d={arcPath(200, 200, 190, redFrom, END)} className="dg-redline" />
      <path d={track} className="dg-track" strokeWidth={9} />
      <GlowArc d={track} percent={speed * 100} width={9} stroke={`url(#${id}v)`} />
      {/* 目盛りは、今の速度までが光る。140 から上は差し色。 */}
      {Array.from({ length: 33 }, (_, index) => {
        const deg = START + ((END - START) * index) / 32;
        const major = index % 4 === 0;
        const middle = index % 2 === 0;
        const lit = speed > 0 && deg <= angle + 0.01;
        return (
          <Tick
            key={index}
            cx={200}
            cy={200}
            r1={major ? 150 : middle ? 156 : 160}
            r2={165}
            deg={deg}
            className={`dg-tick${major ? " is-major" : ""}${lit ? " is-lit" : ""}${deg >= redFrom - 0.01 ? " is-red" : ""}`}
          />
        );
      })}
      {Array.from({ length: 9 }, (_, index) => {
        const [x, y] = at(200, 200, 131, START + ((END - START) * index) / 8);
        const value = index * 20;
        const lit = value <= speed * SPEED_MAX + 0.01;
        return (
          <text
            key={index}
            x={n2(x)}
            y={n2(y + 6)}
            className={`dg-scale${value >= 140 ? " is-red" : ""}${lit ? "" : " is-dim"}`}
            textAnchor="middle"
          >
            {value}
          </text>
        );
      })}
      {/* 内側の細い弧は回転数(6500回転から上は差し色)。 */}
      <path d={rpmTrack} className="dg-rpm-track" />
      <path d={arcPath(200, 200, 108, START + (END - START) * (RPM_RED / RPM_MAX), END)} className="dg-rpm-red" />
      {Array.from({ length: 9 }, (_, index) => (
        <Tick
          key={index}
          cx={200}
          cy={200}
          r1={113}
          r2={118}
          deg={START + ((END - START) * index) / 8}
          className="dg-rpm-tick"
        />
      ))}
      <path
        d={rpmTrack}
        pathLength={100}
        strokeDasharray={`${n2(rpm * 100)} 100`}
        className={`dg-rpm-value${rpm < 0.004 ? " is-empty" : ""}${realRpm >= RPM_RED / RPM_MAX && sweep === 2 ? " is-high" : ""}`}
      />
      {/* 弧の上を動く指針(円の中心で回すので、弧と同じ速さで動く)。 */}
      <g className="dg-sport-pointer" style={{ transform: `rotate(${n2(angle)}deg)` }}>
        <line x1="200" y1="10" x2="200" y2="52" className="dg-needle-glow" />
        <line x1="200" y1="12" x2="200" y2="50" className="dg-needle-line" />
        <circle cx="200" cy="24" r="16" className="dg-tip-halo" />
        <circle cx="200" cy="24" r="7.5" className="dg-tip" />
      </g>
      <BigSpeed x={200} y={226} size={86} value={v.speed} />
      <text x="200" y="254" className="dg-unit" textAnchor="middle">km/h</text>
      {lamps.map((lamp, index) => (
        <g key={lamp.key} transform={`translate(${146 + index * 54} 292)`} className={lamp.warn ? "dg-lamp is-warn" : "dg-lamp"}>
          <g className="dg-lamp-icon">{lamp.icon}</g>
          <text y="28" className="dg-lamp-value" textAnchor="middle">{lamp.label}</text>
        </g>
      ))}
      <text x="200" y="356" className="dg-foot" textAnchor="middle">
        RPM {show(v.rpm)}
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* ANALOG NEEDLE: 針のメーター。下に日付・時刻・速度の小窓。            */
/* ------------------------------------------------------------------ */
function AnalogDesign({ v }: { v: GaugeValues }) {
  const id = useSvgId();
  const START = -120;
  const END = 120;
  const speed = ratio(v.speed, SPEED_MAX);
  const angle = START + (END - START) * speed;
  // 針の通った跡を、針に近いほど明るく光らせる。
  const trailSteps = Math.ceil((angle - START) / 4);
  return (
    <svg viewBox="0 0 400 400" className="dg dg-analog" role="img" aria-label={`速度 ${show(v.speed)} km/h`}>
      <defs>
        <radialGradient id={`${id}f`} cx=".5" cy=".5" r=".5">
          <stop offset=".6" className="dg-stop-face" />
          <stop offset=".93" className="dg-stop-edge" />
          <stop offset="1" className="dg-stop-face" />
        </radialGradient>
      </defs>
      <circle cx="200" cy="200" r="194" className="dg-face" style={{ fill: `url(#${id}f)` }} />
      <circle cx="200" cy="200" r="192" className="dg-rim-glow" />
      <circle cx="200" cy="200" r="192" className="dg-rim" />
      <circle cx="200" cy="200" r="179" className="dg-ring-soft" />
      {Array.from({ length: trailSteps }, (_, index) => {
        const from = START + index * 4;
        const to = Math.min(angle, from + 4.4);
        const strength = (index + 1) / trailSteps;
        return (
          <path
            key={index}
            d={arcPath(200, 200, 160, from, to)}
            className="dg-trail"
            style={{ opacity: n2(0.06 + 0.5 * strength * strength) }}
          />
        );
      })}
      {Array.from({ length: 33 }, (_, index) => {
        const deg = START + ((END - START) * index) / 32;
        const major = index % 4 === 0;
        const middle = index % 2 === 0;
        return (
          <Tick
            key={index}
            cx={200}
            cy={200}
            r1={major ? 154 : middle ? 160 : 165}
            r2={174}
            deg={deg}
            className={major ? "dg-tick is-major" : middle ? "dg-tick is-mid" : "dg-tick"}
          />
        );
      })}
      {Array.from({ length: 9 }, (_, index) => {
        const [x, y] = at(200, 200, 132, START + ((END - START) * index) / 8);
        return (
          <text key={index} x={n2(x)} y={n2(y + 7)} className="dg-scale is-large" textAnchor="middle">
            {index * 20}
          </text>
        );
      })}
      <text x="200" y="118" className="dg-caption" textAnchor="middle">km/h</text>
      <g className="dg-needle" style={{ transform: `rotate(${n2(angle)}deg)` }}>
        <path d="M 194 214 L 198.6 50 L 201.4 50 L 206 214 Z" className="dg-needle-shadow" />
        <path d="M 196 212 L 199.2 52 L 200.8 52 L 204 212 Z" className="dg-needle-body" />
        <path d="M 198.6 52 L 201.4 52 L 202.2 92 L 197.8 92 Z" className="dg-needle-tip" />
      </g>
      <circle cx="200" cy="200" r="17" className="dg-cap" />
      <circle cx="200" cy="200" r="5" className="dg-tip" />
      <rect x="124" y="262" width="152" height="80" rx="13" className="dg-panel-glow" />
      <rect x="124" y="262" width="152" height="80" rx="13" className="dg-panel" />
      <text x="138" y="281" className="dg-panel-small">{v.dateLabel}</text>
      <text x="262" y="281" className="dg-panel-small" textAnchor="end">{v.clock}</text>
      <text x="196" y="318" className="dg-panel-speed" textAnchor="end">{show(v.speed)}</text>
      <text x="202" y="318" className="dg-panel-unit">km/h</text>
      <text x="138" y="334" className="dg-panel-small">RPM {show(v.rpm)}</text>
      <text x="262" y="334" className="dg-panel-small" textAnchor="end">{show(v.voltage, 1)} V</text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* TACHO RING: 細かい目盛りの回転計。中は速度と回転の棒。              */
/* ------------------------------------------------------------------ */
const EQUALIZER = [0.45, 0.7, 0.55, 0.9, 1, 0.8, 0.6, 0.85, 0.5];

function TachoDesign({ v }: { v: GaugeValues }) {
  const START = -135;
  const END = 135;
  const rpm = ratio(v.rpm, RPM_MAX);
  const angle = START + (END - START) * rpm;
  const redFrom = START + (END - START) * (RPM_RED / RPM_MAX);
  const SEGMENTS = 50;
  const step = (END - START) / SEGMENTS;
  const lit = Math.round(rpm * SEGMENTS);
  return (
    <svg viewBox="0 0 400 400" className="dg dg-tacho" role="img" aria-label={`回転数 ${show(v.rpm)} rpm、速度 ${show(v.speed)} km/h`}>
      <circle cx="200" cy="200" r="194" className="dg-face" />
      <circle cx="200" cy="200" r="191" className="dg-ring-soft" />
      {Array.from({ length: 121 }, (_, index) => {
        const deg = START + index * 2.25;
        const major = index % 15 === 0;
        const red = deg >= redFrom;
        const on = rpm > 0 && deg <= angle;
        return (
          <Tick
            key={index}
            cx={200}
            cy={200}
            r1={major ? 160 : 171}
            r2={185}
            deg={deg}
            className={`dg-tick${major ? " is-major" : ""}${on ? " is-lit" : ""}${red ? " is-red" : ""}`}
          />
        );
      })}
      {Array.from({ length: 9 }, (_, index) => {
        const [x, y] = at(200, 200, 145, START + ((END - START) * index) / 8);
        return (
          <text key={index} x={n2(x)} y={n2(y + 6)} className={index >= 7 ? "dg-scale is-red" : "dg-scale"} textAnchor="middle">
            {index}
          </text>
        );
      })}
      <path
        d={arcPath(200, 200, 116, START, END)}
        pathLength={100}
        strokeDasharray={`${n2(lit * (100 / SEGMENTS))} 100`}
        className="dg-seg-glow"
      />
      {Array.from({ length: SEGMENTS }, (_, index) => {
        const from = START + step * index + 0.7;
        const to = START + step * (index + 1) - 0.7;
        const on = index < lit;
        const zone = index >= SEGMENTS * (RPM_RED / RPM_MAX) ? " is-red" : index >= SEGMENTS * 0.55 ? " is-hot" : "";
        return (
          <path
            key={index}
            d={bandPath(200, 200, 104, 128, from, to)}
            className={`dg-seg${on ? " is-lit" : ""}${on ? zone : ""}${on && index === lit - 1 ? " is-head" : ""}`}
          />
        );
      })}
      <circle cx="200" cy="200" r="96" className="dg-ring-soft" />
      <circle cx="200" cy="200" r="90" className="dg-disc" />
      <text x="200" y="150" className="dg-caption" textAnchor="middle">×1000 r/min</text>
      <BigSpeed x={200} y={214} size={64} value={v.speed} />
      <text x="200" y="238" className="dg-unit" textAnchor="middle">km/h</text>
      {EQUALIZER.map((shape, index) => {
        const height = 4 + 22 * shape * Math.max(0.12, rpm);
        return (
          <rect
            key={index}
            x={157 + index * 10}
            y={n2(276 - height)}
            width="6"
            height={n2(height)}
            rx="1"
            className="dg-eq"
          />
        );
      })}
      <text x="200" y="322" className="dg-foot is-strong" textAnchor="middle">
        {show(v.rpm)} RPM
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* NAVI GAUGE(今の形)の見本。本物は page.tsx で地図と一緒に描く。      */
/* ------------------------------------------------------------------ */
function NaviPreview() {
  return (
    <svg viewBox="0 0 400 400" className="dg dg-navi" role="img" aria-label="NAVI GAUGE">
      <circle cx="200" cy="200" r="194" className="dg-face" />
      <circle cx="200" cy="200" r="190" className="dg-rim-glow" />
      <circle cx="200" cy="200" r="190" className="dg-rim" />
      {Array.from({ length: 50 }, (_, index) => {
        const from = -150 + index * 6;
        return (
          <path
            key={index}
            d={bandPath(200, 200, 158, 172, from, from + 4.2)}
            className={index < 12 ? "dg-seg is-lit" : "dg-seg"}
          />
        );
      })}
      <circle cx="200" cy="200" r="132" className="dg-map" />
      <path d="M 70 200 H 330 M 200 70 V 330 M 120 110 L 290 300 M 90 260 L 310 150" className="dg-map-road" />
      <text x="200" y="88" className="dg-caption" textAnchor="middle">N</text>
      <BigSpeed x={200} y={224} size={78} value={58} />
      <text x="200" y="252" className="dg-unit" textAnchor="middle">km/h</text>
    </svg>
  );
}

/** 形の絵。navi は見本(本物の地図つきメーターは page.tsx)。 */
export function MeterDesignGauge({ design, values }: { design: MeterDesign; values: GaugeValues }) {
  switch (design) {
    case "arc":
      return <ArcDesign v={values} />;
    case "frame":
      return <FrameDesign v={values} />;
    case "halo":
      return <HaloDesign v={values} />;
    case "sport":
      return <SportDesign v={values} />;
    case "analog":
      return <AnalogDesign v={values} />;
    case "tacho":
      return <TachoDesign v={values} />;
    default:
      return <NaviPreview />;
  }
}
