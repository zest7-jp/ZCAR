// 車両位置(停めた場所)のやりとり。車が送り、スマホが読む。
// サーバー側は public/api/park.php(同期と同じ合言葉で読み書きする)。

/** 車が送る、いまの場所。 */
export type ParkingReport = {
  lat: number;
  lng: number;
  /** 誤差(m)。 */
  accuracy: number;
  /** 走っているところか。 */
  moving: boolean;
  /**
   * いまの走行の長さ(ミリ秒)。走行中でなければ null。
   * 時刻ではなく長さで送り、サーバーの時計で「走り出した時刻」にする(車の時計のずれに左右されない)。
   */
  drivingMs?: number | null;
};

/** サーバーにある、車の最後の場所。 */
export type ParkedCar = ParkingReport & {
  /** その場所に来た時刻(サーバーの時計のミリ秒)。 */
  since: number;
  /** 最後に位置が届いた時刻(サーバーの時計のミリ秒)。 */
  at: number;
  /** 走り出した時刻(サーバーの時計のミリ秒)。走行中でない・古い車の版なら null。 */
  tripSince: number | null;
};

export const PARK_ENDPOINT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/park.php`;

type Point = { lat: number; lng: number };

/** 2点の間の距離(m)。 */
export const distanceMeters = (from: Point, to: Point) => {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((to.lat - from.lat) * rad) / 2) ** 2 +
    Math.cos(from.lat * rad) *
      Math.cos(to.lat * rad) *
      Math.sin(((to.lng - from.lng) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
};

const postPark = async (payload: Record<string, unknown>) => {
  const response = await fetch(PARK_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`park failed: ${response.status}`);
  return (await response.json()) as { ok?: boolean; park?: unknown; now?: unknown };
};

/** いまの場所を送る。 */
export const pushParking = (key: string, park: ParkingReport) => postPark({ key, park });

/**
 * 画面が消えるとき(電源を切ったときなど)に、最後の場所を送る。
 * ページが閉じても届くように sendBeacon を使う(中身は同じ JSON)。
 */
export const sendParkingBeacon = (key: string, park: ParkingReport) => {
  const body = JSON.stringify({ key, park });
  try {
    if (navigator.sendBeacon(PARK_ENDPOINT, body)) return;
  } catch {
    // 使えないブラウザは下の方法で送る。
  }
  void fetch(PARK_ENDPOINT, { method: "POST", body, keepalive: true }).catch(() => undefined);
};

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** サーバーから戻ってきた場所を、そのまま信用せず確かめる。おかしければ null。 */
const sanitizeParkedCar = (value: unknown): ParkedCar | null => {
  if (!value || typeof value !== "object") return null;
  const park = value as Record<string, unknown>;
  const { lat, lng, accuracy, since, at } = park;
  if (!isNumber(lat) || !isNumber(lng) || !isNumber(accuracy) || !isNumber(since) || !isNumber(at)) {
    return null;
  }
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return {
    lat,
    lng,
    accuracy: Math.max(0, accuracy),
    moving: park.moving === true,
    since,
    at,
    tripSince: isNumber(park.tripSince) ? park.tripSince : null,
  };
};

/**
 * 車の最後の場所を読む。まだ何も届いていなければ park は null。
 * now はサーバーの時計(スマホの時計がずれていても、何分前かを正しく出すため)。
 */
export const fetchParking = async (key: string) => {
  const result = await postPark({ key });
  if (result.ok !== true) throw new Error("park read failed");
  return {
    park: sanitizeParkedCar(result.park),
    now: isNumber(result.now) ? result.now : Date.now(),
  };
};
