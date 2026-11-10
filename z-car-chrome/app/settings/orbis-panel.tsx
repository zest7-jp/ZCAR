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
import { directionName, OrbisDial } from "./orbis-dial";
import { OrbisMap } from "./orbis-map";
import { townAt } from "./town-name";

/**
 * 足そう(直そう)としている場所。制限速度・走る向きは、欄で直してから保存する。
 * 名前は打たず、その場所の町名を地図から読んで入れる(読めなければ空)。
 * editId は登録してあるものを直すときの id(新しく足すときは null)。
 */
type Draft = {
  editId: string | null;
  label: string;
  lat: number;
  lng: number;
  limit: string;
  direction: number | null;
};

/** これより近くに登録してあれば、同じオービスとみなして足さない(m)。 */
const SAME_SPOT_METERS = 30;

/** Google マップのコピーを読めなかったときの案内。 */
const PASTE_NOTES: Record<PlaceImportError | "clipboard", string> = {
  clipboard: "貼り付けできませんでした。もう一度押して「ペースト」を選んでください",
  empty: "コピーされていません。Google マップで場所を選んで「共有」→「コピー」を押してください",
  unlinked: "車とつなぐと、地図の短いリンクから読み取れます",
  unreadable: "場所(緯度・経度)を読み取れませんでした。地図で場所を長押ししてからコピーしてください",
  network: "読み取れませんでした。電波のよい所でもう一度押してください",
  notmaps: "Google マップのリンクだけ読めます。Google マップで「共有」→「コピー」してください",
};

/** 緯度・経度の見せ方(小数5けた ≒ 1m)。 */
const coordsText = (lat: number, lng: number) => `${lat.toFixed(5)}, ${lng.toFixed(5)}`;

/**
 * スマホで登録するオービス(下のタブの「オービス」)。車の80年代の地図で、OpenStreetMap の
 * オービスと一緒に知らせる。Google マップのコピーか、今いる場所から足す。車にも届く。
 * 一番上に、登録した場所を全部出した地図(番号は一覧の行と同じ。印を押すと直す欄が開く)。
 */
export function OrbisPanel({
  points,
  syncKey,
  mapsKey,
  sendNote,
  onChange,
  onToast,
}: {
  points: OrbisPoint[];
  /** 車とつないだ合言葉(Google マップのリンクを読むのに使う)。つないでいなければ空。 */
  syncKey: string;
  /** 向きのダイヤルの下に出す、小さな地図の鍵。 */
  mapsKey: string;
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

  /** 足す欄を開き、その場所の町名を地図から読んで名前にする(読めるまで少しかかる)。 */
  const open = (lat: number, lng: number, direction: number | null = null) => {
    setDraft({ editId: null, lat, lng, label: "", limit: "", direction });
    void townAt(mapsKey, { lat, lng }).then((town) =>
      setDraft((current) =>
        current && !current.editId && current.lat === lat && current.lng === lng
          ? { ...current, label: Array.from(town).slice(0, MAX_ORBIS_LABEL).join("") }
          : current,
      ),
    );
  };
  /** 登録してあるオービスを直す(名前・制限速度・走る向き)。もう一度押すと閉じる。 */
  const edit = (point: OrbisPoint) =>
    setDraft((current) =>
      current?.editId === point.id
        ? null
        : {
            editId: point.id,
            lat: point.lat,
            lng: point.lng,
            label: point.label,
            limit: point.limit === null ? "" : String(point.limit),
            direction: point.direction,
          },
    );

  /** 地図の印を押したとき: その場所を直す欄を開いて、欄が見える所まで動かす。 */
  const pick = (point: OrbisPoint) => {
    setDraft({
      editId: point.id,
      lat: point.lat,
      lng: point.lng,
      label: point.label,
      limit: point.limit === null ? "" : String(point.limit),
      direction: point.direction,
    });
    window.requestAnimationFrame(() =>
      document.querySelector(".zr-orbis-editor")?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };

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
    open(result.lat, result.lng);
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
        // 走りながら(助手席で)押したときは、いま走っている向きを、そのオービスの向きにする。
        const { heading, speed } = position.coords;
        const moving = heading !== null && Number.isFinite(heading) && speed !== null && speed >= 2;
        open(position.coords.latitude, position.coords.longitude, moving ? (Math.round(heading / 5) * 5) % 360 : null);
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
    const label = draft.label.trim();
    if (draft.editId) {
      onChange(
        points.map((point) =>
          point.id === draft.editId
            ? { ...point, label, limit: limitNumber, direction: draft.direction }
            : point,
        ),
      );
      onToast(`オービス「${label || "オービス"}」を直しました${sendNote}`);
      setDraft(null);
      return;
    }
    // 同じ場所の上り・下りを別々に登録できるように、向きが同じ(か両方)ものだけを重なりとみなす。
    const same = points.some(
      (point) =>
        distanceMeters(point, draft) <= SAME_SPOT_METERS &&
        (point.direction === null || draft.direction === null || point.direction === draft.direction),
    );
    if (same) {
      onToast("すぐ近くに、もう登録してあります");
      return;
    }
    onChange([
      ...points,
      {
        id: createPlaceId(),
        label,
        lat: Number(draft.lat.toFixed(6)),
        lng: Number(draft.lng.toFixed(6)),
        limit: limitNumber,
        direction: draft.direction,
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
    if (draft?.editId === point.id) setDraft(null);
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
      {points.length ? <OrbisMap points={points} mapsKey={mapsKey} onPick={pick} /> : null}
      {points.length ? (
        <ul className="zr-places zr-orbis-list">
          {points.map((point, index) => (
            <li key={point.id} className={draft?.editId === point.id ? "is-editing" : undefined}>
              <div className="zr-place-row">
                <button
                  type="button"
                  className="zr-place"
                  aria-expanded={draft?.editId === point.id}
                  onClick={() => edit(point)}
                >
                  <span className="zr-place-name">
                    {/* 地図の印と同じ番号。 */}
                    <em className="zr-orbis-num">{index + 1}</em>
                    <b>{point.label || "オービス"}</b>
                    {point.limit ? <small>制限 {point.limit}km/h</small> : null}
                  </span>
                  <span className="zr-place-addr zr-orbis-way">
                    {/* 走る向き(矢印と「西へ」)。両方なら上下の矢印。 */}
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      style={point.direction === null ? undefined : { transform: `rotate(${point.direction}deg)` }}
                    >
                      {point.direction === null ? (
                        <path d="M12 2.5 17 8h-3.5v8H17l-5 5.5L7 16h3.5V8H7z" />
                      ) : (
                        <path d="M12 3 19 12h-4.5v9h-5v-9H5z" />
                      )}
                    </svg>
                    {directionName(point.direction)}
                    <small>{coordsText(point.lat, point.lng)}</small>
                  </span>
                </button>
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
          <p className="zr-orbis-at">
            {draft.editId ? "直す: " : ""}
            <b>{draft.label || "オービス"}</b>
            <small>{coordsText(draft.lat, draft.lng)}</small>
          </p>
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
          <OrbisDial
            lat={draft.lat}
            lng={draft.lng}
            direction={draft.direction}
            mapsKey={mapsKey}
            onChange={(direction) => setDraft({ ...draft, direction })}
          />
          <div className="zr-editor-actions">
            <button type="button" className="zr-ghost" onClick={() => setDraft(null)}>
              やめる
            </button>
            <button type="submit" className="zr-primary" disabled={!limitOk}>
              {draft.editId ? "保存する" : "追加する"}
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
      <p className="zr-navi-hint zr-orbis-hint">
        車の地図(どのテーマでも)で、進む向きの前方500mになったら、警告と声で知らせます。OpenStreetMap
        のオービスのほかに、ここに足した場所も使います。Google マップで場所を選んで
        「共有」→「コピー」してから、FROM MAPS を押します。名前は町名が自動で入ります。走る向き
        (上り・下り)を決めると、その向きに走るときだけ知らせます。登録した行か、地図の印を押すと直せます。
      </p>
      <p className="zr-note">
        移動式のオービスは場所が決まっていないので、知らせられません。地図から取るオービスの場所は ©
        OpenStreetMap の協力者によるものです。
      </p>
    </section>
  );
}
