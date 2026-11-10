// 速度取締区間(スマホで、始まりと終わりの場所を登録した区間)を知らせる。
// 車の GPS の位置・向きから、区間の手前(入口の 500m 前から)と区間の中(出口までの残り)を選ぶ。
// 区間は、始まりと終わりを結ぶまっすぐな線とみなす(カーブの多い道は、短い区間に分けて登録してもらう)。

import { angleGap } from "./orbis";
import type { SpeedZone } from "./settings-store";

/** 区間の入口のこの距離(m)手前から、警告と声で知らせる。 */
export const ZONE_WARN_M = 500;

/** 車から見て東・北へ何mか。 */
export type ZoneOffset = { east: number; north: number };

/** 前方の(または、いま中を走っている)速度取締区間。 */
export type ZoneAlert = {
  zone: SpeedZone;
  /** before は区間の手前(入口まで 500m 以内)、inside は区間の中。 */
  state: "before" | "inside";
  /** true は始まり→終わりの向きに走っている(false は終わりから始まりへ)。 */
  forward: boolean;
  /** before は入口まで、inside は出口までの距離(m)。 */
  distance: number;
  /** 区間の長さ(m)。 */
  length: number;
  /** 入口と出口が、車から見て東・北へ何mか(地図に区間の線を引く)。 */
  entry: ZoneOffset;
  exit: ZoneOffset;
};

const RAD = Math.PI / 180;
const EARTH_M = 6371000;

/** 車から見た、その場所の東・北の距離(m)。数km の近さなので平らな地図とみなす。 */
export const zoneOffset = (
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): ZoneOffset => ({
  east: (to.lng - from.lng) * RAD * EARTH_M * Math.cos(((from.lat + to.lat) / 2) * RAD),
  north: (to.lat - from.lat) * RAD * EARTH_M,
});

/** 区間の長さ(m)。 */
export const zoneLength = (zone: Pick<SpeedZone, "start" | "end">) => {
  const gap = zoneOffset(zone.start, zone.end);
  return Math.hypot(gap.east, gap.north);
};

/** これより短い区間は使わない(始まりと終わりが同じ場所など)。 */
const MIN_ZONE_M = 30;

// 区間の手前: 入口がオービスと同じ見方で前方にあり、区間の向きに走っている。
/** 進む向きの前方とみなす開き(度)と、横のずれ(m)。知らせている区間は、少し広げる(オービスと同じ)。 */
const AHEAD_DEG = 40;
const KEEP_AHEAD_DEG = 75;
const SIDE_M = 80;
const KEEP_SIDE_M = 120;
const KEEP_EXTRA_M = 40;
/** 走る向きと区間の向きの開き(度)。これより開いていれば(横切る道・逆向き)、その区間には入らない。 */
const BEFORE_TURN_DEG = 60;

// 区間の中。
/** 新しく区間の中とみなす: 区間の線から横にこの距離(m)まで、向きの開きがこの角度まで。 */
const ENTER_SIDE_M = 50;
const ENTER_TURN_DEG = 40;
/** 出口の手前この距離(m)からは、新しく区間の中とはみなさない(抜ける所でちらつかないように)。 */
const ENTER_END_M = 30;
/** 手前から知らせていた区間は、入口のこの距離(m)手前まで来たら区間の中にする。 */
const ENTER_BACK_M = 25;
/**
 * 区間の中を走っている間は、少しゆるく見る。入口と出口までの距離の和が、区間の長さより
 * この距離(m)以上長くなったら(道がゆるく曲がっていても入る、入口と出口を焦点にした楕円の外)、抜けた。
 */
const KEEP_EXCESS_M = 150;
/** 区間の中: 向きの開きがこれより大きくなったら(曲がった・戻った)、抜けた。 */
const KEEP_TURN_DEG = 80;
/** 区間の中: 入口よりこの距離(m)後ろになったら、抜けた(信号待ちの GPS のずれは許す)。 */
const KEEP_BACK_M = 60;
/** 出口をこの距離(m)過ぎたら、抜けた。 */
const EXIT_PAST_M = 15;

/** 向き(度)を 0〜359 に。 */
const normalize = (degrees: number) => ((degrees % 360) + 360) % 360;
/** 東・北の向き(ベクトル)の向き(度。北が0、東が90)。 */
const headingOf = (east: number, north: number) => normalize(Math.atan2(east, north) / RAD);

/** その区間を、その向き(forward)で走っているときの様子。当てはまらなければ null。 */
const evaluate = (
  zone: SpeedZone,
  forward: boolean,
  car: { lat: number; lng: number },
  heading: number | null,
  kept: ZoneAlert["state"] | null,
): ZoneAlert | null => {
  const entry = zoneOffset(car, forward ? zone.start : zone.end);
  const exit = zoneOffset(car, forward ? zone.end : zone.start);
  const axisEast = exit.east - entry.east;
  const axisNorth = exit.north - entry.north;
  const length = Math.hypot(axisEast, axisNorth);
  if (!(length >= MIN_ZONE_M)) return null;
  const unitEast = axisEast / length;
  const unitNorth = axisNorth / length;
  // 車(原点)は、入口から区間の向きに何m進んだ所か(along)と、区間の線から横に何mずれているか(side)。
  const along = -entry.east * unitEast - entry.north * unitNorth;
  const side = Math.abs(-entry.east * unitNorth + entry.north * unitEast);
  const toEntry = Math.hypot(entry.east, entry.north);
  const toExit = Math.hypot(exit.east, exit.north);
  const turn = heading === null ? null : angleGap(heading, headingOf(unitEast, unitNorth));
  const result = (state: ZoneAlert["state"], distance: number): ZoneAlert => ({
    zone,
    state,
    forward,
    distance,
    length,
    entry,
    exit,
  });

  // 区間の中か。
  if (along <= length + EXIT_PAST_M) {
    const inside =
      kept === "inside"
        ? along >= -KEEP_BACK_M &&
          toEntry + toExit - length <= KEEP_EXCESS_M &&
          (turn === null || turn <= KEEP_TURN_DEG)
        : kept === "before"
          ? along >= -ENTER_BACK_M &&
            toEntry + toExit - length <= KEEP_EXCESS_M &&
            turn !== null &&
            turn <= KEEP_TURN_DEG
          : along >= 0 &&
            along <= length - ENTER_END_M &&
            side <= ENTER_SIDE_M &&
            turn !== null &&
            turn <= ENTER_TURN_DEG;
    if (inside) return result("inside", Math.min(length, Math.max(0, length - along)));
  }

  // 区間の手前か: 入口が前方 500m 以内(オービスと同じ見方)で、区間の向きに走っている。
  if (heading === null || turn === null) return null;
  const keep = kept === "before";
  if (toEntry > ZONE_WARN_M + (keep ? KEEP_EXTRA_M : 0)) return null;
  if (turn > (keep ? KEEP_TURN_DEG : BEFORE_TURN_DEG)) return null;
  const gap = angleGap(headingOf(entry.east, entry.north), heading);
  if (gap > (keep ? KEEP_AHEAD_DEG : AHEAD_DEG)) return null;
  if (toEntry * Math.sin(gap * RAD) > (keep ? KEEP_SIDE_M : SIDE_M)) return null;
  return result("before", toEntry);
};

/**
 * 区間の中か、前方 500m 以内に入口がある速度取締区間を選ぶ(区間の中を先に)。
 * keep は前回知らせていたもの(手前から中へ、中は抜けるまで、少しゆるく見て見失わない)。
 * 走る向き(heading)が分からなければ、中を走っている区間だけを続けて出す。
 */
export const findSpeedZone = (
  zones: SpeedZone[],
  car: { lat: number; lng: number; heading: number | null },
  keep: ZoneAlert | null,
): ZoneAlert | null => {
  const heading = car.heading === null || !Number.isFinite(car.heading) ? null : normalize(car.heading);
  let best: ZoneAlert | null = null;
  let bestRank = Infinity;
  for (const zone of zones) {
    for (const forward of zone.oneWay ? [true] : [true, false]) {
      const kept = keep && keep.zone.id === zone.id && keep.forward === forward ? keep.state : null;
      const found = evaluate(zone, forward, car, heading, kept);
      if (!found) continue;
      // 区間の中を先に。同じなら、続けて知らせているもの、近いもの。
      const rank = (found.state === "inside" ? 0 : 2e7) + (kept ? 0 : 1e7) + found.distance;
      if (rank < bestRank) {
        best = found;
        bestRank = rank;
      }
    }
  }
  return best;
};

/** 声で知らせる言葉。手前は 500m を切ったところで、手前で知らせずに入ったら入ったところで1回。 */
export const zoneMessage = (alert: ZoneAlert) => {
  const limit = alert.zone.limit ? `。制限速度、${alert.zone.limit}キロです` : "";
  if (alert.state === "inside") return `速度取締区間に入りました${limit}`;
  // 初めて見つけたのが警告の距離の近く(50m 以内)なら「500メートル先」、もっと近ければ「この先」。
  const near = alert.distance >= ZONE_WARN_M - 50 ? `${ZONE_WARN_M}メートル先、` : "この先、";
  return `${near}速度取締区間です${limit}`;
};

/** 区間の長さの書き方(一覧・登録の画面。1km 未満は 10m 単位、1km からは 0.1km 単位)。 */
export const zoneLengthText = (meters: number) =>
  meters >= 1000 ? `${(meters / 1000).toFixed(1)}km` : `${Math.round(meters / 10) * 10}m`;
