"use client";

import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import { loadGoogleMaps, NIGHT_MAP_STYLES } from "../google-maps";

/** 8方位の呼び名。 */
const NAMES = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];
/** 向きの呼び名(例: 「西へ」)。null は両方の向き。 */
export const directionName = (direction: number | null) =>
  direction === null ? "両方の向き" : `${NAMES[Math.round(direction / 45) % 8]}へ`;

/** ダイヤルを回したときの刻み(度)。 */
const STEP = 5;
/** 目盛り(15度ごと。北・東・南・西は長く)。 */
const TICKS = Array.from({ length: 24 }, (_, i) => i * 15);
const LABELS = [
  { text: "北", angle: 0 },
  { text: "東", angle: 90 },
  { text: "南", angle: 180 },
  { text: "西", angle: 270 },
];

/** 外から点(オービス)へ流れる3つの山形(›››)。外側ほど薄く、順に光って点へ流れる。 */
const FLOW = [
  "-12,57 0,46 12,57",
  "-12,41 0,30 12,41",
  "-12,25 0,14 12,25",
];
const Flow = () => (
  <>
    {FLOW.map((points) => (
      <polyline key={points} points={points} />
    ))}
  </>
);

/**
 * オービスの「走る向き」を選ぶダイヤル。その場所の小さな地図(北が上)の上に、丸い目盛りと、
 * 外から点(オービス)へ流れる山形(›››)を重ねる。車が来る方の外側を押す(なぞる)と、
 * そちらから来て点を通る向きになる。◀ ▶ で 5度ずつ、「両方の向き」で向きなし
 * (上り・下りどちらでも知らせる。上と下の両方から流れる)。
 */
export function OrbisDial({
  lat,
  lng,
  direction,
  mapsKey,
  onChange,
}: {
  lat: number;
  lng: number;
  /** 走る向き(度。北が0、東が90)。null は両方の向き。 */
  direction: number | null;
  mapsKey: string;
  onChange: (direction: number | null) => void;
}) {
  const mapRef = useRef<HTMLDivElement>(null);

  // 道の向きを見るための小さな地図。読めなくても、ダイヤルは使える。
  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps(mapsKey)
      .then((maps) => {
        if (cancelled || !mapRef.current) return;
        const api = maps as {
          Map: new (element: HTMLElement, options: Record<string, unknown>) => unknown;
        };
        new api.Map(mapRef.current, {
          center: { lat, lng },
          zoom: 17,
          styles: NIGHT_MAP_STYLES,
          backgroundColor: "#03150b",
          disableDefaultUI: true,
          clickableIcons: false,
          gestureHandling: "none",
          keyboardShortcuts: false,
        });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lat, lng, mapsKey]);

  /**
   * 押した(なぞった)所から来る向きにする(走る向きは、押した所から点の方)。
   * 真ん中のあたりは向きが決まらないので見ない。
   */
  const pick = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const dx = event.clientX - (box.left + box.width / 2);
    const dy = event.clientY - (box.top + box.height / 2);
    if (Math.hypot(dx, dy) < box.width * 0.12) return;
    const from = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    onChange(((Math.round(from / STEP) * STEP) + 180) % 360);
  };
  const turn = (step: number) => onChange((((direction ?? 0) + step) % 360 + 360) % 360);
  const onKey = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowUp") turn(STEP);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") turn(-STEP);
    else return;
    event.preventDefault();
  };

  return (
    <div className="zr-dial">
      <p className="zr-dial-hint">地図の道で、車が来る方の外側を押して(なぞって)向きを決めます</p>
      <div className="zr-dial-face">
        <div ref={mapRef} className="zr-dial-map" />
        <svg
          className="zr-dial-ring"
          viewBox="-100 -100 200 200"
          role="slider"
          tabIndex={0}
          aria-label="走る向き"
          aria-valuemin={0}
          aria-valuemax={359}
          aria-valuenow={direction ?? undefined}
          aria-valuetext={direction === null ? "両方の向き" : `${directionName(direction)} ${direction}度`}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId);
            pick(event);
          }}
          onPointerMove={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) pick(event);
          }}
          onKeyDown={onKey}
        >
          <circle className="zr-dial-rim" r="94" />
          {TICKS.map((angle) => (
            <line
              key={angle}
              className={angle % 90 === 0 ? "is-long" : undefined}
              y1={-94}
              y2={angle % 90 === 0 ? -82 : -87}
              transform={`rotate(${angle})`}
            />
          ))}
          {LABELS.map(({ text, angle }) => (
            <text
              key={text}
              x={Math.sin((angle * Math.PI) / 180) * 72}
              y={-Math.cos((angle * Math.PI) / 180) * 72 + 5}
              textAnchor="middle"
            >
              {text}
            </text>
          ))}
          {direction === null ? (
            // 両方の向き: 上と下の両方から点へ流れる(どちらから来ても知らせる)。
            <g className="zr-dial-flow is-both">
              <g>
                <Flow />
              </g>
              <g transform="rotate(180)">
                <Flow />
              </g>
            </g>
          ) : (
            // 走る向きが上になるように回す。山形は下(来る方)から点へ流れる。
            <g className="zr-dial-flow" transform={`rotate(${direction})`}>
              <Flow />
            </g>
          )}
          <circle className="zr-dial-spot" r="9" />
        </svg>
      </div>
      <div className="zr-dial-keys">
        <button type="button" aria-label="左へ5度回す" onClick={() => turn(-STEP)}>
          ◀ 5°
        </button>
        <button type="button" aria-pressed={direction === null} onClick={() => onChange(null)}>
          両方の向き
        </button>
        <button type="button" aria-label="右へ5度回す" onClick={() => turn(STEP)}>
          5° ▶
        </button>
      </div>
      <p className="zr-dial-text">
        {direction === null
          ? "上り・下りの両方で知らせます"
          : `${directionName(direction)}(${direction}°)走るときだけ知らせます`}
      </p>
    </div>
  );
}
