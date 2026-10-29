"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSharedSync } from "../hooks/use-shared-sync";
import {
  defaults,
  listNavChoices,
  MAX_DESTINATION_LABEL,
  MAX_DESTINATION_TEXT,
  MAX_PLACES,
  mergeFuelEntries,
  METER_DESIGNS,
  meterDesignInfo,
  METER_STYLES,
  meterStyleInfo,
  METER_THEMES,
  meterThemeInfo,
  MIN_SYNC_KEY_LENGTH,
  NEW_PLACE_KEY,
  PHONE_LONG_EDGE_MAX,
  readSettings,
  readSyncKeyFromHash,
  resolveStartTarget,
  saveNavChoice,
  writeSettings,
  type FuelEntry,
  type MeterDesign,
  type MeterStyle,
  type MeterTheme,
  type NavChoice,
  type Settings,
} from "../settings-store";
import { DEFAULT_GMAPS_KEY } from "../google-maps";
import { MeterDesignGauge, SAMPLE_GAUGE_VALUES } from "../meter-designs";
import { MeterStyleThumb, SegNumber } from "../meter-styles";
import {
  isSamePlace,
  issueShareToken,
  readCopiedPlace,
  shareUrlFor,
  type PlaceDraft,
  type PlaceImportError,
} from "../place-import";
import { StarMark } from "../star-mark";
import { CarLocationPanel } from "./car-location";
import { VehiclePanel } from "./vehicle-info";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** 車とのやりとりを取りに行く間隔(画面に戻ってきたときは、すぐ読み直す)。 */
const SYNC_POLL_MS = 30000;

/**
 * これより長く閉じていたら、開いたときに読み込み直す。
 * ホーム画面のアプリは、開き直しても前の画面の続きから動くことがあり、
 * そのままだと新しく公開した版に入れ替わらないため。
 */
const RELOAD_AFTER_HIDDEN_MS = 10 * 60_000;

/** 版の時刻をこれだけ長く押すと、読み込み直す(押すだけでは何もしない。うっかり押さないように)。 */
const RELOAD_HOLD_MS = 700;

/** いま動いている版の時刻(10/14 13:30)。更新ボタンの左に小さく出す。 */
const BUILD_STAMP = (() => {
  const iso = process.env.NEXT_PUBLIC_BUILD_TIME;
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
})();

/** 日本時間での今日 (YYYY-MM-DD)。 */
const todayKey = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());

const emptyFuelDraft = () => ({
  date: todayKey(),
  liters: "",
  distanceKm: "",
  amountYen: "",
});

type Tab = "park" | "navi" | "fuel" | "vehicle";

/** 並びは使う順。開いたときは車両位置(いちばん左)を出す。メーター設定は「車両」の中。 */
const TABS: { id: Tab; ja: string; en: string }[] = [
  { id: "park", ja: "車両位置", en: "PARK" },
  { id: "navi", ja: "目的地", en: "NAVI" },
  { id: "fuel", ja: "給油", en: "FUEL" },
  { id: "vehicle", ja: "車両", en: "VEHICLE" },
];

/** 接続まわりの案内。英語を大きく、日本語は小さく添える。 */
type Note = { en: string; ja: string; warn?: boolean };

const SCAN_NOTES = {
  starting: { en: "STARTING CAMERA", ja: "カメラを準備しています" },
  aim: { en: "ALIGN THE QR CODE", ja: "車の画面のQRを枠に入れてください" },
  blocked: { en: "CAMERA BLOCKED", ja: "設定でカメラを許可してください", warn: true },
  foreign: { en: "NOT A Z CAR CODE", ja: "車の PHONE SYNC で出るQRを読み取ってください", warn: true },
} satisfies Record<string, Note>;

/** つなぎ方の3ステップ。 */
const LINK_STEPS: Note[] = [
  {
    en: "SHOW THE QR ON THE CAR",
    ja: "車の右の列の DEST を押し、左下の「PHONE LINK」を押します",
  },
  { en: "SCAN THE QR", ja: "このスマホのカメラで読み取ります（QRは10秒で閉じます）" },
  { en: "SYNCED", ja: "給油・目的地・メーターの色がそろいます" },
];

/** QRを読む枠の四隅。 */
const ScanCorners = () => (
  <path className="zr-corners" d="M6 30V6h24M90 6h24v24M114 90v24H90M30 114H6V90" />
);

/** Google マップのコピーを読めなかったときの案内。 */
const PASTE_NOTES: Record<PlaceImportError | "clipboard", string> = {
  clipboard: "貼り付けできませんでした。もう一度押して「ペースト」を選んでください",
  empty: "コピーされていません。Google マップで「共有」→「コピー」を押してください",
  unlinked: "車とつなぐと、Google マップのリンクから読み取れます",
  unreadable: "場所を読み取れませんでした。名前と住所を入れてください",
  network: "読み取れませんでした。電波のよい所でもう一度押してください",
};

/** iPhone の「ショートカット」で「Z CAR に送る」を作る手順。 */
const SHORTCUT_STEPS = [
  "上の「送り先をコピー」を押す",
  "「ショートカット」アプリを開き、右上の「＋」を押す",
  "「アクションを検索」に URL と入れ、「URLの内容を取得」を選ぶ",
  "青い「URL」の文字を押して、コピーした送り先を貼り付ける",
  "「＞」を押して開き、「方法」を「POST」にする",
  "「新規フィールドを追加」→「テキスト」を選び、キーに text、値に「ショートカットの入力」を入れる",
  "「アクションを検索」で「通知を表示」を足し、文の所を「URLの内容」にする",
  "上の名前を「Z CAR に送る」にし、下の i のボタン(詳細)で「共有シートに表示」をオンにする",
];

/** 給油履歴に出す日付(10.10 の形)。 */
const shortDate = (date: string) => date.slice(5).replace("-", ".");

/**
 * スマホ用のページ(/settings/)。
 * 車と共有している「給油記録・目的地・メーターの色」だけを、ここからも変えられる。
 * 変えたものは共通の仕組み(use-shared-sync)で車に届く。
 * 「車両位置」では、車載機が最後に送ってきた場所(停めた場所)を地図で見られる。
 */
export default function PhoneSettingsPage() {
  const [draft, setDraft] = useState<Settings>(defaults);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<Tab>("park");
  const [fuelDraft, setFuelDraft] = useState(emptyFuelDraft);
  // 今月の燃費のカードを押すと開く、給油の記録(履歴)。
  const [logOpen, setLogOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 読み取った瞬間に出す「接続完了」の知らせ。
  const [pairedNotice, setPairedNotice] = useState(false);
  // カメラでQRを読み取る画面。
  const [scanOpen, setScanOpen] = useState(false);
  const [scanNote, setScanNote] = useState<Note | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // 車載機のような大きい画面から来たかどうか。
  const [wideScreen, setWideScreen] = useState(false);
  // 目的地を直しているところ。
  const [editKey, setEditKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState({ label: "", destination: "" });
  // 一覧の右の削除を1回押したところ(もう一度押すと消える。3秒で元に戻る)。
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  // 行を押して開いた、目的地のメニュー(カーナビタイム・Google マップ・直す)。
  const [menuKey, setMenuKey] = useState<string | null>(null);
  // 車両のタブの、メーター設定(テーマ・色・形)を開いているところ。ふだんは閉じておく。
  const [themesOpen, setThemesOpen] = useState(false);
  // Google マップのコピーを読み取っているところ。
  const [pasting, setPasting] = useState(false);
  // 「Google マップから直接送る」(ショートカットの作り方)を開いているところ。
  const [shortcutOpen, setShortcutOpen] = useState(false);
  const [shortcutFailed, setShortcutFailed] = useState(false);

  /** 車のQRを読み取ったときの処理(カメラ・URLのどちらからでも同じ)。 */
  const applyCarKey = useCallback((key: string) => {
    setDraft((current) =>
      current.syncKey.trim() === key && current.pairedAt > 0
        ? current
        : { ...current, syncKey: key, syncedAt: 0, pairedAt: Date.now(), shareToken: "" },
    );
    setPairedNotice(true);
  }, []);

  // 端末に保存してある内容を読む。QRから来たときは、URLの「#」以降に合言葉がある。
  useEffect(() => {
    let stored = readSettings();
    const handedOff = readSyncKeyFromHash(window.location.hash);
    if (handedOff) {
      stored = { ...stored, syncKey: handedOff, syncedAt: 0, pairedAt: Date.now(), shareToken: "" };
      setPairedNotice(true);
      // 合言葉を履歴やアドレスバーに残さない。
      window.history.replaceState(null, "", window.location.pathname);
    }
    setDraft(stored);
    // iPhone は大きい機種(17 Pro Max は縦956px)でもスマホ。車として使う道は出さない。
    setWideScreen(
      !/iPhone|iPod/.test(navigator.userAgent) &&
        Math.max(window.innerWidth, window.innerHeight) >= PHONE_LONG_EDGE_MAX,
    );
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

  // 版の時刻の長押し(読み込み直す)。
  const [reloadPressing, setReloadPressing] = useState(false);
  const reloadTimerRef = useRef(0);
  const startReloadPress = () => {
    window.clearTimeout(reloadTimerRef.current);
    setReloadPressing(true);
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = 0;
      window.location.reload();
    }, RELOAD_HOLD_MS);
  };
  const cancelReloadPress = () => {
    if (!reloadTimerRef.current) return false;
    window.clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = 0;
    setReloadPressing(false);
    return true;
  };
  /** 指を離した: 長押しの前なら、やめて使い方を知らせる。 */
  const endReloadPress = () => {
    if (cancelReloadPress()) setToast("長押しで読み込み直します");
  };

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

  // しばらく閉じていたら、開いたときに読み込み直して新しい版にする。
  // 給油や目的地を入力している途中・QRを読み取っている間は、消えてしまうので読み込み直さない。
  const busyRef = useRef(false);
  useEffect(() => {
    busyRef.current = Boolean(
      fuelDraft.liters || fuelDraft.distanceKm || fuelDraft.amountYen || editKey || scanOpen,
    );
  });
  useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        hiddenAt = Date.now();
        return;
      }
      const away = hiddenAt ? Date.now() - hiddenAt : 0;
      hiddenAt = 0;
      if (away >= RELOAD_AFTER_HIDDEN_MS && !busyRef.current) window.location.reload();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

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

  // 送れなかった変更があるときだけ知らせる(読むのに失敗しただけなら出さない。車の電源とは関係ない)。
  const syncTrouble = linked && sync.unsent;

  // --- QRの読み取り ---
  const stopScan = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanOpen(false);
  }, []);

  const startScan = async () => {
    setScanNote(SCAN_NOTES.starting);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" } },
        audio: false,
      });
      streamRef.current = stream;
      setScanOpen(true);
      setScanNote(SCAN_NOTES.aim);
    } catch {
      setScanNote(SCAN_NOTES.blocked);
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
            setScanNote(SCAN_NOTES.foreign);
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
  // 今月の燃費のカードに並べる、最近の給油の燃費(左が古く、右が新しい)。
  // 棒の高さは、並べた中のいちばん低い燃費からいちばん高い燃費までの位置で決める。
  const chartFuel = draft.fuelEntries
    .slice(0, 10)
    .reverse()
    .map((entry) => ({ id: entry.id, date: entry.date, economy: entry.distanceKm / entry.liters }));
  const chartLow = Math.min(...chartFuel.map((item) => item.economy));
  const chartHigh = Math.max(...chartFuel.map((item) => item.economy));
  const chartLevel = (economy: number) =>
    chartHigh > chartLow ? 30 + (70 * (economy - chartLow)) / (chartHigh - chartLow) : 70;

  // 給油の記録を月ごとにまとめる(新しい月が上)。月の燃費は 走った距離 ÷ 入れた量。
  const fuelMonths = draft.fuelEntries.reduce<
    { month: string; entries: FuelEntry[]; liters: number; distance: number }[]
  >((months, entry) => {
    const month = entry.date.slice(0, 7);
    const last = months[months.length - 1];
    if (last && last.month === month) {
      last.entries.push(entry);
      last.liters += entry.liters;
      last.distance += entry.distanceKm;
    } else {
      months.push({ month, entries: [entry], liters: entry.liters, distance: entry.distanceKm });
    }
    return months;
  }, []);

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

  // --- 目的地(車の DEST と同じ並び) ---
  const choices = listNavChoices(draft);
  // ★の付いた場所(車の START の行き先)。
  const startChoice = resolveStartTarget(choices, draft.startTarget);
  const sendNote = linked ? "・車に送ります" : "";

  /** 場所を開く(もう一度押すと閉じる)。null は新しい目的地を足すとき。 */
  const openEditor = (choice: NavChoice | null) => {
    const key = choice ? choice.key : NEW_PLACE_KEY;
    if (editKey === key) {
      setEditKey(null);
      return;
    }
    setEditKey(key);
    setEditDraft({
      label: choice && !choice.fixed ? choice.label : "",
      destination: choice ? choice.destination : "",
    });
  };

  /**
   * Google マップで「共有」→「コピー」した場所を読み取り、新しい目的地の欄に入れる。
   * 中身を確かめて「追加する」を押すと、目的地に入って車にも届く。
   */
  const pastePlace = async () => {
    if (pasting) return;
    let copied = "";
    try {
      copied = await navigator.clipboard.readText();
    } catch {
      setToast(PASTE_NOTES.clipboard);
      return;
    }
    setPasting(true);
    const result = await readCopiedPlace(linked ? draft.syncKey.trim() : "", copied);
    setPasting(false);
    if (!result.ok) {
      setToast(PASTE_NOTES[result.error]);
      // 読めなかったときも、手で入れられるように新しい目的地の欄を開く。
      if (result.error === "unreadable") {
        setEditKey(NEW_PLACE_KEY);
        setEditDraft({ label: "", destination: "" });
      }
      return;
    }
    // 同じ行き先がもうあれば足さない(ショートカットから送ったときと同じ)。
    const same = draft.places.find((place) => place.destination === result.draft.destination);
    if (same) {
      setToast(`「${same.label || result.draft.label}」は、もう目的地にあります`);
      return;
    }
    setEditKey(NEW_PLACE_KEY);
    setEditDraft(result.draft);
    setToast("読み取りました。確かめて「追加する」を押してください");
  };

  // ショートカットの作り方を開いたら、送り先の鍵を用意しておく。
  // (iPhone では、押した瞬間にしかコピーできないため。押してから作ると間に合わない)
  const shareKey = linked ? draft.syncKey.trim() : "";
  const shareToken = draft.shareToken;
  useEffect(() => {
    if (!shortcutOpen || !shareKey || shareToken) return;
    let active = true;
    void issueShareToken(shareKey).then((token) => {
      if (!active) return;
      if (token) setDraft((current) => ({ ...current, shareToken: token }));
      else setShortcutFailed(true);
    });
    return () => {
      active = false;
    };
  }, [shortcutOpen, shareKey, shareToken]);

  /** ショートカットに貼る送り先(鍵入り)をコピーする。送り先は画面に出さない。 */
  const copyShareUrl = () => {
    if (!shareToken) return;
    navigator.clipboard
      .writeText(shareUrlFor(shareToken))
      .then(() => setToast("送り先をコピーしました。ショートカットに貼り付けてください"))
      .catch(() => setToast("コピーできませんでした。もう一度押してください"));
  };

  useEffect(() => {
    if (!armedDelete) return;
    const timer = window.setTimeout(() => setArmedDelete(null), 3000);
    return () => window.clearTimeout(timer);
  }, [armedDelete]);

  /**
   * 一覧の右の削除。1回目は「消す」に変えるだけで、もう一度押すと消す(間違えて消さないように)。
   * 出発・帰宅は名前が決まっているので、住所だけを消す(編集の欄の「この住所を消す」と同じ)。
   */
  const deleteChoice = (choice: NavChoice) => {
    if (armedDelete !== choice.key) {
      setArmedDelete(choice.key);
      return;
    }
    setArmedDelete(null);
    if (editKey === choice.key) setEditKey(null);
    setDraft((current) => saveNavChoice(current, choice.key, { label: "", destination: "" }));
    setToast(`「${choice.label}」${choice.fixed ? "の住所" : ""}を消しました${sendNote}`);
  };

  /**
   * 目的地の行を押したとき。住所があれば、下からメニュー(カーナビタイム・Google マップ・直す)を出す。
   * 住所が未登録なら直す欄を開き、直している途中なら閉じる。
   */
  const openChoice = (choice: NavChoice) => {
    if (!choice.destination || editKey === choice.key) {
      openEditor(choice);
      return;
    }
    setMenuKey(choice.key);
  };
  const menuChoice = choices.find((choice) => choice.key === menuKey && choice.destination) ?? null;

  /**
   * iPhone の共有メニューに住所を出す。そこでカーナビタイムを選ぶと、その場所を探して開く
   * (ナビタイムは、目的地を渡して直接開く方法を出していない)。
   * 共有メニューが無い端末や開けなかったときは、住所をコピーする。閉じただけならメニューに戻る。
   */
  const shareToNavi = (choice: NavChoice) => {
    const copy = async () => {
      setMenuKey(null);
      try {
        await navigator.clipboard.writeText(choice.destination);
        setToast("住所をコピーしました。ナビのアプリの検索に貼り付けてください");
      } catch {
        setToast("開けませんでした。もう一度押してください");
      }
    };
    if (typeof navigator.share !== "function") {
      void copy();
      return;
    }
    // Google マップの共有と同じく、住所と場所の URL を渡す(URL しか受け取らないアプリにも出るように)。
    const url = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(choice.destination)}`;
    navigator
      .share({ text: choice.destination, url })
      .then(() => setMenuKey(null))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        void copy();
      });
  };

  /** 直した(足した)場所を保存する。clear のときは、その場所を消す。 */
  const saveEditor = (clear = false) => {
    const key = editKey;
    if (!key) return;
    const adding = key === NEW_PLACE_KEY;
    setDraft((current) =>
      saveNavChoice(
        current,
        adding ? null : key,
        clear ? { label: "", destination: "" } : editDraft,
      ),
    );
    setEditKey(null);
    setToast(`${clear ? "消しました" : adding ? "追加しました" : "保存しました"}${sendNote}`);
  };

  /**
   * 車両位置の「現在地を登録」。いまの場所を目的地の一覧(地点リスト)に足す。車の DEST にも届く。
   * 同じ場所がもうあれば足さない。
   */
  const registerPlace = (place: PlaceDraft) => {
    const same = draft.places.find((item) => isSamePlace(item.destination, place.destination));
    if (same) {
      setToast(`「${same.label || place.label}」は、もう地点リストにあります`);
      return;
    }
    if (draft.places.length >= MAX_PLACES) {
      setToast(`地点リストは${MAX_PLACES}件までです。目的地のタブで要らない場所を消してください`);
      return;
    }
    setDraft((current) => saveNavChoice(current, null, place));
    setToast(`「${place.label}」を登録しました${sendNote}`);
  };

  /** ★を付け替える。★の場所が、車の START の行き先になる。 */
  const starChoice = (choice: NavChoice) => {
    if (!choice.destination || startChoice?.key === choice.key) return;
    setDraft((current) => ({ ...current, startTarget: choice.key }));
    setToast(`START → ${choice.label}${sendNote}`);
  };

  /** 場所を直す・足す欄。 */
  const placeEditor = (choice: NavChoice | null) => (
    <form
      className="zr-editor"
      onSubmit={(event) => {
        event.preventDefault();
        saveEditor();
      }}
    >
      {!choice?.fixed ? (
        <label className="zr-field zr-field-wide">
          <span>名前（{MAX_DESTINATION_LABEL}文字まで）</span>
          <div>
            <input
              type="text"
              value={editDraft.label}
              maxLength={MAX_DESTINATION_LABEL}
              placeholder="例: 鳥"
              onChange={(event) => setEditDraft({ ...editDraft, label: event.target.value })}
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
            onChange={(event) => setEditDraft({ ...editDraft, destination: event.target.value })}
          />
        </div>
      </label>
      <div className="zr-editor-actions">
        <button type="button" className="zr-ghost" onClick={() => setEditKey(null)}>
          やめる
        </button>
        <button type="submit" className="zr-primary" disabled={!editDraft.destination.trim()}>
          {choice ? "保存する" : "追加する"}
        </button>
      </div>
      {choice?.destination ? (
        <button type="button" className="zr-danger" onClick={() => saveEditor(true)}>
          {choice.fixed ? "この住所を消す" : "この目的地を消す"}
        </button>
      ) : null}
    </form>
  );

  // --- テーマ(近未来・80年代・デイライト) ---
  const activeStyle = meterStyleInfo(draft.meterStyle);
  const isFuture = activeStyle.id === "future";
  const chooseStyle = (id: MeterStyle) => {
    if (draft.meterStyle === id) return;
    setDraft((current) => ({ ...current, meterStyle: id }));
    setToast(linked ? "テーマを変えました・車に送ります" : "テーマを変えました");
  };

  // --- メーターの色(近未来のテーマの色。選ぶと近未来のテーマになる) ---
  const activeTheme = meterThemeInfo(draft.meterTheme);
  const chooseTheme = (id: MeterTheme) => {
    if (draft.meterTheme === id && isFuture) return;
    setDraft((current) => ({ ...current, meterTheme: id, meterStyle: "future" }));
    setToast(linked ? "メーターの色を変えました・車に送ります" : "メーターの色を変えました");
  };

  // --- メーターの形(近未来のテーマの形。選ぶと近未来のテーマになる) ---
  const activeDesign = meterDesignInfo(draft.meterDesign);
  const chooseDesign = (id: MeterDesign) => {
    if (draft.meterDesign === id && isFuture) return;
    setDraft((current) => ({ ...current, meterDesign: id, meterStyle: "future" }));
    setToast(linked ? "メーターの形を変えました・車に送ります" : "メーターの形を変えました");
  };
  // 形の見本は、今の色と同じ filter で描く。
  const designThumbClass = `dg-thumb is-${activeTheme.id}${activeTheme.tinted ? ` is-tinted zt-${activeTheme.id}` : ""}`;

  return (
    <main
      className={`zr${activeTheme.tinted ? ` is-tinted zt-${activeTheme.id}` : ""}`}
      data-theme={draft.meterTheme}
      data-style={draft.meterStyle}
      aria-busy={!ready}
    >
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
          <b>LINK ESTABLISHED</b>
          <small>車とつながりました</small>
        </button>
      ) : null}

      <header className="zr-head">
        <div className="zr-brand">
          <b>Z CAR</b>
          <small>TANTO · REMOTE</small>
        </div>
        {/* ホーム画面のアプリにはブラウザの更新ボタンが無いので、今の版の時刻を長押しで読み込み直す
            (公開した版に入れ替わったかも、この時刻で分かる)。押している間は、下の線が伸びる。 */}
        <button
          type="button"
          className={`zr-reload-stamp${reloadPressing ? " is-pressing" : ""}`}
          aria-label={`今の版${BUILD_STAMP ? ` ${BUILD_STAMP}` : ""}。長押しで読み込み直す(新しい版があれば入れ替わる)`}
          onPointerDown={startReloadPress}
          onPointerUp={endReloadPress}
          onPointerLeave={cancelReloadPress}
          onPointerCancel={cancelReloadPress}
          onContextMenu={(event) => event.preventDefault()}
          onClick={(event) => {
            // キーボードで押したとき(長押しできない)は、すぐ読み込み直す。
            if (event.detail === 0) window.location.reload();
          }}
        >
          {BUILD_STAMP ?? "UPDATE"}
        </button>
      </header>

      {syncTrouble ? (
        <p className="zr-alert" role="status">
          <b>NO SIGNAL</b>
          <span>まだ送れていない変更があります。電波が戻ると自動で送ります。</span>
        </p>
      ) : null}

      {/* つなぐ欄は、まだ車とつないでいないときだけ出す。 */}
      {!linked ? (
        <section className="zr-link" aria-label="車とつなぐ">
          <header className="zr-link-bar">
            <span>LINK STATUS</span>
            <em>
              <i aria-hidden="true" />
              NOT PAIRED
            </em>
          </header>
          <div className="zr-link-hero">
            <div className="zr-reticle" aria-hidden="true">
              <svg viewBox="0 0 120 120">
                <ScanCorners />
                <g className="zr-reticle-code">
                  <rect x="26" y="26" width="20" height="20" rx="3" />
                  <rect x="74" y="26" width="20" height="20" rx="3" />
                  <rect x="26" y="74" width="20" height="20" rx="3" />
                  <rect className="is-fill" x="32" y="32" width="8" height="8" rx="1.5" />
                  <rect className="is-fill" x="80" y="32" width="8" height="8" rx="1.5" />
                  <rect className="is-fill" x="32" y="80" width="8" height="8" rx="1.5" />
                  {[
                    [56, 27], [62, 38], [54, 49], [66, 55], [79, 56], [88, 65],
                    [56, 66], [70, 75], [84, 80], [60, 86], [76, 90], [90, 92],
                  ].map(([x, y]) => (
                    <rect key={`${x}-${y}`} className="is-dot" x={x} y={y} width="6" height="6" rx="1" />
                  ))}
                </g>
              </svg>
              <i className="zr-scanline" />
            </div>
            <div className="zr-link-title">
              <b>
                PAIR WITH
                <br />
                YOUR CAR
              </b>
              <small>車とつなぐ</small>
            </div>
          </div>
          <ol className="zr-link-steps">
            {LINK_STEPS.map((step, index) => (
              <li key={step.en}>
                <em>{String(index + 1).padStart(2, "0")}</em>
                <span>
                  <b>{step.en}</b>
                  <small>{step.ja}</small>
                </span>
              </li>
            ))}
          </ol>
          <button type="button" className="zr-primary zr-scan-button" onClick={() => void startScan()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16M7 12h10" />
            </svg>
            SCAN QR CODE
          </button>
          {scanNote && !scanOpen ? (
            <p className={`zr-scan-note${scanNote.warn ? " is-warn" : ""}`} role="status">
              <b>{scanNote.en}</b>
              <small>{scanNote.ja}</small>
            </p>
          ) : null}
        </section>
      ) : null}

      <nav className="zr-tabs" aria-label="切り替え">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`is-${item.id}${tab === item.id ? " is-active" : ""}`}
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
        <div className="zr-fuel">
          {/* 押すと給油の記録(履歴)が開く。 */}
          <section
            className="zr-hero is-pressable"
            role="button"
            tabIndex={0}
            aria-label="今月の燃費。押すと給油の記録を開く"
            onClick={() => setLogOpen(true)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setLogOpen(true);
              }
            }}
          >
            <header>
              <small>THIS MONTH</small>
              <span>今月の平均燃費</span>
              <em className="zr-hero-more">
                LOG {draft.fuelEntries.length}
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="m9 5 7 7-7 7" />
                </svg>
              </em>
            </header>
            <p className="zr-hero-value">
              <strong>
                {monthEconomy === null ? (
                  "—"
                ) : draft.meterStyle === "future" ? (
                  monthEconomy.toFixed(1)
                ) : (
                  // 80年代・デイライトのテーマでは、車と同じ7セグメントの数字(読み上げ用の字も残す)。
                  <>
                    <SegNumber text={monthEconomy.toFixed(1)} h={60} className="zr-seg" />
                    <span className="zr-sr">{monthEconomy.toFixed(1)}</span>
                  </>
                )}
              </strong>
              <em>km/L</em>
            </p>
            {/* 最近の給油ごとの燃費。画面に余った高さはこのグラフが受け持つ。 */}
            {chartFuel.length ? (
              <div className="zr-hero-chart" aria-hidden="true">
                {chartFuel.map((item, index) => {
                  const level = chartLevel(item.economy);
                  return (
                    <span key={item.id} className={index === chartFuel.length - 1 ? "is-latest" : undefined}>
                      <i className="zr-chart-space" style={{ flexGrow: 100 - level }} />
                      <b>{item.economy.toFixed(1)}</b>
                      <i className="zr-chart-bar" style={{ flexGrow: level }} />
                      <small>{shortDate(item.date)}</small>
                    </span>
                  );
                })}
              </div>
            ) : null}
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

          <section className="zr-panel zr-refuel" aria-label="給油を記録">
            <header className="zr-panel-head">
              <span>
                <small>NEW REFUEL</small>
                <b>給油を記録</b>
              </span>
            </header>
            <div className="zr-form">
              <label className="zr-field">
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
              <label className="zr-field">
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
            <div className="zr-record-row">
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
            </div>
          </section>
        </div>
      ) : null}

      {tab === "park" ? (
        linked ? (
          // 合言葉が変わったら、読み直して地図も作り直す。
          <CarLocationPanel
            key={draft.syncKey.trim()}
            syncKey={draft.syncKey.trim()}
            mapsKey={draft.googleRoutesApiKey.trim() || DEFAULT_GMAPS_KEY}
            look={draft.meterStyle}
            vehicle={{
              carId: draft.carId,
              inspectionDue: draft.inspectionDue,
              oilChangedOn: draft.oilChangedOn,
              fuelEntries: draft.fuelEntries,
            }}
            onRegister={registerPlace}
            onOpenList={() => {
              setTab("navi");
              setEditKey(null);
            }}
            onOpenFuel={() => setTab("fuel")}
            onVehicleChange={(dates) => setDraft((current) => ({ ...current, ...dates }))}
          />
        ) : (
          <section className="zr-panel" aria-label="車両位置">
            <header className="zr-panel-head">
              <span>
                <small>CAR LOCATION</small>
                <b>車両位置</b>
              </span>
            </header>
            <p className="zr-note">
              車とつなぐと、車を停めた場所がここに出ます。上の「SCAN QR CODE」から車とつないでください。
            </p>
          </section>
        )
      ) : null}

      {tab === "navi" ? (
        <section className="zr-panel" aria-label="ナビの目的地">
          <header className="zr-panel-head">
            <span>
              <small>DESTINATIONS</small>
              <b>ナビの目的地</b>
            </span>
            <em className="zr-star-legend">
              <StarMark filled />
              START
            </em>
          </header>
          <p className="zr-navi-hint">
            行を押すとメニュー。<b>カーナビタイム</b>や<b>Google マップ</b>で開けます。
          </p>
          <ul className="zr-places">
            {choices.map((choice) => {
              const starred = startChoice?.key === choice.key;
              const editing = editKey === choice.key;
              return (
                <li
                  key={choice.key}
                  className={`${editing ? "is-editing" : ""}${starred ? " is-start" : ""}`.trim() || undefined}
                >
                  <div className="zr-place-row">
                    <button
                      type="button"
                      className="zr-star"
                      aria-pressed={starred}
                      aria-label={`${choice.label} を START の行き先にする`}
                      disabled={!choice.destination}
                      onClick={() => starChoice(choice)}
                    >
                      <StarMark filled={starred} />
                    </button>
                    <button
                      type="button"
                      className="zr-place"
                      aria-haspopup={choice.destination && !editing ? "dialog" : undefined}
                      aria-expanded={editing}
                      onClick={() => openChoice(choice)}
                    >
                      <span className="zr-place-name">
                        <b>{choice.label}</b>
                        {choice.note ? <small>{choice.note}</small> : null}
                        {starred ? <em>START</em> : null}
                      </span>
                      <span className="zr-place-addr">{choice.destination || "未登録"}</span>
                      <i aria-hidden="true" />
                    </button>
                    {choice.destination ? (
                      <button
                        type="button"
                        className={`zr-del${armedDelete === choice.key ? " is-armed" : ""}`}
                        aria-label={
                          armedDelete === choice.key
                            ? `${choice.label} を消す(もう一度押すと消えます)`
                            : `${choice.label} を消す`
                        }
                        onClick={() => deleteChoice(choice)}
                      >
                        {armedDelete === choice.key ? (
                          <b>消す</b>
                        ) : (
                          <svg viewBox="0 0 24 24" aria-hidden="true">
                            <path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13M10 11v6M14 11v6" />
                          </svg>
                        )}
                      </button>
                    ) : (
                      <span className="zr-del-space" aria-hidden="true" />
                    )}
                  </div>
                  {editing ? placeEditor(choice) : null}
                </li>
              );
            })}
            {editKey === NEW_PLACE_KEY ? (
              <li className="is-editing is-new">
                <p className="zr-new-head">
                  <b>NEW PLACE</b>
                  <small>新しい目的地</small>
                </p>
                {placeEditor(null)}
              </li>
            ) : null}
          </ul>
          {draft.places.length < MAX_PLACES && editKey !== NEW_PLACE_KEY ? (
            <div className="zr-add-row">
              <button type="button" className="zr-add" onClick={() => openEditor(null)}>
                <i aria-hidden="true" />
                <b>ADD PLACE</b>
                <small>目的地を追加</small>
              </button>
              {/* Google マップで「共有」→「コピー」した場所を貼り付ける。 */}
              <button
                type="button"
                className="zr-add is-paste"
                aria-busy={pasting}
                onClick={() => void pastePlace()}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
                  <circle cx="12" cy="10" r="2.4" />
                </svg>
                <b>FROM MAPS</b>
                <small>{pasting ? "読み取り中…" : "コピーを貼り付け"}</small>
              </button>
            </div>
          ) : null}
          <p className="zr-note">
            <StarMark filled />
            を付けた場所に、車の START で案内します。
            <button
              type="button"
              className="zr-inline-link"
              onClick={() => {
                setShortcutFailed(false);
                setShortcutOpen(true);
              }}
            >
              Google マップから直接送る ›
            </button>
          </p>
        </section>
      ) : null}

      {/* 車両情報(給油・オイル交換・車検)。車がどこにあっても、いつでも見られる。 */}
      {tab === "vehicle" ? (
        <VehiclePanel
          record={{
            carId: draft.carId,
            inspectionDue: draft.inspectionDue,
            oilChangedOn: draft.oilChangedOn,
            fuelEntries: draft.fuelEntries,
          }}
          look={draft.meterStyle}
          onSave={(dates) => setDraft((current) => ({ ...current, ...dates }))}
          onOpenFuel={() => setTab("fuel")}
        />
      ) : null}

      {/* 車両のタブの下: メーターのテーマ・色・形。ふだんは1行に格納し、押すと開く。 */}
      {tab === "vehicle" ? (
        <section className="zr-themes" aria-label="メーターのテーマと色と形">
          <button
            type="button"
            className="zr-themes-toggle"
            aria-expanded={themesOpen}
            onClick={() => setThemesOpen((open) => !open)}
          >
            <span>
              <small>METER</small>
              <b>メーター設定</b>
            </span>
            <em>{activeStyle.shortJa}</em>
            <i aria-hidden="true" />
          </button>
          {themesOpen ? (
            <>
              {/* テーマ・色・形は小さな見本を並べ、1画面に収める。選んでいる名前は見出しに出す。 */}
              <p className="zr-new-head">
                <b>THEME</b>
                <small>
                  {activeStyle.name} · {activeStyle.caption}
                </small>
              </p>
              <div className="zr-styles">
                {METER_STYLES.map((style) => {
                  const active = activeStyle.id === style.id;
                  return (
                    <button
                      key={style.id}
                      type="button"
                      className={`zr-style${active ? " is-active" : ""}`}
                      aria-pressed={active}
                      aria-label={`${style.name}(${style.caption})`}
                      onClick={() => chooseStyle(style.id)}
                    >
                      <i aria-hidden="true">
                        <MeterStyleThumb style={style.id} />
                      </i>
                      <b>{style.shortJa}</b>
                      <em>{active ? "ACTIVE" : "SELECT"}</em>
                    </button>
                  );
                })}
              </div>
              {/* 色と形は、近未来のテーマのもの(選ぶと近未来のテーマになる)。 */}
              <p className="zr-new-head">
                <b>COLOR</b>
                <small>{activeTheme.name}</small>
              </p>
              <div className="zr-swatches">
                {METER_THEMES.map((theme) => {
                  const active = isFuture && draft.meterTheme === theme.id;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      className={`zr-theme is-${theme.id}${theme.tinted ? ` is-tinted zt-${theme.id}` : ""}${active ? " is-active" : ""}`}
                      aria-pressed={active}
                      aria-label={`${theme.name}(${theme.caption})`}
                      onClick={() => chooseTheme(theme.id)}
                    >
                      <i aria-hidden="true" />
                      <b>{theme.shortEn}</b>
                      <small>{theme.shortJa}</small>
                      <em>{active ? "ACTIVE" : "SELECT"}</em>
                    </button>
                  );
                })}
              </div>
              <p className="zr-new-head">
                <b>DESIGN</b>
                <small>
                  {activeDesign.name} · {activeDesign.caption}
                </small>
              </p>
              <div className="zr-designs">
                {METER_DESIGNS.map((design) => {
                  const active = isFuture && activeDesign.id === design.id;
                  return (
                    <button
                      key={design.id}
                      type="button"
                      className={`zr-design${active ? " is-active" : ""}`}
                      aria-pressed={active}
                      aria-label={`${design.name}(${design.caption})`}
                      onClick={() => chooseDesign(design.id)}
                    >
                      <i className={designThumbClass} aria-hidden="true">
                        <MeterDesignGauge design={design.id} values={SAMPLE_GAUGE_VALUES} />
                      </i>
                      <b>{design.name}</b>
                      <small>{design.caption}</small>
                      <em>{active ? "ACTIVE" : "SELECT"}</em>
                    </button>
                  );
                })}
              </div>
              <p className="zr-note">
                色と形は、近未来のテーマで使います。
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      {/* 目的地のメニュー。行を押すと下から出て、iPhone でナビを開く。 */}
      {menuChoice ? (
        <div className="zr-sheet" role="presentation" onClick={() => setMenuKey(null)}>
          <section
            className="zr-sheet-card"
            role="dialog"
            aria-modal="true"
            aria-label={`${menuChoice.label} のメニュー`}
            onClick={(event) => event.stopPropagation()}
          >
            <header className="zr-sheet-head">
              <span>
                <small>DESTINATION</small>
                <b>{menuChoice.label}</b>
              </span>
              <button type="button" onClick={() => setMenuKey(null)}>
                CLOSE
              </button>
            </header>
            <p className="zr-go-addr">{menuChoice.destination}</p>
            <div className="zr-go-actions">
              <button type="button" className="zr-primary" onClick={() => shareToNavi(menuChoice)}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3.5 11.2 20.5 3.5l-7.7 17-2.3-7-7-2.3Z" />
                </svg>
                カーナビタイムで開く
              </button>
              {/* Google マップは直接開ける(車の START と同じく、すぐ道案内を始める)。 */}
              <a
                className="zr-ghost"
                href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(menuChoice.destination)}&travelmode=driving&dir_action=navigate`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => setMenuKey(null)}
              >
                Google マップで開く
              </a>
              <button
                type="button"
                className="zr-ghost"
                onClick={() => {
                  setMenuKey(null);
                  openEditor(menuChoice);
                }}
              >
                この目的地を直す
              </button>
            </div>
          </section>
        </div>
      ) : null}

      {/* 給油の記録(履歴)。今月の燃費のカードを押すと下から出る。 */}
      {logOpen ? (
        <div className="zr-sheet" role="presentation" onClick={() => setLogOpen(false)}>
          <section
            className="zr-sheet-card"
            role="dialog"
            aria-modal="true"
            aria-label="給油の記録"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="zr-sheet-head">
              <span>
                <small>FUEL LOG</small>
                <b>給油の記録</b>
              </span>
              <em>{draft.fuelEntries.length} TOTAL</em>
              <button type="button" onClick={() => setLogOpen(false)}>
                CLOSE
              </button>
            </header>
            <div className="zr-sheet-body">
              {fuelMonths.length ? (
                fuelMonths.map((group) => (
                  <section key={group.month} className="zr-log-month" aria-label={`${group.month} の給油`}>
                    <h3>
                      <b>{group.month.replace("-", ".")}</b>
                      <small>
                        {group.entries.length}回 · 平均 {(group.distance / group.liters).toFixed(1)} km/L
                      </small>
                    </h3>
                    <ol className="zr-history">
                      {group.entries.map((entry) => (
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
                  </section>
                ))
              ) : (
                <p className="zr-note">まだ記録がありません。給油したら下の欄から記録してください。</p>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {/* Google マップの「共有」から目的地を直接送る、ショートカットの作り方。 */}
      {shortcutOpen ? (
        <div className="zr-sheet" role="presentation" onClick={() => setShortcutOpen(false)}>
          <section
            className="zr-sheet-card"
            role="dialog"
            aria-modal="true"
            aria-label="Google マップから直接送る"
            onClick={(event) => event.stopPropagation()}
          >
            <header className="zr-sheet-head">
              <span>
                <small>SHORTCUT</small>
                <b>Google マップから直接送る</b>
              </span>
              <button type="button" onClick={() => setShortcutOpen(false)}>
                CLOSE
              </button>
            </header>
            <div className="zr-sheet-body">
              {linked ? (
                <>
                  <p className="zr-note zr-share-lead">
                    Google マップの「共有」から、目的地に直接送れるようにします(車にも届きます)。
                    最初に1回だけ、iPhone の「ショートカット」アプリで準備します。
                  </p>
                  <button
                    type="button"
                    className="zr-primary zr-share-copy"
                    disabled={!shareToken}
                    onClick={copyShareUrl}
                  >
                    {shareToken ? "送り先をコピー" : shortcutFailed ? "準備できませんでした" : "準備しています…"}
                  </button>
                  <ol className="zr-steps">
                    {SHORTCUT_STEPS.map((step, index) => (
                      <li key={step}>
                        <em>{index + 1}</em>
                        <span>{step}</span>
                      </li>
                    ))}
                  </ol>
                  <p className="zr-note">
                    <b>使い方</b> Google マップで「共有」→「Z CAR に送る」。追加すると通知が出ます。
                  </p>
                  <p className="zr-note">
                    送り先には専用の鍵が入っています。他の人には教えないでください(この鍵でできるのは、目的地を足すことだけです)。
                  </p>
                </>
              ) : (
                <p className="zr-note zr-share-lead">車とつないでから設定してください。</p>
              )}
            </div>
          </section>
        </div>
      ) : null}

      {toast ? (
        <p className="zr-toast" role="status">
          {toast}
        </p>
      ) : null}

      {scanOpen ? (
        <div className="zr-scanner" role="dialog" aria-label="QRの読み取り">
          <header className="zr-scanner-bar">
            <span>
              <i aria-hidden="true" />
              SCANNING
            </span>
            <small>Z CAR · LINK</small>
          </header>
          <div className="zr-scanner-view">
            <video ref={videoRef} playsInline muted />
            <div className="zr-scanner-frame" aria-hidden="true">
              <svg viewBox="0 0 120 120" preserveAspectRatio="none">
                <ScanCorners />
              </svg>
              <i className="zr-scanline" />
            </div>
          </div>
          <p className={`zr-scanner-hint${scanNote?.warn ? " is-warn" : ""}`}>
            <b>{(scanNote ?? SCAN_NOTES.aim).en}</b>
            <small>{(scanNote ?? SCAN_NOTES.aim).ja}</small>
          </p>
          <button type="button" onClick={stopScan}>
            CANCEL
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
