// Google マップで「共有」→「コピー」した内容から、目的地(名前と行き先)を作る。
// コピーされるのは短いリンク(maps.app.goo.gl/…)で、その行き先はブラウザからは読めないので、
// サーバー(public/api/place.php)に読んでもらう。

import { distanceMeters } from "./parking";
import { MAX_DESTINATION_LABEL, MAX_DESTINATION_TEXT, MAX_TRIP_LABEL } from "./settings-store";

export const PLACE_ENDPOINT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/place.php`;
export const SHARE_ENDPOINT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/share.php`;

/** 名前も住所も無い場所(地図に落としたピン)の名前。サーバーの place-lib.php と同じ。 */
const PIN_LABEL = "地図の場所";

/** 目的地の欄に入れる内容。 */
export type PlaceDraft = { label: string; destination: string };

/** 今回だけの行き先にするときの内容(名前は長めに残し、着いたかを見るための場所も持つ)。 */
export type TripDraft = PlaceDraft & { lat: number | null; lng: number | null };

/** 読めなかった理由。画面の案内を変えるのに使う。 */
export type PlaceImportError = "empty" | "unlinked" | "unreadable" | "network";

type ReadPlace = { name: string; address: string; lat: number | null; lng: number | null };

const LINK = /https?:\/\/[^\s<>"']+/;

/** 文字数で切る(絵文字などが途中で割れないように)。 */
const clip = (text: string, length: number) => Array.from(text).slice(0, length).join("");

/** 読んだ名前・住所・場所から、目的地の欄の内容を作る(今回だけの行き先にするときの内容も)。 */
const toDraft = ({ name, address, lat, lng }: ReadPlace): { draft: PlaceDraft; trip: TripDraft } | null => {
  const coords = lat !== null && lng !== null ? `${lat.toFixed(6)},${lng.toFixed(6)}` : "";
  // 名前と住所があれば両方(ナビが店を見つけやすい)。住所が無ければ場所(緯度,経度)。
  const destination = clip(name && address ? `${name} ${address}` : address || coords || name, MAX_DESTINATION_TEXT);
  if (!destination) return null;
  const label = name || address || PIN_LABEL;
  return {
    draft: { label: clip(label, MAX_DESTINATION_LABEL), destination },
    trip: { label: clip(label, MAX_TRIP_LABEL), destination, lat, lng },
  };
};

/** 行き先が「緯度,経度」だけなら、その場所。 */
export const readCoords = (destination: string) => {
  const match = /^(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(destination.trim());
  return match ? { lat: Number(match[1]), lng: Number(match[2]) } : null;
};

/** 緯度・経度の行き先どうしが、この距離(m)より近ければ同じ場所とみなす。 */
const SAME_PLACE_METERS = 30;

/** 2つの行き先が同じ場所か(同じ文字か、近くの緯度・経度)。同じ場所を二重に登録しないために使う。 */
export const isSamePlace = (a: string, b: string) => {
  if (a.trim() === b.trim()) return true;
  const from = readCoords(a);
  const to = readCoords(b);
  return from !== null && to !== null && distanceMeters(from, to) <= SAME_PLACE_METERS;
};

/** 読んだ結果。読めなければ、その理由。 */
export type PlaceImport =
  | { ok: true; draft: PlaceDraft; trip: TripDraft }
  | { ok: false; error: PlaceImportError };

const failed = (error: PlaceImportError) => ({ ok: false as const, error });
const done = (read: { draft: PlaceDraft; trip: TripDraft } | null): PlaceImport =>
  read ? { ok: true, ...read } : failed("unreadable");

/**
 * コピーした内容を読んで、目的地の欄の内容を返す。
 * リンクが無ければ、書いてある文字(店名や住所)をそのまま使う。
 */
export const readCopiedPlace = async (key: string, copied: string): Promise<PlaceImport> => {
  const text = copied.trim();
  if (!text) return failed("empty");
  // リンク以外の行(店名などが一緒にコピーされることがある)。
  const lines = text
    .split(/\n+/)
    .map((line) => line.replace(LINK, "").trim())
    .filter(Boolean);

  if (!LINK.test(text)) {
    return done(
      toDraft({
        name: lines.length > 1 ? lines[0] : "",
        address: lines.length > 1 ? lines.slice(1).join(" ") : (lines[0] ?? ""),
        lat: null,
        lng: null,
      }),
    );
  }

  if (!key) return failed("unlinked");
  const result = await readLinkedPlace(key, text);
  if (!result.ok) return result;
  return done(
    toDraft({
      ...result.place,
      // 名前が読めなければ、一緒にコピーされた最初の行を名前にする。
      name: result.place.name || lines[0] || "",
    }),
  );
};

/** コピーした Google マップのリンクの中身(名前・住所・場所)を、サーバーに読んでもらう。 */
const readLinkedPlace = async (
  key: string,
  text: string,
): Promise<{ ok: true; place: ReadPlace } | { ok: false; error: PlaceImportError }> => {
  let result: { ok?: boolean; name?: unknown; address?: unknown; lat?: unknown; lng?: unknown };
  try {
    const response = await fetch(PLACE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, text }),
      cache: "no-store",
    });
    if (response.status >= 500) return failed("network");
    result = await response.json();
  } catch {
    return failed("network");
  }
  if (result.ok !== true) return failed("unreadable");
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    ok: true,
    place: {
      name: typeof result.name === "string" ? result.name.trim() : "",
      address: typeof result.address === "string" ? result.address.trim() : "",
      lat: number(result.lat),
      lng: number(result.lng),
    },
  };
};

/** 場所(緯度・経度)を読んだ結果。オービスを登録するときに使う。 */
export type PointImport =
  | { ok: true; name: string; lat: number; lng: number }
  | { ok: false; error: PlaceImportError };

/** Yahoo!マップのアドレス(…?lat=緯度&lon=経度)から場所を読む。無ければ null。 */
export const readLinkCoords = (text: string) => {
  const link = LINK.exec(text)?.[0];
  if (!link) return null;
  try {
    const url = new URL(link);
    const lat = url.searchParams.get("lat");
    const lng = url.searchParams.get("lon") ?? url.searchParams.get("lng");
    if (lat === null || lng === null || lat.trim() === "" || lng.trim() === "") return null;
    const point = { lat: Number(lat), lng: Number(lng) };
    return Number.isFinite(point.lat) && Number.isFinite(point.lng) && Math.abs(point.lat) <= 90 && Math.abs(point.lng) <= 180
      ? point
      : null;
  } catch {
    return null;
  }
};

/**
 * コピーした内容から、場所(緯度・経度)を読む。「34.76,135.62」のような数字、
 * 場所の入った Yahoo!マップのアドレス、Google マップ・Yahoo!マップの短いリンク(サーバーでたどる)。
 * 名前も読めれば返す。
 */
export const readCopiedPoint = async (key: string, copied: string): Promise<PointImport> => {
  const text = copied.trim();
  if (!text) return failed("empty");
  const coords = readCoords(text.replace(/[()]/g, "")) ?? readLinkCoords(text);
  if (coords) return { ok: true, name: "", ...coords };
  if (!LINK.test(text)) return failed("unreadable");
  if (!key) return failed("unlinked");
  const result = await readLinkedPlace(key, text);
  if (!result.ok) return result;
  const { name, lat, lng } = result.place;
  return lat !== null && lng !== null ? { ok: true, name, lat, lng } : failed("unreadable");
};

/**
 * iPhone の「ショートカット」から目的地を送るための、専用の鍵を作る(目的地を足すことしかできない)。
 * 作り直すと、前の鍵(前に作ったショートカット)は使えなくなる。作れなければ null。
 */
export const issueShareToken = async (key: string): Promise<string | null> => {
  try {
    const response = await fetch(SHARE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key, issue: true }),
      cache: "no-store",
    });
    const result = (await response.json()) as { ok?: boolean; token?: unknown };
    return result.ok === true && typeof result.token === "string" && /^[0-9a-f]{32}$/.test(result.token)
      ? result.token
      : null;
  } catch {
    return null;
  }
};

/** ショートカットに貼る送り先(鍵入り)。画面には出さず、コピーだけする。 */
export const shareUrlFor = (token: string) =>
  `${window.location.origin}${SHARE_ENDPOINT}?k=${token}`;
