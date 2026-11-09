"use client";

import { useEffect } from "react";
import { TRIP_TTL_MS, type NavTrip, type Settings } from "../settings-store";

/**
 * 今回だけの行き先は、行かなくても TRIP_TTL_MS たつと消す(車とスマホの両方で見る)。
 * そのあいだに新しい行き先に替わっていたら、そちらは消さない。
 */
export function useTripExpiry(
  trip: NavTrip | null,
  setSettings: (update: (current: Settings) => Settings) => void,
) {
  useEffect(() => {
    if (!trip) return;
    const timer = window.setTimeout(
      () =>
        setSettings((current) =>
          current.trip?.id === trip.id ? { ...current, trip: null } : current,
        ),
      Math.max(0, trip.sentAt + TRIP_TTL_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [trip, setSettings]);
}
