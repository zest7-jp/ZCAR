"use client";

import { useEffect, useRef } from "react";
import {
  distanceMeters,
  pingParking,
  pushParking,
  sendParkingBeacon,
  type ParkingReport,
} from "../parking";

/** 走っているとみなす速さ(km/h)。 */
const MOVING_KMH = 8;
/** 前に送った場所からこれ(m)以上離れたら、新しい場所として送る。 */
const MOVED_METERS = 20;
/** 走っている間は、これより短い間隔では送らない。 */
const MOVING_INTERVAL_MS = 60_000;
/** 止まったとき・走り出したときは、前に送ってからこれだけたっていれば、すぐ送る。 */
const STOPPED_INTERVAL_MS = 10_000;
/**
 * 同じ場所にいても、この間隔で送る(電源が入っていることをスマホに知らせる)。
 * スマホは3分届かなければ駐車中にするので、1回届かなくても間に合うようにしておく。
 * GPS が使えない間(ドライブスルーの屋根の下など)も、この間隔で電源が入っていることだけ知らせる。
 */
const HEARTBEAT_MS = 60_000;
/** 送るかどうかを調べる間隔。 */
const CHECK_MS = 5_000;
/** 誤差がこれ(m)より大きい位置は送らない(地下の駐車場などで外れた場所を残さない)。 */
const MAX_ACCURACY_METERS = 100;
/** これより長く止まっていたら、1回の走行は終わり(信号待ちなどの短い停止では続ける)。 */
const TRIP_BREAK_MS = 5 * 60_000;
/**
 * 位置の動きから速さを出すとき、これ(m)と誤差の大きいほうより動いていなければ、
 * 止まっているとみなす(止まっていても GPS の位置は少し揺れるため)。
 */
const MIN_MOVED_METERS = 10;

type Fix = {
  lat: number;
  lng: number;
  accuracy: number;
  /** GPS の速さ(km/h)。分からなければ null。 */
  speed?: number | null;
};

type Options = {
  /** 送ってよいか(車載機で、合言葉があるときだけ)。 */
  enabled: boolean;
  syncKey: string;
  /** いまの場所(GPS)。まだ分からなければ null。 */
  location: Fix | null;
  /** OBD の速さ(km/h)。いま届いていなければ null(そのときは GPS で決める)。 */
  obdSpeed: number | null;
};

/**
 * 車両位置をサーバーへ送る(スマホの「車両位置」に出る)。
 *
 * 車載機の電源が切れる瞬間は、ブラウザからはつかめないことがある。そこで
 * 止まったとき・走っている間(1分おき)・同じ場所にいる間(1分おき)に送っておき、
 * 最後に届いた場所を「停めた場所」とする。画面が消えるとき(電源を切ったときなど)にも、
 * そのときの場所を送る。GPS が使えない間も、電源が入っていることは1分おきに知らせる。
 * 走っている間は、走り出してからの長さも送る(スマホに走行時間と出発時刻を出す)。
 */
export function useParkingReport({ enabled, syncKey, location, obdSpeed }: Options) {
  // 一定の間隔で調べるので、最新の場所と速さは ref から読む。
  const latestRef = useRef({ location, obdSpeed });
  useEffect(() => {
    latestRef.current = { location, obdSpeed };
  });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let busy = false;
    // 最後に送れた場所と時刻と、走っていたか。
    let sent: { lat: number; lng: number; at: number; moving: boolean } | null = null;
    // 最後にサーバーへ届いた時刻(場所でも、電源が入っていることだけの知らせでも)。
    let contactAt = 0;
    // 前に調べたときの場所。速さが分からないときは、ここからの動きで速さを出す。
    let seen: { lat: number; lng: number; at: number } | null = null;
    // 走り出した時刻と、止まった時刻(5分以上止まったら、次に走り出したときが新しい走行)。
    let tripStart: number | null = null;
    let stillSince: number | null = null;

    /** 走っているかどうかで、走行の始まりと終わりを決める。 */
    const track = (moving: boolean, now: number) => {
      if (moving) {
        if (tripStart === null || (stillSince !== null && now - stillSince >= TRIP_BREAK_MS)) {
          tripStart = now;
        }
        stillSince = null;
      } else if (stillSince === null) {
        stillSince = now;
      }
    };

    /** いまの走行の長さ(ミリ秒)。走行中でなければ null。 */
    const drivingMs = (now: number) =>
      tripStart === null || (stillSince !== null && now - stillSince >= TRIP_BREAK_MS)
        ? null
        : now - tripStart;

    /** いま送る内容。場所が分からない・外れているときは null。 */
    const report = (): ParkingReport | null => {
      const { location: fix, obdSpeed: knownKmh } = latestRef.current;
      if (!fix || !(fix.accuracy <= MAX_ACCURACY_METERS)) return null;
      const now = Date.now();
      let kmh = knownKmh;
      if (kmh === null) {
        // OBD が無ければ GPS で決める。GPS の速さが 0 のままの車載機もあるので、
        // 前に調べたときからの位置の動きでも速さを出し、速いほうを使う。
        const gpsKmh = typeof fix.speed === "number" && Number.isFinite(fix.speed) ? fix.speed : null;
        let movedKmh: number | null = null;
        if (seen && now - seen.at >= 1000) {
          const meters = distanceMeters(seen, fix);
          movedKmh =
            meters > Math.max(fix.accuracy, MIN_MOVED_METERS) ? (meters / (now - seen.at)) * 3600 : 0;
        }
        kmh = gpsKmh === null ? movedKmh : Math.max(gpsKmh, movedKmh ?? 0);
      }
      return {
        lat: fix.lat,
        lng: fix.lng,
        accuracy: Math.round(fix.accuracy),
        moving: kmh !== null && kmh >= MOVING_KMH,
      };
    };

    const check = () => {
      if (document.visibilityState !== "visible") return;
      const fix = report();
      if (!fix) {
        // GPS が使えない(屋根の下・まだ測れていない)ときも、電源が入っていることは知らせる。
        // そうしないと、ドライブスルーなどで止まっている間に、スマホが駐車中と思ってしまう。
        if (busy || Date.now() - contactAt < HEARTBEAT_MS) return;
        busy = true;
        void pingParking(syncKey)
          .then((result) => {
            if (active && result.ok) contactAt = Date.now();
          })
          .catch(() => undefined)
          .finally(() => {
            busy = false;
          });
        return;
      }
      const now = Date.now();
      seen = { lat: fix.lat, lng: fix.lng, at: now };
      // 送っている途中でも、走り出し・止まりは数えておく。
      track(fix.moving, now);
      if (busy) return;
      const park = { ...fix, drivingMs: drivingMs(now) };
      if (sent) {
        // 走り出した・止まった(前に送ったときと変わった)ときは、すぐ知らせる。
        const changed = sent.moving !== park.moving;
        const moved = distanceMeters(sent, park) >= MOVED_METERS;
        const wait = changed
          ? STOPPED_INTERVAL_MS
          : moved
            ? park.moving
              ? MOVING_INTERVAL_MS
              : STOPPED_INTERVAL_MS
            : HEARTBEAT_MS;
        if (now - sent.at < wait) return;
      }
      busy = true;
      void pushParking(syncKey, park)
        .then((result) => {
          if (!active || !result.ok) return;
          sent = { lat: park.lat, lng: park.lng, at: Date.now(), moving: park.moving };
          contactAt = sent.at;
        })
        // 圏外などは、次に調べたときに送り直す。
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    };

    // 画面が消える(電源を切る・ほかのアプリにする)ときは、その場所をすぐ送る。
    // 戻ってきたときは、すぐ調べ直す。
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        check();
        return;
      }
      const fix = report();
      if (!fix) return;
      const now = Date.now();
      sendParkingBeacon(syncKey, { ...fix, drivingMs: drivingMs(now) });
      sent = { lat: fix.lat, lng: fix.lng, at: now, moving: fix.moving };
    };

    check();
    const timer = window.setInterval(check, CHECK_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, syncKey]);
}
