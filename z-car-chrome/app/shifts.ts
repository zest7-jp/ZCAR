// Zポータル(zest-home)の確定シフト。七塚のシフトを読み、車の上の帯と1週間の画面に出す。
// Zポータルは 2026-10-12 に自社の Cloudflare(portal.zest7.app)へ引っ越した。前の ChatGPT のサイトには
// 9月までのシフトしか残っていないので、新しい住所から読む。

/** 確定シフト1件。date は日本の日付(YYYY-MM-DD)、時刻は HH:MM(読めなければ空)。 */
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
  /** Zポータルから届いたシフトの数(読めなかったもの・取り消しも入れる)。 */
  received: number;
  /** 日付が読めず、捨てたシフトの数(Zポータルの形が変わったときに増える)。 */
  unreadable: number;
};

export const SHIFT_URL = "https://portal.zest7.app/api/confirmed-shifts?profileId=nanatsuka";
/** シフトを読み直す間隔。 */
export const SHIFT_REFRESH_MS = 30 * 60_000;

const DATE_RE = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/;
const TIME_RE = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;
/** 「2026-10-23T13:00:00+09:00」のような日時。 */
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
/** 取り消し・下書きなど、出勤しないシフトの状態。 */
const DROPPED_STATUS = /cancel|reject|draft|pending|取消|取り消|キャンセル|未確定/i;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
/** 最初に中身のある項目(名前が違っても読めるように、いくつかの名前を順に見る)。 */
const pick = (item: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = text(item[key]);
    if (value) return value;
  }
  return "";
};
const pad2 = (value: string) => value.padStart(2, "0");
/** 日本の時刻での日付(YYYY-MM-DD)と時刻(HH:MM)。 */
const japanParts = (time: number) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(time)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
};
/** 日付を YYYY-MM-DD に(2026/10/23・2026-10-23T00:00:00+09:00 なども読む)。読めなければ ""。 */
const readDate = (value: string) => {
  const plain = DATE_RE.exec(value);
  if (plain) return `${plain[1]}-${pad2(plain[2])}-${pad2(plain[3])}`;
  if (!DATETIME_RE.test(value)) return "";
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : japanParts(time).date;
};
/** 時刻を HH:MM に(9:00・09:00:00・日時も読む)。読めなければ ""。 */
const readTime = (value: string) => {
  const plain = TIME_RE.exec(value);
  if (plain) return `${pad2(plain[1])}:${plain[2]}`;
  if (!DATETIME_RE.test(value)) return "";
  const time = Date.parse(value);
  return Number.isNaN(time) ? "" : japanParts(time).time;
};

/**
 * 届いた中身を確かめて、使える形にする。日付が読めないものと、取り消しなどのシフトは捨てる。
 * 時刻が読めないシフトは、時刻なしの出勤として残す。形が違えば null。
 */
export const parseShiftFeed = (raw: unknown): ShiftFeed | null => {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  if (!Array.isArray(data.shifts)) return null;
  let unreadable = 0;
  const shifts = data.shifts.flatMap((item): ConfirmedShift[] => {
    if (!item || typeof item !== "object") {
      unreadable += 1;
      return [];
    }
    const shift = item as Record<string, unknown>;
    const start = pick(shift, ["startTime", "start", "start_time", "startAt", "from"]);
    const end = pick(shift, ["endTime", "end", "end_time", "endAt", "to"]);
    const date = readDate(pick(shift, ["date", "shiftDate", "workDate", "day"]) || start);
    if (!date) {
      unreadable += 1;
      return [];
    }
    if (DROPPED_STATUS.test(text(shift.status))) return [];
    const startTime = readTime(start);
    const endTime = readTime(end);
    return [
      {
        id: text(shift.id) || `${date} ${startTime}`,
        date,
        startTime,
        endTime: startTime ? endTime : "",
        storeName: pick(shift, ["storeName", "store", "storeTitle", "place"]),
        workType: pick(shift, ["workType", "type", "role"]),
      },
    ];
  });
  shifts.sort((a, b) => `${a.date} ${a.startTime}`.localeCompare(`${b.date} ${b.startTime}`));
  return { displayName: text(data.displayName), updatedAt: text(data.updatedAt), shifts, received: data.shifts.length, unreadable };
};

/** 時刻の書き方(「13:00〜22:00」。時刻がないシフトは「出勤」)。 */
export const shiftTimeText = (shift: ConfirmedShift, sep = "〜") =>
  shift.startTime ? `${shift.startTime}${shift.endTime ? `${sep}${shift.endTime}` : ""}` : "出勤";

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
 * 次のシフト。今日のシフトは終わる時刻まで(夜をまたぐシフトと、終わりの時刻がないシフトは、その日のうちずっと)
 * 今日のものとして出す。now は今の時刻(HH:MM)。
 */
export const nextShift = (feed: ShiftFeed, today: string, now: string) =>
  feed.shifts.find(
    (shift) => shift.date > today || (shift.date === today && (!shift.endTime || shift.endTime <= shift.startTime || shift.endTime > now)),
  ) ?? null;

/** 上の帯に出す日の呼び名(今日・明日・10/24(土))。 */
export const shiftDayLabel = (date: string, today: string) =>
  date === today ? "今日" : date === addDays(today, 1) ? "明日" : `${shortDate(date)}(${weekdayJa(date)})`;

/** 今日を含む週(月曜〜日曜)のうち、シフトのある曜日(0 が日曜)。 */
export const workWeekdays = (feed: ShiftFeed, today: string) => {
  const [year, month, day] = today.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const monday = addDays(today, -((weekday + 6) % 7));
  const dates = new Set(feed.shifts.map((shift) => shift.date));
  return new Set(Array.from({ length: 7 }, (_, i) => i).filter((i) => dates.has(addDays(monday, i))).map((i) => (i + 1) % 7));
};

/** 今日から7日分の、日ごとのシフト(1日に2つ以上あればどれも)。 */
export const shiftWeek = (feed: ShiftFeed, today: string) =>
  Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index);
    return { date, shifts: feed.shifts.filter((shift) => shift.date === date) };
  });
