"use client";

import { useEffect, useState } from "react";
import { readCopiedPoint, type PlaceImportError } from "../place-import";
import {
  createPlaceId,
  isOrbisLimit,
  MAX_ORBIS_LABEL,
  MAX_SPEED_ZONES,
  type SpeedZone,
  type ZoneEnd,
} from "../settings-store";
import { zoneLength, zoneLengthText } from "../speed-zone";
import { townAt } from "./town-name";
import { ZoneMap } from "./zone-map";

/** 区間の始まりと終わり。 */
type End = "start" | "end";

/**
 * 足そう(直そう)としている区間。名前は打たず、始まりの町名を地図から読んで入れる(読めなければ空)。
 * names は始まり・終わりの欄に出す町名(終わりの町名は出すだけで、保存しない)。
 * editId は登録してあるものを直すときの id(新しく足すときは null)。
 */
type Draft = {
  editId: string | null;
  label: string;
  start: ZoneEnd | null;
  end: ZoneEnd | null;
  names: Record<End, string>;
  limit: string;
  oneWay: boolean;
};

/** 区間として受け付ける長さ(m)。短すぎる(同じ場所を2回選んだ)・長すぎる(場所の選び間違い)ものは足さない。 */
const MIN_ZONE_M = 50;
const MAX_ZONE_M = 30_000;
/** 始まりと終わりがどちらもこれより近ければ、同じ区間とみなして足さない(m)。 */
const SAME_ZONE_METERS = 30;

const END_NAMES: Record<End, string> = { start: "始まり", end: "終わり" };

/** Google マップのコピーを読めなかったときの案内(オービスと同じ)。 */
const PASTE_NOTES: Record<PlaceImportError | "clipboard", string> = {
  clipboard: "貼り付けできませんでした。もう一度押して「ペースト」を選んでください",
  empty: "コピーされていません。Google マップで場所を選んで「共有」→「コピー」を押してください",
  unlinked: "車とつなぐと、地図の短いリンクから読み取れます",
  unreadable: "場所(緯度・経度)を読み取れませんでした。地図で場所を長押ししてからコピーしてください",
  network: "読み取れませんでした。電波のよい所でもう一度押してください",
  notmaps: "Google マップのリンクだけ読めます。Google マップで「共有」→「コピー」してください",
};

/** 緯度・経度の見せ方(小数5けた ≒ 1m)。 */
const coordsText = (point: ZoneEnd) => `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
/** 保存する場所(小数6けた)。 */
const roundEnd = (point: ZoneEnd): ZoneEnd => ({ lat: Number(point.lat.toFixed(6)), lng: Number(point.lng.toFixed(6)) });
const sameEnd = (left: ZoneEnd | null, right: ZoneEnd | null) =>
  !!left && !!right && left.lat === right.lat && left.lng === right.lng;
/** 2つの場所の間(m)。 */
const gapMeters = (left: ZoneEnd, right: ZoneEnd) => zoneLength({ start: left, end: right });

const PinIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
    <circle cx="12" cy="10" r="2.4" />
  </svg>
);
const HereIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <circle cx="12" cy="12" r="6.5" />
    <circle cx="12" cy="12" r="2" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
  </svg>
);
/** 走る向きの矢印(両方なら上下、片方なら上)。 */
const WayIcon = ({ oneWay }: { oneWay: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    {oneWay ? <path d="M12 3 19 12h-4.5v9h-5v-9H5z" /> : <path d="M12 2.5 17 8h-3.5v8H17l-5 5.5L7 16h3.5V8H7z" />}
  </svg>
);

/**
 * スマホで登録する速度取締区間(下のタブの「オービス」で「取締区間」を選んだとき)。オービスとは別の一覧。
 * 始まりと終わりを、Google マップのコピーか今いる場所で選ぶ。車の地図で、区間の 500m 手前から
 * 警告と声で知らせ、区間の中は残りの距離を出す。車にも届く。
 * 一番上に、登録した区間を全部出した地図(「区1」の札は一覧の行と同じ。押すと直す欄が開く)。
 */
export function ZonePanel({
  zones,
  syncKey,
  mapsKey,
  sendNote,
  onChange,
  onToast,
}: {
  zones: SpeedZone[];
  /** 車とつないだ合言葉(Google マップのリンクを読むのに使う)。つないでいなければ空。 */
  syncKey: string;
  /** 地図の鍵。 */
  mapsKey: string;
  /** 車とつないでいれば「・車に送ります」。 */
  sendNote: string;
  onChange: (zones: SpeedZone[]) => void;
  onToast: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<{ end: End; how: "paste" | "here" } | null>(null);
  // 消すときは2回押す(1回目は「消す」に変わるだけ)。
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  /** 新しい区間を足す欄を開く(始まりと終わりは、まだ空)。 */
  const openNew = () =>
    setDraft({ editId: null, label: "", start: null, end: null, names: { start: "", end: "" }, limit: "", oneWay: false });

  /** 登録してある区間を直す欄を開く(終わりの町名は、地図から読んで出す)。 */
  const openEdit = (zone: SpeedZone) => {
    setDraft({
      editId: zone.id,
      label: zone.label,
      start: zone.start,
      end: zone.end,
      names: { start: zone.label, end: "" },
      limit: zone.limit === null ? "" : String(zone.limit),
      oneWay: zone.oneWay,
    });
    void townAt(mapsKey, zone.end).then((town) =>
      setDraft((current) =>
        current?.editId === zone.id && sameEnd(current.end, zone.end)
          ? { ...current, names: { ...current.names, end: town } }
          : current,
      ),
    );
  };
  /** 一覧の行を押したとき: 直す欄を開く。もう一度押すと閉じる。 */
  const edit = (zone: SpeedZone) => {
    if (draft?.editId === zone.id) {
      setDraft(null);
      return;
    }
    openEdit(zone);
  };
  /** 地図の「区1」の札を押したとき: 直す欄を開いて、欄が見える所まで動かす。 */
  const pick = (id: string) => {
    const zone = zones.find((entry) => entry.id === id);
    if (!zone) return;
    openEdit(zone);
    window.requestAnimationFrame(() =>
      document.querySelector(".zr-zone-editor")?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };

  /** 始まりか終わりを決める。町名を地図から読んで欄に出す(始まりの町名は、区間の名前にもなる)。 */
  const setEnd = (which: End, point: ZoneEnd) => {
    setDraft((current) => (current ? { ...current, [which]: point, names: { ...current.names, [which]: "" } } : current));
    void townAt(mapsKey, point).then((town) =>
      setDraft((current) => {
        if (!current || !sameEnd(current[which], point)) return current;
        const names = { ...current.names, [which]: town };
        return which === "start"
          ? { ...current, names, label: Array.from(town).slice(0, MAX_ORBIS_LABEL).join("") }
          : { ...current, names };
      }),
    );
  };

  /** Google マップで「共有」→「コピー」した場所(か「34.76,135.62」のような数字)を読む。 */
  const pasteEnd = async (which: End) => {
    if (busy) return;
    let copied = "";
    try {
      copied = await navigator.clipboard.readText();
    } catch {
      onToast(PASTE_NOTES.clipboard);
      return;
    }
    setBusy({ end: which, how: "paste" });
    const result = await readCopiedPoint(syncKey, copied);
    setBusy(null);
    if (!result.ok) {
      onToast(PASTE_NOTES[result.error]);
      return;
    }
    setEnd(which, { lat: result.lat, lng: result.lng });
  };

  /** このスマホの GPS で、今いる場所にする(助手席から、区間の始まりと終わりを通ったときなど)。 */
  const hereEnd = (which: End) => {
    if (busy) return;
    if (!navigator.geolocation) {
      onToast("今いる場所が分かりませんでした");
      return;
    }
    setBusy({ end: which, how: "here" });
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setBusy(null);
        setEnd(which, { lat: position.coords.latitude, lng: position.coords.longitude });
      },
      () => {
        setBusy(null);
        onToast("今いる場所が分かりませんでした。位置情報を許可してください");
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
    );
  };

  const limitNumber = draft && draft.limit.trim() ? Number(draft.limit) : null;
  const limitOk = limitNumber === null || isOrbisLimit(limitNumber);
  const length = draft?.start && draft.end ? zoneLength({ start: draft.start, end: draft.end }) : null;
  const lengthNote =
    length === null
      ? null
      : length < MIN_ZONE_M
        ? `始まりと終わりが近すぎます(${MIN_ZONE_M}m 以上はなしてください)`
        : length > MAX_ZONE_M
          ? `区間が長すぎます(${MAX_ZONE_M / 1000}km まで)`
          : null;
  const canSave = !!draft?.start && !!draft.end && limitOk && !lengthNote;

  const save = () => {
    if (!draft || !draft.start || !draft.end || !canSave) return;
    const label = draft.label.trim();
    const start = roundEnd(draft.start);
    const end = roundEnd(draft.end);
    const name = label || "取締区間";
    if (draft.editId) {
      onChange(
        zones.map((zone) =>
          zone.id === draft.editId ? { ...zone, label, start, end, limit: limitNumber, oneWay: draft.oneWay } : zone,
        ),
      );
      onToast(`取締区間「${name}」を直しました${sendNote}`);
      setDraft(null);
      return;
    }
    // 同じ区間(始まりと終わりが、どちらも同じ所)は足さない。逆向き(終わり→始まり)も同じ区間とみなす。
    const near = (left: ZoneEnd, right: ZoneEnd) => gapMeters(left, right) <= SAME_ZONE_METERS;
    const same = zones.some(
      (zone) =>
        (near(zone.start, start) && near(zone.end, end)) || (near(zone.start, end) && near(zone.end, start)),
    );
    if (same) {
      onToast("同じ区間が、もう登録してあります");
      return;
    }
    onChange([...zones, { id: createPlaceId(), label, start, end, limit: limitNumber, oneWay: draft.oneWay }]);
    onToast(`取締区間「${name}」を登録しました${sendNote}`);
    setDraft(null);
  };

  const remove = (zone: SpeedZone) => {
    if (armed !== zone.id) {
      setArmed(zone.id);
      return;
    }
    setArmed(null);
    if (draft?.editId === zone.id) setDraft(null);
    onChange(zones.filter((entry) => entry.id !== zone.id));
    onToast(`取締区間「${zone.label || "取締区間"}」を消しました${sendNote}`);
  };

  return (
    <section className="zr-panel zr-orbis zr-zone" aria-label="速度取締区間">
      <header className="zr-panel-head">
        <span>
          <small>SPEED TRAP</small>
          <b>速度取締区間</b>
        </span>
      </header>
      {zones.length ? (
        <ZoneMap zones={zones} mapsKey={mapsKey} caption={`登録 ${zones.length}区間`} onPick={pick} />
      ) : null}
      {zones.length ? (
        <ul className="zr-places zr-orbis-list zr-zone-list">
          {zones.map((zone, index) => (
            <li key={zone.id} className={draft?.editId === zone.id ? "is-editing" : undefined}>
              <div className="zr-place-row">
                <button
                  type="button"
                  className="zr-place"
                  aria-expanded={draft?.editId === zone.id}
                  onClick={() => edit(zone)}
                >
                  <span className="zr-place-name">
                    {/* 地図の札と同じ番号。 */}
                    <em className="zr-orbis-num zr-zone-num">区{index + 1}</em>
                    <b>{zone.label || "取締区間"}</b>
                    {zone.limit ? <small>制限 {zone.limit}km/h</small> : null}
                  </span>
                  <span className="zr-place-addr zr-orbis-way">
                    <WayIcon oneWay={zone.oneWay} />
                    {zone.oneWay ? "始まり→終わり" : "両方の向き"}
                    <small>長さ {zoneLengthText(zoneLength(zone))}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={`zr-del${armed === zone.id ? " is-armed" : ""}`}
                  aria-label={
                    armed === zone.id
                      ? `${zone.label || "取締区間"} を消す(もう一度押すと消えます)`
                      : `${zone.label || "取締区間"} を消す`
                  }
                  onClick={() => remove(zone)}
                >
                  {armed === zone.id ? (
                    <b>消す</b>
                  ) : (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
                    </svg>
                  )}
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="zr-orbis-empty">取締区間は、まだありません。</p>
      )}
      {draft ? (
        <form
          className="zr-editor zr-orbis-editor zr-zone-editor"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <p className="zr-orbis-at">
            {draft.editId ? "直す: " : ""}
            <b>{draft.label || (draft.editId ? "取締区間" : "新しい取締区間")}</b>
            <small>始まりと終わりを選ぶ</small>
          </p>
          <div className="zr-zone-ends">
            {(["start", "end"] as const).map((which) => {
              const point = draft[which];
              const name = END_NAMES[which];
              return (
                <div key={which} className={`zr-zone-end is-${which}${point ? "" : " is-empty"}`}>
                  <i aria-hidden="true">{which === "start" ? "始" : "終"}</i>
                  <span className="zr-zone-end-text">
                    <b>{point ? draft.names[which] || name : `${name}: まだ選んでいません`}</b>
                    <small>{point ? coordsText(point) : "MAPS か HERE で選ぶ"}</small>
                  </span>
                  <span className="zr-zone-pick">
                    <button
                      type="button"
                      aria-label={`${name}を Google マップのコピーから選ぶ`}
                      aria-busy={busy?.end === which && busy.how === "paste"}
                      onClick={() => void pasteEnd(which)}
                    >
                      <PinIcon />
                      MAPS
                    </button>
                    <button
                      type="button"
                      aria-label={`${name}を今いる場所にする`}
                      aria-busy={busy?.end === which && busy.how === "here"}
                      onClick={() => hereEnd(which)}
                    >
                      <HereIcon />
                      HERE
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
          {draft.start ? (
            <ZoneMap
              preview
              zones={[{ id: "draft", label: draft.label, start: draft.start, end: draft.end }]}
              mapsKey={mapsKey}
              caption={length === null ? "終わりを選ぶと長さが出ます" : `長さ ${zoneLengthText(length)}`}
            />
          ) : null}
          {lengthNote ? <p className="zr-orbis-error">{lengthNote}</p> : null}
          <label className="zr-field zr-field-wide">
            <span>制限速度(km/h。分かれば)</span>
            <div>
              <input
                type="number"
                inputMode="numeric"
                min={10}
                max={140}
                value={draft.limit}
                placeholder="例: 50"
                onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
              />
            </div>
          </label>
          {!limitOk ? <p className="zr-orbis-error">制限速度は 10〜140 の数字で入れてください</p> : null}
          <div className="zr-zone-way" role="group" aria-label="走る向き">
            <span>走る向き</span>
            <button type="button" aria-pressed={!draft.oneWay} onClick={() => setDraft({ ...draft, oneWay: false })}>
              両方
            </button>
            <button type="button" aria-pressed={draft.oneWay} onClick={() => setDraft({ ...draft, oneWay: true })}>
              始まり → 終わり
            </button>
          </div>
          <div className="zr-editor-actions">
            <button type="button" className="zr-ghost" onClick={() => setDraft(null)}>
              やめる
            </button>
            <button type="submit" className="zr-primary" disabled={!canSave}>
              {draft.editId ? "保存する" : "追加する"}
            </button>
          </div>
        </form>
      ) : zones.length < MAX_SPEED_ZONES ? (
        <div className="zr-add-row zr-zone-add">
          <button type="button" className="zr-add is-paste is-zone" onClick={openNew}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 19 19 5" strokeDasharray="3.2 2.6" />
              <rect x="2.5" y="16.5" width="5" height="5" rx="1" />
              <rect x="16.5" y="2.5" width="5" height="5" rx="1" />
            </svg>
            <b>ADD ZONE</b>
            <small>区間を足す(始まりと終わり)</small>
          </button>
        </div>
      ) : null}
      <p className="zr-navi-hint zr-orbis-hint">
        車の地図(どのテーマでも)で、区間の500m手前から警告と声で知らせ、区間の中は終わりまでの残りの距離を出します。
        始まりと終わりは、Google マップで場所を選んで「共有」→「コピー」してから MAPS を押すか、今いる場所(HERE)で選びます。
        始まりと終わりをまっすぐ結んで見るので、曲がった道は短い区間に分けて登録してください。名前は始まりの町名が自動で入ります。
        登録した行か、地図の「区」の札を押すと直せます。
      </p>
    </section>
  );
}
