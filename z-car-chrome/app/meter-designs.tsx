"use client";

// 真ん中のメーターの形 ORBIT NAVI(大きな地図のまわりに細かい目盛りの回転計)を SVG で描く。
// 地図の入った今の形(NAVI GAUGE)の本物は app/page.tsx にあり、ここにはその見本の絵だけ置く。
//
// 色はすべて計器の部品と同じ「緑」で塗る(globals.css の .dg の変数)。
// 計器全体に filter がかかっているので、8色のどれを選んでもその色になる。
// 下の二隅(平均巡行速度・平均燃費)の文字が重ならないよう、絵は二隅を空けてある。

import { useId } from "react";
import type { MeterDesign } from "./settings-store";

/** 形の絵に渡す値。取れていない値は null。 */
export type GaugeValues = {
  /** 速度(km/h)。 */
  speed: number | null;
  rpm: number | null;
  /** 進んでいる向き(北が0、時計回りの度)。分からなければ null。地図はこの分だけ逆に回る。 */
  heading: number | null;
};

/** 形選びの見本に出す値。 */
export const SAMPLE_GAUGE_VALUES: GaugeValues = {
  speed: 58,
  rpm: 2400,
  heading: 0,
};

const RPM_MAX = 8000;
/** ここから上の回転は目盛りの色を変える。 */
const RPM_RED = 6500;

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
/* ORBIT NAVI: 大きな丸い地図のまわりに、細かい目盛りの回転計。          */
/* 地図そのものは page.tsx が下に敷く(NAVI と同じ作り方)。ここは輪と文字。 */
/* ------------------------------------------------------------------ */
/** 中心(200,200)の、内側 r1・外側 r2 の輪(内側は抜ける。fill-rule は evenodd)。 */
const annulus = (r1: number, r2: number) =>
  `M ${200 - r2} 200 a ${r2} ${r2} 0 1 0 ${2 * r2} 0 a ${r2} ${r2} 0 1 0 ${-2 * r2} 0 Z ` +
  `M ${200 - r1} 200 a ${r1} ${r1} 0 1 0 ${2 * r1} 0 a ${r1} ${r1} 0 1 0 ${-2 * r1} 0 Z`;

function OrbitDesign({ v, liveMap }: { v: GaugeValues; liveMap: boolean }) {
  const id = useSvgId();
  const START = -135;
  const END = 135;
  const rpm = ratio(v.rpm, RPM_MAX);
  const angle = START + (END - START) * rpm;
  const redFrom = START + (END - START) * (RPM_RED / RPM_MAX);
  const SEGMENTS = 45;
  const step = (END - START) / SEGMENTS;
  const lit = Math.round(rpm * SEGMENTS);
  const heading = v.heading ?? 0;
  return (
    <svg
      viewBox="0 0 400 400"
      className="dg dg-orbit"
      role="img"
      aria-label={`速度 ${show(v.speed)} km/h、回転数 ${show(v.rpm)} rpm`}
    >
      <defs>
        <radialGradient id={`${id}p`} cx=".5" cy=".5" r=".5">
          <stop offset="0" className="dg-stop-pod" />
          <stop offset=".7" className="dg-stop-pod-mid" />
          <stop offset="1" className="dg-stop-pod-end" />
        </radialGradient>
      </defs>
      {/* 地図の外側の暗い面(地図の窓は抜けている)。見本では地図の代わりに道を描く。 */}
      <path d={annulus(150, 199)} className="dg-orbit-face" fillRule="evenodd" />
      {!liveMap ? (
        <g>
          <circle cx="200" cy="200" r="150" className="dg-map" />
          <path
            d="M 60 232 L 340 168 M 150 52 L 236 348 M 78 118 L 322 298 M 252 58 L 118 342"
            className="dg-map-road"
          />
        </g>
      ) : null}
      <circle cx="200" cy="200" r="198" className="dg-bezel" />
      <path d={arcPath(200, 200, 198, -48, 48)} className="dg-bezel-light" />
      {/* 細かい目盛り(今の回転数までが光る。6500回転から上は差し色) */}
      {Array.from({ length: 121 }, (_, index) => {
        const deg = START + index * 2.25;
        const major = index % 15 === 0;
        const on = rpm > 0 && deg <= angle + 0.01;
        return (
          <Tick
            key={index}
            cx={200}
            cy={200}
            r1={major ? 170 : 180}
            r2={194}
            deg={deg}
            className={`dg-tick${major ? " is-major" : ""}${on ? " is-lit" : ""}${deg >= redFrom - 0.01 ? " is-red" : ""}`}
          />
        );
      })}
      {Array.from({ length: 9 }, (_, index) => {
        const [x, y] = at(200, 200, 160, START + ((END - START) * index) / 8);
        return (
          <text key={index} x={n2(x)} y={n2(y + 5)} className={index >= 7 ? "dg-scale is-red" : "dg-scale"} textAnchor="middle">
            {index}
          </text>
        );
      })}
      {/* 地図の窓のふちと、その内側の区切った回転数の輪(地図が少し透ける暗い帯の上) */}
      <circle cx="200" cy="200" r="150" className="dg-orbit-rim-glow" />
      <circle cx="200" cy="200" r="150" className="dg-orbit-rim" />
      <path d={annulus(126, 149)} className="dg-orbit-band" fillRule="evenodd" />
      <ellipse cx="200" cy="296" rx="96" ry="52" style={{ fill: `url(#${id}p)` }} />
      <path
        d={arcPath(200, 200, 137, START, END)}
        pathLength={100}
        strokeDasharray={`${n2(lit * (100 / SEGMENTS))} 100`}
        className="dg-seg-glow is-thin"
      />
      {Array.from({ length: SEGMENTS }, (_, index) => {
        const from = START + step * index + 0.8;
        const to = START + step * (index + 1) - 0.8;
        const on = index < lit;
        const zone =
          index >= SEGMENTS * (RPM_RED / RPM_MAX) ? " is-red" : index >= SEGMENTS * 0.55 ? " is-hot" : "";
        return (
          <path
            key={index}
            d={bandPath(200, 200, 130, 145, from, to)}
            className={`dg-seg${on ? " is-lit" : ""}${on ? zone : ""}${on && index === lit - 1 ? " is-head" : ""}`}
          />
        );
      })}
      {/* 北の印(地図と同じだけ回る) */}
      <g className="dg-orbit-north" style={{ transform: `rotate(${n2(-heading)}deg)` }}>
        <circle cx="200" cy="84" r="9" className="dg-orbit-north-dot" />
        <text x="200" y="88" className="dg-orbit-north-text" textAnchor="middle">
          N
        </text>
      </g>
      {/* 自分の車(地図の真ん中。地図は進む向きが上) */}
      <circle cx="200" cy="200" r="16" className="dg-tip-halo" />
      <path d="M 200 185 L 211 211 L 200 204.5 L 189 211 Z" className="dg-orbit-car" />
      {/* 下に大きな速度 */}
      <BigSpeed x={200} y={312} size={60} value={v.speed} />
      <text x="200" y="334" className="dg-unit" textAnchor="middle">
        km/h
      </text>
      <text x="200" y="376" className="dg-foot is-strong" textAnchor="middle">
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

/**
 * 形の絵。navi は見本(本物の地図つきメーターは page.tsx)。
 * orbit は liveMap のとき地図の所を空け、下に敷いた本物の地図を見せる。
 */
export function MeterDesignGauge({
  design,
  values,
  liveMap = false,
}: {
  design: MeterDesign;
  values: GaugeValues;
  liveMap?: boolean;
}) {
  return design === "orbit" ? <OrbitDesign v={values} liveMap={liveMap} /> : <NaviPreview />;
}
