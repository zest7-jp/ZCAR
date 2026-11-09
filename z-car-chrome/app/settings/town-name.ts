// オービスの名前にする町名(例: 大阪市北区西天満2丁目)。地図(Google の住所)から読む。

import { loadGoogleMaps } from "../google-maps";
import { MAX_ORBIS_LABEL } from "../settings-store";

/** 住所を調べるのを待つ長さ(ミリ秒)。間に合わなければ名前なし(一覧では「オービス」)。 */
const TOWN_TIMEOUT_MS = 4000;

type Geocoder = new () => {
  geocode: (request: Record<string, unknown>) => Promise<{
    results?: { formatted_address?: string; types?: string[] }[];
  }>;
};

/**
 * 住所から、短い町名を作る。〒・都道府県・番地(丁目より後)を外し、長ければ市を外す。
 * 例: 「日本、〒530-0047 大阪府大阪市北区西天満2丁目10-1」→「大阪市北区西天満2丁目」
 *     「兵庫県神戸市東灘区深江浜町1」→「神戸市東灘区深江浜町」
 */
export const shortTown = (address: string) => {
  let text = address
    .normalize("NFKC")
    .replace(/^日本[、,]\s*/, "")
    .replace(/^〒?\s*\d{3}-?\d{4}\s*/, "")
    .replace(/^(北海道|東京都|大阪府|京都府|\S{2,3}県)/, "")
    .trim();
  const chome = /^(.*?\d+丁目)/.exec(text);
  // 番地(数字)より前まで。丁目があれば、丁目まで。
  text = (chome ? chome[1] : (/^[^\d]+/.exec(text)?.[0] ?? text)).trim();
  if (Array.from(text).length > MAX_ORBIS_LABEL) text = text.replace(/^.+?市(?=.+区)/, "");
  return Array.from(text).slice(0, MAX_ORBIS_LABEL).join("");
};

/** その場所の町名。調べられない(Geocoding が使えない・電波が悪い)ときは空。 */
export const townAt = async (mapsKey: string, point: { lat: number; lng: number }): Promise<string> => {
  try {
    const maps = (await loadGoogleMaps(mapsKey)) as { Geocoder?: Geocoder };
    if (!maps.Geocoder) return "";
    const lookup = new maps.Geocoder()
      .geocode({ location: point, language: "ja", region: "jp" })
      .catch(() => null);
    const timeout = new Promise<null>((resolve) => window.setTimeout(() => resolve(null), TOWN_TIMEOUT_MS));
    const response = await Promise.race([lookup, timeout]);
    // 「MH4C+QX」のような Plus Code は住所ではないので使わない。
    const result = response?.results?.find(
      (entry) => entry.formatted_address && !entry.types?.includes("plus_code"),
    );
    return result?.formatted_address ? shortTown(result.formatted_address) : "";
  } catch {
    return "";
  }
};
