// 燃料の残りの見積もり(車とスマホで同じ計算)。
// 新しい給油5回分の燃費(走った距離 ÷ 入れた量)で、最後の給油から走った距離に使った量を出し、
// タンクの大きさから引いて残りにする。走行可能距離は、予備の量を残して走れる距離。

import type { FuelEntry } from "./settings-store";

/** タンクの大きさ(L)。タント(2代目・2007〜2013年)は 36L。 */
export const FUEL_TANK_CAPACITY_L = 36;
/** 走行可能距離で、残しておく予備の量(L)。 */
export const FUEL_RESERVE_L = 4;
/** 燃費を出すのに使う、新しい給油の数。 */
const RECENT_FUEL_ENTRIES = 5;

/** 新しい順に並べた給油の記録(給油日の新しい順。同じ日なら記録した時刻の新しい順)。 */
export const sortFuelEntries = (entries: FuelEntry[]) =>
  [...entries].sort((left, right) => right.date.localeCompare(left.date) || right.createdAt - left.createdAt);

export type FuelEstimate = {
  /** 新しい給油5回分の燃費(km/L)。給油の記録が無ければ null。 */
  economy: number | null;
  /** 残りの量(L)。燃費が分からなければ null。 */
  remainingLiters: number | null;
  /** 走行可能距離(km。予備を残して走れる距離)。分からなければ 0。 */
  rangeKm: number;
  /** 残りの割合(0〜100)。分からなければ 0。 */
  percent: number;
};

/** tripKm は、最後の給油から走った距離(km。車で合わせた係数を掛けたもの)。 */
export const estimateFuel = (entries: FuelEntry[], tripKm: number): FuelEstimate => {
  const recent = sortFuelEntries(entries).slice(0, RECENT_FUEL_ENTRIES);
  const liters = recent.reduce((total, entry) => total + entry.liters, 0);
  const distance = recent.reduce((total, entry) => total + entry.distanceKm, 0);
  const economy = liters > 0 ? distance / liters : null;
  if (economy === null) return { economy, remainingLiters: null, rangeKm: 0, percent: 0 };
  const remainingLiters = Math.max(0, FUEL_TANK_CAPACITY_L - tripKm / economy);
  return {
    economy,
    remainingLiters,
    rangeKm: Math.max(0, remainingLiters - FUEL_RESERVE_L) * economy,
    percent: Math.max(0, Math.min(100, (remainingLiters / FUEL_TANK_CAPACITY_L) * 100)),
  };
};
