"use client";

// 近未来のテーマの、丸い地図の上のオービス。
// 地図の縁を輪にして残りの距離だけ光らせる(近づくほど短く)。輪の上に距離、地図の中の右下に制限と今の速さ、
// 地図の上に赤いカメラの印と車からの点線。
// 近未来のメーターには色を変える filter(ブルーなら色を回す)がかかっていて、中に描くと警告の赤が変わってしまう。
// そのため地図の窓の場所を測り、filter の外(main の直下)から重ねる(出勤日の札 WorkdayMarks と同じ作り)。

import { useEffect, useRef, useState, type RefObject } from "react";
import { orbisDistance, type OrbisView } from "./meter-styles";

/** この距離(m)で輪がいっぱい。近づくほど短くなる。 */
const RING_FULL_M = 500;
/** 輪と地図の縁の間の空き(輪の太さの真ん中まで)。 */
const RING_GAP = 9;
/** 印を置ける、地図の縁からの内側の空き(縁で切れないように)。 */
const MARK_EDGE = 20;

const round = (value: number) => Math.round(value * 100) / 100;

type Box = { x: number; y: number; size: number };

const CameraIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="3" y="7" width="13" height="10" rx="1.5" />
    <path d="M16 10.5 21 8v8l-5-2.5" />
    <circle cx="9.5" cy="12" r="2.2" />
  </svg>
);

export function OrbisRing({
  orbis,
  windowRef,
  metersPerPx,
  rotation,
}: {
  orbis: OrbisView;
  /** 丸い地図の窓(NAVI GAUGE・ORBIT NAVI のどちらか)。 */
  windowRef: RefObject<HTMLElement | null>;
  /** 地図の1点が何mか(今の縮尺で)。 */
  metersPerPx: number;
  /** 地図の回り(度)。地図は進む向きが上なので、印も地図と同じだけ回す。 */
  rotation: number;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  useEffect(() => {
    const layer = layerRef.current;
    const map = windowRef.current;
    if (!layer || !map || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const base = layer.getBoundingClientRect();
      const rect = map.getBoundingClientRect();
      const next = { x: round(rect.left - base.left), y: round(rect.top - base.top), size: round(rect.width) };
      setBox((current) =>
        current && current.x === next.x && current.y === next.y && current.size === next.size ? current : next,
      );
    };
    // 見始めたときにも一度呼ばれる。
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(map);
    return () => observer.disconnect();
  }, [windowRef]);

  const over = orbis.limit !== null && orbis.speed !== null && orbis.speed > orbis.limit;
  const tone = orbis.level === "show" ? "is-show" : over ? "is-over" : "is-warn";
  const distance = orbisDistance(orbis.distance);
  return (
    <div ref={layerRef} className={`fo-orbis ${tone}`}>
      {box ? (
        (() => {
          const r = box.size / 2;
          const cx = box.x + r;
          const cy = box.y + r;
          const ringR = r + RING_GAP;
          const pad = 8;
          const circumference = 2 * Math.PI * ringR;
          const lit = round(circumference * Math.min(1, Math.max(0, orbis.distance / RING_FULL_M)));
          // 印: 北が上の向きで車(真ん中)から東・北へ。縁より外なら、同じ向きの縁の内側に置く。
          let markX = orbis.east / metersPerPx;
          let markY = -orbis.north / metersPerPx;
          const reach = Math.hypot(markX, markY);
          if (reach > r - MARK_EDGE) {
            markX = (markX / reach) * (r - MARK_EDGE);
            markY = (markY / reach) * (r - MARK_EDGE);
          }
          return (
            <>
              <svg
                className="fo-orbis-ring"
                style={{ left: cx - ringR - pad, top: cy - ringR - pad, width: 2 * (ringR + pad), height: 2 * (ringR + pad) }}
                viewBox={`${-ringR - pad} ${-ringR - pad} ${2 * (ringR + pad)} ${2 * (ringR + pad)}`}
                aria-hidden="true"
              >
                <circle className="fo-orbis-track" r={round(ringR)} />
                {/* 光りは、太く薄い線を下に重ねて出す(影の filter は機種によって崩れるので使わない)。 */}
                <circle className="fo-orbis-glow" r={round(ringR)} strokeDasharray={`${lit} ${round(circumference)}`} transform="rotate(-90)" />
                <circle className="fo-orbis-arc" r={round(ringR)} strokeDasharray={`${lit} ${round(circumference)}`} transform="rotate(-90)" />
              </svg>
              <div
                className="fo-orbis-map"
                style={{ left: box.x, top: box.y, width: box.size, height: box.size, transform: `rotate(${rotation}deg)` }}
                aria-hidden="true"
              >
                <svg viewBox={`0 0 ${box.size} ${box.size}`}>
                  <line x1={r} y1={r} x2={round(r + markX)} y2={round(r + markY)} />
                </svg>
                <span className="fo-orbis-mark" style={{ left: round(r + markX), top: round(r + markY), transform: `translate(-50%, -50%) rotate(${-rotation}deg)` }}>
                  <i>
                    <CameraIcon />
                  </i>
                </span>
              </div>
              <div className="fo-orbis-tag" role="status" style={{ left: cx, top: cy - ringR }}>
                <CameraIcon />
                <b className="fo-orbis-name">ORBIS</b>
                <b className="fo-orbis-distance">
                  {distance.value}
                  <small> {distance.unit}</small>
                </b>
                {/* 連続区間: 1 2 3 の札(通ったものは薄く、いまのものを光らせる)。 */}
                {orbis.series ? (
                  <span
                    className="fo-orbis-series"
                    aria-label={`オービス連続区間 全${orbis.series.total}か所の${orbis.series.index}か所目`}
                  >
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
                ) : null}
              </div>
              {orbis.muted ? (
                <small className="fo-orbis-muted" style={{ left: cx, top: cy - ringR + 24 }}>
                  画面に触れると声が出ます
                </small>
              ) : null}
              <div className="fo-orbis-speed" style={{ left: round(cx + r * 0.62), top: round(cy + r * 0.5) }}>
                {orbis.limit !== null ? (
                  <i className="fo-orbis-limit" aria-label={`制限速度 ${orbis.limit}`}>
                    {orbis.limit}
                  </i>
                ) : null}
                {orbis.speed !== null ? (
                  <b aria-label={`いまの速さ ${orbis.speed}`}>
                    {orbis.speed}
                    <small>km/h</small>
                  </b>
                ) : null}
              </div>
              {orbis.osm ? (
                <small className="fo-orbis-credit" style={{ left: cx, top: round(cy + r * 0.84) }}>
                  © OpenStreetMap
                </small>
              ) : null}
            </>
          );
        })()
      ) : null}
    </div>
  );
}
