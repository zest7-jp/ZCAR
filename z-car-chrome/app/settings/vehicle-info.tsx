"use client";

import { useState, type ReactNode } from "react";
import { isDateKey, type FuelEntry } from "../settings-store";

/** オイル交換の目安(どちらか早いほう)。 */
const OIL_INTERVAL_KM = 5000;
const OIL_INTERVAL_MONTHS = 6;
/** 車検の満了日がこれより近づいたら、札の色を変える(日)。 */
const INSPECTION_SOON_DAYS = 30;
/** オイル交換の目安の、この割合を過ぎたら札の色を変える。 */
const OIL_SOON_RATIO = 0.9;

/** 車両情報に出すもの。車検・オイル交換の日は、未登録なら空。 */
export type VehicleRecord = {
  carId: string;
  inspectionDue: string;
  oilChangedOn: string;
  fuelEntries: FuelEntry[];
};
export type VehicleDates = Partial<Pick<VehicleRecord, "inspectionDue" | "oilChangedOn">>;

type RowId = "inspection" | "oil" | "fuel";
/** 札の色。ok: まだ先 / soon: 近い / over: 過ぎた / info: 給油 / none: 未登録。 */
type Tone = "ok" | "soon" | "over" | "info" | "none";
type Row = { id: RowId; title: string; lines: string[]; chip: string; tone: Tone };

/** 日本時間の今日(YYYY-MM-DD)。 */
const japanToday = () => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
};
const dayNumber = (day: string) =>
  Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))) / 86_400_000;
/** from から to まで何日か(to が前なら負)。 */
const daysBetween = (from: string, to: string) => Math.round(dayNumber(to) - dayNumber(from));
const addMonths = (day: string, months: number) =>
  new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1 + months, Number(day.slice(8, 10))))
    .toISOString()
    .slice(0, 10);
/** 2027.03.15 */
const dotted = (day: string) => day.replace(/-/g, ".");
/** 今年なら 10.20、ほかの年なら 2025.10.20。 */
const shortDay = (day: string, today: string) =>
  day.slice(0, 4) === today.slice(0, 4) ? dotted(day.slice(5)) : dotted(day);
const number = (value: number) => Math.round(value).toLocaleString("ja-JP");

/** 車検・オイル交換・最終給油の3行を作る。 */
const vehicleRows = (record: VehicleRecord, today: string): Row[] => {
  const rows: Row[] = [];

  if (record.inspectionDue) {
    const left = daysBetween(today, record.inspectionDue);
    rows.push({
      id: "inspection",
      title: "車検",
      lines: [`満了日 ${dotted(record.inspectionDue)}`],
      chip: left > 0 ? `あと${left}日` : left === 0 ? "今日まで" : `${-left}日過ぎ`,
      tone: left < 0 ? "over" : left <= INSPECTION_SOON_DAYS ? "soon" : "ok",
    });
  } else {
    rows.push({ id: "inspection", title: "車検", lines: ["押して満了日を入れてください"], chip: "未登録", tone: "none" });
  }

  if (record.oilChangedOn) {
    // 給油の記録の距離は「前の給油からその給油まで」なので、交換した日より後の給油を足す(だいたいの距離)。
    const driven = record.fuelEntries
      .filter((entry) => entry.date > record.oilChangedOn)
      .reduce((total, entry) => total + entry.distanceKm, 0);
    const due = addMonths(record.oilChangedOn, OIL_INTERVAL_MONTHS);
    const span = daysBetween(record.oilChangedOn, due);
    const passed = Math.max(0, daysBetween(record.oilChangedOn, today));
    const kmLeft = OIL_INTERVAL_KM - driven;
    const daysLeft = daysBetween(today, due);
    const kmRatio = driven / OIL_INTERVAL_KM;
    const timeRatio = passed / span;
    const over = kmLeft <= 0 || daysLeft <= 0;
    rows.push({
      id: "oil",
      title: "オイル交換",
      lines: [
        `前回 ${dotted(record.oilChangedOn)}・そこから約${number(driven)}km`,
        `目安 ${number(OIL_INTERVAL_KM)}km か ${dotted(due)}`,
      ],
      // 距離と日にちの、目安に近いほうを出す。
      chip: over ? "交換の時期" : kmRatio >= timeRatio ? `あと約${number(kmLeft)}km` : `あと${daysLeft}日`,
      tone: over ? "over" : Math.max(kmRatio, timeRatio) >= OIL_SOON_RATIO ? "soon" : "ok",
    });
  } else {
    rows.push({ id: "oil", title: "オイル交換", lines: ["押して前回の交換日を入れてください"], chip: "未登録", tone: "none" });
  }

  const latest = [...record.fuelEntries].sort(
    (left, right) => right.date.localeCompare(left.date) || right.createdAt - left.createdAt,
  )[0];
  if (latest) {
    const ago = Math.max(0, daysBetween(latest.date, today));
    const price = latest.amountYen > 0 ? `・${number(latest.amountYen)}円(${number(latest.amountYen / latest.liters)}円/L)` : "";
    rows.push({
      id: "fuel",
      title: "最終給油",
      lines: [
        `${shortDay(latest.date, today)}・${latest.liters.toFixed(1)}L${price}`,
        ...(latest.distanceKm > 0
          ? [`${number(latest.distanceKm)}km 走行・${(latest.distanceKm / latest.liters).toFixed(1)}km/L`]
          : []),
      ],
      chip: ago === 0 ? "今日" : `${ago}日前`,
      tone: "info",
    });
  } else {
    rows.push({ id: "fuel", title: "最終給油", lines: ["給油の記録はまだありません"], chip: "", tone: "none" });
  }
  return rows;
};

const ICONS: Record<RowId, ReactNode> = {
  inspection: (
    <svg viewBox="0 0 24 24">
      <path d="M12 3.2 19 6v5.3c0 4.4-3 7.9-7 9.5-4-1.6-7-5.1-7-9.5V6l7-2.8Z" />
      <path d="m8.7 12 2.3 2.3 4.4-4.6" />
    </svg>
  ),
  oil: (
    <svg viewBox="0 0 24 24">
      <path d="M3 11h8l3 2.5h4.5l2.5-2v2.3L17 18H6.5L3 14.5V11Z" />
      <path d="M6 11V8.5h3V11M4 8.5h7" />
      <path d="M20.5 6.3c0 .9-.7 1.6-1.6 1.6s-1.6-.7-1.6-1.6c0-.9 1.6-2.8 1.6-2.8s1.6 1.9 1.6 2.8Z" />
    </svg>
  ),
  fuel: (
    <svg viewBox="0 0 24 24">
      <path d="M5 20.5V5.2C5 4.5 5.5 4 6.2 4h6.6c.7 0 1.2.5 1.2 1.2v15.3M3.8 20.5h11.4M7.5 8h4" />
      <path d="M14 9.5h1.8l2.2 2.2v5.6a1.5 1.5 0 0 0 3 0V9.2l-2.7-2.7" />
    </svg>
  ),
};

/**
 * 車両情報(下から出るシート)。自宅に駐車中に、車両位置の「車両情報」から開く。
 * 車検とオイル交換は、行を押すと日付を入れられる(車とスマホで共有)。最終給油は給油の記録から。
 */
export function VehicleSheet({
  record,
  onSave,
  onClose,
}: {
  record: VehicleRecord;
  onSave: (dates: VehicleDates) => void;
  onClose: () => void;
}) {
  const [editing, setEditing] = useState<"inspection" | "oil" | null>(null);
  const [draft, setDraft] = useState("");
  const today = japanToday();
  const rows = vehicleRows(record, today);

  const open = (id: "inspection" | "oil") => {
    if (editing === id) {
      setEditing(null);
      return;
    }
    setEditing(id);
    // オイルは替えたその日に入れることが多いので、未登録なら今日から選べるようにする。
    setDraft((id === "inspection" ? record.inspectionDue : record.oilChangedOn) || (id === "oil" ? today : ""));
  };
  const save = (day: string) => {
    onSave(editing === "inspection" ? { inspectionDue: day } : { oilChangedOn: day });
    setEditing(null);
  };

  return (
    <div className="zr-sheet" role="presentation" onClick={onClose}>
      <section
        className="zr-sheet-card"
        role="dialog"
        aria-modal="true"
        aria-label="車両情報"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="zr-sheet-head">
          <span>
            <small>VEHICLE</small>
            <b>車両情報</b>
          </span>
          <em>{record.carId.toUpperCase()}</em>
          <button type="button" onClick={onClose}>
            CLOSE
          </button>
        </header>
        <div className="zr-sheet-body">
          <ul className="zr-car-list">
            {rows.map((row) => {
              const content = (
                <>
                  <i aria-hidden="true">{ICONS[row.id]}</i>
                  <span>
                    <b>{row.title}</b>
                    {row.lines.map((line) => (
                      <small key={line}>{line}</small>
                    ))}
                  </span>
                  {row.chip ? <em className={`zr-car-chip is-${row.tone}`}>{row.chip}</em> : null}
                </>
              );
              const id = row.id;
              if (id === "fuel") {
                return (
                  <li key={id}>
                    <div className="zr-car-row">{content}</div>
                  </li>
                );
              }
              const current = id === "inspection" ? record.inspectionDue : record.oilChangedOn;
              return (
                <li key={id} className={editing === id ? "is-editing" : undefined}>
                  <button
                    type="button"
                    className="zr-car-row"
                    aria-expanded={editing === id}
                    onClick={() => open(id)}
                  >
                    {content}
                  </button>
                  {editing === id ? (
                    <form
                      className="zr-car-edit"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (isDateKey(draft)) save(draft);
                      }}
                    >
                      <label className="zr-field zr-field-wide">
                        <span>{id === "inspection" ? "車検の満了日(車検証に書いてある日)" : "前回オイルを替えた日"}</span>
                        <div>
                          <input type="date" value={draft} onChange={(event) => setDraft(event.target.value)} />
                        </div>
                      </label>
                      <div className="zr-editor-actions">
                        <button
                          type="button"
                          className="zr-ghost"
                          onClick={() => (current ? save("") : setEditing(null))}
                        >
                          {current ? "消す" : "やめる"}
                        </button>
                        <button type="submit" className="zr-primary" disabled={!isDateKey(draft)}>
                          保存する
                        </button>
                      </div>
                    </form>
                  ) : null}
                </li>
              );
            })}
          </ul>
          <p className="zr-note">
            車検とオイル交換は、押すと日付を入れられます。オイル交換からの距離は、給油の記録から数えます。
          </p>
        </div>
      </section>
    </div>
  );
}
