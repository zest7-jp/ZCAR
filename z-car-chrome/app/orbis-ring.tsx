"use client";

// 近未来のテーマの、丸い地図の上のオービスと速度取締区間。
// 地図の縁を輪にして残りの距離だけ光らせる(近づくほど短く)。輪の上に距離、地図の中の右下に制限と今の速さ、
// 地図の上に赤いカメラの印と車からの点線。速度取締区間は紫で、地図に区間の線と「取締」「終」の札、
// 輪の上に「取締区間まで 300m」(中は「取締区間 あと 1.2km」。輪は区間の残りだけ光る)。
// オービスと区間が同時なら、輪と右下はオービス、区間の札はオービスの札の下に出す。
// 近未来のメーターには色を変える filter(ブルーなら色を回す)がかかっていて、中に描くと警告の赤が変わってしまう。
// そのため地図の窓の場所を測り、filter の外(main の直下)から重ねる(出勤日の札 WorkdayMarks と同じ作り)。

import { useEffect, useRef, useState, type RefObject } from "react";
import { orbisDistance, zoneOnMap, ZoneIcon, type OrbisView, type ZoneView } from "./meter-styles";
import { ZONE_WARN_M } from "./speed-zone";

/** この距離(m)で輪がいっぱい。近づくほど短くなる。 */
const RING_FULL_M = 500;
/** 輪と地図の縁の間の空き(輪の太さの真ん中まで)。 */
const RING_GAP = 9;
/** 印を置ける、地図の縁からの内側の空き(縁で切れないように)。 */
const MARK_EDGE = 20;
/** オービスの札の下に、区間の札を出すときの間(点)。 */
const TAG_STEP = 40;

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
  zone,
  windowRef,
  metersPerPx,
  rotation,
}: {
  orbis: OrbisView | null;
  zone: ZoneView | null;
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

  const orbisOver = !!orbis && orbis.limit !== null && orbis.speed !== null && orbis.speed > orbis.limit;
  const zoneOver = !!zone && zone.limit !== null && zone.speed !== null && zone.speed > zone.limit;
  // 輪の色: オービスがあればオービス(静か・警告・速すぎは赤)、区間だけなら紫(手前は脈打ち、中は静かに光る)。
  const tone = orbis
    ? orbis.level === "show"
      ? "is-show"
      : orbisOver
        ? "is-over"
        : "is-warn"
    : zone?.state === "before"
      ? "is-zone is-zone-before"
      : "is-zone";
  // 輪の光る割合: オービスは 500m でいっぱい。区間の手前は入口まで 500m で、中は区間の残りの割合。
  const share = orbis
    ? orbis.distance / RING_FULL_M
    : zone
      ? zone.state === "before"
        ? zone.distance / ZONE_WARN_M
        : zone.distance / Math.max(1, zone.length)
      : 0;
  const orbisDistanceText = orbis ? orbisDistance(orbis.distance) : null;
  const zoneDistanceText = zone ? orbisDistance(zone.distance) : null;
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
          const lit = round(circumference * Math.min(1, Math.max(0, share)));
          // 印: 北が上の向きで車(真ん中)から東・北へ。縁より外なら、同じ向きの縁の内側に置く。
          let markX = orbis ? orbis.east / metersPerPx : 0;
          let markY = orbis ? -orbis.north / metersPerPx : 0;
          const reach = Math.hypot(markX, markY);
          if (reach > r - MARK_EDGE) {
            markX = (markX / reach) * (r - MARK_EDGE);
            markY = (markY / reach) * (r - MARK_EDGE);
          }
          const zoneAt = zone ? zoneOnMap(zone, metersPerPx, box.size, box.size, true) : null;
          const zoneTagTop = cy - ringR + (orbis ? TAG_STEP : 0);
          const muted = orbis?.muted || zone?.muted;
          // 右下の制限と速さ: オービスがあればオービスの分、区間だけなら区間の分(制限が分かるときだけ)。
          const speed = orbis
            ? { limit: orbis.limit, value: orbis.speed, over: orbisOver }
            : zone && zone.limit !== null
              ? { limit: zone.limit, value: zone.speed, over: zoneOver }
              : null;
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
                  {zoneAt?.line ? (
                    <g className="fo-zone-line">
                      <line className="fo-zone-glow" {...zoneAt.line} />
                      <line className="fo-zone-road" {...zoneAt.line} />
                      {zoneAt.entry.shown ? <line className="fo-zone-tick" {...zoneAt.entry.tick} /> : null}
                      {zoneAt.exit.shown ? <line className="fo-zone-tick" {...zoneAt.exit.tick} /> : null}
                    </g>
                  ) : null}
                  {orbis ? <line className="fo-orbis-line" x1={r} y1={r} x2={round(r + markX)} y2={round(r + markY)} /> : null}
                </svg>
                {zoneAt
                  ? (
                      [
                        ["is-entry", zoneAt.entry, "取締"],
                        ["is-exit", zoneAt.exit, "終"],
                      ] as const
                    ).map(([kind, end, text]) =>
                      end.shown ? (
                        <span
                          key={kind}
                          className={`fo-zone-flag ${kind}`}
                          style={{ left: end.flag.x, top: end.flag.y, transform: `translate(-50%, -50%) rotate(${-rotation}deg)` }}
                        >
                          {text}
                        </span>
                      ) : null,
                    )
                  : null}
                {orbis ? (
                  <span className="fo-orbis-mark" style={{ left: round(r + markX), top: round(r + markY), transform: `translate(-50%, -50%) rotate(${-rotation}deg)` }}>
                    <i>
                      <CameraIcon />
                    </i>
                  </span>
                ) : null}
              </div>
              {orbis && orbisDistanceText ? (
                <div className="fo-orbis-tag" role="status" style={{ left: cx, top: cy - ringR }}>
                  <CameraIcon />
                  <b className="fo-orbis-name">ORBIS</b>
                  <b className="fo-orbis-distance">
                    {orbisDistanceText.value}
                    <small> {orbisDistanceText.unit}</small>
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
              ) : null}
              {zone && zoneDistanceText ? (
                <div className="fo-zone-tag" role="status" style={{ left: cx, top: zoneTagTop }}>
                  <ZoneIcon />
                  <b className="fo-zone-name">{zone.state === "before" ? "取締区間まで" : "取締区間 あと"}</b>
                  <b className="fo-zone-distance">
                    {zoneDistanceText.value}
                    <small> {zoneDistanceText.unit}</small>
                  </b>
                </div>
              ) : null}
              {muted ? (
                <small className="fo-orbis-muted" style={{ left: cx, top: (zone ? zoneTagTop : cy - ringR) + 24 }}>
                  画面に触れると声が出ます
                </small>
              ) : null}
              {speed ? (
                <div className="fo-orbis-speed" style={{ left: round(cx + r * 0.62), top: round(cy + r * 0.5) }}>
                  {speed.limit !== null ? (
                    <i className="fo-orbis-limit" aria-label={`制限速度 ${speed.limit}`}>
                      {speed.limit}
                    </i>
                  ) : null}
                  {speed.value !== null ? (
                    <b className={speed.over ? "is-over" : undefined} aria-label={`いまの速さ ${speed.value}`}>
                      {speed.value}
                      <small>km/h</small>
                    </b>
                  ) : null}
                </div>
              ) : null}
              {orbis?.osm ? (
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
