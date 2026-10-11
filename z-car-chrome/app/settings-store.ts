// 設定の型・初期値・localStorage の読み書きをまとめた場所。
// ダッシュボード(app/page.tsx)とスマホ用設定ページ(app/settings/page.tsx)の
// 両方から使うので、片方だけ直しても食い違わないようにしている。

export type CarState = "not_departed" | "departed" | "checked_out";

export type MeterTheme = "green" | "eva";

/** 満タン法の給油記録1件分。 */
export type FuelEntry = {
  id: string;
  /** 給油日 (YYYY-MM-DD)。 */
  date: string;
  liters: number;
  distanceKm: number;
  amountYen: number;
  createdAt: number;
};

/** 同期に載せる上限。古いものから落とす(通信量とサーバーの制限のため)。 */
export const MAX_FUEL_ENTRIES = 120;

/** 給油記録の保存先(この機能より前のバージョンが使っていたキー)。 */
export const LEGACY_FUEL_LOG_KEY = "zcar-fuel-log-v1";

export const isValidFuelEntry = (entry: unknown): entry is FuelEntry => {
  if (!entry || typeof entry !== "object") return false;
  const { id, date, liters, distanceKm, amountYen } = entry as Partial<FuelEntry>;
  return (
    typeof id === "string" &&
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(liters) &&
    (liters as number) > 0 &&
    Number.isFinite(distanceKm) &&
    (distanceKm as number) >= 0 &&
    Number.isFinite(amountYen) &&
    (amountYen as number) >= 0
  );
};

const sanitizeFuelEntries = (value: unknown): FuelEntry[] => {
  if (!Array.isArray(value)) return [];
  return value.filter(isValidFuelEntry).map((entry) => ({
    id: entry.id,
    date: entry.date,
    liters: entry.liters,
    distanceKm: entry.distanceKm,
    amountYen: entry.amountYen,
    createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : Date.parse(entry.date),
  }));
};

/**
 * 給油記録は消す操作が無いので、両方を足し合わせる(idが同じものは1件)。
 * こうしておけば、車とスマホのどちらで記録しても失われない。
 */
export const mergeFuelEntries = (
  left: FuelEntry[],
  right: FuelEntry[],
): FuelEntry[] => {
  const byId = new Map<string, FuelEntry>();
  // 日付・給油量・距離・金額がすべて同じなら同じ給油とみなす
  // (車とスマホの両方で同じ給油を入れたときに二重にならないように)。
  const seen = new Set<string>();
  for (const entry of [...left, ...right]) {
    if (!isValidFuelEntry(entry)) continue;
    if (byId.has(entry.id)) {
      byId.set(entry.id, entry);
      continue;
    }
    const sameRefuel = `${entry.date}|${entry.liters}|${entry.distanceKm}|${entry.amountYen}`;
    if (seen.has(sameRefuel)) continue;
    seen.add(sameRefuel);
    byId.set(entry.id, entry);
  }
  return [...byId.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt)
    .slice(0, MAX_FUEL_ENTRIES);
};

/** 車のマップ画面に並ぶ 1〜5 のナビ目的地1件分。 */
export type MapDestination = {
  /** ボタンに出す短い名前(例: ケーズ)。空なら未登録。 */
  label: string;
  /** Googleマップに渡す住所または検索語。空なら押せない。 */
  destination: string;
};

/** ボタンはちょうど5つなので、常に5件そろえる。 */
export const MAP_DESTINATION_COUNT = 5;
export const MAX_DESTINATION_LABEL = 8;
export const MAX_DESTINATION_TEXT = 200;

export const defaultMapDestinations: MapDestination[] = [
  { label: "ケーズ", destination: "〒546-0012 大阪府大阪市東住吉区中野1丁目15-9 ケーズデンキ東住吉中野店" },
  { label: "自宅", destination: "〒573-0065 大阪府枚方市出口3丁目1-1" },
  { label: "荻野くん家", destination: "〒545-0031 大阪府大阪市阿倍野区橋本町" },
  { label: "", destination: "" },
  { label: "鳥", destination: "〒534-0024 大阪府大阪市都島区東野田町4丁目6-6" },
];

const sanitizeMapDestinations = (value: unknown): MapDestination[] => {
  // 保存されていない(この機能より前の設定)場合は、これまでの目的地を使う。
  // 配列が入っているときだけ、空欄も「未登録」として尊重する。
  if (!Array.isArray(value)) return defaultMapDestinations;
  const source = value;
  return Array.from({ length: MAP_DESTINATION_COUNT }, (_unused, index) => {
    const entry = source[index];
    if (!entry || typeof entry !== "object") return { label: "", destination: "" };
    const { label, destination } = entry as Partial<MapDestination>;
    return {
      label: (typeof label === "string" ? label : "").slice(0, MAX_DESTINATION_LABEL),
      destination: (typeof destination === "string" ? destination : "").slice(
        0,
        MAX_DESTINATION_TEXT,
      ),
    };
  });
};

export type Settings = {
  storeName: string;
  storeDest: string;
  start: string;
  homeDest: string;
  googleRoutesApiKey: string;
  carId: string;
  state: CarState;
  departedAt: string;
  checkedOutAt: string;
  meterTheme: MeterTheme;
  /** 設定同期の合言葉。空なら同期しない。端末内だけに保存し、送信内容には含めない。 */
  syncKey: string;
  /** 車とつないだ時刻(0なら未接続)。端末ごとの値なので同期しない。 */
  pairedAt: number;
  /** 最後に同期できた内容の時刻(ミリ秒)。これより新しいものが来たら取り込む。 */
  syncedAt: number;
  /** 車のマップ画面の 1〜5 のナビ目的地。 */
  mapDestinations: MapDestination[];
  /** 満タン法の給油記録。車とスマホのどちらで記録しても共有する。 */
  fuelEntries: FuelEntry[];
};

export const defaults: Settings = {
  storeName: "ケーズデンキ 東住吉中野店",
  storeDest: "ケーズデンキ 東住吉中野店",
  start: "10:00",
  homeDest: "",
  googleRoutesApiKey: "",
  carId: "Tanto",
  state: "not_departed",
  departedAt: "",
  checkedOutAt: "",
  meterTheme: "green",
  syncKey: "",
  pairedAt: 0,
  syncedAt: 0,
  mapDestinations: defaultMapDestinations,
  fuelEntries: [],
};

/** サーバーと共有する項目。走行状態やAPIキーは端末ごとなので送らない。 */
export const SYNCED_FIELDS = [
  "meterTheme",
  "storeName",
  "storeDest",
  "start",
  "homeDest",
  "carId",
  "mapDestinations",
  "fuelEntries",
] as const;

export type SyncedSettings = Pick<Settings, (typeof SYNCED_FIELDS)[number]>;

export const SYNC_ENDPOINT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/settings.php`;

/** 合言葉は短すぎると総当たりされるので下限を設ける(PHP側と同じ値)。 */
export const MIN_SYNC_KEY_LENGTH = 8;

/**
 * 合言葉を自動生成する。人が読む必要はないので、紛らわしい文字を除いた
 * 32文字のランダム文字列にする(推測されないだけの長さを確保)。
 */
export const generateSyncKey = () => {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = new Uint32Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
};

/**
 * 合言葉を他の端末へ渡すためのURL。合言葉は「#」より後ろ(フラグメント)に
 * 置く。フラグメントはサーバーへ送信されないので、アクセスログに残らない。
 */
export const buildSyncHandoffUrl = (key: string) =>
  `${window.location.origin}${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/settings/#k=${encodeURIComponent(key)}`;

/** 受け取ったURLのフラグメントから合言葉を取り出す。無ければ null。 */
export const readSyncKeyFromHash = (hash: string) => {
  const match = /(?:^#|&)k=([^&]+)/.exec(hash);
  if (!match) return null;
  try {
    const key = decodeURIComponent(match[1]).trim();
    return key.length >= MIN_SYNC_KEY_LENGTH ? key : null;
  } catch {
    return null;
  }
};

const postSync = async (payload: Record<string, unknown>) => {
  const response = await fetch(SYNC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`sync failed: ${response.status}`);
  return (await response.json()) as {
    ok: boolean;
    settings?: SyncedSettings | null;
    updatedAt?: number;
  };
};

/**
 * サーバーから戻ってきた内容を、そのまま信用せず整えてから取り込む。
 * (壊れた値が1件でも入ると画面が崩れるため)
 */
export const sanitizeSyncedSettings = (
  value: Partial<SyncedSettings> | null | undefined,
): Partial<SyncedSettings> => {
  if (!value || typeof value !== "object") return {};
  const cleaned: Partial<SyncedSettings> = {};
  for (const field of SYNCED_FIELDS) {
    if (field === "mapDestinations" || field === "fuelEntries") continue;
    const entry = value[field];
    if (typeof entry === "string") cleaned[field] = entry as never;
  }
  if (isMeterTheme(cleaned.meterTheme)) {
    cleaned.meterTheme = cleaned.meterTheme;
  } else {
    delete cleaned.meterTheme;
  }
  if (Array.isArray(value.mapDestinations)) {
    cleaned.mapDestinations = sanitizeMapDestinations(value.mapDestinations);
  }
  if (Array.isArray(value.fuelEntries)) {
    cleaned.fuelEntries = sanitizeFuelEntries(value.fuelEntries);
  }
  return cleaned;
};

/** サーバーに置いてある設定を読む。まだ何も無ければ settings は null。 */
export const fetchSharedSettings = async (key: string) =>
  postSync({ key });

/**
 * 車とスマホのどちらからでも変えられる項目(給油記録は別に足し合わせる)。
 * 片方で変えた項目だけを送るので、もう片方の変更を古い値で上書きしない。
 */
export const SHARED_EDIT_FIELDS = [
  "meterTheme",
  "storeName",
  "storeDest",
  "homeDest",
  "mapDestinations",
] as const;
export type SharedEditField = (typeof SHARED_EDIT_FIELDS)[number];

/**
 * 目的地は5枠まとめて1項目なので、送る前に最新の内容を取り直し、
 * 自分で変えた枠だけをその上に重ねる(もう片方で変えた別の枠を消さないため)。
 * before は「前回サーバーと一致していた5枠」。分からなければ自分の内容をそのまま使う。
 */
export const overlayChangedDestinations = (
  mine: MapDestination[],
  before: MapDestination[] | null,
  latest: MapDestination[] | undefined,
): MapDestination[] => {
  if (!before || !latest) return mine;
  return mine.map((slot, index) =>
    JSON.stringify(slot) !== JSON.stringify(before[index]) ? slot : latest[index] ?? slot,
  );
};

/** 指定した項目だけをサーバーへ送る(送らなかった項目はサーバー側でそのまま残る)。 */
export const pushSyncedFields = async (
  key: string,
  fields: Partial<SyncedSettings>,
) =>
  postSync({
    key,
    updatedAt: Date.now(),
    settings: fields,
  });

/**
 * 給油記録だけをサーバーへ送る。
 * サーバーは届いた記録をいまの記録に足し合わせ、ほかの項目はそのまま残す。
 */
export const pushFuelEntries = async (key: string, fuelEntries: FuelEntry[]) =>
  postSync({
    key,
    updatedAt: Date.now(),
    settings: { fuelEntries },
  });

export const SETTINGS_STORAGE_KEY = "zcar";

export const METER_THEMES: {
  id: MeterTheme;
  name: string;
  caption: string;
  swatch: [string, string];
}[] = [
  {
    id: "green",
    name: "TURQUOISE BLUE",
    caption: "ターコイズ・コックピット",
    swatch: ["#0a1c18", "#39ccd4"],
  },
  {
    id: "eva",
    name: "PATTERN ORANGE",
    caption: "コマンドルーム・コックピット",
    swatch: ["#1a1109", "#ff8a2b"],
  },
];

const isMeterTheme = (value: unknown): value is MeterTheme =>
  value === "green" || value === "eva";

/** 前のバージョンが保存していた、もう使わない項目。 */
const OBSOLETE_SETTINGS_FIELDS = ["playlists", "nowPlaying"];

/** 保存済みの設定を読む。壊れていたり廃止した値だった場合は初期値に寄せる。 */
export const readSettings = (): Settings => {
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}",
    ) as Partial<Settings> & Record<string, unknown>;
    // やめた機能(YouTube・音楽の再生指示)の値は持ち越さない。
    for (const field of OBSOLETE_SETTINGS_FIELDS) delete stored[field];
    return {
      ...defaults,
      ...stored,
      carId:
        !stored.carId || stored.carId === "CAR-01" ? defaults.carId : stored.carId,
      // 廃止したテーマ(RED / AURORA VIOLET)が保存されていたら初期値に戻す。
      meterTheme: isMeterTheme(stored.meterTheme)
        ? stored.meterTheme
        : defaults.meterTheme,
      syncKey: typeof stored.syncKey === "string" ? stored.syncKey : "",
      pairedAt: typeof stored.pairedAt === "number" ? stored.pairedAt : 0,
      syncedAt: Number.isFinite(stored.syncedAt) ? Number(stored.syncedAt) : 0,
      mapDestinations: sanitizeMapDestinations(stored.mapDestinations),
      // 古いバージョンは給油記録を別のキーに置いていたので、そこからも拾う。
      fuelEntries: mergeFuelEntries(
        sanitizeFuelEntries(stored.fuelEntries),
        sanitizeFuelEntries(readLegacyFuelEntries()),
      ),
    };
  } catch {
    return defaults;
  }
};

const readLegacyFuelEntries = (): unknown => {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(LEGACY_FUEL_LOG_KEY) || "[]");
  } catch {
    return [];
  }
};

export const writeSettings = (settings: Settings) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // プライベートブラウズなどで保存できない場合は黙って諦める。
  }
};

/**
 * スマホ判定のしきい値(px)。画面の「長い方」の辺がこれ未満ならスマホとみなす。
 *
 * 短い方の辺で判定していたが、車載機のブラウザは上のアドレスバーの分だけ
 * 縦が削られるため、600pxの画面でも短辺が500pxを下回ってスマホと誤判定
 * されることがあった。長辺なら削られないので、車載機(1024px)とスマホ
 * (いちばん大きい iPhone でも932px)を確実に分けられる。
 * この値は layout.tsx の先読みスクリプトでも使う。
 */
export const PHONE_LONG_EDGE_MAX = 940;

/** スマホでダッシュボードを開いたままにする印(そのタブの間だけ)。 */
export const PHONE_SETUP_SKIP_KEY = "zcar-skip-setup";

/**
 * 「この端末は車載機」という印。一度付けば設定ページへ送られなくなる。
 * 画面の大きさに関係なく効くので、車載機の誤判定はこれで止められる。
 * ?app=1 で付き、?app=0 で外れる。
 */
export const CAR_DEVICE_KEY = "zcar-device";
