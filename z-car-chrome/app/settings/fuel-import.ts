// 過去の給油のメモ(メモ帳に書きためた文)を読み取り、給油の記録にする。
// 書き方は人によって・時期によってばらばらなので、決まった形には頼らず、次の決まりで読む。
//   - 空いた行で区切った1かたまりを、1回の給油とみなす(給油量が読めないかたまりは飛ばす。メモや月の合計など)
//   - 日付は「8/5」「日付:12/10」の形。「12/27.28」のように2日分あれば後の日にする。年は書いていないので、
//     並び順(古い順)と今日の日付から決める。日付が空のかたまりは、前後の給油の間の日にする
//   - 「給油量」「金額」「走行距離」の見出しがあればそれを使う(「6.71+18.84 25.55」のような式は最後の数)
//   - 見出しが無ければ、円の付いた数を金額に、残りの数のうち一番大きいものを走行距離にし、
//     走行距離 ÷ 給油量 が平均燃費の数と合うものを給油量にする(単位の書き間違い「16.13ℓ」でも読める)

import type { FuelEntry } from "../settings-store";

export type ImportedFuel = {
  date: string;
  liters: number;
  distanceKm: number;
  amountYen: number;
  /** 日付が書いていなかったので、前後の給油の間の日にした。 */
  estimated: boolean;
};

type Block = {
  month: number | null;
  day: number | null;
  liters: number;
  distanceKm: number;
  amountYen: number;
};

/** 1つの数。円なら , は位取り。ほかは「20,59」のような , の小数も読む(, のあとが1〜2けた)。 */
const toNumber = (raw: string, money: boolean) => {
  const text = raw.replace(/\.$/, "");
  if (!money && /^\d+,\d{1,2}$/.test(text)) return Number(text.replace(",", "."));
  return Number(text.replace(/,/g, ""));
};
const numbersIn = (text: string, money = false) =>
  [...text.matchAll(/\d[\d,]*(?:\.\d+)?\.?/g)].map((match) => toNumber(match[0], money)).filter(Number.isFinite);
const lastNumber = (text: string, money = false) => {
  const values = numbersIn(text, money);
  return values.length ? values[values.length - 1] : null;
};

const DATE_RE = /(\d{1,2})\/(\d{1,2})(?:[.・,](\d{1,2}))?/;
/** 日付だけの行(「11/21」「日付:12/4」)。 */
const DATE_ONLY_RE = /^(?:日付:?)?\s*\d{1,2}\/\d{1,2}(?:[.・,]\d{1,2})?\s*$/;

const readBlock = (lines: string[]): Block | null => {
  let month: number | null = null;
  let day: number | null = null;
  let dateLine = -1;
  lines.forEach((line, index) => {
    if (dateLine >= 0) return;
    if (/^日付/.test(line)) {
      dateLine = index;
      const match = DATE_RE.exec(line);
      if (match) {
        month = Number(match[1]);
        day = Number(match[3] ?? match[2]);
      }
      return;
    }
    // 見出しの無い形は、かたまりの1行目が日付(「8/5」「11/21」)。
    if (index === 0) {
      const match = DATE_RE.exec(line);
      if (match && line.trim().startsWith(match[0])) {
        dateLine = index;
        month = Number(match[1]);
        day = Number(match[3] ?? match[2]);
      }
    }
  });
  if (month !== null && (month < 1 || month > 12 || day === null || day < 1 || day > 31)) {
    month = null;
    day = null;
  }

  let liters: number | null = null;
  let distance: number | null = null;
  let amount: number | null = null;
  let kmpl: number | null = null;
  const loose: number[] = [];
  lines.forEach((line, index) => {
    if (index === dateLine) return;
    const label = /^(給油量|金額|走行距離|平均燃費)[^:]*:\s*(.*)$/.exec(line);
    if (label) {
      const value = lastNumber(label[2], label[1] === "金額");
      if (label[1] === "給油量") liters = value;
      else if (label[1] === "金額") amount = value;
      else if (label[1] === "走行距離") distance = value;
      else kmpl = value;
      return;
    }
    if (/円/.test(line)) {
      amount = lastNumber(line, true);
      return;
    }
    if (/平均燃費/.test(line)) {
      kmpl = lastNumber(line);
      return;
    }
    // 見出しの無い数(km・l・単位なし)。日付や「○月」のような行は数えない。
    if (/^\s*[\d.,]+\s*(km|l)?\s*$/.test(line)) {
      const value = lastNumber(line);
      if (value !== null) loose.push(value);
    }
  });

  // 見出しの無い数から、走行距離・給油量・平均燃費を当てる。
  if (distance === null || liters === null) {
    const values = [...loose];
    if (distance === null && values.length) {
      distance = Math.max(...values);
      values.splice(values.indexOf(distance), 1);
    }
    if (liters === null && values.length && distance !== null) {
      const rest = values.filter((value) => value > 0 && value < 80);
      // 走行距離 ÷ 給油量 が、残りの数(平均燃費)と合うものを給油量にする。
      const target = kmpl;
      const fits = rest.find((value) =>
        rest.some((other) => other !== value && Math.abs((distance as number) / value - other) <= 0.6) ||
        (target !== null && Math.abs((distance as number) / value - target) <= 0.6),
      );
      liters = fits ?? rest[0] ?? null;
    }
  }
  if (liters === null || !(liters > 0) || liters > 80) return null;
  if (distance === null || !(distance >= 0) || distance > 2000) distance = 0;
  return {
    month,
    day,
    liters: Math.round(liters * 100) / 100,
    distanceKm: Math.round(distance * 10) / 10,
    amountYen: amount !== null && amount >= 0 && amount < 100000 ? Math.round(amount) : 0,
  };
};

const pad = (value: number) => String(value).padStart(2, "0");
const toKey = (date: Date) => `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const dayNumber = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10))) / 86_400_000;
const fromDayNumber = (value: number) => toKey(new Date(value * 86_400_000));

/**
 * メモの文を読み、古い順の給油の記録にする。today(YYYY-MM-DD)は年を決めるのに使う
 * (いちばん新しい記録が今日より先にならない年にし、そこから月が戻るたびに前の年にする)。
 */
export function parseFuelLog(source: string, today: string): ImportedFuel[] {
  const text = source.normalize("NFKC").replace(/\r\n?/g, "\n");
  const chunks = text
    .split(/\n\s*\n/)
    .map((chunk) => chunk.split("\n").map((line) => line.trim()).filter(Boolean))
    .filter((lines) => lines.length);
  // 日付だけの行のあとに空いた行があるとき(「11/21」⏎⏎「27.61ℓ」…)は、次のかたまりの日付にする。
  const merged: string[][] = [];
  for (let index = 0; index < chunks.length; index += 1) {
    const lines = chunks[index];
    const following = chunks[index + 1];
    if (lines.length === 1 && DATE_ONLY_RE.test(lines[0]) && following && !DATE_RE.test(following[0])) {
      chunks[index + 1] = [lines[0], ...following];
      continue;
    }
    merged.push(lines);
  }
  const blocks = merged.map(readBlock).filter((block): block is Block => block !== null);
  if (!blocks.length) return [];

  // 年: 後ろから決める。月日が次の記録より後なら、年をまたいだので1年戻す。
  const keys: (string | null)[] = blocks.map(() => null);
  let year = Number(today.slice(0, 4));
  let next: { month: number; day: number } | null = null;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const { month, day } = blocks[index];
    if (month === null || day === null) continue;
    if (next === null) {
      if (`${pad(month)}-${pad(day)}` > today.slice(5)) year -= 1;
    } else if (month > next.month || (month === next.month && day > next.day)) {
      year -= 1;
    }
    keys[index] = `${year}-${pad(month)}-${pad(day)}`;
    next = { month, day };
  }

  // 日付の無い記録は、前後の日付の間に等しく並べる(端なら隣の日付)。
  for (let index = 0; index < keys.length; index += 1) {
    if (keys[index] !== null) continue;
    let end = index;
    while (end < keys.length && keys[end] === null) end += 1;
    const before = index > 0 ? keys[index - 1] : null;
    const after = end < keys.length ? keys[end] : null;
    const count = end - index;
    for (let step = 0; step < count; step += 1) {
      if (before && after) {
        const span = dayNumber(after) - dayNumber(before);
        keys[index + step] = fromDayNumber(dayNumber(before) + Math.round((span * (step + 1)) / (count + 1)));
      } else {
        keys[index + step] = before ?? after;
      }
    }
    index = end;
  }

  return blocks
    .map((block, index) => ({
      date: keys[index] as string,
      liters: block.liters,
      distanceKm: block.distanceKm,
      amountYen: block.amountYen,
      estimated: block.month === null,
    }))
    .filter((entry) => entry.date !== null);
}

/** 読み取った記録を、保存する形にする。id は日付と給油量から作る(同じ文を2回入れても二重にならない)。 */
export const toFuelEntries = (entries: ImportedFuel[]): FuelEntry[] =>
  entries.map((entry, index) => ({
    id: `imp-${entry.date}-${Math.round(entry.liters * 100)}`,
    date: entry.date,
    liters: entry.liters,
    distanceKm: entry.distanceKm,
    amountYen: entry.amountYen,
    createdAt: Date.parse(`${entry.date}T12:00:00+09:00`) + index,
  }));
