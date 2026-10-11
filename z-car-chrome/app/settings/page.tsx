"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSharedSync } from "../hooks/use-shared-sync";
import {
  defaults,
  MAX_DESTINATION_LABEL,
  MAX_DESTINATION_TEXT,
  mergeFuelEntries,
  METER_THEMES,
  MIN_SYNC_KEY_LENGTH,
  PHONE_LONG_EDGE_MAX,
  readSettings,
  readSyncKeyFromHash,
  writeSettings,
  type FuelEntry,
  type MeterTheme,
  type Settings,
} from "../settings-store";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** 車とのやりとりを取りに行く間隔(画面に戻ってきたときは、すぐ読み直す)。 */
const SYNC_POLL_MS = 30000;

/** 日本時間での今日 (YYYY-MM-DD)。 */
const todayKey = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

const emptyFuelDraft = () => ({
  date: todayKey(),
  liters: "",
  distanceKm: "",
  amountYen: "",
});

type Tab = "fuel" | "navi" | "theme";

const TABS: { id: Tab; ja: string; en: string }[] = [
  { id: "fuel", ja: "給油", en: "FUEL" },
  { id: "navi", ja: "目的地", en: "NAVI" },
  { id: "theme", ja: "メーター", en: "THEME" },
];

/** 給油履歴に出す日付(10.10 の形)。 */
const shortDate = (date: string) => date.slice(5).replace("-", ".");

/**
 * スマホ用のページ(/settings/)。
 * 車と共有している「給油記録・目的地・メーターの色」だけを、ここからも変えられる。
 * 変えたものは共通の仕組み(use-shared-sync)で車に届く。
 */
export default function PhoneSettingsPage() {
  const [draft, setDraft] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("fuel");
  const [fuelDraft, setFuelDraft] = useState(emptyFuelDraft);
  const [toast, setToast] = useState<string | null>(null);
  // 読み取った瞬間に出す「接続完了」の知らせ。
  const [pairedNotice, setPairedNotice] = useState(false);
  // つながっているときに、つなぎ直しの欄を開いているか。
  const [linkOpen, setLinkOpen] = useState(false);
  // カメラでQRを読み取る画面。
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // 車載機のような大きい画面から来たかどうか。
  const [wideScreen, setWideScreen] = useState(false);
  // 目的地を直しているところ。
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ label: "", destination: "" });

  /** 車のQRを読み取ったときの処理(カメラ・URLのどちらからでも同じ)。 */
  const applyCarKey = useCallback((key: string) => {
    setDraft((current) =>
      current.syncKey.trim() === key && current.pairedAt > 0
        ? current
        : { ...current, syncKey: key, syncedAt: 0, pairedAt: Date.now() },
    );
    setPairedNotice(true);
    setLinkOpen(false);
  }, []);

  // 端末に保存してある内容を読む。QRから来たときは、URLの「#」以降に合言葉がある。
  useEffect(() => {
    let stored = readSettings();
    const handedOff = readSyncKeyFromHash(window.location.hash);
    if (handedOff) {
      stored = { ...stored, syncKey: handedOff, syncedAt: 0, pairedAt: Date.now() };
      setPairedNotice(true);
      // 合言葉を履歴やアドレスバーに残さない。
      window.history.replaceState(null, "", window.location.pathname);
    }
    setDraft(stored);
    setWideScreen(Math.max(window.innerWidth, window.innerHeight) >= PHONE_LONG_EDGE_MAX);
    setReady(true);
  }, []);

  // 変えたものは、すぐ端末に保存する。
  useEffect(() => {
    if (ready) writeSettings(draft);
  }, [ready, draft]);

  // 設定ページを開いたまま、QRのURL(「#」以降だけ違う)に飛んできたとき。
  useEffect(() => {
    const onHashChange = () => {
      const key = readSyncKeyFromHash(window.location.hash);
      if (!key) return;
      applyCarKey(key);
      window.history.replaceState(null, "", window.location.pathname);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [applyCarKey]);

  // 「接続完了」とお知らせは、少ししたら消す。
  useEffect(() => {
    if (!pairedNotice) return;
    const timer = window.setTimeout(() => setPairedNotice(false), 3500);
    return () => window.clearTimeout(timer);
  }, [pairedNotice]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 2600);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // 車のQRを読み取ったときだけ「つながっている」。
  const linked =
    draft.pairedAt > 0 && draft.syncKey.trim().length >= MIN_SYNC_KEY_LENGTH;

  // 車と同じ仕組みで、給油記録・目的地・色をやりとりする。
  // スマホは開いた直後、サーバー(車)の内容を正として取り込む。
  const sync = useSharedSync({
    settings: draft,
    setSettings: setDraft,
    ready: ready && linked,
    pollMs: SYNC_POLL_MS,
    keepLocalOnFirstSync: () => false,
  });

  const syncLabel = !linked
    ? { ja: "未接続", en: "NOT LINKED", tone: "off" }
    : sync.state === "error"
      ? { ja: "通信なし", en: "NO SIGNAL", tone: "warn" }
      : sync.state === "ok" && sync.at
        ? {
            ja: "同期",
            en: `SYNC ${new Date(sync.at).toLocaleTimeString("ja-JP", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })}`,
            tone: "ok",
          }
        : { ja: "同期中", en: "SYNCING", tone: "warn" };

  // --- QRの読み取り ---
  const stopScan = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanOpen(false);
  }, []);

  const startScan = async () => {
    setScanNote("カメラを準備しています…");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setScanOpen(true);
      setScanNote("車の画面のQRを枠に入れてください");
    } catch {
      setScanNote("カメラを使えませんでした。設定でカメラを許可してください。");
    }
  };

  // カメラを開いている間、映像からQRを探し続ける。
  useEffect(() => {
    if (!scanOpen) return;
    let active = true;
    let timer = 0;
    const video = videoRef.current;
    if (!video || !streamRef.current) return;
    video.srcObject = streamRef.current;
    void video.play().catch(() => undefined);

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });

    const scan = async () => {
      if (!active) return;
      if (context && video.videoWidth > 0) {
        // 大きすぎると重いので、横640pxまで縮めてから読む。
        const scale = Math.min(1, 640 / video.videoWidth);
        canvas.width = Math.round(video.videoWidth * scale);
        canvas.height = Math.round(video.videoHeight * scale);
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        const image = context.getImageData(0, 0, canvas.width, canvas.height);
        try {
          const jsQR = (await import("jsqr")).default;
          const found = jsQR(image.data, canvas.width, canvas.height);
          if (found?.data && active) {
            const hash = found.data.includes("#")
              ? found.data.slice(found.data.indexOf("#"))
              : "";
            const key = readSyncKeyFromHash(hash);
            if (key) {
              active = false;
              applyCarKey(key);
              stopScan();
              setScanNote(null);
              return;
            }
            setScanNote("Z CAR のQRではないようです");
          }
        } catch {
          // 読み取りに失敗しても次のコマで試す。
        }
      }
      if (active) timer = window.setTimeout(scan, 250);
    };
    timer = window.setTimeout(scan, 400);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [scanOpen, stopScan, applyCarKey]);

  // --- 給油 ---
  const fuelLiters = Number.parseFloat(fuelDraft.liters);
  const fuelDistance = Number.parseFloat(fuelDraft.distanceKm);
  const fuelAmount = Number.parseFloat(fuelDraft.amountYen);
  const fuelValid =
    /^\d{4}-\d{2}-\d{2}$/.test(fuelDraft.date) &&
    Number.isFinite(fuelLiters) &&
    fuelLiters > 0 &&
    Number.isFinite(fuelDistance) &&
    fuelDistance >= 0 &&
    Number.isFinite(fuelAmount) &&
    fuelAmount >= 0;
  const fuelEconomy = fuelValid ? fuelDistance / fuelLiters : null;

  // 今月の合計(車の燃費画面と同じ数え方)。
  const monthKey = todayKey().slice(0, 7);
  const monthEntries = draft.fuelEntries.filter((entry) => entry.date.startsWith(monthKey));
  const monthLiters = monthEntries.reduce((total, entry) => total + entry.liters, 0);
  const monthDistance = monthEntries.reduce((total, entry) => total + entry.distanceKm, 0);
  const monthAmount = monthEntries.reduce((total, entry) => total + entry.amountYen, 0);
  const monthEconomy = monthLiters > 0 ? monthDistance / monthLiters : null;
  const recentFuel = draft.fuelEntries.slice(0, 10);

  const recordFuel = () => {
    if (!fuelValid) return;
    const now = Date.now();
    const entry: FuelEntry = {
      id: `${now}`,
      date: fuelDraft.date,
      liters: fuelLiters,
      distanceKm: fuelDistance,
      amountYen: Math.round(fuelAmount),
      createdAt: now,
    };
    setDraft((current) => ({
      ...current,
      fuelEntries: mergeFuelEntries(current.fuelEntries, [entry]),
    }));
    setFuelDraft(emptyFuelDraft());
    setToast(linked ? "記録しました・車に送ります" : "記録しました");
  };

  // --- 目的地(車の「場所を直す」と同じ並び) ---
  const workDestination =
    draft.storeDest.trim() ||
    draft.storeName.trim() ||
    draft.mapDestinations[0]?.destination ||
    "";
  const homeDestination = draft.homeDest.trim() || draft.mapDestinations[1]?.destination || "";
  const slots = [
    { key: "work", label: "DEPART", note: "出発(店舗)", destination: workDestination, canRename: false },
    { key: "home", label: "RETURN", note: "帰宅", destination: homeDestination, canRename: false },
    ...draft.mapDestinations.map((entry, index) => ({
      key: `dest-${index}`,
      label: entry.label.trim() || `${index + 1}番`,
      note: `${index + 1}番`,
      destination: entry.destination.trim(),
      canRename: true,
    })),
  ];

  const openEditor = (slot: (typeof slots)[number]) => {
    if (editKey === slot.key) {
      setEditKey(null);
      return;
    }
    setEditKey(slot.key);
    setEditDraft({ label: slot.canRename ? slot.label : "", destination: slot.destination });
  };

  /** 直した場所を保存する。住所を空にすると、その枠は未登録に戻る。 */
  const saveEditor = (clear = false) => {
    const key = editKey;
    if (!key) return;
    const destination = clear ? "" : editDraft.destination.trim().slice(0, MAX_DESTINATION_TEXT);
    const label = clear ? "" : editDraft.label.trim().slice(0, MAX_DESTINATION_LABEL);
    setDraft((current) => {
      if (key === "work") return { ...current, storeDest: destination };
      if (key === "home") return { ...current, homeDest: destination };
      const index = Number.parseInt(key.slice("dest-".length), 10);
      if (!Number.isInteger(index)) return current;
      return {
        ...current,
        mapDestinations: current.mapDestinations.map((entry, position) =>
          position === index ? { label, destination } : entry,
        ),
      };
    });
    setEditKey(null);
    setToast(linked ? "保存しました・車に送ります" : "保存しました");
  };

  // --- メーターの色 ---
  const chooseTheme = (id: MeterTheme) => {
    if (draft.meterTheme === id) return;
    setDraft((current) => ({ ...current, meterTheme: id }));
    setToast(linked ? "メーターの色を変えました・車に送ります" : "メーターの色を変えました");
  };

  const showLink = !linked || linkOpen;

  return (
    <main className="zr" data-theme={draft.meterTheme} aria-busy={!ready}>
      {pairedNotice ? (
        <button
          type="button"
          className="zr-paired"
          role="status"
          onClick={() => setPairedNotice(false)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M7 12.4l3.2 3.2L17 8.8" />
          </svg>
          <b>接続しました</b>
          <small>LINK ACTIVE · 車とつながりました</small>
        </button>
      ) : null}

      <header className="zr-head">
        <div className="zr-brand">
          <b>Z CAR</b>
          <small>TANTO · REMOTE</small>
        </div>
        <button
          type="button"
          className={`zr-link-chip is-${syncLabel.tone}`}
          onClick={() => setLinkOpen((open) => !open)}
          aria-expanded={showLink}
          aria-label="車との接続"
        >
          <i aria-hidden="true" />
          <span>
            <small>端末 LINK</small>
            <b>
              {syncLabel.ja}
              <em>{syncLabel.en}</em>
            </b>
          </span>
        </button>
      </header>

      {showLink ? (
        <section className="zr-panel zr-link" aria-label="車とつなぐ">
          <header className="zr-panel-head">
            <span>
              <small>LINK</small>
              <b>車とつなぐ</b>
            </span>
            {linked ? (
              <button type="button" className="zr-close" onClick={() => setLinkOpen(false)}>
                閉じる
              </button>
            ) : null}
          </header>
          <p className="zr-note">
            車の燃費画面（給油履歴の右）か、DEST の画面の下にある
            <b>「LINK PHONE」</b>を押すとQRが出ます。読み取ると、給油記録・目的地・
            メーターの色を、車とこのスマホのどちらからでも変えられます。
          </p>
          <button type="button" className="zr-primary" onClick={() => void startScan()}>
            カメラでQRを読み取る
          </button>
          {scanNote && !scanOpen ? (
            <p className="zr-scan-note" role="status">{scanNote}</p>
          ) : null}
        </section>
      ) : null}

      <nav className="zr-tabs" aria-label="切り替え">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={tab === item.id ? "is-active" : undefined}
            aria-pressed={tab === item.id}
            onClick={() => {
              setTab(item.id);
              setEditKey(null);
            }}
          >
            <b>{item.ja}</b>
            <small>{item.en}</small>
          </button>
        ))}
      </nav>

      {tab === "fuel" ? (
        <>
          <section className="zr-hero" aria-label="今月の燃費">
            <header>
              <small>THIS MONTH</small>
              <span>今月の平均燃費</span>
            </header>
            <p className="zr-hero-value">
              <strong>{monthEconomy === null ? "—" : monthEconomy.toFixed(1)}</strong>
              <em>km/L</em>
            </p>
            <dl className="zr-hero-stats">
              <div>
                <dt>給油量</dt>
                <dd>{monthLiters.toFixed(1)}<em>L</em></dd>
              </div>
              <div>
                <dt>金額</dt>
                <dd>{Math.round(monthAmount).toLocaleString("ja-JP")}<em>円</em></dd>
              </div>
              <div>
                <dt>走行</dt>
                <dd>{monthDistance.toFixed(1)}<em>km</em></dd>
              </div>
            </dl>
          </section>

          <section className="zr-panel" aria-label="給油を記録">
            <header className="zr-panel-head">
              <span>
                <small>NEW REFUEL</small>
                <b>給油を記録</b>
              </span>
            </header>
            <div className="zr-form">
              <label className="zr-field zr-field-wide">
                <span>給油日</span>
                <div>
                  <input
                    type="date"
                    value={fuelDraft.date}
                    onChange={(event) => setFuelDraft({ ...fuelDraft, date: event.target.value })}
                  />
                </div>
              </label>
              <label className="zr-field">
                <span>給油量</span>
                <div>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    placeholder="0.00"
                    value={fuelDraft.liters}
                    onChange={(event) => setFuelDraft({ ...fuelDraft, liters: event.target.value })}
                  />
                  <em>L</em>
                </div>
              </label>
              <label className="zr-field">
                <span>走行距離</span>
                <div>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.1"
                    placeholder="前回から"
                    value={fuelDraft.distanceKm}
                    onChange={(event) =>
                      setFuelDraft({ ...fuelDraft, distanceKm: event.target.value })
                    }
                  />
                  <em>km</em>
                </div>
              </label>
              <label className="zr-field zr-field-wide">
                <span>金額</span>
                <div>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="1"
                    placeholder="0"
                    value={fuelDraft.amountYen}
                    onChange={(event) =>
                      setFuelDraft({ ...fuelDraft, amountYen: event.target.value })
                    }
                  />
                  <em>円</em>
                </div>
              </label>
            </div>
            <p className="zr-preview" aria-live="polite">
              <small>今回の燃費</small>
              <strong>{fuelEconomy === null ? "—" : fuelEconomy.toFixed(1)}</strong>
              <em>km/L</em>
            </p>
            <button
              type="button"
              className="zr-primary"
              disabled={!fuelValid}
              onClick={recordFuel}
            >
              記録する
            </button>
          </section>

          <section className="zr-panel" aria-label="給油履歴">
            <header className="zr-panel-head">
              <span>
                <small>HISTORY</small>
                <b>給油履歴</b>
              </span>
              <em>{draft.fuelEntries.length} TOTAL</em>
            </header>
            {recentFuel.length ? (
              <ol className="zr-history">
                {recentFuel.map((entry) => (
                  <li key={entry.id}>
                    <time dateTime={entry.date}>{shortDate(entry.date)}</time>
                    <strong>
                      {(entry.distanceKm / entry.liters).toFixed(1)}
                      <em>km/L</em>
                    </strong>
                    <span>{entry.liters.toFixed(2)}<em>L</em></span>
                    <span>{Math.round(entry.amountYen).toLocaleString("ja-JP")}<em>円</em></span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="zr-note">まだ記録がありません。</p>
            )}
          </section>
        </>
      ) : null}

      {tab === "navi" ? (
        <section className="zr-panel" aria-label="ナビの目的地">
          <header className="zr-panel-head">
            <span>
              <small>DESTINATIONS</small>
              <b>ナビの目的地</b>
            </span>
          </header>
          <ul className="zr-places">
            {slots.map((slot) => (
              <li key={slot.key} className={editKey === slot.key ? "is-editing" : undefined}>
                <button
                  type="button"
                  className="zr-place"
                  aria-expanded={editKey === slot.key}
                  onClick={() => openEditor(slot)}
                >
                  <span className="zr-place-name">
                    <b>{slot.label}</b>
                    <small>{slot.note}</small>
                  </span>
                  <span className="zr-place-addr">{slot.destination || "未登録"}</span>
                  <i aria-hidden="true" />
                </button>
                {editKey === slot.key ? (
                  <form
                    className="zr-editor"
                    onSubmit={(event) => {
                      event.preventDefault();
                      saveEditor();
                    }}
                  >
                    {slot.canRename ? (
                      <label className="zr-field zr-field-wide">
                        <span>名前（{MAX_DESTINATION_LABEL}文字まで）</span>
                        <div>
                          <input
                            type="text"
                            value={editDraft.label}
                            maxLength={MAX_DESTINATION_LABEL}
                            placeholder="例: 鳥"
                            onChange={(event) =>
                              setEditDraft({ ...editDraft, label: event.target.value })
                            }
                          />
                        </div>
                      </label>
                    ) : null}
                    <label className="zr-field zr-field-wide">
                      <span>住所、または場所の名前</span>
                      <div>
                        <input
                          type="text"
                          value={editDraft.destination}
                          maxLength={MAX_DESTINATION_TEXT}
                          placeholder="例: 大阪府枚方市出口3丁目1-1"
                          onChange={(event) =>
                            setEditDraft({ ...editDraft, destination: event.target.value })
                          }
                        />
                      </div>
                    </label>
                    <div className="zr-editor-actions">
                      <button type="button" className="zr-ghost" onClick={() => setEditKey(null)}>
                        やめる
                      </button>
                      <button
                        type="submit"
                        className="zr-primary"
                        disabled={!editDraft.destination.trim()}
                      >
                        保存する
                      </button>
                    </div>
                    {slot.destination ? (
                      <button type="button" className="zr-danger" onClick={() => saveEditor(true)}>
                        この場所を消す
                      </button>
                    ) : null}
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="zr-note">
            住所でも店名でも構いません。車の DEST にそのまま並び、右下の START で
            案内が始まります。
          </p>
        </section>
      ) : null}

      {tab === "theme" ? (
        <section className="zr-themes" aria-label="メーターの色">
          {METER_THEMES.map((theme) => {
            const active = draft.meterTheme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                className={`zr-theme is-${theme.id}${active ? " is-active" : ""}`}
                aria-pressed={active}
                onClick={() => chooseTheme(theme.id)}
              >
                <i aria-hidden="true" />
                <span>
                  <b>{theme.name}</b>
                  <small>{theme.caption}</small>
                </span>
                <em>{active ? "ACTIVE" : "SELECT"}</em>
              </button>
            );
          })}
          <p className="zr-note">押すと車のメーターの色も変わります。</p>
        </section>
      ) : null}

      {toast ? (
        <p className="zr-toast" role="status">
          {toast}
        </p>
      ) : null}

      {scanOpen ? (
        <div className="zr-scanner" role="dialog" aria-label="QRの読み取り">
          <video ref={videoRef} playsInline muted />
          <div className="zr-scanner-frame" aria-hidden="true" />
          <p>{scanNote ?? "車の画面のQRを枠に入れてください"}</p>
          <button type="button" onClick={stopScan}>
            やめる
          </button>
        </div>
      ) : null}

      {/* 車載機がまちがってこの画面に来たときの戻り道。スマホには出さない。 */}
      {wideScreen ? (
        <a className="zr-car-link" href={`${basePath}/?app=1`}>
          この端末を車として使う（車の画面を開く）
        </a>
      ) : null}
    </main>
  );
}
