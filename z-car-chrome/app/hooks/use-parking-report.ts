"use client";

import { useEffect, useRef } from "react";
import {
  distanceMeters,
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
/** 止まったら、前に送ってからこれだけたっていれば、すぐ送る。 */
const STOPPED_INTERVAL_MS = 10_000;
/** 同じ場所にいても、この間隔で送る(電源が入っていることをスマホに知らせる)。 */
const HEARTBEAT_MS = 2 * 60_000;
/** 送るかどうかを調べる間隔。 */
const CHECK_MS = 5_000;
/** 誤差がこれ(m)より大きい位置は送らない(地下の駐車場などで外れた場所を残さない)。 */
const MAX_ACCURACY_METERS = 100;

type Fix = { lat: number; lng: number; accuracy: number };

type Options = {
  /** 送ってよいか(車載機で、合言葉があるときだけ)。 */
  enabled: boolean;
  syncKey: string;
  /** いまの場所(GPS)。まだ分からなければ null。 */
  location: Fix | null;
  /** 速さ(km/h)。OBD か GPS から。分からなければ null。 */
  speed: number | null;
};

/**
 * 車両位置をサーバーへ送る(スマホの「車両位置」に出る)。
 *
 * 車載機の電源が切れる瞬間は、ブラウザからはつかめないことがある。そこで
 * 止まったとき・走っている間(1分おき)・同じ場所にいる間(2分おき)に送っておき、
 * 最後に届いた場所を「停めた場所」とする。画面が消えるとき(電源を切ったときなど)にも、
 * そのときの場所を送る。
 */
export function useParkingReport({ enabled, syncKey, location, speed }: Options) {
  // 一定の間隔で調べるので、最新の場所と速さは ref から読む。
  const latestRef = useRef({ location, speed });
  useEffect(() => {
    latestRef.current = { location, speed };
  });

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let busy = false;
    // 最後に送れた場所と時刻。
    let sent: { lat: number; lng: number; at: number } | null = null;
    // 前に調べたときの場所。速さが分からないときは、ここからの動きで速さを出す。
    let seen: { lat: number; lng: number; at: number } | null = null;

    /** いま送る内容。場所が分からない・外れているときは null。 */
    const report = (): ParkingReport | null => {
      const { location: fix, speed: knownKmh } = latestRef.current;
      if (!fix || !(fix.accuracy <= MAX_ACCURACY_METERS)) return null;
      const now = Date.now();
      let kmh = knownKmh;
      if (kmh === null && seen && now - seen.at >= 1000) {
        kmh = (distanceMeters(seen, fix) / (now - seen.at)) * 3600;
      }
      return {
        lat: fix.lat,
        lng: fix.lng,
        accuracy: Math.round(fix.accuracy),
        moving: kmh !== null && kmh >= MOVING_KMH,
      };
    };

    const check = () => {
      if (busy || document.visibilityState !== "visible") return;
      const park = report();
      if (!park) return;
      const now = Date.now();
      seen = { lat: park.lat, lng: park.lng, at: now };
      if (sent) {
        const moved = distanceMeters(sent, park) >= MOVED_METERS;
        const wait = moved
          ? park.moving
            ? MOVING_INTERVAL_MS
            : STOPPED_INTERVAL_MS
          : HEARTBEAT_MS;
        if (now - sent.at < wait) return;
      }
      busy = true;
      void pushParking(syncKey, park)
        .then((result) => {
          if (active && result.ok) sent = { lat: park.lat, lng: park.lng, at: Date.now() };
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
      const park = report();
      if (!park) return;
      sendParkingBeacon(syncKey, park);
      sent = { lat: park.lat, lng: park.lng, at: Date.now() };
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
