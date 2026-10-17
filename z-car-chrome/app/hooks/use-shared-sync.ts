"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  fetchSharedSettings,
  mergeChangedPlaces,
  mergeFuelEntries,
  MIN_SYNC_KEY_LENGTH,
  pushFuelEntries,
  pushSyncedFields,
  sanitizeSyncedSettings,
  SHARED_EDIT_FIELDS,
  type FuelEntry,
  type NavPlace,
  type Settings,
  type SyncedSettings,
} from "../settings-store";

/** off は合言葉が無い(まだつないでいない)状態。 */
export type SharedSyncState = "off" | "syncing" | "ok" | "error";

/**
 * 読めなかったときは、これだけ待って1回だけ読み直す(開いた直後などは、すぐつながらないことがある)。
 * それでも読めなければ、いつもの間隔に任せる。
 */
const PULL_RETRY_MS = 5_000;
/** 送れなかったときは、これだけ待って送り直す。 */
const PUSH_RETRY_MS = 10_000;

type Options = {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  /** 端末の保存内容を読み終えたか。読む前は何もしない。 */
  ready: boolean;
  /** サーバーを読みに行く間隔(ミリ秒)。 */
  pollMs: number;
  /**
   * 開いた直後(まだサーバーと照合していないとき)に、手元とサーバーで
   * 違う項目があったら手元を正とするか。false ならサーバーの内容を取り込む。
   */
  keepLocalOnFirstSync: (serverUpdatedAt: number, local: Settings) => boolean;
  /** 手元とサーバーがそろったときに呼ぶ。 */
  onInSync?: () => void;
};

/** 給油記録の並び(id の順)が同じかどうか。 */
const sameFuelList = (left: FuelEntry[], right: FuelEntry[]) =>
  left.length === right.length &&
  left.every((entry, index) => entry.id === right[index]?.id);

/**
 * 車とスマホで、給油記録・目的地・メーターの色を共有する。
 *
 * - 給油記録は足し合わせる(消す操作が無いので、どちらで入れても消えない)
 * - それ以外は項目ごとに「変えた方」を正とし、変えた項目だけを送る
 * - 目的地の一覧は1項目なので、送る直前に最新を取り直し、自分で変えた場所だけ重ねる
 * - まだ送っていない手元の変更は、サーバーを読んでも上書きしない
 */
export function useSharedSync({
  settings,
  setSettings,
  ready,
  pollMs,
  keepLocalOnFirstSync,
  onInSync,
}: Options) {
  const syncKey = settings.syncKey.trim();
  const enabled = ready && syncKey.length >= MIN_SYNC_KEY_LENGTH;
  const [status, setStatus] = useState<{
    state: "syncing" | "ok" | "error";
    at: number | null;
  }>({ state: "syncing", at: null });
  // サーバーが持っている給油記録の id(どの合言葉で読んだかも覚える)。
  const [serverFuel, setServerFuel] = useState<{
    key: string;
    ids: Set<string>;
  } | null>(null);
  // 項目ごとの「いまサーバーにある値」(JSON)。変えた項目だけを送るのに使う。
  const baseRef = useRef<{ key: string; values: Record<string, string> } | null>(null);
  const [tick, setTick] = useState(0);
  const [pullCount, setPullCount] = useState(0);
  // 送れなかった変更があるか(目的地・色など / 給油記録)。送れたら消す。
  const [unsentShared, setUnsentShared] = useState(false);
  const [unsentFuel, setUnsentFuel] = useState(false);

  // 非同期の処理から最新の値を読めるようにしておく。
  const settingsRef = useRef(settings);
  const callbacksRef = useRef({ keepLocalOnFirstSync, onInSync });
  useEffect(() => {
    settingsRef.current = settings;
    callbacksRef.current = { keepLocalOnFirstSync, onInSync };
  });

  // 共有する項目だけの中身(送り比べに使う)。
  const sharedJson = JSON.stringify(
    Object.fromEntries(SHARED_EDIT_FIELDS.map((field) => [field, settings[field]])),
  );
  const fuelEntries = settings.fuelEntries;

  /** すぐに読み直す(画面に戻ってきたときなど)。 */
  const refresh = useCallback(() => setPullCount((count) => count + 1), []);

  // サーバーを読み、給油記録は足し合わせ、ほかの項目は変わっていれば取り込む。
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let failures = 0;
    let retry = 0;
    const pull = async () => {
      try {
        const result = await fetchSharedSettings(syncKey);
        if (!active) return;
        if (!result.ok) throw new Error("SHARED_SYNC_FAILED");
        const shared = sanitizeSyncedSettings(result.settings);
        const serverEntries = shared.fuelEntries ?? [];
        const updatedAt = result.updatedAt ?? 0;
        const local = settingsRef.current;
        const base =
          baseRef.current && baseRef.current.key === syncKey
            ? baseRef.current.values
            : null;
        const keepLocalFirst = base
          ? false
          : callbacksRef.current.keepLocalOnFirstSync(updatedAt, local);

        const take: Partial<Settings> = {};
        const nextBase: Record<string, string> = {};
        for (const field of SHARED_EDIT_FIELDS) {
          const remote = shared[field];
          const remoteJson = remote === undefined ? "" : JSON.stringify(remote);
          const localJson = JSON.stringify(local[field]);
          if (remote === undefined || remoteJson === localJson) {
            nextBase[field] = remoteJson;
            continue;
          }
          // 手元で変えたばかり(まだ送っていない)項目は手元のまま。そうでなければ取り込む。
          const changedHere = base ? localJson !== base[field] : keepLocalFirst;
          if (changedHere) {
            // 比べる元(前回そろっていた内容)は変えない。送るときに、もう片方の
            // 変更と重ね合わせるため。元が分からない初回は、目的地を空から
            // 足し合わせる(どちらで足した場所も消さない)。
            nextBase[field] = base ? base[field] : field === "places" ? "[]" : remoteJson;
          } else {
            Object.assign(take, { [field]: remote });
            nextBase[field] = remoteJson;
          }
        }
        baseRef.current = { key: syncKey, values: nextBase };

        setServerFuel({ key: syncKey, ids: new Set(serverEntries.map((entry) => entry.id)) });
        setSettings((current) => {
          const merged = mergeFuelEntries(current.fuelEntries, serverEntries);
          const fuelChanged = !sameFuelList(merged, current.fuelEntries);
          // 読んでいる間に手元で変えた項目は、取り込まない。
          const apply = Object.fromEntries(
            Object.entries(take).filter(
              ([field]) =>
                JSON.stringify(current[field as keyof Settings]) ===
                JSON.stringify(local[field as keyof Settings]),
            ),
          ) as Partial<Settings>;
          const nextSyncedAt = Math.max(current.syncedAt, updatedAt);
          if (
            !fuelChanged &&
            Object.keys(apply).length === 0 &&
            nextSyncedAt === current.syncedAt
          ) {
            return current;
          }
          return {
            ...current,
            ...apply,
            fuelEntries: fuelChanged ? merged : current.fuelEntries,
            syncedAt: nextSyncedAt,
          };
        });
        failures = 0;
        setTick((count) => count + 1);
        setStatus({ state: "ok", at: Date.now() });
      } catch {
        if (!active) return;
        setStatus((now) => ({ state: "error", at: now.at }));
        // 1回目の失敗だけ、少しして読み直す。続けて読めなければ、いつもの間隔に任せる(圏外など)。
        failures += 1;
        if (failures === 1) retry = window.setTimeout(() => void pull(), PULL_RETRY_MS);
      }
    };
    void pull();
    const timer = window.setInterval(pull, pollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.clearTimeout(retry);
    };
  }, [enabled, syncKey, pollMs, pullCount, setSettings]);

  // 画面に戻ってきたら、すぐ読み直す(スマホで変えた直後に車を見たときなど)。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  // 手元で変えた項目(目的地・色)を送る。
  useEffect(() => {
    if (!enabled) return;
    const base = baseRef.current;
    if (!base || base.key !== syncKey) return;
    const local = JSON.parse(sharedJson) as Partial<SyncedSettings>;
    const changed = Object.fromEntries(
      SHARED_EDIT_FIELDS.filter(
        (field) => JSON.stringify(local[field]) !== base.values[field],
      ).map((field) => [field, local[field]]),
    ) as Partial<SyncedSettings>;
    if (Object.keys(changed).length === 0) {
      callbacksRef.current.onInSync?.();
      // 送るものが無くなった(ほかの端末と同じになった)ら、送れていない印も消す。
      const clear = window.setTimeout(() => setUnsentShared(false), 0);
      return () => window.clearTimeout(clear);
    }
    const timer = window.setTimeout(async () => {
      setStatus((now) => ({ ...now, state: "syncing" }));
      let fields = changed;
      // 目的地は、もう片方で足した・直した場所を消さないよう、最新に自分の変更だけ重ねる。
      if (changed.places) {
        try {
          const latest = await fetchSharedSettings(syncKey);
          const before = base.values.places
            ? (JSON.parse(base.values.places) as NavPlace[])
            : null;
          const merged = mergeChangedPlaces(
            changed.places,
            before,
            sanitizeSyncedSettings(latest.settings).places,
          );
          fields = { ...changed, places: merged };
          if (JSON.stringify(merged) !== JSON.stringify(changed.places)) {
            setSettings((now) => ({ ...now, places: merged }));
          }
        } catch {
          // 読めなければ、そのまま送る。
        }
      }
      void pushSyncedFields(syncKey, fields)
        .then((result) => {
          if (!result.ok) throw new Error("SHARED_PUSH_FAILED");
          const current = baseRef.current;
          if (current && current.key === syncKey) {
            for (const [field, value] of Object.entries(fields)) {
              current.values[field] = JSON.stringify(value);
            }
          }
          callbacksRef.current.onInSync?.();
          const updatedAt = result.updatedAt ?? 0;
          setSettings((now) =>
            updatedAt > now.syncedAt ? { ...now, syncedAt: updatedAt } : now,
          );
          setUnsentShared(false);
          setStatus({ state: "ok", at: Date.now() });
          setTick((count) => count + 1);
        })
        .catch(() => {
          setUnsentShared(true);
          setStatus((now) => ({ state: "error", at: now.at }));
          // 少しして送り直す(届くまで続ける)。
          window.setTimeout(() => setTick((count) => count + 1), PUSH_RETRY_MS);
        });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [enabled, sharedJson, syncKey, tick, setSettings]);

  // 手元にあってサーバーに無い給油記録(この端末で入れた分)があれば送る。
  useEffect(() => {
    if (!enabled || !serverFuel || serverFuel.key !== syncKey) return;
    const known = serverFuel.ids;
    if (fuelEntries.every((entry) => known.has(entry.id))) {
      const clear = window.setTimeout(() => setUnsentFuel(false), 0);
      return () => window.clearTimeout(clear);
    }
    const timer = window.setTimeout(() => {
      setStatus((now) => ({ ...now, state: "syncing" }));
      void pushFuelEntries(syncKey, fuelEntries)
        .then((result) => {
          if (!result.ok) throw new Error("FUEL_PUSH_FAILED");
          setServerFuel({
            key: syncKey,
            ids: new Set([...known, ...fuelEntries.map((entry) => entry.id)]),
          });
          setUnsentFuel(false);
          setStatus({ state: "ok", at: Date.now() });
        })
        .catch(() => {
          setUnsentFuel(true);
          setStatus((now) => ({ state: "error", at: now.at }));
          window.setTimeout(() => setTick((count) => count + 1), PUSH_RETRY_MS);
        });
    }, 800);
    return () => window.clearTimeout(timer);
  }, [enabled, fuelEntries, serverFuel, syncKey, tick]);

  return {
    state: (enabled ? status.state : "off") as SharedSyncState,
    at: enabled ? status.at : null,
    /** 送れなかった変更があるか(電波が戻ると、自動で送り直す)。 */
    unsent: enabled && (unsentShared || unsentFuel),
    refresh,
  };
}
