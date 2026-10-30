"use client";

import { useState } from "react";
import { SegNumber } from "../meter-styles";
import { isDateKey, type FuelEntry, type MeterStyle } from "../settings-store";

/** オイル交換の目安(どちらか早いほう)。 */
const OIL_INTERVAL_KM = 3000;
const OIL_INTERVAL_MONTHS = 3;
/** 車検の満了日がこれより近づいたら、数字の色を変える(日)。 */
const INSPECTION_SOON_DAYS = 30;
/** オイル交換の目安の、この割合を過ぎたら数字の色を変える。 */
const OIL_SOON_RATIO = 0.9;
/** オイルのコンディション。交換からの距離が1つ目の区切りまでは HIGH(最高)、2つ目までは MID(普通)、その先は LOW(低下)(km)。 */
const OIL_CONDITIONS = ["HIGH", "MID", "LOW"] as const;
const OIL_CONDITION_LIMITS_KM = [1000, 2000];
/** 光るメモリの数(オイル交換までの残り・車検までの残り)。 */
const BAR_STEPS = 15;
/** 車検の間隔(日)。車検のメモリは2年のうちの残りを出す。 */
const INSPECTION_CYCLE_DAYS = 730;
/** 燃費の棒グラフ: 最近の何回分を出すか、1本を何段にするか(いちばん下の km/L から 1km/L ずつ)。 */
const FUEL_CHART_COUNT = 8;
const FUEL_CHART_STEPS = 10;
const FUEL_CHART_MIN_KMPL = 10;

/** 車両情報に出すもの。車検・オイル交換の日は、未登録なら空。 */
export type VehicleRecord = {
  carId: string;
  inspectionDue: string;
  oilChangedOn: string;
  fuelEntries: FuelEntry[];
};
export type VehicleDates = Partial<Pick<VehicleRecord, "inspectionDue" | "oilChangedOn">>;

/** 数字の色。ok: まだ先 / soon: 近い / over: 過ぎた / info: 給油 / none: 未登録。 */
type Tone = "ok" | "soon" | "over" | "info" | "none";
/**
 * 1つ分の数字と単位。digits なら7セグメントの数字で出す(80年代・デイライト)。
 * short はボタンに並べる短い字。
 */
type Reading = { value: string; unit: string; digits: boolean; short: string; tone: Tone };

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
const text = (value: string, tone: Tone): Reading => ({ value, unit: "", digits: false, short: value, tone });

/** 車検・オイル交換・最終給油の、いまの様子。 */
const vehicleStatus = (record: VehicleRecord, today: string) => {
  let inspection: Reading;
  // 車検のメモリ: 2年のうちの残り(0〜1)。未登録なら出さない。
  let inspectionLife: number | null = null;
  if (!record.inspectionDue) {
    inspection = text("未登録", "none");
  } else {
    const left = daysBetween(today, record.inspectionDue);
    inspectionLife = Math.min(1, Math.max(0, left / INSPECTION_CYCLE_DAYS));
    const tone = left < 0 ? "over" : left <= INSPECTION_SOON_DAYS ? "soon" : "ok";
    inspection =
      left === 0
        ? text("今日まで", "soon")
        : left > 0
          ? { value: String(left), unit: "日", digits: true, short: `${left}日`, tone }
          : { value: String(-left), unit: "日過ぎ", digits: true, short: `${-left}日過ぎ`, tone };
  }

  let oil: Reading;
  // 給油の記録の距離は「前の給油からその給油まで」なので、交換した日より後の給油を足す(だいたいの距離)。
  const driven = record.oilChangedOn
    ? record.fuelEntries
        .filter((entry) => entry.date > record.oilChangedOn)
        .reduce((total, entry) => total + entry.distanceKm, 0)
    : 0;
  // コンディションは距離だけで決める(0: 最高 / 1: 普通 / 2: 低下)。交換日が未登録なら出さない。
  const condition = record.oilChangedOn ? OIL_CONDITION_LIMITS_KM.filter((limit) => driven >= limit).length : null;
  // オイルのメモリ(LIFE): 交換までの残り(距離と日にちの、目安に近いほう。0〜1)。
  let oilLife: number | null = null;
  if (!record.oilChangedOn) {
    oil = text("未登録", "none");
  } else {
    const due = addMonths(record.oilChangedOn, OIL_INTERVAL_MONTHS);
    const passed = Math.max(0, daysBetween(record.oilChangedOn, today));
    const kmLeft = Math.round(OIL_INTERVAL_KM - driven);
    const daysLeft = daysBetween(today, due);
    const kmRatio = driven / OIL_INTERVAL_KM;
    const timeRatio = passed / daysBetween(record.oilChangedOn, due);
    const tone = Math.max(kmRatio, timeRatio) >= OIL_SOON_RATIO ? "soon" : "ok";
    oilLife = Math.min(1, Math.max(0, 1 - Math.max(kmRatio, timeRatio)));
    // 距離と日にちの、目安に近いほうを出す。
    oil =
      kmLeft <= 0 || daysLeft <= 0
        ? { ...text("交換の時期", "over"), short: "交換時期" }
        : kmRatio >= timeRatio
          ? { value: String(kmLeft), unit: "km", digits: true, short: `${number(kmLeft)}km`, tone }
          : { value: String(daysLeft), unit: "日", digits: true, short: `${daysLeft}日`, tone };
  }

  const latest = [...record.fuelEntries].sort(
    (left, right) => right.date.localeCompare(left.date) || right.createdAt - left.createdAt,
  )[0];
  let fuel: Reading;
  if (!latest) {
    fuel = { ...text("記録なし", "none"), short: "なし" };
  } else {
    const ago = Math.max(0, daysBetween(latest.date, today));
    fuel = ago === 0 ? text("今日", "info") : { value: String(ago), unit: "日前", digits: true, short: `${ago}日前`, tone: "info" };
  }
  // 燃費の棒グラフ: 走った距離が分かる給油の、最近の分(古い順)。
  const kmpl = record.fuelEntries
    .filter((entry) => entry.distanceKm > 0 && entry.liters > 0)
    .sort((left, right) => left.date.localeCompare(right.date) || left.createdAt - right.createdAt)
    .slice(-FUEL_CHART_COUNT)
    .map((entry) => entry.distanceKm / entry.liters);
  return { inspection, inspectionLife, oil, oilLife, condition, fuel, kmpl, driven, latest };
};

/** 大きい数字。80年代・デイライトでは車と同じ7セグメント(読み上げ用の字も残す)、近未来ではそのままの字。 */
function Big({ reading, look, h, kind }: { reading: Reading; look: MeterStyle; h: number; kind: string }) {
  return (
    <span className={`zr-car-big is-${kind} is-${reading.tone}${reading.digits ? "" : " is-text"}`}>
      {reading.digits && look !== "future" ? (
        <>
          <SegNumber text={reading.value} h={h} className="zr-seg" />
          <span className="zr-sr">{reading.value}</span>
        </>
      ) : (
        <b>{reading.digits ? number(Number(reading.value)) : reading.value}</b>
      )}
      {reading.unit ? <em>{reading.unit}</em> : null}
    </span>
  );
}

/** コンディションの印(HIGH ◎ / MID ○ / LOW △)。字だと機種のフォントで大きさがばらつくので、絵で描く。 */
function ConditionMark({ index }: { index: number }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      {index === 2 ? <path d="M10 2.6 18.2 17H1.8Z" /> : <circle cx="10" cy="10" r="8" />}
      {index === 0 ? <circle cx="10" cy="10" r="3.6" /> : null}
    </svg>
  );
}

/**
 * 数字の右に光らせる、本物の車の警告灯のような印(給油機・オイル差し・車検の盾)。
 * 数字が長くて場所が足りないときは小さくなり、それでも足りなければ出さない(CSS)。
 */
function TileIcon({ kind }: { kind: "fuel" | "oil" | "inspection" }) {
  return (
    <span className="zr-car-icon-box" aria-hidden="true">
      <TileIconMark kind={kind} />
    </span>
  );
}

function TileIconMark({ kind }: { kind: "fuel" | "oil" | "inspection" }) {
  return (
    <svg className={`zr-car-icon is-${kind}`} viewBox="0 0 24 24">
      {kind === "fuel" ? (
        <>
          <path d="M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16" />
          <path d="M2.5 21h13" />
          <path d="M6.5 6.5h5v4h-5z" />
          <path d="M14 9h1.6a1.4 1.4 0 0 1 1.4 1.4v6.1a1.5 1.5 0 0 0 3 0V8l-2.6-2.6" />
        </>
      ) : kind === "oil" ? (
        <>
          <path d="M3.5 10.5h11.5l5.5-3v1.6l-5.2 6.4H6.3a2.8 2.8 0 0 1-2.8-2.8z" />
          <path d="M3.5 11.2 1.8 9.6" />
          <path d="M8.2 10.5V8.6h3.2v1.9" />
          <path d="M7 8.6h5.6" />
          <path d="M21.4 13.6a1 1 0 0 1-2 0c0-.8 1-2 1-2s1 1.2 1 2z" />
        </>
      ) : (
        <>
          <path d="M12 2.8 19 5.6v5.2c0 4.4-2.9 8.2-7 9.6-4.1-1.4-7-5.2-7-9.6V5.6z" />
          <path d="m8.6 11.8 2.4 2.4 4.6-4.8" />
        </>
      )}
    </svg>
  );
}

/** 80年代のメーターのような、光るメモリの横棒。share は光らせる割合(0〜1)。 */
function MeterBar({ share, label, kind, tone }: { share: number; label: string; kind: string; tone: Tone }) {
  const lit = Math.round(share * BAR_STEPS);
  return (
    <span className={`zr-car-bar is-${kind} is-${tone}`} aria-hidden="true">
      <span>
        {Array.from({ length: BAR_STEPS }, (_, index) => (
          <i key={index} className={index < lit ? "is-on" : undefined} />
        ))}
      </span>
      <small>
        <span>{label}</span>
        <span>{Math.round(share * 100)}%</span>
      </small>
    </span>
  );
}

/** 最近の給油の燃費の棒グラフ(古い順。いちばん右が最後の給油)。 */
function FuelChart({ kmpl }: { kmpl: number[] }) {
  return (
    <span className="zr-car-chart" aria-hidden="true">
      <small>km/L</small>
      <span>
        {kmpl.map((value, index) => {
          const lit = Math.min(FUEL_CHART_STEPS, Math.max(0, Math.round(value - FUEL_CHART_MIN_KMPL)));
          return (
            <span key={index} className={index === kmpl.length - 1 ? "is-last" : undefined}>
              {Array.from({ length: FUEL_CHART_STEPS }, (_, step) => (
                <i key={step} className={step < lit ? "is-on" : undefined} />
              ))}
            </span>
          );
        })}
      </span>
      <em>{kmpl[kmpl.length - 1].toFixed(1)}</em>
    </span>
  );
}

/** 自宅に駐車中のボタン。給油・オイル・車検の数字も(大事な順に)並べ、押すと車両情報を開く。 */
export function VehicleButton({ record, onOpen }: { record: VehicleRecord; onOpen: () => void }) {
  const status = vehicleStatus(record, japanToday());
  const items = [
    ["給油", status.fuel],
    ["オイル", status.oil],
    ["車検", status.inspection],
  ] as const;
  return (
    <button
      type="button"
      className="zr-ghost zr-park-car"
      aria-label={`車両情報を開く(${items.map(([label, reading]) => `${label} ${reading.short}`).join("・")})`}
      onClick={onOpen}
    >
      <span>
        <small>VEHICLE</small>
        <b>車両情報</b>
      </span>
      <span className="zr-park-car-stats" aria-hidden="true">
        {items.map(([label, reading]) => (
          <span key={label}>
            {label}
            <b className={`is-${reading.tone}`}>{reading.short}</b>
          </span>
        ))}
      </span>
    </button>
  );
}

type DetailsProps = {
  record: VehicleRecord;
  look: MeterStyle;
  onSave: (dates: VehicleDates) => void;
  onOpenFuel: () => void;
};

/**
 * 車両情報の中身。光る数字のタイルで、大事な順に最終給油から(横いっぱい)・
 * オイル交換まで・車検までを出す。給油のタイルは給油の記録を開き、
 * オイル交換と車検のタイルを押すと日付を入れられる(車とスマホで共有)。
 * note が false なら、下の説明の文は出さない(車両のタブでは ? を押したときだけ出す)。
 */
function VehicleDetails({ record, look, onSave, onOpenFuel, note = true }: DetailsProps & { note?: boolean }) {
  const [editing, setEditing] = useState<"inspection" | "oil" | null>(null);
  const [draft, setDraft] = useState("");
  const today = japanToday();
  const status = vehicleStatus(record, today);
  const current = editing === "inspection" ? record.inspectionDue : editing === "oil" ? record.oilChangedOn : "";

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
  const latest = status.latest;

  return (
    <>
      <div className="zr-car-tiles">
        <button
          type="button"
          className={`zr-car-tile is-wide is-fuel${status.kmpl.length > 1 ? " has-chart" : ""}`}
          onClick={onOpenFuel}
        >
          <small>
            FUEL<span>最終給油</span>
          </small>
          <span className="zr-car-row">
            <Big reading={status.fuel} look={look} h={46} kind="fuel" />
            <TileIcon kind="fuel" />
          </span>
          <p>
            {latest ? (
              <>
                {shortDay(latest.date, today)}・{latest.liters.toFixed(1)}L
                {latest.amountYen > 0 ? `・${number(latest.amountYen)}円` : ""}
                {latest.distanceKm > 0 ? (
                  <>
                    <br />
                    {number(latest.distanceKm)}km 走行・{(latest.distanceKm / latest.liters).toFixed(1)}km/L
                  </>
                ) : null}
              </>
            ) : (
              "押すと給油の記録を開きます"
            )}
          </p>
          {status.kmpl.length > 1 ? <FuelChart kmpl={status.kmpl} /> : null}
        </button>
        <button
          type="button"
          className={`zr-car-tile is-oil${editing === "oil" ? " is-editing" : ""}`}
          aria-expanded={editing === "oil"}
          onClick={() => open("oil")}
        >
          <small>
            OIL<span>交換まで</span>
          </small>
          <span className="zr-car-row">
            <Big reading={status.oil} look={look} h={32} kind="oil" />
            <TileIcon kind="oil" />
          </span>
          {status.oilLife !== null ? (
            <MeterBar share={status.oilLife} label="LIFE" kind="oil" tone={status.oil.tone} />
          ) : null}
          {status.condition !== null ? (
            <span className="zr-oil-cond">
              <small aria-hidden="true">CONDITION</small>
              <span className="zr-oil-lamps" aria-hidden="true">
                {OIL_CONDITIONS.map((label, index) => (
                  <i key={label} className={index === status.condition ? "is-on" : undefined}>
                    <ConditionMark index={index} />
                    {label}
                  </i>
                ))}
              </span>
              <span className="zr-sr">コンディション {OIL_CONDITIONS[status.condition]}</span>
            </span>
          ) : null}
          <p>
            {record.oilChangedOn ? (
              <>
                前回 {dotted(record.oilChangedOn)}
                <br />
                交換から約{number(status.driven)}km
              </>
            ) : (
              "押して前回の交換日を入れてください"
            )}
          </p>
        </button>
        <button
          type="button"
          className={`zr-car-tile is-inspection${editing === "inspection" ? " is-editing" : ""}`}
          aria-expanded={editing === "inspection"}
          onClick={() => open("inspection")}
        >
          <small>
            INSPECTION<span>{status.inspection.unit === "日過ぎ" ? "期限切れ" : "車検まで"}</span>
          </small>
          <span className="zr-car-row">
            <Big reading={status.inspection} look={look} h={32} kind="inspection" />
            <TileIcon kind="inspection" />
          </span>
          {status.inspectionLife !== null ? (
            <MeterBar share={status.inspectionLife} label="2 YEARS" kind="inspection" tone={status.inspection.tone} />
          ) : null}
          <p>{record.inspectionDue ? `満了日 ${dotted(record.inspectionDue)}` : "押して満了日を入れてください"}</p>
        </button>
      </div>
      {editing ? (
        <form
          className="zr-car-edit"
          onSubmit={(event) => {
            event.preventDefault();
            if (isDateKey(draft)) save(draft);
          }}
        >
          <label className="zr-field zr-field-wide">
            <span>{editing === "inspection" ? "車検の満了日(車検証に書いてある日)" : "前回オイルを替えた日"}</span>
            <div>
              <input type="date" value={draft} onChange={(event) => setDraft(event.target.value)} />
            </div>
          </label>
          <div className="zr-editor-actions">
            <button type="button" className="zr-ghost" onClick={() => (current ? save("") : setEditing(null))}>
              {current ? "消す" : "やめる"}
            </button>
            <button type="submit" className="zr-primary" disabled={!isDateKey(draft)}>
              保存する
            </button>
          </div>
        </form>
      ) : null}
      {note ? (
        <p className="zr-note">
          給油を押すと記録を開きます。オイル交換と車検は、押すと日付を入れられます。オイル交換の目安は{" "}
          {number(OIL_INTERVAL_KM)}km か {OIL_INTERVAL_MONTHS}か月の早いほうで、距離は給油の記録から数えます。コンディションは交換からの距離で、
          {number(OIL_CONDITION_LIMITS_KM[0])}kmまでは {OIL_CONDITIONS[0]}、{number(OIL_CONDITION_LIMITS_KM[1])}kmまでは{" "}
          {OIL_CONDITIONS[1]}、その先は {OIL_CONDITIONS[2]} です。
        </p>
      ) : null}
    </>
  );
}

/** 自宅に駐車中の「車両情報」から開く、下から出るシート。 */
export function VehicleSheet({ onClose, ...props }: DetailsProps & { onClose: () => void }) {
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
          <em>{props.record.carId.toUpperCase()}</em>
          <button type="button" onClick={onClose}>
            CLOSE
          </button>
        </header>
        <div className="zr-sheet-body">
          <VehicleDetails {...props} />
        </div>
      </section>
    </div>
  );
}

/**
 * 下のタブ「車両」のページ。車がどこにあっても、いつでも車両情報を見られる。
 * 大きい iPhone でメーター設定まで1画面に収まるよう、説明の文はふだん隠し、右上の ? で開く。
 */
export function VehiclePanel(props: DetailsProps) {
  const [helpOpen, setHelpOpen] = useState(false);
  return (
    <section className="zr-panel zr-car-panel" aria-label="車両情報">
      <header className="zr-panel-head">
        <span>
          <small>VEHICLE</small>
          <b>車両情報</b>
        </span>
        <em>{props.record.carId.toUpperCase()}</em>
        <button
          type="button"
          className="zr-car-help"
          aria-label="説明"
          aria-expanded={helpOpen}
          onClick={() => setHelpOpen((open) => !open)}
        >
          ?
        </button>
      </header>
      <VehicleDetails {...props} note={helpOpen} />
    </section>
  );
}
