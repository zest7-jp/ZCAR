"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  adoptMusicLibrary,
  claimLinkCode,
  createLinkCode,
  LINK_CODE_LENGTH,
  SETTINGS_URL_HINT,
  defaults,
  fetchSharedSettings,
  mergeFuelEntries,
  MAX_DESTINATION_LABEL,
  MAX_DESTINATION_TEXT,
  METER_THEMES,
  deleteMusicTrack,
  fetchMusicTracks,
  generateSyncKey,
  MAX_MUSIC_PLAYLISTS,
  MAX_MUSIC_PLAYLIST_NAME,
  saveMusicPlaylists,
  MIN_SYNC_KEY_LENGTH,
  PHONE_LONG_EDGE_MAX,
  pushSharedSettings,
  uploadMusicFiles,
  type MusicPlaylist,
  type MusicTrack,
  readSettings,
  readSyncKeyFromHash,
  sanitizeSyncedSettings,
  writeSettings,
  type FuelEntry,
  type MapDestination,
  type MeterTheme,
  type Settings,
} from "../settings-store";

type SyncState = "idle" | "sending" | "done" | "error";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** 日本時間での今日 (YYYY-MM-DD)。 */
const todayKey = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

const emptyFuelDraft = {
  date: todayKey(),
  liters: "",
  distanceKm: "",
  amountYen: "",
};

/** Googleマップを案内モードで開くURL。車側の目的地ボタンと同じ形式。 */
export default function PhoneSettingsPage() {
  const [draft, setDraft] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("idle");
  const [handoffDone, setHandoffDone] = useState(false);
  // 最初はどのカードも閉じておき、触りたいものだけ開く(1枚ずつ)。
  const [openCard, setOpenCard] = useState<string | null>(null);
  const toggleCard = (id: string) =>
    setOpenCard((current) => (current === id ? null : id));
  const [fuelDraft, setFuelDraft] = useState(emptyFuelDraft);
  const [fuelSaved, setFuelSaved] = useState(false);
  // 読み取った瞬間に出す「接続完了！」の知らせ。
  const [pairedNotice, setPairedNotice] = useState(false);
  // パソコンなどに合言葉を渡すコードの状態。
  const [linkState, setLinkState] = useState<
    | { kind: "idle" | "loading" }
    | { kind: "shown"; code: string; left: number }
    | { kind: "error"; note: string }
  >({ kind: "idle" });
  const [codeInput, setCodeInput] = useState("");
  // カメラでQRを読み取る画面。
  const [scanOpen, setScanOpen] = useState(false);
  const [scanState, setScanState] = useState<{
    kind: "idle" | "opening" | "scanning" | "done" | "error";
    note?: string;
  }>({ kind: "idle" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // 車載機のような大きい画面から来たかどうか(描画後に測る)。
  const [wideScreen, setWideScreen] = useState(false);
  // 音源置き場(サーバー)の中身。
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [tracksBytes, setTracksBytes] = useState(0);
  const [musicPlaylists, setMusicPlaylists] = useState<MusicPlaylist[]>([]);
  // 車で流すプレイリスト("" は「すべての曲」)。
  const [activePlaylistId, setActivePlaylistId] = useState("");
  // いま編集しているプレイリスト("" のときは曲の追加・削除だけ)。
  const [editingPlaylistId, setEditingPlaylistId] = useState("");
  const [musicState, setMusicState] = useState<
    { kind: "idle" | "loading" | "uploading" | "error"; note?: string }
  >({ kind: "idle" });

  useEffect(() => {
    setWideScreen(
      Math.max(window.innerWidth, window.innerHeight) >= PHONE_LONG_EDGE_MAX,
    );
  }, []);

  useEffect(() => {
    let stored = readSettings();

    // QRを読み取って来た場合、URLの「#」以降に合言葉が入っている。
    const handedOff = readSyncKeyFromHash(window.location.hash);
    if (handedOff) {
      const previousKey = stored.syncKey.trim();
      // 合言葉が変わったら、それまでの同期時刻は無効。0に戻して車側の内容を取り込む。
      stored = { ...stored, syncKey: handedOff, syncedAt: 0, pairedAt: Date.now() };
      writeSettings(stored);
      setHandoffDone(true);
      // つなぐ前にこの端末へ入れた曲を、車の置き場へ移す。
      if (previousKey.length >= MIN_SYNC_KEY_LENGTH && previousKey !== handedOff) {
        void adoptMusicLibrary(handedOff, previousKey)
          .then((result) => {
            if (result.ok) applyLibrary(result);
          })
          .catch(() => undefined);
      }
      // 合言葉を履歴やアドレスバーに残さない。
      window.history.replaceState(null, "", window.location.pathname);
    }

    setDraft(stored);
    setReady(true);

    // 車側で先に変更されているかもしれないので、開いた時点で一度取りに行く。
    const key = stored.syncKey.trim();
    if (key.length < MIN_SYNC_KEY_LENGTH) return;
    const base = stored;
    void fetchSharedSettings(key)
      .then((result) => {
        const updatedAt = result.updatedAt ?? 0;
        if (!result.ok || !result.settings || updatedAt <= base.syncedAt) return;
        const shared = sanitizeSyncedSettings(result.settings);
        const merged = {
          ...base,
          ...shared,
          // 給油記録は車の分も残す(消す操作が無いので足し合わせる)。
          fuelEntries: mergeFuelEntries(base.fuelEntries, shared.fuelEntries ?? []),
          syncedAt: updatedAt,
        };
        setDraft(merged);
        writeSettings(merged);
      })
      .catch(() => undefined);
  }, []);

  // 保存後の「保存しました」表示は数秒で消す。
  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2600);
    return () => window.clearTimeout(timer);
  }, [saved]);

  useEffect(() => {
    if (!fuelSaved) return;
    const timer = window.setTimeout(() => setFuelSaved(false), 3000);
    return () => window.clearTimeout(timer);
  }, [fuelSaved]);

  const update = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
    setSyncState("idle");
  };


  /** 保存した内容を車側にも届ける。 */
  const sendToCar = async (settings: Settings) => {
    if (settings.syncKey.trim().length < MIN_SYNC_KEY_LENGTH) return;
    setSyncState("sending");
    try {
      const result = await pushSharedSettings(settings.syncKey.trim(), settings);
      const updatedAt = result.updatedAt ?? Date.now();
      const synced = { ...settings, syncedAt: updatedAt };
      setDraft(synced);
      writeSettings(synced);
      setSyncState("done");
    } catch {
      setSyncState("error");
    }
  };

  const updateDestination = (index: number, patch: Partial<MapDestination>) => {
    setDraft((current) => ({
      ...current,
      mapDestinations: current.mapDestinations.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
      ),
    }));
    setSaved(false);
    setSyncState("idle");
  };

  const syncKey = draft.syncKey.trim();
  const hasKey = syncKey.length >= MIN_SYNC_KEY_LENGTH;
  // 「つながっている」のは、車のQRを読み取ったときだけ。
  // (曲を先に入れるために、この端末が自分で作った合言葉は接続ではない)
  const isPaired = draft.pairedAt > 0 && hasKey;

  /**
   * 音源を置くための合言葉。まだ無ければこの端末で作る。
   * 車とつないだときに、その合言葉の置き場へ引っ越す。
   */
  const ensureMusicKey = () => {
    if (hasKey) return syncKey;
    const key = generateSyncKey();
    const next = { ...draft, syncKey: key, syncedAt: 0 };
    setDraft(next);
    writeSettings(next);
    return key;
  };

  /** カメラでQRを読み取る。読めたら車とつながる。 */
  const startScan = async () => {
    setScanState({ kind: "opening", note: "カメラを準備しています…" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setScanOpen(true);
      setScanState({ kind: "scanning", note: "車の画面のQRを枠に入れてください" });
    } catch {
      setScanState({
        kind: "error",
        note: "カメラを使えませんでした。設定でカメラを許可してください。",
      });
    }
  };

  /** カメラを閉じる。 */
  const stopScan = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanOpen(false);
  }, []);

  /** 車のQRを読み取ったときの処理(カメラ・URLのどちらからでも同じ)。 */
  const applyCarKey = (carKey: string) => {
    setPairedNotice(true);
    const previousKey = syncKey;
    const next = { ...draft, syncKey: carKey, syncedAt: 0, pairedAt: Date.now() };
    setDraft(next);
    writeSettings(next);
    if (previousKey.length >= MIN_SYNC_KEY_LENGTH && previousKey !== carKey) {
      // つなぐ前に入れた曲を、車の置き場へ移す。
      void adoptMusicLibrary(carKey, previousKey)
        .then((result) => {
          if (result.ok) applyLibrary(result);
        })
        .catch(() => undefined);
    }
  };

  /** サーバーから返ってきた中身を画面に反映する。 */
  const applyLibrary = (result: {
    tracks: MusicTrack[];
    totalBytes: number;
    playlists: MusicPlaylist[];
    activePlaylistId: string;
  }) => {
    setTracks(result.tracks);
    setTracksBytes(result.totalBytes);
    setMusicPlaylists(result.playlists);
    setActivePlaylistId(result.activePlaylistId);
  };

  // 設定ページを開いたまま、QRのURL(「#」以降だけ違う)に飛んできたとき。
  // この場合はページが読み込み直されないので、ここで拾う。
  useEffect(() => {
    if (!ready) return;
    const onHashChange = () => {
      const key = readSyncKeyFromHash(window.location.hash);
      if (!key || key === draft.syncKey.trim()) return;
      applyCarKey(key);
      setHandoffDone(true);
      window.history.replaceState(null, "", window.location.pathname);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  });

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
            const hash = found.data.includes("#") ? found.data.slice(found.data.indexOf("#")) : "";
            const key = readSyncKeyFromHash(hash);
            if (key) {
              active = false;
              applyCarKey(key);
              stopScan();
              setScanState({ kind: "done", note: "車とつながりました" });
              return;
            }
            setScanState({ kind: "scanning", note: "Z CAR のQRではないようです" });
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
  }, [scanOpen, stopScan]);

  // 画面を離れるときは必ずカメラを止める。
  useEffect(() => stopScan, [stopScan]);

  // コードの残り時間を数え、0になったら消す。
  useEffect(() => {
    if (linkState.kind !== "shown") return;
    const timer = window.setInterval(() => {
      setLinkState((current) => {
        if (current.kind !== "shown") return current;
        if (current.left <= 1) return { kind: "idle" };
        return { ...current, left: current.left - 1 };
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [linkState.kind]);

  // 「接続完了！」は数秒で自分から消える(押しても消せる)。
  useEffect(() => {
    if (!pairedNotice) return;
    const timer = window.setTimeout(() => setPairedNotice(false), 4000);
    return () => window.clearTimeout(timer);
  }, [pairedNotice]);

  // 音源置き場の中身は、カードを開いたときに読みに行く。
  useEffect(() => {
    if (openCard !== "files" || !hasKey) return;
    let active = true;
    setMusicState({ kind: "loading" });
    fetchMusicTracks(syncKey)
      .then((result) => {
        if (!active) return;
        if (!result.ok) {
          setMusicState({ kind: "error", note: "一覧を取得できませんでした" });
          return;
        }
        applyLibrary(result);
        setMusicState({ kind: "idle" });
      })
      .catch(() => {
        if (active) setMusicState({ kind: "error", note: "通信できませんでした" });
      });
    return () => {
      active = false;
    };
  }, [openCard, hasKey, syncKey]);

  /** 選んだ音楽ファイルを預ける。 */
  const uploadFiles = async (fileList: FileList | null) => {
    const files = fileList ? Array.from(fileList) : [];
    if (!files.length) return;
    const key = ensureMusicKey();
    setMusicState({ kind: "uploading", note: `0 / ${files.length}曲` });
    try {
      const result = await uploadMusicFiles(key, files, (done, total, name) => {
        setMusicState({
          kind: "uploading",
          note: name ? `${done} / ${total}曲　${name}` : `${done} / ${total}曲`,
        });
      });
      if (!result.ok) {
        setMusicState({ kind: "error", note: "アップロードできませんでした" });
        return;
      }
      applyLibrary(result);
      const skipped = result.skipped ?? [];
      setMusicState({
        kind: "idle",
        note: skipped.length
          ? `${result.saved ?? 0}曲を追加。${skipped.length}曲は追加できませんでした（${skipped[0].reason}）`
          : `${result.saved ?? 0}曲を追加しました`,
      });
    } catch {
      setMusicState({ kind: "error", note: "通信できませんでした" });
    }
  };

  /**
   * パソコンなどカメラの無い端末に合言葉を渡すためのコードを出す。
   * 合言葉そのものは画面に出さない。コードは10分で切れる。
   */
  const showLinkCode = async () => {
    const key = syncKey;
    if (key.length < MIN_SYNC_KEY_LENGTH) {
      setLinkState({ kind: "error", note: "先に車とつないでください" });
      return;
    }
    setLinkState({ kind: "loading" });
    try {
      const made = await createLinkCode(key);
      if (!made) {
        setLinkState({ kind: "error", note: "コードを作れませんでした" });
        return;
      }
      setLinkState({ kind: "shown", code: made.code, left: made.expiresIn });
    } catch {
      setLinkState({ kind: "error", note: "通信できませんでした" });
    }
  };

  /** 受け取ったコードを打って、この端末を車につなぐ。 */
  const useLinkCode = async () => {
    const code = codeInput.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
    if (code.length !== LINK_CODE_LENGTH) {
      setLinkState({ kind: "error", note: `コードは${LINK_CODE_LENGTH}文字です` });
      return;
    }
    setLinkState({ kind: "loading" });
    try {
      const result = await claimLinkCode(code);
      if (!result.ok) {
        setLinkState({
          kind: "error",
          note:
            result.status === 429
              ? "試した回数が多すぎます。しばらく待ってください"
              : "このコードは使えません（期限切れか、打ち間違いです）",
        });
        return;
      }
      applyCarKey(result.key);
      setCodeInput("");
      setLinkState({ kind: "idle" });
    } catch {
      setLinkState({ kind: "error", note: "通信できませんでした" });
    }
  };

  /** 置いてある曲を消す。 */
  const removeTrack = async (track: MusicTrack) => {
    if (!hasKey) return;
    if (!window.confirm(`「${track.title}」を消します。よろしいですか？`)) return;
    try {
      const result = await deleteMusicTrack(syncKey, track.id);
      if (!result.ok) {
        setMusicState({ kind: "error", note: "消せませんでした" });
        return;
      }
      applyLibrary(result);
      setMusicState({ kind: "idle", note: "1曲消しました" });
    } catch {
      setMusicState({ kind: "error", note: "通信できませんでした" });
    }
  };

  /** プレイリストの変更をサーバーに保存する。 */
  const storePlaylists = async (
    nextPlaylists: MusicPlaylist[],
    nextActiveId: string,
  ) => {
    setMusicPlaylists(nextPlaylists);
    setActivePlaylistId(nextActiveId);
    try {
      const result = await saveMusicPlaylists(syncKey, nextPlaylists, nextActiveId);
      if (!result.ok) {
        setMusicState({ kind: "error", note: "保存できませんでした" });
        return;
      }
      applyLibrary(result);
      setMusicState({ kind: "idle", note: "プレイリストを保存しました" });
    } catch {
      setMusicState({ kind: "error", note: "通信できませんでした" });
    }
  };

  /** 新しいプレイリストを作る。 */
  const createMusicPlaylist = () => {
    if (musicPlaylists.length >= MAX_MUSIC_PLAYLISTS) {
      setMusicState({ kind: "error", note: "プレイリストが多すぎます" });
      return;
    }
    const name = window.prompt("プレイリストの名前", "ドライブ");
    if (name === null) return;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(8)))
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    const next = [
      ...musicPlaylists,
      {
        id,
        name: name.trim().slice(0, MAX_MUSIC_PLAYLIST_NAME) || "PLAYLIST",
        trackIds: [],
      },
    ];
    setEditingPlaylistId(id);
    void storePlaylists(next, id);
  };

  /** 名前を変える。 */
  const renameMusicPlaylist = (playlist: MusicPlaylist) => {
    const name = window.prompt("プレイリストの名前", playlist.name);
    if (name === null) return;
    void storePlaylists(
      musicPlaylists.map((entry) =>
        entry.id === playlist.id
          ? {
              ...entry,
              name: name.trim().slice(0, MAX_MUSIC_PLAYLIST_NAME) || "PLAYLIST",
            }
          : entry,
      ),
      activePlaylistId,
    );
  };

  /** プレイリストを消す(曲そのものは残る)。 */
  const removeMusicPlaylist = (playlist: MusicPlaylist) => {
    if (!window.confirm(`「${playlist.name}」を消します。曲は残ります。`)) return;
    const next = musicPlaylists.filter((entry) => entry.id !== playlist.id);
    if (editingPlaylistId === playlist.id) setEditingPlaylistId("");
    void storePlaylists(next, activePlaylistId === playlist.id ? "" : activePlaylistId);
  };

  /** 曲をプレイリストに入れる / 外す。 */
  const toggleTrackInPlaylist = (playlistId: string, trackId: string) => {
    void storePlaylists(
      musicPlaylists.map((entry) => {
        if (entry.id !== playlistId) return entry;
        const has = entry.trackIds.includes(trackId);
        return {
          ...entry,
          trackIds: has
            ? entry.trackIds.filter((id) => id !== trackId)
            : [...entry.trackIds, trackId],
        };
      }),
      activePlaylistId,
    );
  };

  /** 車で流す一覧を切り替える。 */
  const selectActivePlaylist = (id: string) => {
    void storePlaylists(musicPlaylists, id);
  };

  const editingPlaylist =
    musicPlaylists.find((entry) => entry.id === editingPlaylistId) ?? null;

  const fuelLiters = Number.parseFloat(fuelDraft.liters);
  const fuelDistance = Number.parseFloat(fuelDraft.distanceKm);
  const fuelAmount = Number.parseFloat(fuelDraft.amountYen);
  const fuelDraftIsValid =
    /^\d{4}-\d{2}-\d{2}$/.test(fuelDraft.date) &&
    Number.isFinite(fuelLiters) &&
    fuelLiters > 0 &&
    Number.isFinite(fuelDistance) &&
    fuelDistance >= 0 &&
    Number.isFinite(fuelAmount) &&
    fuelAmount >= 0;
  /** この給油分の燃費(満タン法)。 */
  const fuelDraftEconomy = fuelDraftIsValid ? fuelDistance / fuelLiters : null;
  const recentFuel = draft.fuelEntries.slice(0, 5);

  /** 給油を記録して、車にも届ける。 */
  const recordFuel = () => {
    if (!fuelDraftIsValid) return;
    const now = Date.now();
    const entry: FuelEntry = {
      id: `${now}`,
      date: fuelDraft.date,
      liters: fuelLiters,
      distanceKm: fuelDistance,
      amountYen: Math.round(fuelAmount),
      createdAt: now,
    };
    const next = {
      ...draft,
      fuelEntries: mergeFuelEntries(draft.fuelEntries, [entry]),
    };
    setDraft(next);
    writeSettings(next);
    setFuelDraft({ ...emptyFuelDraft, date: todayKey() });
    setFuelSaved(true);
    void sendToCar(next);
  };

  const save = () => {
    const next: Settings = {
      ...draft,
      storeName: draft.storeName.trim() || defaults.storeName,
      storeDest:
        draft.storeDest.trim() || draft.storeName.trim() || defaults.storeDest,
      start: draft.start || defaults.start,
      carId: draft.carId.trim() || defaults.carId,
      mapDestinations: draft.mapDestinations.map((entry) => ({
        label: entry.label.trim().slice(0, MAX_DESTINATION_LABEL),
        destination: entry.destination.trim().slice(0, MAX_DESTINATION_TEXT),
      })),
      // YouTubeのプレイリストはこの画面から編集しないので、そのまま保つ。
    };
    setDraft(next);
    writeSettings(next);
    setSaved(true);
    void sendToCar(next);
  };

  return (
    <main className="zsetup" aria-busy={!ready}>
      {pairedNotice ? (
        <button
          type="button"
          className="zsetup-paired"
          role="status"
          onClick={() => setPairedNotice(false)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path d="M7 12.4l3.2 3.2L17 8.8" />
          </svg>
          <b>接続完了！</b>
          <small>車とつながりました</small>
        </button>
      ) : null}
      <header className="zsetup-head">
        <div className="zsetup-head-top">
          <p className="zsetup-eyebrow">Z PORTAL | CAR</p>
          {/* 車とつながっているかを、メーターの上のバーと同じ書き方で出す。 */}
          <span className={`zsetup-link${isPaired ? " is-ok" : ""}`}>
            <i aria-hidden="true" />
            <small>LINK</small>
            <b>{isPaired ? "LINKED" : "UNPAIRED"}</b>
          </span>
        </div>
        <h1>Z CAR 設定</h1>
        <p className="zsetup-lead">
          {handoffDone
            ? "車とつながりました。この端末から設定を変えられます。"
            : "この端末（スマートフォン）に保存される設定です。"}
        </p>
      </header>

      <section className={`zsetup-section zsetup-card${openCard === "pair" ? " is-open" : ""}`}>
        <button
          type="button"
          className="zsetup-card-head"
          aria-expanded={openCard === "pair"}
          onClick={() => toggleCard("pair")}
        >
          <span>
            <em className="zsetup-card-tag">01 · LINK</em>
            <b>車と接続</b>
            <small>{isPaired ? "接続済み" : "まだつながっていません"}</small>
          </span>
          <i aria-hidden="true" />
        </button>
        {openCard === "pair" ? (
          <div className="zsetup-card-body">
            <button type="button" className="zsetup-scan" onClick={() => void startScan()}>
              カメラでQRを読み取る
            </button>
            <p className="zsetup-music-state" role="status">
              {scanState.note ?? ""}
            </p>
            <p className="zsetup-sync-note">
              車の画面の右上（QRのマーク）を押すとQRが出ます。それをこのボタンから
              読み取ると、車とつながります。つながると、メーターの色・ナビの目的地・
              音楽がこの端末から変えられます。
            </p>

            {/* カメラが無いパソコンは、スマホに出したコードを打ってつなぐ。 */}
            <div className="zsetup-code">
              <b>コードでつなぐ</b>
              <p>
                カメラが無いパソコンはこちら。つないである端末の「音源フォルダ」で
                出したコードを打ってください。
              </p>
              <div className="zsetup-code-row">
                <input
                  type="text"
                  inputMode="text"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={LINK_CODE_LENGTH + 2}
                  placeholder={"X".repeat(LINK_CODE_LENGTH)}
                  value={codeInput}
                  onChange={(event) => setCodeInput(event.target.value)}
                />
                <button type="button" onClick={() => void useLinkCode()}>
                  つなぐ
                </button>
              </div>
              {linkState.kind === "error" ? (
                <p className="zsetup-code-note" role="status">{linkState.note}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      <section className={`zsetup-section zsetup-card zsetup-nav${openCard === "nav" ? " is-open" : ""}`}>
        <button
          type="button"
          className="zsetup-card-head"
          aria-expanded={openCard === "nav"}
          onClick={() => toggleCard("nav")}
        >
          <span>
            <em className="zsetup-card-tag">02 · NAVI</em>
            <b>ナビの目的地</b>
            <small>車の「目的地設定」に並ぶ行き先を登録します</small>
          </span>
          <i aria-hidden="true" />
        </button>
        {openCard === "nav" ? (
          <div className="zsetup-card-body">
        <div className="zsetup-dest-edit">
        <div className="zsetup-playlists">
          {draft.mapDestinations.map((entry, index) => (
            <div className="zsetup-playlist" key={index}>
              <div className="zsetup-playlist-head">
                <b>{index + 1}</b>
                <input
                  className="zsetup-playlist-label"
                  placeholder="名前（例: ケーズ）"
                  maxLength={MAX_DESTINATION_LABEL}
                  value={entry.label}
                  onChange={(event) =>
                    updateDestination(index, { label: event.target.value })
                  }
                />
              </div>
              <input
                placeholder="住所または検索語（空欄なら未登録）"
                maxLength={MAX_DESTINATION_TEXT}
                value={entry.destination}
                onChange={(event) =>
                  updateDestination(index, { destination: event.target.value })
                }
              />
            </div>
          ))}
        </div>
        <p className="zsetup-sync-note">
          住所でも「ケーズデンキ 東住吉中野店」のような店名でも構いません。
          空欄にした番号は、車のボタンにも出なくなります。
          案内の開始は車の画面から行います（下の「案内開始」）。
        </p>
        </div>
          </div>
        ) : null}
      </section>

      <section className={`zsetup-section zsetup-card${openCard === "theme" ? " is-open" : ""}`}>
        <button
          type="button"
          className="zsetup-card-head"
          aria-expanded={openCard === "theme"}
          onClick={() => toggleCard("theme")}
        >
          <span>
            <em className="zsetup-card-tag">03 · THEME</em>
            <b>メーターテーマ</b>
            <small>フルスクリーン表示の配色</small>
          </span>
          <i aria-hidden="true" />
        </button>
        {openCard === "theme" ? (
          <div className="zsetup-card-body">
        <div className="zsetup-themes">
          {METER_THEMES.map((theme) => {
            const active = draft.meterTheme === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                className={active ? "zsetup-theme is-active" : "zsetup-theme"}
                aria-pressed={active}
                onClick={() => update("meterTheme", theme.id as MeterTheme)}
              >
                <i
                  aria-hidden="true"
                  style={{
                    background: `linear-gradient(135deg, ${theme.swatch[0]}, ${theme.swatch[1]})`,
                  }}
                />
                <span>
                  <b>{theme.name}</b>
                  <small>{theme.caption}</small>
                </span>
                <em>{active ? "選択中" : "選ぶ"}</em>
              </button>
            );
          })}
        </div>
          </div>
        ) : null}
      </section>

      <section className={`zsetup-section zsetup-card${openCard === "fuel" ? " is-open" : ""}`}>
        <button
          type="button"
          className="zsetup-card-head"
          aria-expanded={openCard === "fuel"}
          onClick={() => toggleCard("fuel")}
        >
          <span>
            <em className="zsetup-card-tag">04 · FUEL</em>
            <b>満タン法 燃費記録</b>
            <small>給油のたびに入力すると実燃費が出ます</small>
          </span>
          <i aria-hidden="true" />
        </button>
        {openCard === "fuel" ? (
          <div className="zsetup-card-body">
        <div className="zsetup-fuel-form">
          <label className="zsetup-field">
            <span>給油日</span>
            <input
              type="date"
              value={fuelDraft.date}
              onChange={(event) =>
                setFuelDraft({ ...fuelDraft, date: event.target.value })
              }
            />
          </label>
          <label className="zsetup-field">
            <span>給油量（L）</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={fuelDraft.liters}
              onChange={(event) =>
                setFuelDraft({ ...fuelDraft, liters: event.target.value })
              }
            />
          </label>
          <label className="zsetup-field">
            <span>走行距離（km）</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min="0"
              placeholder="前回の給油からの距離"
              value={fuelDraft.distanceKm}
              onChange={(event) =>
                setFuelDraft({ ...fuelDraft, distanceKm: event.target.value })
              }
            />
          </label>
          <label className="zsetup-field">
            <span>給油金額（円）</span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              placeholder="0"
              value={fuelDraft.amountYen}
              onChange={(event) =>
                setFuelDraft({ ...fuelDraft, amountYen: event.target.value })
              }
            />
          </label>
        </div>
        <p className="zsetup-fuel-preview">
          今回の燃費{" "}
          <b>
            {fuelDraftEconomy === null ? "—" : fuelDraftEconomy.toFixed(1)}
          </b>{" "}
          km/L
        </p>
        <button
          type="button"
          className="zsetup-fuel-save"
          disabled={!fuelDraftIsValid}
          onClick={recordFuel}
        >
          記録する
        </button>
        <p className="zsetup-play-state" role="status">
          {fuelSaved ? "記録しました（車にも共有されます）" : ""}
        </p>
        {recentFuel.length > 0 ? (
          <div className="zsetup-fuel-history">
            <h3>給油履歴</h3>
            <ul>
              {recentFuel.map((entry) => (
                <li key={entry.id}>
                  <b>{entry.date}</b>
                  <span>
                    {(entry.distanceKm / entry.liters).toFixed(1)}
                    <small> km/L</small>
                  </span>
                  <em>
                    {entry.liters.toFixed(2)} L / {Math.round(entry.amountYen)} 円
                  </em>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
          </div>
        ) : null}
      </section>



      {/* YouTube(ミュージック)の設定は非表示。車のホーム画面が、
          登録済みのプレイリストからランダムに流します。 */}

      <section className={`zsetup-section zsetup-card${openCard === "files" ? " is-open" : ""}`}>
        <button
          type="button"
          className="zsetup-card-head"
          aria-expanded={openCard === "files"}
          onClick={() => toggleCard("files")}
        >
          <span>
            <em className="zsetup-card-tag">05 · MEDIA</em>
            <b>音源フォルダ</b>
            <small>車のプレイヤーで鳴らす音楽ファイル</small>
          </span>
          <i aria-hidden="true" />
        </button>
        {openCard === "files" ? (
          <div className="zsetup-card-body">
            {isPaired ? null : (
              <p className="zsetup-notice">
                まだ車とつながっていません。ここに入れた曲は、
                車とつないだときにそのまま車へ渡されます。
              </p>
            )}
              <>
                <label className="zsetup-upload">
                  <input
                    type="file"
                    multiple
                    accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.opus,.flac"
                    onChange={(event) => {
                      void uploadFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <span>音楽ファイルを追加</span>
                </label>
                {isPaired ? (
                  <div className="zsetup-code">
                    <b>パソコンから入れる</b>
                    <p>
                      曲がパソコンにあるなら、そちらから入れた方が速くて楽です。
                      パソコンで {SETTINGS_URL_HINT} を開き、「車と接続」の
                      「コードでつなぐ」にこのコードを打ってください。
                    </p>
                    {linkState.kind === "shown" ? (
                      <div className="zsetup-code-shown" role="status">
                        <strong>{linkState.code}</strong>
                        <small>
                          あと {Math.floor(linkState.left / 60)}分
                          {String(linkState.left % 60).padStart(2, "0")}秒で切れます
                        </small>
                      </div>
                    ) : (
                      <div className="zsetup-code-row">
                        <button
                          type="button"
                          onClick={() => void showLinkCode()}
                          disabled={linkState.kind === "loading"}
                        >
                          {linkState.kind === "loading" ? "作っています…" : "コードを出す"}
                        </button>
                      </div>
                    )}
                    {linkState.kind === "error" ? (
                      <p className="zsetup-code-note" role="status">{linkState.note}</p>
                    ) : null}
                  </div>
                ) : null}
                <p className="zsetup-music-state" role="status">
                  {musicState.kind === "loading"
                    ? "読み込み中…"
                    : musicState.kind === "uploading"
                      ? musicState.note
                      : musicState.kind === "error"
                        ? musicState.note
                        : musicState.note ?? ""}
                </p>
                {/* 車で流す一覧を選ぶ。左端は「すべての曲」。 */}
                <div className="zsetup-lists">
                  <button
                    type="button"
                    className={`zsetup-list${activePlaylistId === "" ? " is-active" : ""}`}
                    onClick={() => {
                      setEditingPlaylistId("");
                      selectActivePlaylist("");
                    }}
                  >
                    <b>すべての曲</b>
                    <small>{tracks.length}曲</small>
                  </button>
                  {musicPlaylists.map((playlist) => (
                    <button
                      key={playlist.id}
                      type="button"
                      className={`zsetup-list${activePlaylistId === playlist.id ? " is-active" : ""}`}
                      onClick={() => {
                        setEditingPlaylistId(playlist.id);
                        selectActivePlaylist(playlist.id);
                      }}
                    >
                      <b>{playlist.name}</b>
                      <small>{playlist.trackIds.length}曲</small>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="zsetup-list zsetup-list-add"
                    onClick={createMusicPlaylist}
                  >
                    <b>＋ 作る</b>
                    <small>プレイリスト</small>
                  </button>
                </div>

                {editingPlaylist ? (
                  <div className="zsetup-list-tools">
                    <span>
                      「{editingPlaylist.name}」に入れる曲を選んでください
                    </span>
                    <div>
                      <button type="button" onClick={() => renameMusicPlaylist(editingPlaylist)}>
                        名前を変える
                      </button>
                      <button type="button" onClick={() => removeMusicPlaylist(editingPlaylist)}>
                        消す
                      </button>
                    </div>
                  </div>
                ) : null}

                <div className="zsetup-tracks">
                  {tracks.length === 0 ? (
                    <p className="zsetup-tracks-empty">
                      まだ1曲も入っていません。
                    </p>
                  ) : (
                    tracks.map((track, index) => {
                      const inList =
                        !!editingPlaylist && editingPlaylist.trackIds.includes(track.id);
                      return (
                        <div
                          className={`zsetup-track${inList ? " is-in-list" : ""}`}
                          key={track.id}
                        >
                          <b>{String(index + 1).padStart(2, "0")}</b>
                          <span>
                            <strong>{track.title}</strong>
                            <small>{(track.size / 1048576).toFixed(1)} MB</small>
                          </span>
                          {editingPlaylist ? (
                            <button
                              type="button"
                              className="zsetup-track-toggle"
                              onClick={() =>
                                toggleTrackInPlaylist(editingPlaylist.id, track.id)
                              }
                              aria-pressed={inList}
                            >
                              {inList ? "入れた" : "入れる"}
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => void removeTrack(track)}
                              aria-label={`${track.title} を消す`}
                            >
                              消す
                            </button>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
                <p className="zsetup-sync-note">
                  合計 {(tracksBytes / 1048576).toFixed(1)} MB / 曲数 {tracks.length}
                  （1曲25MBまで・全体で2GB・500曲まで）。
                  選んだ一覧が、車のメーター右下のプレイヤーに並びます。
                  車の画面で「再生」を押すと鳴ります。
                  {editingPlaylist
                    ? "　曲を消したいときは「すべての曲」に戻してください。"
                    : ""}
                </p>
              </>
          </div>
        ) : null}
      </section>

      {openCard === "theme" || openCard === "nav" ? (
      <div className="zsetup-actions">
        <button type="button" className="zsetup-save" onClick={save}>
          保存する
        </button>
        <p className="zsetup-saved" role="status">
          {syncState === "sending"
            ? "保存しました・車に送信中…"
            : syncState === "done"
              ? "保存しました・車にも反映しました"
              : syncState === "error"
                ? "保存しました（車への送信は失敗）"
                : saved
                  ? "保存しました"
                  : ""}
        </p>
      </div>
      ) : null}

      {scanOpen ? (
        <div className="zsetup-scanner" role="dialog" aria-label="QRの読み取り">
          <video ref={videoRef} playsInline muted />
          <div className="zsetup-scanner-frame" aria-hidden="true" />
          <p>{scanState.note ?? "車の画面のQRを枠に入れてください"}</p>
          <button type="button" onClick={stopScan}>
            やめる
          </button>
        </div>
      ) : null}

      {/* 車載機がまちがってこの画面に来たときの戻り道。スマホには出さない。 */}
      {wideScreen ? (
        <a className="zsetup-car-link" href={`${basePath}/?app=1`}>
          この端末を車として使う（車の画面を開く）
        </a>
      ) : null}

    </main>
  );
}
