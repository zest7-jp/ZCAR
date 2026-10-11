// 設定の型・初期値・localStorage の読み書きをまとめた場所。
// ダッシュボード(app/page.tsx)とスマホ用設定ページ(app/settings/page.tsx)の
// 両方から使うので、片方だけ直しても食い違わないようにしている。

export type CarState = "not_departed" | "departed" | "checked_out";

export type MeterTheme = "green" | "eva";

/** ミュージック画面と待機画面に出す YouTube プレイリスト1件分。 */
export type Playlist = {
  /** 画面に出すジャンル名(例: REGGAE)。 */
  label: string;
  /** YouTube のプレイリストID(PL... で始まる文字列)。 */
  playlistId: string;
};

export const MAX_PLAYLISTS = 8;
export const MAX_PLAYLIST_LABEL = 24;

export const defaultPlaylists: Playlist[] = [
  { label: "YOUTUBE", playlistId: "PLMC9KNkIncKtGvr2kFRuXBVmBev6cAJ2u" },
  { label: "ANIME NOW", playlistId: "PLaodxkj-4NkRFKJZwtT3wvmC3rN8qG2n1" },
  { label: "REGGAE", playlistId: "PLjF50Dlp9ieks26oOKahUFiRTj18o6YGt" },
  { label: "EDM", playlistId: "PLPbMT4wSxX89gUYpgYMrmOqsupKMRR5Rj" },
];

/**
 * 貼り付けられた文字列からプレイリストIDを取り出す。
 * YouTube のURL(list=... を含むもの)でも、ID単体でも受け付ける。
 */
export const extractPlaylistId = (input: string) => {
  const value = input.trim();
  const fromUrl = /[?&]list=([A-Za-z0-9_-]+)/.exec(value);
  if (fromUrl) return fromUrl[1];
  return /^[A-Za-z0-9_-]{2,64}$/.test(value) ? value : "";
};

const sanitizePlaylists = (value: unknown): Playlist[] => {
  if (!Array.isArray(value)) return defaultPlaylists;
  const cleaned: Playlist[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { label, playlistId } = entry as Partial<Playlist>;
    const id = typeof playlistId === "string" ? extractPlaylistId(playlistId) : "";
    if (!id) continue;
    cleaned.push({
      label: (typeof label === "string" ? label : "").slice(0, MAX_PLAYLIST_LABEL) || "PLAYLIST",
      playlistId: id,
    });
    if (cleaned.length >= MAX_PLAYLISTS) break;
  }
  // 1件も残らないと画面が空になってしまうので、その場合は既定に戻す。
  return cleaned.length > 0 ? cleaned : defaultPlaylists;
};

/**
 * スマホから車へ「これを再生して」と伝えるための指示。
 * 設定と同じ入れ物で運ぶが、中身は設定ではなく一度きりの指示。
 */
export type PlayCommand = {
  playlistId: string;
  label: string;
  /** 指示を出した時刻(ミリ秒)。古い指示を再生し直さないための目印。 */
  requestedAt: number;
};

/**
 * 指示の有効期限。これより古い指示は無視する。
 * 車のブラウザを開き直したときに、前回の指示で急に音が鳴らないようにするため。
 */
export const PLAY_COMMAND_MAX_AGE_MS = 5 * 60 * 1000;

const sanitizePlayCommand = (value: unknown): PlayCommand | null => {
  if (!value || typeof value !== "object") return null;
  const { playlistId, label, requestedAt } = value as Partial<PlayCommand>;
  const id = typeof playlistId === "string" ? extractPlaylistId(playlistId) : "";
  if (!id || !Number.isFinite(requestedAt)) return null;
  return {
    playlistId: id,
    label: (typeof label === "string" ? label : "").slice(0, MAX_PLAYLIST_LABEL),
    requestedAt: Number(requestedAt),
  };
};

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
  /** ミュージック画面に並べる YouTube プレイリスト。 */
  playlists: Playlist[];
  /** 車のマップ画面の 1〜5 のナビ目的地。 */
  mapDestinations: MapDestination[];
  /** スマホから車へ送る再生指示。指示が無ければ null。 */
  nowPlaying: PlayCommand | null;
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
  playlists: defaultPlaylists,
  mapDestinations: defaultMapDestinations,
  nowPlaying: null,
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
  "playlists",
  "mapDestinations",
  "nowPlaying",
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

export const pickSyncedFields = (settings: Settings): SyncedSettings => ({
  meterTheme: settings.meterTheme,
  storeName: settings.storeName,
  storeDest: settings.storeDest,
  start: settings.start,
  homeDest: settings.homeDest,
  carId: settings.carId,
  playlists: settings.playlists,
  mapDestinations: settings.mapDestinations,
  nowPlaying: settings.nowPlaying,
  fuelEntries: settings.fuelEntries,
});

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
 * (壊れたプレイリストが1件でも入ると画面が崩れるため)
 */
export const sanitizeSyncedSettings = (
  value: Partial<SyncedSettings> | null | undefined,
): Partial<SyncedSettings> => {
  if (!value || typeof value !== "object") return {};
  const cleaned: Partial<SyncedSettings> = {};
  for (const field of SYNCED_FIELDS) {
    if (
      field === "playlists" ||
      field === "mapDestinations" ||
      field === "nowPlaying" ||
      field === "fuelEntries"
    ) {
      continue;
    }
    const entry = value[field];
    if (typeof entry === "string") cleaned[field] = entry as never;
  }
  if (isMeterTheme(cleaned.meterTheme)) {
    cleaned.meterTheme = cleaned.meterTheme;
  } else {
    delete cleaned.meterTheme;
  }
  if (Array.isArray(value.playlists)) {
    cleaned.playlists = sanitizePlaylists(value.playlists);
  }
  if (Array.isArray(value.mapDestinations)) {
    cleaned.mapDestinations = sanitizeMapDestinations(value.mapDestinations);
  }
  if (value.nowPlaying !== undefined) {
    cleaned.nowPlaying = sanitizePlayCommand(value.nowPlaying);
  }
  if (Array.isArray(value.fuelEntries)) {
    cleaned.fuelEntries = sanitizeFuelEntries(value.fuelEntries);
  }
  return cleaned;
};

/** サーバーに置いてある設定を読む。まだ何も無ければ settings は null。 */
export const fetchSharedSettings = async (key: string) =>
  postSync({ key });

/** サーバーへ設定を送る。updatedAt は端末の時計(ミリ秒)。 */
export const pushSharedSettings = async (key: string, settings: Settings) =>
  postSync({
    key,
    updatedAt: Date.now(),
    settings: pickSyncedFields(settings),
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

/* --- 音源置き場 (music.php) --- */

export const MUSIC_ENDPOINT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/music.php`;

/** 合言葉を渡すコードの長さ(music.php の LINK_CODE_LENGTH と同じ)。 */
export const LINK_CODE_LENGTH = 8;

/** 「パソコンでここを開いて」と案内するときに見せるアドレス。 */
export const SETTINGS_URL_HINT = "zest7.jp/zcar/settings/";

/** 音源置き場の1曲。url はエンドポイントからの相対パス。 */
export type MusicTrack = {
  id: string;
  title: string;
  url: string;
  size: number;
};

/** 音源のプレイリスト(曲そのものではなく、並び順の名簿)。 */
export type MusicPlaylist = {
  id: string;
  name: string;
  trackIds: string[];
};

export type MusicListResult = {
  ok: boolean;
  tracks: MusicTrack[];
  totalBytes: number;
  playlists: MusicPlaylist[];
  activePlaylistId: string;
  skipped?: Array<{ name: string; reason: string }>;
  saved?: number;
};

export const MAX_MUSIC_PLAYLISTS = 12;
export const MAX_MUSIC_PLAYLIST_NAME = 24;

/** 曲の URL を、そのまま再生できる絶対パスにする。 */
export const musicTrackUrl = (track: MusicTrack) =>
  `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/${track.url}`;

const emptyLibrary: MusicListResult = {
  ok: false,
  tracks: [],
  totalBytes: 0,
  playlists: [],
  activePlaylistId: "",
};

const readMusicResponse = async (response: Response): Promise<MusicListResult> => {
  if (!response.ok) return emptyLibrary;
  const data = (await response.json()) as {
    ok?: boolean;
    tracks?: unknown;
    totalBytes?: unknown;
    playlists?: unknown;
    activePlaylistId?: unknown;
    skipped?: unknown;
    saved?: unknown;
  };
  const tracks = Array.isArray(data.tracks)
    ? data.tracks.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.id !== "string" || typeof item.url !== "string") return [];
        return [
          {
            id: item.id,
            title: typeof item.title === "string" ? item.title : "TRACK",
            url: item.url,
            size: typeof item.size === "number" ? item.size : 0,
          },
        ];
      })
    : [];
  const playlists = Array.isArray(data.playlists)
    ? data.playlists.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const item = entry as Record<string, unknown>;
        if (typeof item.id !== "string") return [];
        return [
          {
            id: item.id,
            name: typeof item.name === "string" ? item.name : "PLAYLIST",
            trackIds: Array.isArray(item.trackIds)
              ? item.trackIds.filter((id): id is string => typeof id === "string")
              : [],
          },
        ];
      })
    : [];
  return {
    ok: data.ok === true,
    tracks,
    playlists,
    activePlaylistId:
      typeof data.activePlaylistId === "string" ? data.activePlaylistId : "",
    totalBytes: typeof data.totalBytes === "number" ? data.totalBytes : 0,
    skipped: Array.isArray(data.skipped)
      ? (data.skipped as Array<{ name: string; reason: string }>)
      : undefined,
    saved: typeof data.saved === "number" ? data.saved : undefined,
  };
};

/** 置いてある曲の一覧を取る。 */
export const fetchMusicTracks = async (key: string) =>
  readMusicResponse(
    await fetch(MUSIC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "list" }),
      cache: "no-store",
    }),
  );

/**
 * 音楽ファイルを預ける。1曲ずつ順番に送る。
 *
 * まとめて1回で送ると、曲数が多いときにサーバーの受け取り上限
 * (post_max_size) や時間切れに引っかかって全部やり直しになる。
 * 1曲ずつなら、途中で失敗しても失敗した曲だけが残る。
 * onProgress には「何曲目まで終わったか」を渡す。
 */
export const uploadMusicFiles = async (
  key: string,
  files: File[],
  onProgress?: (done: number, total: number, name: string) => void,
) => {
  let last: MusicListResult | null = null;
  const skipped: Array<{ name: string; reason: string }> = [];
  let saved = 0;

  for (const [index, file] of files.entries()) {
    onProgress?.(index, files.length, file.name);
    const form = new FormData();
    form.append("key", key);
    form.append("file[]", file);
    let result: MusicListResult;
    try {
      result = await readMusicResponse(
        await fetch(MUSIC_ENDPOINT, { method: "POST", body: form }),
      );
    } catch {
      skipped.push({ name: file.name, reason: "通信できませんでした" });
      continue;
    }
    if (!result.ok) {
      skipped.push({ name: file.name, reason: "保存できませんでした" });
      continue;
    }
    last = result;
    saved += result.saved ?? 0;
    if (result.skipped) skipped.push(...result.skipped);
  }
  onProgress?.(files.length, files.length, "");

  if (!last) {
    // 1曲も入らなかったときは、今の一覧を読み直して返す。
    const current = await fetchMusicTracks(key).catch(() => null);
    return current
      ? { ...current, saved: 0, skipped }
      : {
          ok: false,
          tracks: [],
          playlists: [],
          activePlaylistId: "",
          totalBytes: 0,
          saved: 0,
          skipped,
        };
  }
  return { ...last, saved, skipped };
};

/**
 * 合言葉を短い文字列で別の端末に渡す。カメラの無いパソコンでも
 * 車とつなげるようにするため。コードは10分で切れ、1回使うと消える。
 */
export const createLinkCode = async (key: string) => {
  const response = await fetch(MUSIC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, action: "linkcode" }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    code?: string;
    expiresIn?: number;
  } | null;
  if (!data || data.ok !== true || typeof data.code !== "string") return null;
  return {
    code: data.code,
    expiresIn: typeof data.expiresIn === "number" ? data.expiresIn : 600,
  };
};

/** 受け取ったコードを合言葉に引き換える。 */
export const claimLinkCode = async (code: string) => {
  const response = await fetch(MUSIC_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "linkclaim", code }),
    cache: "no-store",
  });
  const data = (await response.json().catch(() => null)) as {
    ok?: boolean;
    key?: string;
  } | null;
  if (!data || data.ok !== true || typeof data.key !== "string") {
    return { ok: false as const, status: response.status };
  }
  return { ok: true as const, key: data.key };
};

/** プレイリストと「車で流す一覧」をまとめて保存する。 */
export const saveMusicPlaylists = async (
  key: string,
  playlists: MusicPlaylist[],
  activePlaylistId: string,
) =>
  readMusicResponse(
    await fetch(MUSIC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "playlists", playlists, activePlaylistId }),
      cache: "no-store",
    }),
  );

/**
 * 車とつなぐ前にスマホへ入れた曲を、車の置き場へ引っ越す。
 * 両方の合言葉を知っているこの端末からだけ呼べる。
 */
export const adoptMusicLibrary = async (key: string, fromKey: string) =>
  readMusicResponse(
    await fetch(MUSIC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "adopt", fromKey }),
      cache: "no-store",
    }),
  );

/** 曲を消す。 */
export const deleteMusicTrack = async (key: string, id: string) =>
  readMusicResponse(
    await fetch(MUSIC_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, action: "delete", id }),
      cache: "no-store",
    }),
  );

/** 車に貯めた曲を入れておく場所(sw.js の MUSIC_CACHE_NAME と同じ名前)。 */
export const MUSIC_CACHE_NAME = "zcar-music-v1";

/** 通信できないときのために、最後に見た一覧を端末に控えておく。 */
export const MUSIC_LIBRARY_KEY = "zcar-music-library";

export const readStoredLibrary = (): {
  tracks: MusicTrack[];
  playlists: MusicPlaylist[];
  activePlaylistId: string;
} => {
  const empty = { tracks: [], playlists: [], activePlaylistId: "" };
  if (typeof window === "undefined") return empty;
  try {
    const raw = window.localStorage.getItem(MUSIC_LIBRARY_KEY);
    if (!raw) return empty;
    const stored = JSON.parse(raw) as Partial<MusicListResult>;
    return {
      tracks: Array.isArray(stored.tracks) ? stored.tracks : [],
      playlists: Array.isArray(stored.playlists) ? stored.playlists : [],
      activePlaylistId:
        typeof stored.activePlaylistId === "string" ? stored.activePlaylistId : "",
    };
  } catch {
    return empty;
  }
};

export const writeStoredLibrary = (library: {
  tracks: MusicTrack[];
  playlists: MusicPlaylist[];
  activePlaylistId: string;
}) => {
  try {
    window.localStorage.setItem(MUSIC_LIBRARY_KEY, JSON.stringify(library));
  } catch {
    // 保存できなくても再生には支障がない。
  }
};

export const SETTINGS_STORAGE_KEY = "zcar";

/**
 * 最後に反応した再生指示の時刻を端末に覚えておくためのキー。
 * これが無いと、車の画面を開き直すたびに前の指示で音が鳴ってしまう。
 */
const HANDLED_PLAY_KEY = "zcar-handled-play";

export const readHandledPlayAt = () => {
  if (typeof window === "undefined") return 0;
  try {
    const value = Number(window.localStorage.getItem(HANDLED_PLAY_KEY));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
};

export const writeHandledPlayAt = (requestedAt: number) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(HANDLED_PLAY_KEY, String(requestedAt));
  } catch {
    // 保存できなくても、その画面を開いている間は覚えている。
  }
};

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

/** 保存済みの設定を読む。壊れていたり廃止した値だった場合は初期値に寄せる。 */
export const readSettings = (): Settings => {
  if (typeof window === "undefined") return defaults;
  try {
    const stored = JSON.parse(
      window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}",
    ) as Partial<Settings>;
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
      playlists: sanitizePlaylists(stored.playlists),
      mapDestinations: sanitizeMapDestinations(stored.mapDestinations),
      nowPlaying: sanitizePlayCommand(stored.nowPlaying),
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
