// 設定の型・初期値・localStorage の読み書きをまとめた場所。
// ダッシュボード(app/page.tsx)とスマホ用設定ページ(app/settings/page.tsx)の
// 両方から使うので、片方だけ直しても食い違わないようにしている。

export type CarState = "not_departed" | "departed" | "checked_out";

/**
 * メーターの色。ターコイズは昔の名残で "green"、オレンジは "eva" という名前で保存している。
 * 中身(名前や色の作り方)は下の METER_THEMES にまとめてある。
 */
export type MeterTheme =
  | "green"
  | "blue"
  | "violet"
  | "pink"
  | "red"
  | "eva"
  | "classic"
  | "silver";

/**
 * 真ん中のメーターの形。色とは別に選べる。
 * navi は地図の入った今までの形、orbit は大きな地図のまわりに細かい目盛りの回転計。
 * 中身(名前や説明)は下の METER_DESIGNS、ORBIT の絵は app/meter-designs.tsx。
 * (前に足した ARC・SPORT などの形はやめた。保存されていたら navi に戻す)
 */
export type MeterDesign = "navi" | "orbit";

/**
 * テーマ(画面全体の雰囲気)。future は今の近未来のメーター(上の色と形を選べる)、
 * retro は80年代のデジタル、day は昼間に見やすい白いメーター、hud は方位とガソリン残量が大きい光る緑の線。
 * 中身は下の METER_STYLES、絵は app/meter-styles.tsx。
 * (前にあった classic(本物の針のメーター)と bagua(八卦)はやめた。保存されていたら近未来に戻す)
 */
export type MeterStyle = "future" | "retro" | "day" | "hud";

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

/** 前のバージョンの目的地(1〜5の決まった枠)の1件分。引き継ぎにだけ使う。 */
type MapDestination = {
  /** ボタンに出す短い名前(例: ケーズ)。空なら未登録。 */
  label: string;
  /** Googleマップに渡す住所または検索語。空なら押せない。 */
  destination: string;
};

/** 前のバージョンの枠の数。 */
const MAP_DESTINATION_COUNT = 5;
export const MAX_DESTINATION_LABEL = 8;
export const MAX_DESTINATION_TEXT = 200;

const defaultMapDestinations: MapDestination[] = [
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

/** ナビの目的地1件分。出発(店舗)・帰宅のほかに、何件でも登録できる。 */
export type NavPlace = {
  /** 車とスマホで同じ場所を指すための印。 */
  id: string;
  /** 一覧や START に出す短い名前(例: ケーズ)。 */
  label: string;
  /** Googleマップに渡す住所または検索語。 */
  destination: string;
};

/** 登録できる目的地の上限(サーバー側と同じ値)。 */
export const MAX_PLACES = 30;

/** START の行き先が出発・帰宅のときの印。それ以外は目的地の id。 */
export const START_TARGET_WORK = "work";
export const START_TARGET_HOME = "home";

/** 画面で「新しい目的地を足す」ときの印。目的地の id には使えない文字(+)を含める。 */
export const NEW_PLACE_KEY = "+new";

const PLACE_ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** 新しい目的地の id。時刻と乱数で、車とスマホで重ならないようにする。 */
export const createPlaceId = () =>
  `p${Date.now().toString(36)}${Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0")}`;

/**
 * 前のバージョンの1〜5の枠を、目的地の一覧に移す。
 * id は枠の番号から決めるので、車とスマホが別々に移しても同じ一覧になる。
 */
const placesFromSlots = (slots: MapDestination[]): NavPlace[] =>
  slots.flatMap((slot, index) =>
    slot.destination.trim()
      ? [
          {
            id: `slot-${index + 1}`,
            label: slot.label.trim() || `${index + 1}番`,
            destination: slot.destination.trim(),
          },
        ]
      : [],
  );

const sanitizePlaces = (value: unknown[]): NavPlace[] => {
  const cleaned: NavPlace[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, destination } = entry as Partial<NavPlace>;
    if (typeof id !== "string" || !PLACE_ID_PATTERN.test(id) || seen.has(id)) continue;
    const target = (typeof destination === "string" ? destination : "")
      .trim()
      .slice(0, MAX_DESTINATION_TEXT);
    if (!target) continue;
    seen.add(id);
    cleaned.push({
      id,
      label: (typeof label === "string" ? label : "").trim().slice(0, MAX_DESTINATION_LABEL),
      destination: target,
    });
    if (cleaned.length >= MAX_PLACES) break;
  }
  return cleaned;
};

/**
 * 保存されている目的地を読む。places があればそれを、無ければ
 * 前のバージョンの1〜5の枠(mapDestinations)から移す。
 */
const readPlaces = (value: { places?: unknown; mapDestinations?: unknown }) =>
  Array.isArray(value.places)
    ? sanitizePlaces(value.places)
    : placesFromSlots(sanitizeMapDestinations(value.mapDestinations));

/** 一覧に出す名前。名前が空なら住所の頭を使う。 */
export const placeLabel = (place: NavPlace) =>
  place.label.trim() || place.destination.trim().slice(0, MAX_DESTINATION_LABEL);

/** START で選べる行き先1件分(出発・帰宅・目的地)。 */
export type NavChoice = {
  /** work / home / 目的地の id。START の行き先(startTarget)にそのまま入る。 */
  key: string;
  label: string;
  /** 出発・帰宅の説明。目的地は空。 */
  note: string;
  destination: string;
  /** 出発・帰宅は決まった枠なので、名前を変えたり消したりはできない。 */
  fixed: boolean;
};

/**
 * 出発・帰宅と目的地を、車とスマホで同じ並びにする(住所が空のものも含む)。
 * 出発・帰宅が未入力なら、前のバージョンで代わりに使っていた1番・2番の住所を使う。
 */
export const listNavChoices = (
  settings: Pick<Settings, "storeDest" | "storeName" | "homeDest" | "places">,
): NavChoice[] => {
  const formerSlot = (slot: number) =>
    settings.places.find((place) => place.id === `slot-${slot}`)?.destination ?? "";
  return [
    {
      key: START_TARGET_WORK,
      label: "DEPART",
      note: "出発(店舗)",
      destination: settings.storeDest.trim() || settings.storeName.trim() || formerSlot(1),
      fixed: true,
    },
    {
      key: START_TARGET_HOME,
      label: "RETURN",
      note: "帰宅",
      destination: settings.homeDest.trim() || formerSlot(2),
      fixed: true,
    },
    ...settings.places.map((place) => ({
      key: place.id,
      label: placeLabel(place),
      note: "",
      destination: place.destination,
      fixed: false,
    })),
  ];
};

/** いま START で案内する行き先(★)。★の場所が無くなっていたら、住所のある最初のもの。 */
export const resolveStartTarget = (choices: NavChoice[], startTarget: string) => {
  const usable = choices.filter((choice) => choice.destination);
  return usable.find((choice) => choice.key === startTarget) ?? usable[0] ?? null;
};

/**
 * 行き先を1件保存する。key が work / home なら出発・帰宅の住所、目的地の id ならその場所、
 * null なら新しい目的地として足す。住所を空にすると、目的地は消え、出発・帰宅は未入力に戻る。
 * 消した場所が★だったときは、★を出発に戻す。
 */
export const saveNavChoice = (
  settings: Settings,
  key: string | null,
  draft: { label: string; destination: string },
): Settings => {
  const destination = draft.destination.trim().slice(0, MAX_DESTINATION_TEXT);
  const label = draft.label.trim().slice(0, MAX_DESTINATION_LABEL);
  if (key === START_TARGET_WORK) return { ...settings, storeDest: destination };
  if (key === START_TARGET_HOME) return { ...settings, homeDest: destination };
  // 出発・帰宅が未入力で、前のバージョンの1番・2番の住所を代わりに使っていた場合は、
  // その場所を直したり消したりする前に、いまの住所を出発・帰宅に写しておく
  // (一覧の「自宅」を消したら帰宅まで消えた、とならないように)。
  const [work, home] = listNavChoices(settings);
  let current = settings;
  if (key === "slot-1" && !settings.storeDest.trim() && !settings.storeName.trim()) {
    current = { ...current, storeDest: work.destination };
  }
  if (key === "slot-2" && !settings.homeDest.trim()) {
    current = { ...current, homeDest: home.destination };
  }
  if (key === null) {
    if (!destination || current.places.length >= MAX_PLACES) return current;
    return {
      ...current,
      places: [...current.places, { id: createPlaceId(), label, destination }],
    };
  }
  if (!destination) {
    return {
      ...current,
      places: current.places.filter((place) => place.id !== key),
      startTarget: current.startTarget === key ? START_TARGET_WORK : current.startTarget,
    };
  }
  return {
    ...current,
    places: current.places.map((place) =>
      place.id === key ? { ...place, label, destination } : place,
    ),
  };
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
  /** 真ん中のメーターの形。 */
  meterDesign: MeterDesign;
  /** テーマ(画面全体の雰囲気)。色と形は、近未来のテーマのときに使う。 */
  meterStyle: MeterStyle;
  /** 設定同期の合言葉。空なら同期しない。端末内だけに保存し、送信内容には含めない。 */
  syncKey: string;
  /** 車とつないだ時刻(0なら未接続)。端末ごとの値なので同期しない。 */
  pairedAt: number;
  /**
   * iPhone の「ショートカット」から目的地を送るための鍵(目的地を足すことしかできない)。
   * この端末だけに保存し、同期しない。車とつなぎ直したら作り直す。
   */
  shareToken: string;
  /** 最後に同期できた内容の時刻(ミリ秒)。これより新しいものが来たら取り込む。 */
  syncedAt: number;
  /** ナビの目的地(出発・帰宅のほか)。車とスマホのどちらからでも足せる。 */
  places: NavPlace[];
  /** 車の START で案内する行き先。work(出発) / home(帰宅) / 目的地の id。 */
  startTarget: string;
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
  meterDesign: "navi",
  meterStyle: "future",
  syncKey: "",
  pairedAt: 0,
  shareToken: "",
  syncedAt: 0,
  places: placesFromSlots(defaultMapDestinations),
  startTarget: START_TARGET_WORK,
  fuelEntries: [],
};

/** サーバーと共有する項目。走行状態やAPIキーは端末ごとなので送らない。 */
export const SYNCED_FIELDS = [
  "meterTheme",
  "meterDesign",
  "meterStyle",
  "storeName",
  "storeDest",
  "start",
  "homeDest",
  "carId",
  "places",
  "startTarget",
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
    if (field === "places" || field === "fuelEntries") continue;
    const entry = value[field];
    if (typeof entry === "string") cleaned[field] = entry as never;
  }
  if (isMeterTheme(cleaned.meterTheme)) {
    cleaned.meterTheme = cleaned.meterTheme;
  } else {
    delete cleaned.meterTheme;
  }
  if (!isMeterDesign(cleaned.meterDesign)) delete cleaned.meterDesign;
  if (!isMeterStyle(cleaned.meterStyle)) delete cleaned.meterStyle;
  // サーバーにまだ一覧が無ければ、前のバージョンの1〜5の枠から移す。
  const legacy = value as { places?: unknown; mapDestinations?: unknown };
  if (Array.isArray(legacy.places) || Array.isArray(legacy.mapDestinations)) {
    cleaned.places = readPlaces(legacy);
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
  "meterDesign",
  "meterStyle",
  "storeName",
  "storeDest",
  "homeDest",
  "places",
  "startTarget",
] as const;
export type SharedEditField = (typeof SHARED_EDIT_FIELDS)[number];

/**
 * 目的地の一覧は1項目なので、送る前に最新の一覧を取り直し、自分で変えた分
 * (足した・直した・消した場所)だけをその上に重ねる。もう片方で足した場所を
 * 消さないため。before は「前回サーバーと一致していた一覧」。
 */
export const mergeChangedPlaces = (
  mine: NavPlace[],
  before: NavPlace[] | null,
  latest: NavPlace[] | undefined,
): NavPlace[] => {
  if (!before || !latest) return mine;
  const same = (left: NavPlace, right: NavPlace) =>
    left.label === right.label && left.destination === right.destination;
  const beforeById = new Map(before.map((place) => [place.id, place]));
  const mineById = new Map(mine.map((place) => [place.id, place]));
  const merged: NavPlace[] = [];
  for (const place of latest) {
    const was = beforeById.get(place.id);
    const now = mineById.get(place.id);
    // 自分で消した場所は外し、自分で直した場所は自分の内容にする。
    if (was && !now) continue;
    merged.push(was && now && !same(was, now) ? now : place);
  }
  // 自分で足した場所を後ろに足す。
  const known = new Set(merged.map((place) => place.id));
  for (const place of mine) {
    if (!beforeById.has(place.id) && !known.has(place.id)) merged.push(place);
  }
  return merged.slice(0, MAX_PLACES);
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

export type MeterThemeInfo = {
  id: MeterTheme;
  name: string;
  /** スマホの色選びに出す説明。 */
  caption: string;
  /** 車の色選びに出す説明(英語)。 */
  captionEn: string;
  /** 上のバーに出す短い名前。 */
  shortJa: string;
  shortEn: string;
  /**
   * true は、ターコイズと同じ盤面に色をかけて作る色。色の値は globals.css の
   * .zt-<id> にまとめてあり、画面には meter-tinted と zt-<id> のクラスを付ける。
   * ターコイズとオレンジは、それぞれ専用の書き方で作ってある。
   */
  tinted: boolean;
};

/** 色選びに並べる順(色相の順に一周し、最後に色の無いシルバー)。 */
export const METER_THEMES: MeterThemeInfo[] = [
  {
    id: "green",
    name: "TURQUOISE BLUE",
    caption: "ターコイズ・コックピット",
    captionEn: "TURQUOISE COCKPIT THEME",
    shortJa: "ターコイズ",
    shortEn: "TURQUOISE",
    tinted: false,
  },
  {
    id: "blue",
    name: "COBALT BLUE",
    caption: "ミッドナイト・コックピット",
    captionEn: "MIDNIGHT COCKPIT",
    shortJa: "ブルー",
    shortEn: "BLUE",
    tinted: true,
  },
  {
    id: "violet",
    name: "ULTRA VIOLET",
    caption: "ネオン・コックピット",
    captionEn: "NEON COCKPIT",
    shortJa: "バイオレット",
    shortEn: "VIOLET",
    tinted: true,
  },
  {
    id: "pink",
    name: "NEON PINK",
    caption: "ナイトクルーズ・コックピット",
    captionEn: "NIGHT CRUISE COCKPIT",
    shortJa: "ピンク",
    shortEn: "PINK",
    tinted: true,
  },
  {
    id: "red",
    name: "CRIMSON RED",
    caption: "スポーツ・コックピット",
    captionEn: "SPORTS COCKPIT",
    shortJa: "レッド",
    shortEn: "RED",
    tinted: true,
  },
  {
    id: "eva",
    name: "PATTERN ORANGE",
    caption: "コマンドルーム・コックピット",
    captionEn: "COMMAND ROOM COCKPIT",
    shortJa: "オレンジ",
    shortEn: "ORANGE",
    tinted: false,
  },
  {
    id: "classic",
    name: "CLASSIC GREEN",
    caption: "オリジナル・コックピット",
    captionEn: "ORIGINAL COCKPIT",
    shortJa: "グリーン",
    shortEn: "GREEN",
    tinted: true,
  },
  {
    id: "silver",
    name: "ICE SILVER",
    caption: "ステルス・コックピット",
    captionEn: "STEALTH COCKPIT",
    shortJa: "シルバー",
    shortEn: "SILVER",
    tinted: true,
  },
];

/** 色の説明を引く。知らない名前ならターコイズ。 */
export const meterThemeInfo = (id: string): MeterThemeInfo =>
  METER_THEMES.find((theme) => theme.id === id) ?? METER_THEMES[0];

const isMeterTheme = (value: unknown): value is MeterTheme =>
  METER_THEMES.some((theme) => theme.id === value);

export type MeterDesignInfo = {
  id: MeterDesign;
  name: string;
  /** スマホの形選びに出す説明。 */
  caption: string;
  /** 車の形選びに出す説明(英語)。 */
  captionEn: string;
};

/** 形選びに並べる順。最初は地図の入った今の形。 */
export const METER_DESIGNS: MeterDesignInfo[] = [
  { id: "navi", name: "NAVI GAUGE", caption: "地図つき(今までの形)", captionEn: "MAP + TACHOMETER" },
  { id: "orbit", name: "ORBIT NAVI", caption: "大きな地図と回転計", captionEn: "MAP + DENSE TACHO" },
];

/** 形の説明を引く。知らない名前なら今の形(NAVI)。 */
export const meterDesignInfo = (id: string): MeterDesignInfo =>
  METER_DESIGNS.find((design) => design.id === id) ?? METER_DESIGNS[0];

const isMeterDesign = (value: unknown): value is MeterDesign =>
  METER_DESIGNS.some((design) => design.id === value);

export type MeterStyleInfo = {
  id: MeterStyle;
  name: string;
  /** スマホのテーマ選びに出す説明。 */
  caption: string;
  /** 車のテーマ選びに出す説明(英語)。 */
  captionEn: string;
  /** 上のバーに出す短い名前。 */
  shortJa: string;
  shortEn: string;
};

/** テーマ選びに並べる順。最初は今の近未来のメーター。 */
export const METER_STYLES: MeterStyleInfo[] = [
  { id: "future", name: "FUTURE", caption: "近未来(色と形を選べる)", captionEn: "NEON COCKPIT", shortJa: "近未来", shortEn: "FUTURE" },
  { id: "retro", name: "DIGITAL 80s", caption: "80年代のデジタル", captionEn: "RETRO DIGITAL DASH", shortJa: "80年代", shortEn: "80s" },
  { id: "day", name: "DAYLIGHT", caption: "昼間に見やすい白いメーター", captionEn: "WHITE DAY GAUGES", shortJa: "デイライト", shortEn: "DAYLIGHT" },
  { id: "hud", name: "NIGHT HUD", caption: "方位とガソリン残量が大きい光る線", captionEn: "HEADING & FUEL HUD", shortJa: "ナイトHUD", shortEn: "HUD" },
];

/** テーマの説明を引く。知らない名前なら近未来。 */
export const meterStyleInfo = (id: string): MeterStyleInfo =>
  METER_STYLES.find((style) => style.id === id) ?? METER_STYLES[0];

const isMeterStyle = (value: unknown): value is MeterStyle =>
  METER_STYLES.some((style) => style.id === value);

/** 前のバージョンが保存していた、もう使わない項目(目的地の枠は places に移してから消す)。 */
const OBSOLETE_SETTINGS_FIELDS = ["playlists", "nowPlaying", "mapDestinations"];

/** 保存済みの設定を読む。壊れていたり廃止した値だった場合は初期値に寄せる。 */
export const readSettings = (): Settings => {
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}",
    ) as Partial<Settings> & Record<string, unknown>;
    // 目的地は、前のバージョンの1〜5の枠(mapDestinations)からも移す。
    const places = readPlaces(stored);
    // やめた機能(YouTube・音楽の再生指示)と、移し終えた古い目的地は持ち越さない。
    for (const field of OBSOLETE_SETTINGS_FIELDS) delete stored[field];
    return {
      ...defaults,
      ...stored,
      carId:
        !stored.carId || stored.carId === "CAR-01" ? defaults.carId : stored.carId,
      // 知らない色(前に廃止した AURORA VIOLET など)が保存されていたら初期値に戻す。
      meterTheme: isMeterTheme(stored.meterTheme)
        ? stored.meterTheme
        : defaults.meterTheme,
      meterDesign: isMeterDesign(stored.meterDesign)
        ? stored.meterDesign
        : defaults.meterDesign,
      meterStyle: isMeterStyle(stored.meterStyle) ? stored.meterStyle : defaults.meterStyle,
      syncKey: typeof stored.syncKey === "string" ? stored.syncKey : "",
      pairedAt: typeof stored.pairedAt === "number" ? stored.pairedAt : 0,
      shareToken: typeof stored.shareToken === "string" ? stored.shareToken : "",
      syncedAt: Number.isFinite(stored.syncedAt) ? Number(stored.syncedAt) : 0,
      places,
      startTarget:
        typeof stored.startTarget === "string" && stored.startTarget
          ? stored.startTarget
          : START_TARGET_WORK,
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
 * されることがあった。長辺なら削られないので、車載機(1024px)とスマホを分けられる。
 * ただし iPhone 17 Pro Max は長辺が956pxあるので、iPhone は大きさに関係なく
 * スマホとして扱う(判定する所ではどこも iPhone かどうかも見る)。
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
