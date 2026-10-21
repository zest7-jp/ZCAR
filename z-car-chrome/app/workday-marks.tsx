"use client";

// 近未来のテーマの一週間の帯で、出勤日(シフトのある日)の曜日の札に五行の色を付ける。
// 近未来のメーターには色を変える filter(ブルーなら色を回す)がかかっていて、中に描くと五行の色が変わってしまう。
// そのため帯の札の場所を測り、filter の外から同じ大きさの札を重ねる。

import { useEffect, useRef, useState, type CSSProperties, type RefObject } from "react";

/** 曜日(0 が日曜)の五行の色。火=赤・水=青・木=緑・金=金色・土=土色、月は銀・日は橙。 */
export const WEEKDAY_ELEMENT_COLORS = ["#ff9a3c", "#cfd8e3", "#ef6a5e", "#4aa6ef", "#5ec46e", "#f5c04a", "#c9a26b"];

/** 色を暗い下地と混ぜる(札の下の帯が透けないように、混ぜた色は不透明)。 */
const mixDark = (hex: string, amount: number) => {
  const dark = [5, 8, 7];
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${rgb.map((v, i) => Math.round(v * amount + dark[i] * (1 - amount))).join(", ")})`;
};
const glow = (hex: string, alpha: number) => `rgba(${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(", ")}, ${alpha})`;

type Box = { day: number; left: number; top: number; width: number; height: number; font: string };

/**
 * stripRef の帯(li に data-day で曜日の番号)の上に、days の曜日の札を重ねる。
 * 置き場所は親(position: relative)いっぱいの層。帯や、帯と同じ札の中の物の大きさが変わると測り直す。
 */
export function WorkdayMarks({
  stripRef,
  days,
  today,
  labels,
}: {
  stripRef: RefObject<HTMLOListElement | null>;
  days: number[];
  today: number;
  labels: string[];
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const [boxes, setBoxes] = useState<Box[]>([]);
  const key = days.join(",");
  useEffect(() => {
    const layer = layerRef.current;
    const strip = stripRef.current;
    if (!layer || !strip || typeof ResizeObserver === "undefined") return;
    const wanted = new Set(key ? key.split(",").map(Number) : []);
    const measure = () => {
      const base = layer.getBoundingClientRect();
      const next = Array.from(strip.children).flatMap((child): Box[] => {
        const item = child as HTMLElement;
        const day = Number(item.dataset.day);
        if (!wanted.has(day)) return [];
        const rect = item.getBoundingClientRect();
        return [
          {
            day,
            left: Math.round((rect.left - base.left) * 100) / 100,
            top: Math.round((rect.top - base.top) * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
            font: getComputedStyle(item).fontSize,
          },
        ];
      });
      setBoxes((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    // 見始めたときにも一度呼ばれる。帯の札の中で上の物の高さが変わったときも測り直す。
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    observer.observe(strip);
    Array.from(strip.parentElement?.children ?? []).forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [stripRef, key]);
  return (
    <div ref={layerRef} className="workday-marks" aria-hidden="true">
      {boxes.map((box) => {
        const color = WEEKDAY_ELEMENT_COLORS[box.day];
        const isToday = box.day === today;
        return (
          <span
            key={box.day}
            data-day={box.day}
            className={isToday ? "is-today" : undefined}
            style={
              {
                left: box.left,
                top: box.top,
                width: box.width,
                height: box.height,
                fontSize: box.font,
                "--wx": color,
                "--wx-bg": mixDark(color, isToday ? 0.55 : 0.3),
                "--wx-glow": glow(color, isToday ? 0.7 : 0.45),
              } as CSSProperties
            }
          >
            {labels[box.day]}
          </span>
        );
      })}
    </div>
  );
}
