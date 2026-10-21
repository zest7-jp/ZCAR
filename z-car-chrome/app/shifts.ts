// Zポータル(zest-home)の確定シフト。七塚のシフトを読み、車の上の帯と1週間の画面に出す。
// (前のホーム画面で使っていたのと同じところから読む)

/** 確定シフト1件。date は日本の日付(YYYY-MM-DD)、時刻は HH:MM。 */
export type ConfirmedShift = {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  storeName: string;
  workType: string;
};

export type ShiftFeed = {
  displayName: string;
  updatedAt: string;
  shifts: ConfirmedShift[];
};

export const SHIFT_URL =
  "https://zest-home.amok-uk.chatgpt.site/api/confirmed-shifts?profileId=nanatsuka";
/** シフトを読み直す間隔。 */
export const SHIFT_REFRESH_MS = 30 * 60_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2}$/;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
/** 「9:00」を「09:00」にそろえる(時刻の大小を文字で比べるため)。 */
const hhmm = (value: string) => value.padStart(5, "0");

/** 届いた中身を確かめて、使える形にする(日付と時刻が読めないものは捨てる)。形が違えば null。 */
export const parseShiftFeed = (raw: unknown): ShiftFeed | null => {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.shifts)) return null;
  const shifts = data.shifts.flatMap((item): ConfirmedShift[] => {
    if (!item || typeof item !== "object") return [];
    const shift = item as Record<string, unknown>;
    const date = text(shift.date);
    const startTime = text(shift.startTime);
    const endTime = text(shift.endTime);
    if (!DATE_RE.test(date) || !TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return [];
    if (shift.status !== undefined && shift.status !== "confirmed") return [];
    return [
      {
        id: text(shift.id) || `${date} ${startTime}`,
        date,
        startTime: hhmm(startTime),
        endTime: hhmm(endTime),
        storeName: text(shift.storeName),
        workType: text(shift.workType),
      },
    ];
  });
  shifts.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
  return { displayName: text(data.displayName), updatedAt: text(data.updatedAt), shifts };
};

/** 日本の日付(YYYY-MM-DD)に日数を足す。 */
export const addDays = (date: string, days: number) => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
};

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"];
/** 曜日(「木」など)。 */
export const weekdayJa = (date: string) => {
  const [year, month, day] = date.split("-").map(Number);
  return WEEKDAYS_JA[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
};
/** 「10/24」の形。 */
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/**
 * 次のシフト。今日のシフトは終わる時刻まで(夜をまたぐシフトはその日のうちずっと)今日のものとして出す。
 * now は今の時刻(HH:MM)。
 */
export const nextShift = (feed: ShiftFeed, today: string, now: string) =>
  feed.shifts.find(
    (shift) => shift.date > today || (shift.date === today && (shift.endTime <= shift.startTime || shift.endTime > now)),
  ) ?? null;

/** 上の帯に出す日の呼び名(今日・明日・10/24(土))。 */
export const shiftDayLabel = (date: string, today: string) =>
  date === today ? "今日" : date === addDays(today, 1) ? "明日" : `${shortDate(date)}(${weekdayJa(date)})`;

/** 今日から7日分の、日ごとのシフト(1日に2つ以上あればどれも)。 */
export const shiftWeek = (feed: ShiftFeed, today: string) =>
  Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index);
    return { date, shifts: feed.shifts.filter((shift) => shift.date === date) };
  });
