// オービス(速度の自動取締機)を知らせる。レーダー探知機のような働き。
// 場所は OpenStreetMap(みんなで作る地図。highway=speed_camera)と、スマホで登録した場所。
// 車の GPS の位置・向きから、進む向きの前方にあるものを選ぶ。
// 移動式のオービスは場所が決まっていないので、知らせられない。

import { distanceMeters } from "./parking";

/** 地図に印を出し始める距離(m)。 */
export const ORBIS_SHOW_M = 500;
/** 警告(帯や輪の色・声)を出す距離(m)。印を出し始めるのと同じ 500m 手前から警告する。 */
export const ORBIS_WARN_M = 500;

/** オービス1か所。 */
export type OrbisSpot = {
  /** OpenStreetMap の場所は osm-番号、スマホで登録した場所はその id。 */
  id: string;
  lat: number;
  lng: number;
  /** 制限速度(km/h)。分からなければ null。 */
  limit: number | null;
  /**
   * この向き(度。北が0、東が90)へ走るときだけ知らせる(上り・下りのどちらか)。
   * null は両方の向き(OpenStreetMap の場所は向きが分からないので、いつも null)。
   */
  direction: number | null;
  /** どこの情報か(OpenStreetMap の場所は、出した所に出典を書く)。 */
  source: "osm" | "mine";
};

/** 連続区間(オービスがいくつも続く所)の、何か所目か・全部で何か所か。 */
export type OrbisSeries = {
  index: number;
  total: number;
  /** 次のオービス(この区間で、走る向きの先にあるもの)。最後なら null。 */
  nextId: string | null;
};

/** 前方にあるオービスと、そこまでの道のり。 */
export type OrbisAlert = {
  spot: OrbisSpot;
  /** そこまでの距離(m)。 */
  distance: number;
  /** 車から見て東・北へ何mか(地図の上に印を置くのに使う)。 */
  east: number;
  north: number;
  /** 500m 以内は warn(警告)。連続区間の次のオービスを 500m より先から出すときだけ show(印だけ静かに)。 */
  level: "show" | "warn";
  /** このオービスに近づく間に拡大した、地図の縮尺(近づくほど大きく、戻さない)。 */
  zoom: number;
  /** 連続区間なら、何か所目か。1か所だけなら null。 */
  series: OrbisSeries | null;
};

const RAD = Math.PI / 180;

/** from から to を見た向き(度。北が0、東が90)。 */
export const bearingDeg = (
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
) => {
  const fromLat = from.lat * RAD;
  const toLat = to.lat * RAD;
  const lngGap = (to.lng - from.lng) * RAD;
  const y = Math.sin(lngGap) * Math.cos(toLat);
  const x = Math.cos(fromLat) * Math.sin(toLat) - Math.sin(fromLat) * Math.cos(toLat) * Math.cos(lngGap);
  return (Math.atan2(y, x) / RAD + 360) % 360;
};

/** 2つの向きの開き(0〜180度)。 */
export const angleGap = (left: number, right: number) =>
  Math.abs(((((left - right) % 360) + 540) % 360) - 180);

/** 進む向きの前方とみなす開き(度)。 */
const AHEAD_DEG = 40;
/**
 * もう知らせているオービスは、すぐ近く(道の横にずれて角度が開く)でも見失わないよう、
 * 開きと距離を少し広げる。これを越えたら(後ろになった・離れた)通り過ぎた。
 */
const KEEP_DEG = 75;
const KEEP_EXTRA_M = 40;
/**
 * 進む向きから横にずれている距離(m)の上限。並んだ別の道のオービスを外す
 * (カーブの先にあるものは、近づいて横のずれが小さくなってから出る)。
 */
const SIDE_M = 80;
const KEEP_SIDE_M = 120;
/** 印が地図の真ん中(車)からこの点数くらいの所に来るように、近づくほど拡大する。 */
const MARK_PX = 100;

/**
 * そのオービスまでの距離に合う、地図の縮尺(Google マップの zoom)。
 * 近づくほど大きくなり、max で止まる。
 */
export const orbisZoom = (distance: number, lat: number, max: number) => {
  const metersPerPxAtZoom0 = 156543.03392 * Math.cos(lat * RAD);
  return Math.min(max, Math.floor(Math.log2(metersPerPxAtZoom0 / (Math.max(distance, 1) / MARK_PX))));
};

/**
 * 進む向きの前方 500m 以内で一番近いオービスを選ぶ。向きが分からなければ選ばない。
 * keep は前回知らせていたもの(通り過ぎるまで見失わないように)。
 */
/** 登録した向きと走る向きの開きがこれまでなら、そのオービスの向き(上り・下り)に走っている。 */
const DIRECTION_DEG = 60;
/** 走る向き(heading)に、そのオービスが当てはまるか(向きが決まっていなければ両方)。 */
const appliesTo = (spot: OrbisSpot, heading: number) =>
  spot.direction === null || angleGap(spot.direction, heading) <= DIRECTION_DEG;

/** となりのオービスまでがこれ以内(m)なら、続いている(連続区間)。 */
const SERIES_GAP_M = 1500;
/** となりのオービスへの向きと、そこを走る向きの開きがこれまでなら、同じ道の先(か手前)。 */
const SERIES_DEG = 50;
/** 連続区間として数える上限。 */
const SERIES_MAX = 9;
/** 区間の途中で、次のオービスをこの距離(m)より近ければ、500m より先でも出す。 */
const SERIES_SHOW_M = SERIES_GAP_M + 200;

/**
 * from から、走る向き(forward)か逆向きに、続いているオービスをたどる。
 * 向きが登録してあるオービスは、その向きを道の向きとして使う(カーブでも続けてたどれる)。
 */
const followSeries = (spots: OrbisSpot[], from: OrbisSpot, heading: number, forward: boolean) => {
  const chain: OrbisSpot[] = [];
  const used = new Set([from.id]);
  let current = from;
  while (chain.length < SERIES_MAX - 1) {
    const road = current.direction ?? heading;
    const want = forward ? road : (road + 180) % 360;
    let next: OrbisSpot | null = null;
    let nearest = Infinity;
    for (const spot of spots) {
      if (used.has(spot.id) || !appliesTo(spot, heading)) continue;
      const distance = distanceMeters(current, spot);
      if (distance < 1 || distance > SERIES_GAP_M || distance >= nearest) continue;
      if (angleGap(bearingDeg(current, spot), want) > SERIES_DEG) continue;
      next = spot;
      nearest = distance;
    }
    if (!next) break;
    used.add(next.id);
    chain.push(next);
    current = next;
  }
  return chain;
};

/** そのオービスが連続区間の中なら、何か所目か・全部で何か所か(1か所だけなら null)。 */
export const findSeries = (spots: OrbisSpot[], target: OrbisSpot, heading: number): OrbisSeries | null => {
  const before = followSeries(spots, target, heading, false);
  const after = followSeries(spots, target, heading, true);
  const total = before.length + 1 + after.length;
  if (total < 2) return null;
  return { index: before.length + 1, total: Math.min(total, SERIES_MAX), nextId: after[0]?.id ?? null };
};

/**
 * スマホで登録した場所の近く(この距離・m)にある OpenStreetMap のオービスは使わない
 * (同じオービスを、向き付きで登録し直したとみなす)。
 */
const OVERRIDE_M = 60;
export const combineOrbisSpots = (osm: OrbisSpot[], mine: OrbisSpot[]) => [
  ...osm.filter((spot) => !mine.some((own) => distanceMeters(own, spot) <= OVERRIDE_M)),
  ...mine,
];

/**
 * 進む向きの前方 500m 以内で一番近いオービスを選ぶ。向きが分からなければ選ばない。
 * そのオービスに向き(上り・下り)が登録してあれば、その向きに走っているときだけ選ぶ。
 * keep は前回知らせていたもの(通り過ぎるまで見失わないように)。連続区間の途中なら、
 * 通り過ぎたあと、次のオービスを 500m より先からでも出す。
 */
export const findOrbisAhead = (
  spots: OrbisSpot[],
  car: { lat: number; lng: number; heading: number | null },
  keep: OrbisAlert | null,
  maxZoom: number,
): OrbisAlert | null => {
  if (car.heading === null || !Number.isFinite(car.heading)) return null;
  const heading = ((car.heading % 360) + 360) % 360;
  // 前方にあるか(距離 limit 以内・左右の開き・横のずれ)。
  const ahead = (spot: OrbisSpot, limit: number, kept: boolean) => {
    const distance = distanceMeters(car, spot);
    if (distance > limit) return null;
    const bearing = bearingDeg(car, spot);
    const gap = angleGap(bearing, heading);
    if (gap > (kept ? KEEP_DEG : AHEAD_DEG)) return null;
    if (distance * Math.sin(gap * RAD) > (kept ? KEEP_SIDE_M : SIDE_M)) return null;
    return { spot, distance, bearing };
  };
  let best: { spot: OrbisSpot; distance: number; bearing: number } | null = null;
  for (const spot of spots) {
    if (!appliesTo(spot, heading)) continue;
    const kept = keep?.spot.id === spot.id;
    const found = ahead(spot, ORBIS_SHOW_M + (kept ? KEEP_EXTRA_M : 0), kept);
    if (found && (!best || found.distance < best.distance)) best = found;
  }
  // 連続区間の途中: 通り過ぎたオービスの次を、500m より先でも出す。
  if (!best && keep?.series?.nextId) {
    const next = spots.find((spot) => spot.id === keep.series?.nextId);
    if (next && appliesTo(next, heading)) best = ahead(next, SERIES_SHOW_M, false);
  }
  if (!best) return null;
  const { spot, distance, bearing } = best;
  const zoom = orbisZoom(distance, car.lat, maxZoom);
  return {
    spot,
    distance,
    east: distance * Math.sin(bearing * RAD),
    north: distance * Math.cos(bearing * RAD),
    level: distance <= ORBIS_WARN_M ? "warn" : "show",
    zoom: keep?.spot.id === spot.id ? Math.max(keep.zoom, zoom) : zoom,
    series: findSeries(spots, spot, heading),
  };
};

/**
 * 声で知らせる言葉。500m を切ったところで1回。連続区間なら、何か所目かも言う
 * (1か所目で「全部で3か所」、途中は「2か所目」、最後は「最後」)。
 */
export const orbisMessage = (alert: OrbisAlert) => {
  // 初めて見つけたのが警告の距離の近く(50m 以内)なら「500メートル先」、もっと近ければ「この先」。
  const near = alert.distance >= ORBIS_WARN_M - 50 ? `${ORBIS_WARN_M}メートル先、` : "この先、";
  const series = alert.series;
  const head = !series
    ? `${near}オービスです`
    : series.index === 1
      ? `${near}オービス連続区間です。全部で${series.total}か所あります`
      : series.index >= series.total
        ? `${near}最後のオービスです`
        : `${near}${series.index}か所目のオービスです`;
  return alert.spot.limit ? `${head}。制限速度、${alert.spot.limit}キロです` : head;
};

/** 帯に出す距離(1km 未満は 10m 単位、1km からは 0.1km 単位)。 */
export const orbisDistanceText = (meters: number) =>
  meters >= 1000 ? { value: (meters / 1000).toFixed(1), unit: "km" } : { value: String(Math.round(meters / 10) * 10), unit: "m" };

// --- OpenStreetMap から取る ---

/** OpenStreetMap の検索の窓口(Overpass API)。つながらなければ次を使う。 */
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
/** 車のまわりのこの範囲(緯度で ±0.3度 ≒ ±33km)をまとめて取る。 */
const AREA_DEG = 0.3;
/** 取った範囲の真ん中からこれ(m)より離れたら、取り直す。 */
const REFETCH_M = 15_000;
/** 取ってからこれだけたったら、取り直す(地図は時々直されるので)。 */
const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
/** 取れなかったときは、これだけ待ってから取り直す。 */
export const OSM_RETRY_MS = 10 * 60 * 1000;
const OSM_CACHE_KEY = "zcar-orbis-osm";

type OsmCache = { lat: number; lng: number; at: number; spots: OrbisSpot[] };

const isSpot = (value: unknown): value is OrbisSpot => {
  const spot = value as Partial<OrbisSpot> | null;
  return (
    !!spot &&
    typeof spot.id === "string" &&
    Number.isFinite(spot.lat) &&
    Number.isFinite(spot.lng) &&
    (spot.limit === null || Number.isFinite(spot.limit)) &&
    (spot.direction === undefined || spot.direction === null || Number.isFinite(spot.direction))
  );
};

/** 端末に覚えてある OpenStreetMap のオービス(車だけ。同期しない)。 */
export const readOsmCache = (): OsmCache | null => {
  if (typeof window === "undefined") return null;
  try {
    const cache = JSON.parse(window.localStorage.getItem(OSM_CACHE_KEY) || "null") as OsmCache | null;
    if (!cache || !Number.isFinite(cache.lat) || !Number.isFinite(cache.lng) || !Number.isFinite(cache.at)) return null;
    return {
      ...cache,
      spots: Array.isArray(cache.spots)
        ? cache.spots.filter(isSpot).map((spot) => ({ ...spot, direction: spot.direction ?? null }))
        : [],
    };
  } catch {
    return null;
  }
};

const writeOsmCache = (cache: OsmCache) => {
  try {
    window.localStorage.setItem(OSM_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 覚えられなくても、いまの走行では使える。
  }
};

/** 覚えてある分が、いまの場所で使えるか(近くて新しい)。 */
export const osmCacheFresh = (cache: OsmCache | null, point: { lat: number; lng: number }, now: number) =>
  !!cache && now - cache.at < REFRESH_MS && distanceMeters(cache, point) < REFETCH_M;

/** 制限速度の書き方(「60」「60 km/h」)から数字を読む。 */
const readLimit = (value: unknown) => {
  if (typeof value !== "string") return null;
  const limit = Number(/^\s*(\d{2,3})/.exec(value)?.[1]);
  return limit >= 10 && limit <= 140 ? limit : null;
};

/** Overpass API の返事から、オービスの一覧を作る。 */
export const parseOsmOrbis = (json: unknown): OrbisSpot[] => {
  const elements = (json as { elements?: unknown })?.elements;
  if (!Array.isArray(elements)) return [];
  return elements.flatMap((element) => {
    const node = element as { type?: unknown; id?: unknown; lat?: unknown; lon?: unknown; tags?: Record<string, unknown> };
    if (node.type !== "node" || typeof node.id !== "number") return [];
    const lat = Number(node.lat);
    const lng = Number(node.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return [];
    return [{ id: `osm-${node.id}`, lat, lng, limit: readLimit(node.tags?.maxspeed), direction: null, source: "osm" as const }];
  });
};

/**
 * 車のまわりのオービスを OpenStreetMap から取り、端末に覚える。取れなければ例外。
 * (向きの書き方は地図によってまちまちなので使わず、どちら向きでも知らせる)
 */
export const fetchOsmOrbis = async (point: { lat: number; lng: number }): Promise<OrbisSpot[]> => {
  const south = point.lat - AREA_DEG;
  const north = point.lat + AREA_DEG;
  const lngSpan = AREA_DEG / Math.cos(point.lat * RAD);
  const west = point.lng - lngSpan;
  const east = point.lng + lngSpan;
  const query =
    `[out:json][timeout:25];node["highway"="speed_camera"]` +
    `(${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)});out body;`;
  for (const url of OVERPASS_URLS) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method: "POST",
        body: new URLSearchParams({ data: query }),
        signal: controller.signal,
      });
      if (!response.ok) continue;
      const spots = parseOsmOrbis(await response.json());
      writeOsmCache({ lat: point.lat, lng: point.lng, at: Date.now(), spots });
      return spots;
    } catch {
      // 次の窓口を試す。
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error("OSM_ORBIS_UNAVAILABLE");
};

// --- 声と音 ---

let audioContext: AudioContext | null = null;

/**
 * 声と音を出せるようにする。ブラウザは、画面に触れたあとでないと音を出させないので、
 * 画面に触れたときに呼ぶ(出発のボタンなど)。
 */
export const unlockOrbisSound = () => {
  try {
    audioContext ??= new AudioContext();
    void audioContext.resume();
  } catch {
    // 音の仕組みが無い端末。
  }
  try {
    window.speechSynthesis?.getVoices();
  } catch {
    // 声の仕組みが無い端末。
  }
};

/** 画面にまだ触れていない(声や音を出させてもらえない)か。 */
export const soundLocked = () =>
  typeof navigator !== "undefined" &&
  "userActivation" in navigator &&
  !(navigator as Navigator & { userActivation: { hasBeenActive: boolean } }).userActivation.hasBeenActive;

/** ピッ、ピッという短い音(声が出せないとき)。 */
const beep = () => {
  try {
    audioContext ??= new AudioContext();
    const context = audioContext;
    void context.resume();
    [0, 0.22].forEach((offset) => {
      const tone = context.createOscillator();
      const volume = context.createGain();
      tone.frequency.value = 1320;
      volume.gain.setValueAtTime(0.0001, context.currentTime + offset);
      volume.gain.exponentialRampToValueAtTime(0.4, context.currentTime + offset + 0.01);
      volume.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + offset + 0.16);
      tone.connect(volume).connect(context.destination);
      tone.start(context.currentTime + offset);
      tone.stop(context.currentTime + offset + 0.18);
    });
  } catch {
    // 音も出せない端末。画面だけで知らせる。
  }
};

/**
 * 声で知らせる。日本語の声が無い・話し始めないときは、ピッという音にする。
 * queue なら、いま話している声を止めずに、あとに続けて言う(オービスと速度取締区間が同時のとき)。
 */
export const speakOrbis = (text: string, queue = false) => {
  const synth = typeof window !== "undefined" ? window.speechSynthesis : undefined;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    beep();
    return;
  }
  try {
    const voices = synth.getVoices();
    const voice = voices.find((entry) => /^ja/i.test(entry.lang));
    // 声の一覧があるのに日本語が無ければ、変な読み方になるので音にする。
    if (voices.length > 0 && !voice) {
      beep();
      return;
    }
    let settled = false;
    const fallBack = () => {
      if (settled) return;
      settled = true;
      beep();
    };
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "ja-JP";
    if (voice) utterance.voice = voice;
    utterance.onstart = () => {
      settled = true;
    };
    utterance.onerror = fallBack;
    if (!queue) synth.cancel();
    synth.speak(utterance);
    window.setTimeout(() => {
      if (!synth.speaking) fallBack();
    }, 1500);
  } catch {
    beep();
  }
};
