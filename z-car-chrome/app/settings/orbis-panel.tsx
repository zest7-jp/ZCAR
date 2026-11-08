"use client";

import { useEffect, useState } from "react";
import { distanceMeters } from "../parking";
import { readCopiedPoint, type PlaceImportError } from "../place-import";
import {
  createPlaceId,
  isOrbisLimit,
  MAX_ORBIS_LABEL,
  MAX_ORBIS_POINTS,
  type OrbisPoint,
} from "../settings-store";

/** 足そうとしている場所(名前と制限速度は、欄で直してから「追加する」)。 */
type Draft = { label: string; lat: number; lng: number; limit: string };

/** これより近くに登録してあれば、同じオービスとみなして足さない(m)。 */
const SAME_SPOT_METERS = 30;

/** Google マップのコピーを読めなかったときの案内。 */
const PASTE_NOTES: Record<PlaceImportError | "clipboard", string> = {
  clipboard: "貼り付けできませんでした。もう一度押して「ペースト」を選んでください",
  empty: "コピーされていません。Google マップで場所を長押しして「共有」→「コピー」を押してください",
  unlinked: "車とつなぐと、Google マップのリンクから読み取れます",
  unreadable: "場所(緯度・経度)を読み取れませんでした。地図で場所を長押ししてからコピーしてください",
  network: "読み取れませんでした。電波のよい所でもう一度押してください",
};

/** 緯度・経度の見せ方(小数5けた ≒ 1m)。 */
const coordsText = (lat: number, lng: number) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

/**
 * スマホで登録するオービス(目的地のタブの下)。車の80年代の地図で、OpenStreetMap の
 * オービスと一緒に知らせる。Google マップのコピーか、今いる場所から足す。車にも届く。
 */
export function OrbisPanel({
  points,
  syncKey,
  sendNote,
  onChange,
  onToast,
}: {
  points: OrbisPoint[];
  /** 車とつないだ合言葉(Google マップのリンクを読むのに使う)。つないでいなければ空。 */
  syncKey: string;
  /** 車とつないでいれば「・車に送ります」。 */
  sendNote: string;
  onChange: (points: OrbisPoint[]) => void;
  onToast: (text: string) => void;
}) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<"paste" | "here" | null>(null);
  // 消すときは2回押す(1回目は「消す」に変わるだけ)。
  const [armed, setArmed] = useState<string | null>(null);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  const open = (lat: number, lng: number, label: string) =>
    setDraft({ lat, lng, label: Array.from(label).slice(0, MAX_ORBIS_LABEL).join(""), limit: "" });

  /** Google マップで「共有」→「コピー」した場所(か「34.76,135.62」のような数字)を読む。 */
  const pastePoint = async () => {
    if (busy) return;
    let copied = "";
    try {
      copied = await navigator.clipboard.readText();
    } catch {
      onToast(PASTE_NOTES.clipboard);
      return;
    }
    setBusy("paste");
    const result = await readCopiedPoint(syncKey, copied);
    setBusy(null);
    if (!result.ok) {
      onToast(PASTE_NOTES[result.error]);
      return;
    }
    open(result.lat, result.lng, result.name);
  };

  /** このスマホの GPS で、今いる場所を足す(助手席から、通りかかったときなど)。 */
  const hereSpot = () => {
    if (busy) return;
    if (!navigator.geolocation) {
      onToast("今いる場所が分かりませんでした");
      return;
    }
    setBusy("here");
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setBusy(null);
        open(position.coords.latitude, position.coords.longitude, "");
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

  const save = () => {
    if (!draft || !limitOk) return;
    if (points.some((point) => distanceMeters(point, draft) <= SAME_SPOT_METERS)) {
      onToast("すぐ近くに、もう登録してあります");
      return;
    }
    const label = draft.label.trim();
    onChange([
      ...points,
      {
        id: createPlaceId(),
        label,
        lat: Number(draft.lat.toFixed(6)),
        lng: Number(draft.lng.toFixed(6)),
        limit: limitNumber,
      },
    ]);
    onToast(`オービス「${label || "オービス"}」を登録しました${sendNote}`);
    setDraft(null);
  };

  const remove = (point: OrbisPoint) => {
    if (armed !== point.id) {
      setArmed(point.id);
      return;
    }
    setArmed(null);
    onChange(points.filter((entry) => entry.id !== point.id));
    onToast(`オービス「${point.label || "オービス"}」を消しました${sendNote}`);
  };

  return (
    <section className="zr-panel zr-orbis" aria-label="オービス">
      <header className="zr-panel-head">
        <span>
          <small>ORBIS</small>
          <b>オービス</b>
        </span>
      </header>
      <p className="zr-navi-hint">
        車の80年代の地図で、進む向きの前方500mから知らせ、300mで声でも知らせます。OpenStreetMap
        のオービスのほかに、ここに足した場所も使います。
      </p>
      {points.length ? (
        <ul className="zr-places zr-orbis-list">
          {points.map((point) => (
            <li key={point.id}>
              <div className="zr-place-row">
                <div className="zr-place">
                  <span className="zr-place-name">
                    <b>{point.label || "オービス"}</b>
                    {point.limit ? <small>制限 {point.limit}km/h</small> : null}
                  </span>
                  <span className="zr-place-addr">{coordsText(point.lat, point.lng)}</span>
                </div>
                <button
                  type="button"
                  className={`zr-del${armed === point.id ? " is-armed" : ""}`}
                  aria-label={
                    armed === point.id
                      ? `${point.label || "オービス"} を消す(もう一度押すと消えます)`
                      : `${point.label || "オービス"} を消す`
                  }
                  onClick={() => remove(point)}
                >
                  {armed === point.id ? (
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
        <p className="zr-orbis-empty">自分で足したオービスは、まだありません。</p>
      )}
      {draft ? (
        <form
          className="zr-editor zr-orbis-editor"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <p className="zr-orbis-at">場所 {coordsText(draft.lat, draft.lng)}</p>
          <label className="zr-field zr-field-wide">
            <span>名前({MAX_ORBIS_LABEL}文字まで)</span>
            <div>
              <input
                type="text"
                value={draft.label}
                maxLength={MAX_ORBIS_LABEL}
                placeholder="例: 中央環状"
                onChange={(event) => setDraft({ ...draft, label: event.target.value })}
              />
            </div>
          </label>
          <label className="zr-field zr-field-wide">
            <span>制限速度(km/h。分かれば)</span>
            <div>
              <input
                type="number"
                inputMode="numeric"
                min={10}
                max={140}
                value={draft.limit}
                placeholder="例: 60"
                onChange={(event) => setDraft({ ...draft, limit: event.target.value })}
              />
            </div>
          </label>
          {!limitOk ? <p className="zr-orbis-error">制限速度は 10〜140 の数字で入れてください</p> : null}
          <div className="zr-editor-actions">
            <button type="button" className="zr-ghost" onClick={() => setDraft(null)}>
              やめる
            </button>
            <button type="submit" className="zr-primary" disabled={!limitOk}>
              追加する
            </button>
          </div>
        </form>
      ) : points.length < MAX_ORBIS_POINTS ? (
        <div className="zr-add-row">
          <button type="button" className="zr-add is-paste" aria-busy={busy === "paste"} onClick={() => void pastePoint()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
              <circle cx="12" cy="10" r="2.4" />
            </svg>
            <b>FROM MAPS</b>
            <small>{busy === "paste" ? "読み取り中…" : "コピーを貼り付け"}</small>
          </button>
          <button type="button" className="zr-add is-paste" aria-busy={busy === "here"} onClick={hereSpot}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="6.5" />
              <circle cx="12" cy="12" r="2" />
              <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3" />
            </svg>
            <b>HERE</b>
            <small>{busy === "here" ? "場所を調べ中…" : "今いる場所"}</small>
          </button>
        </div>
      ) : null}
      <p className="zr-note">
        移動式のオービスは場所が決まっていないので、知らせられません。地図から取るオービスの場所は ©
        OpenStreetMap の協力者によるものです。
      </p>
    </section>
  );
}
