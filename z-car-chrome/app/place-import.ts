// Google マップで「共有」→「コピー」した内容から、目的地(名前と行き先)を作る。
// コピーされるのは短いリンク(maps.app.goo.gl/…)で、その行き先はブラウザからは読めないので、
// サーバー(public/api/place.php)に読んでもらう。

import { MAX_DESTINATION_LABEL, MAX_DESTINATION_TEXT } from "./settings-store";

export const PLACE_ENDPOINT = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/place.php`;

/** 目的地の欄に入れる内容。 */
export type PlaceDraft = { label: string; destination: string };

/** 読めなかった理由。画面の案内を変えるのに使う。 */
export type PlaceImportError = "empty" | "unlinked" | "unreadable" | "network";

type ReadPlace = { name: string; address: string; lat: number | null; lng: number | null };

const LINK = /https?:\/\/[^\s<>"']+/;

/** 文字数で切る(絵文字などが途中で割れないように)。 */
const clip = (text: string, length: number) => Array.from(text).slice(0, length).join("");

/** 読んだ名前・住所・場所から、目的地の欄の内容を作る。 */
const toDraft = ({ name, address, lat, lng }: ReadPlace): PlaceDraft | null => {
  const coords = lat !== null && lng !== null ? `${lat.toFixed(6)},${lng.toFixed(6)}` : "";
  // 名前と住所があれば両方(ナビが店を見つけやすい)。住所が無ければ場所(緯度,経度)。
  const destination = name && address ? `${name} ${address}` : address || coords || name;
  if (!destination) return null;
  return {
    label: clip(name || address, MAX_DESTINATION_LABEL),
    destination: clip(destination, MAX_DESTINATION_TEXT),
  };
};

/** 読んだ結果。読めなければ、その理由。 */
export type PlaceImport = { ok: true; draft: PlaceDraft } | { ok: false; error: PlaceImportError };

const failed = (error: PlaceImportError): PlaceImport => ({ ok: false, error });
const done = (draft: PlaceDraft | null): PlaceImport =>
  draft ? { ok: true, draft } : failed("unreadable");

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
  return done(
    toDraft({
      // 名前が読めなければ、一緒にコピーされた最初の行を名前にする。
      name: (typeof result.name === "string" && result.name.trim()) || lines[0] || "",
      address: typeof result.address === "string" ? result.address.trim() : "",
      lat: number(result.lat),
      lng: number(result.lng),
    }),
  );
};
