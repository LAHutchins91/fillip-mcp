import {
  addCalendarDays,
  assertTimeZone,
  formatClock,
  formatWhen,
  isRealDate,
  weekdayOf,
  zonedParts,
  interpretWall,
  zonedTimeToUtc
} from "./zone.js";
import type { Recurrence, RecurrenceEnd } from "./types.js";

export class WhenError extends Error {
  suggestion: string | null;
  constructor(message: string, suggestion: string | null = null) {
    super(message);
    this.name = "WhenError";
    this.suggestion = suggestion;
  }
}

export type ResolvedWhen = {
  fireAt: Date;
  recurrence: Recurrence | null;
  corrected: boolean;
  note: string | null;
};

const WEEKDAY = "sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?";
const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_INDEX: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

function weekdayIndex(name: string): number {
  const key = name.slice(0, 3).toLowerCase();
  const index = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(key);
  if (index < 0) throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
  return index;
}

function monthIndex(name: string): number {
  const index = MONTH_INDEX[name.slice(0, 3).toLowerCase()];
  if (!index) throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
  return index;
}

export function parseClock(text: string): { hour: number; minute: number } | null {
  const value = text.trim().replace(/^at\s+/i, "").trim();
  if (!value) return null;
  if (/^noon$/i.test(value)) return { hour: 12, minute: 0 };
  if (/^midnight$/i.test(value)) return { hour: 0, minute: 0 };
  if (/^morning$/i.test(value)) return { hour: 9, minute: 0 };
  if (/^afternoon$/i.test(value)) return { hour: 13, minute: 0 };
  if (/^evening$/i.test(value)) return { hour: 18, minute: 0 };
  const meridiem = value.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)$/i);
  if (meridiem) {
    let hour = Number(meridiem[1]);
    const minute = Number(meridiem[2] ?? "0");
    if (hour < 1 || hour > 12 || minute > 59) return null;
    const pm = /^p/i.test(meridiem[3] ?? "");
    if (hour === 12) hour = pm ? 12 : 0;
    else if (pm) hour += 12;
    return { hour, minute };
  }
  const h24 = value.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (h24) return { hour: Number(h24[1]), minute: Number(h24[2]) };
  return null;
}

const NTH_NAMES = ["", "first", "second", "third", "fourth", "fifth"];

function endPhrase(ends: RecurrenceEnd | undefined): string {
  if (!ends) return "";
  const bits: string[] = [];
  if (ends.count) bits.push(`${ends.count} times`);
  if (ends.until) {
    const last = new Date(new Date(ends.until).getTime() - 1);
    const parts = zonedParts(last, "UTC");
    bits.push(`until ${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`);
  }
  return bits.length ? `, ${bits.join(", ")}` : "";
}

export function describeRecurrence(recurrence: Recurrence | null): string {
  if (!recurrence) return "once";
  const clock = formatClock(recurrence.hour, recurrence.minute);
  const tail = endPhrase(recurrence.ends);
  if (recurrence.kind === "daily") return `every day at ${clock}${tail}`;
  if (recurrence.kind === "weekdays") return `every weekday at ${clock}${tail}`;
  if (recurrence.kind === "weekly") return `every ${WEEKDAY_NAMES[recurrence.weekday]} at ${clock}${tail}`;
  if (recurrence.kind === "every_n_days") return `every ${recurrence.interval} days at ${clock}${tail}`;
  if (recurrence.kind === "every_n_weeks") return `every ${recurrence.interval} weeks on ${WEEKDAY_NAMES[recurrence.weekday]} at ${clock}${tail}`;
  if (recurrence.kind === "monthly_date") return `the ${recurrence.day}${ordinalSuffix(recurrence.day)} of every month at ${clock}${tail}`;
  const nth = recurrence.nth === -1 ? "last" : NTH_NAMES[recurrence.nth] ?? "monthly";
  return `the ${nth} ${WEEKDAY_NAMES[recurrence.weekday]} of every month at ${clock}${tail}`;
}

function ordinalSuffix(day: number): string {
  if (day % 100 >= 11 && day % 100 <= 13) return "th";
  if (day % 10 === 1) return "st";
  if (day % 10 === 2) return "nd";
  if (day % 10 === 3) return "rd";
  return "th";
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nthWeekday(year: number, month: number, nth: number, weekday: number): number | null {
  const last = daysInMonth(year, month);
  if (nth === -1) {
    for (let day = last; day >= 1; day -= 1) {
      if (weekdayOf(year, month, day) === weekday) return day;
    }
    return null;
  }
  let seen = 0;
  for (let day = 1; day <= last; day += 1) {
    if (weekdayOf(year, month, day) !== weekday) continue;
    seen += 1;
    if (seen === nth) return day;
  }
  return null;
}

function withinEnd(recurrence: Recurrence, instant: Date): Date | null {
  if (!recurrence.ends?.until) return instant;
  return instant.getTime() >= new Date(recurrence.ends.until).getTime() ? null : instant;
}

function instantAfter(year: number, month: number, day: number, hour: number, minute: number, timeZone: string, after: Date): Date | null {
  const wall = interpretWall(year, month, day, hour, minute, timeZone);
  for (const instant of wall.instants) {
    if (instant.getTime() > after.getTime()) return instant;
  }
  return null;
}

/** Next instant strictly after `after`, or null when the series has ended. */
export function nextFire(recurrence: Recurrence, timeZone: string, after: Date): Date | null {
  if (recurrence.kind === "every_n_days" || recurrence.kind === "every_n_weeks") {
    const step = recurrence.kind === "every_n_days" ? recurrence.interval : recurrence.interval * 7;
    let cursor: { year: number; month: number; day: number } = zonedParts(new Date(recurrence.anchor), timeZone);
    for (let i = 0; i < 400; i += 1) {
      const instant = instantAfter(cursor.year, cursor.month, cursor.day, recurrence.hour, recurrence.minute, timeZone, after);
      if (instant) return withinEnd(recurrence, instant);
      cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, step);
    }
    throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
  }
  if (recurrence.kind === "monthly_date" || recurrence.kind === "monthly_nth") {
    const start = zonedParts(after, timeZone);
    for (let i = 0; i < 18; i += 1) {
      const monthIndex = start.month - 1 + i;
      const year = start.year + Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      const day = recurrence.kind === "monthly_date"
        ? Math.min(recurrence.day, daysInMonth(year, month))
        : nthWeekday(year, month, recurrence.nth, recurrence.weekday);
      if (!day) continue;
      const instant = instantAfter(year, month, day, recurrence.hour, recurrence.minute, timeZone, after);
      if (instant) return withinEnd(recurrence, instant);
    }
    throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
  }
  const start = zonedParts(after, timeZone);
  for (let i = 0; i < 400; i += 1) {
    const date = addCalendarDays(start.year, start.month, start.day, i);
    const weekday = weekdayOf(date.year, date.month, date.day);
    const matches = recurrence.kind === "daily"
      || (recurrence.kind === "weekdays" && weekday >= 1 && weekday <= 5)
      || (recurrence.kind === "weekly" && weekday === recurrence.weekday);
    if (!matches) continue;
    const instant = instantAfter(date.year, date.month, date.day, recurrence.hour, recurrence.minute, timeZone, after);
    if (instant) return withinEnd(recurrence, instant);
  }
  throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
}

export function advanceSeries(recurrence: Recurrence): { recurrence: Recurrence; done: boolean } {
  if (!recurrence.ends?.count) return { recurrence, done: false };
  const completed = recurrence.ends.completed + 1;
  const next: Recurrence = { ...recurrence, ends: { ...recurrence.ends, completed } };
  return { recurrence: next, done: completed >= recurrence.ends.count };
}

function clockOr(rest: string, fallback: { hour: number; minute: number } | null): { hour: number; minute: number } {
  const trimmed = rest.trim();
  if (!trimmed) {
    if (fallback) return fallback;
    throw new WhenError("Add a time, such as 9am.");
  }
  const clock = parseClock(trimmed);
  if (!clock) throw new WhenError("Add a time, such as 9am.");
  return clock;
}

function rejectBadYear(explicitYear: number, timeZone: string, now: Date, month: number, day: number, hour: number, minute: number) {
  const current = zonedParts(now, timeZone).year;
  if (explicitYear >= current && explicitYear <= current + 1) return;
  const suggestion = suggestCalendar(month, day, hour, minute, timeZone, now);
  throw new WhenError(
    `That year (${explicitYear}) is not a time Fillip will schedule. Reminders use this year or the next one.`,
    suggestion
  );
}

function suggestCalendar(month: number, day: number, hour: number, minute: number, timeZone: string, now: Date): string | null {
  const current = zonedParts(now, timeZone).year;
  for (const year of [current, current + 1]) {
    if (!isRealDate(year, month, day)) continue;
    const instant = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
    if (instant.getTime() > now.getTime()) return formatWhen(instant, timeZone);
  }
  return null;
}

function finishExplicit(instant: Date, explicitYear: number | null, timeZone: string, now: Date, month: number, day: number, hour: number, minute: number): ResolvedWhen {
  if (explicitYear !== null) rejectBadYear(explicitYear, timeZone, now, month, day, hour, minute);
  if (instant.getTime() <= now.getTime()) {
    const suggestion = suggestCalendar(month, day, hour, minute, timeZone, now);
    throw new WhenError("That date has already passed.", suggestion);
  }
  return { fireAt: instant, recurrence: null, corrected: false, note: null };
}

function parseEvery(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const daily = raw.match(/^(?:every\s+day|daily)(?:\s+at)?\s*(.*)$/i);
  const weekly = raw.match(new RegExp(`^every\\s+(${WEEKDAY})(?:\\s+at)?\\s*(.*)$`, "i"));
  const weekdays = raw.match(/^(?:every\s+weekdays?|weekdays)(?:\s+at)?\s*(.*)$/i);
  let recurrence: Recurrence | null = null;
  let rest = "";
  if (daily) {
    const clock = clockOr(daily[1] ?? "", { hour: 9, minute: 0 });
    recurrence = { kind: "daily", hour: clock.hour, minute: clock.minute };
    rest = daily[1] ?? "";
  } else if (weekly) {
    const clock = clockOr(weekly[2] ?? "", { hour: 9, minute: 0 });
    recurrence = { kind: "weekly", weekday: weekdayIndex(weekly[1] ?? ""), hour: clock.hour, minute: clock.minute };
    rest = weekly[2] ?? "";
  } else if (weekdays) {
    const clock = clockOr(weekdays[1] ?? "", { hour: 9, minute: 0 });
    recurrence = { kind: "weekdays", hour: clock.hour, minute: clock.minute };
    rest = weekdays[1] ?? "";
  } else if (/^every\b/i.test(raw)) {
    throw new WhenError("Fillip can repeat every day, every weekday, every N days or weeks, one weekday each week, or a day each month. Try \"every 2 weeks until Dec\" or \"first Monday of every month\".");
  } else {
    return null;
  }
  if (!parseClock(rest.trim() || "9am")) throw new WhenError("Add a time, such as 9am.");
  const fireAt = nextFire(recurrence, timeZone, now);
  if (!fireAt) throw new WhenError("That repeating reminder has already ended.");
  return { fireAt, recurrence, corrected: false, note: null };
}

const NTH_WORD = "first|second|third|fourth|fifth|last";

function nthNumber(word: string): number {
  const index = ["first", "second", "third", "fourth", "fifth"].indexOf(word.toLowerCase());
  return index >= 0 ? index + 1 : -1;
}

function exclusiveEnd(year: number, month: number, day: number, timeZone: string): Date {
  const next = addCalendarDays(year, month, day, 1);
  return zonedTimeToUtc(next.year, next.month, next.day, 0, 0, timeZone);
}

function monthEnd(year: number, month: number, timeZone: string): Date {
  if (month === 12) return zonedTimeToUtc(year + 1, 1, 1, 0, 0, timeZone);
  return zonedTimeToUtc(year, month + 1, 1, 0, 0, timeZone);
}

function parseUntil(text: string, timeZone: string, now: Date): Date {
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    if (!isRealDate(year, month, day)) throw new WhenError("That date is not a real calendar day.");
    const end = exclusiveEnd(year, month, day, timeZone);
    if (end.getTime() <= now.getTime()) throw new WhenError("That date has already passed.");
    return end;
  }
  const named = text.match(new RegExp(`^(${MONTH})(?:\\s+(\\d{1,2})(?:st|nd|rd|th)?)?$`, "i"));
  if (!named) throw new WhenError("Fillip could not read that end date. Try \"until Dec\" or \"until 2026-12-15\".");
  const month = monthIndex(named[1] ?? "");
  const day = named[2] ? Number(named[2]) : null;
  const current = zonedParts(now, timeZone).year;
  for (const year of [current, current + 1]) {
    if (day && !isRealDate(year, month, day)) continue;
    const end = day ? exclusiveEnd(year, month, day, timeZone) : monthEnd(year, month, timeZone);
    if (end.getTime() > now.getTime()) return end;
  }
  throw new WhenError("That date has already passed.");
}

function peelEnds(raw: string): { body: string; untilText: string | null; count: number | null } {
  let body = raw.trim();
  let count: number | null = null;
  const times = body.match(/^(.*)\s+for\s+(\d+)\s+times$/i);
  if (times?.[1] && times[2]) {
    body = times[1].trim();
    count = Number(times[2]);
    if (!Number.isFinite(count) || count < 1) throw new WhenError("Say how many times, such as for 6 times.");
  }
  let untilText: string | null = null;
  const until = body.match(/^(.*)\s+until\s+(.+)$/i);
  if (until?.[1] && until[2]) {
    body = until[1].trim();
    untilText = until[2].trim();
  }
  return { body, untilText, count };
}

function withEnds(resolved: ResolvedWhen, until: Date | null, count: number | null): ResolvedWhen {
  if (!until && count === null) return resolved;
  if (!resolved.recurrence) throw new WhenError("An end date needs a repeating reminder, such as every 2 weeks until Dec.");
  return {
    ...resolved,
    recurrence: { ...resolved.recurrence, ends: { until: until ? until.toISOString() : null, count, completed: 0 } }
  };
}

function requireFire(recurrence: Recurrence, timeZone: string, now: Date): Date {
  const fireAt = nextFire(recurrence, timeZone, now);
  if (!fireAt) throw new WhenError("That repeating reminder has already ended.");
  return fireAt;
}

function parseMonthly(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const nth = raw.match(new RegExp(`^(?:the\\s+)?(${NTH_WORD})\\s+(${WEEKDAY})\\s+of\\s+every\\s+month(?:\\s+at)?\\s*(.*)$`, "i"));
  if (nth) {
    const clock = clockOr(nth[3] ?? "", { hour: 9, minute: 0 });
    const recurrence: Recurrence = {
      kind: "monthly_nth",
      nth: nthNumber(nth[1] ?? ""),
      weekday: weekdayIndex(nth[2] ?? ""),
      hour: clock.hour,
      minute: clock.minute
    };
    return { fireAt: requireFire(recurrence, timeZone, now), recurrence, corrected: false, note: null };
  }
  const dated = raw.match(/^(?:every\s+month\s+on\s+the\s+|monthly\s+on\s+the\s+|the\s+)(\d{1,2})(?:st|nd|rd|th)?(?:\s+of\s+every\s+month)?(?:\s+at)?\s*(.*)$/i);
  if (!dated) return null;
  if (!/every\s+month|monthly/i.test(raw)) return null;
  const day = Number(dated[1]);
  if (day < 1 || day > 31) throw new WhenError("That date is not a real calendar day.");
  const clock = clockOr(dated[2] ?? "", { hour: 9, minute: 0 });
  const recurrence: Recurrence = { kind: "monthly_date", day, hour: clock.hour, minute: clock.minute };
  return { fireAt: requireFire(recurrence, timeZone, now), recurrence, corrected: false, note: null };
}

function parseInterval(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const days = raw.match(/^every\s+(\d+)\s+days?(?:\s+at)?\s*(.*)$/i);
  if (days) {
    const interval = Number(days[1]);
    if (interval < 1 || interval > 366) throw new WhenError("Fillip can repeat every N days with N from 1 to 366.");
    const clock = clockOr(days[2] ?? "", { hour: 9, minute: 0 });
    const parts = zonedParts(now, timeZone);
    let cursor: { year: number; month: number; day: number } = parts;
    let anchorInstant = zonedTimeToUtc(cursor.year, cursor.month, cursor.day, clock.hour, clock.minute, timeZone);
    if (anchorInstant.getTime() <= now.getTime()) {
      cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, 1);
      anchorInstant = zonedTimeToUtc(cursor.year, cursor.month, cursor.day, clock.hour, clock.minute, timeZone);
    }
    const recurrence: Recurrence = {
      kind: "every_n_days",
      interval,
      hour: clock.hour,
      minute: clock.minute,
      anchor: anchorInstant.toISOString()
    };
    const fireAt = requireFire(recurrence, timeZone, now);
    recurrence.anchor = fireAt.toISOString();
    return { fireAt, recurrence, corrected: false, note: null };
  }
  const weeks = raw.match(new RegExp(`^every\\s+(\\d+)\\s+weeks?(?:\\s+on)?(?:\\s+(${WEEKDAY}))?(?:\\s+at)?\\s*(.*)$`, "i"));
  if (!weeks) return null;
  const interval = Number(weeks[1]);
  if (interval < 1 || interval > 52) throw new WhenError("Fillip can repeat every N weeks with N from 1 to 52.");
  const clock = clockOr(weeks[3] ?? "", { hour: 9, minute: 0 });
  const parts = zonedParts(now, timeZone);
  const weekday = weeks[2] ? weekdayIndex(weeks[2]) : null;
  let cursor: { year: number; month: number; day: number } = parts;
  if (weekday !== null) {
    const delta = (weekday - parts.weekday + 7) % 7;
    cursor = addCalendarDays(parts.year, parts.month, parts.day, delta);
  }
  let anchorInstant = zonedTimeToUtc(cursor.year, cursor.month, cursor.day, clock.hour, clock.minute, timeZone);
  if (anchorInstant.getTime() <= now.getTime()) {
    cursor = addCalendarDays(cursor.year, cursor.month, cursor.day, weekday !== null ? 7 : 1);
    anchorInstant = zonedTimeToUtc(cursor.year, cursor.month, cursor.day, clock.hour, clock.minute, timeZone);
  }
  const recurrence: Recurrence = {
    kind: "every_n_weeks",
    interval,
    weekday: weekdayOf(cursor.year, cursor.month, cursor.day),
    hour: clock.hour,
    minute: clock.minute,
    anchor: anchorInstant.toISOString()
  };
  const fireAt = requireFire(recurrence, timeZone, now);
  recurrence.anchor = fireAt.toISOString();
  return { fireAt, recurrence, corrected: false, note: null };
}

function gapNote(hour: number, minute: number, fireAt: Date, timeZone: string): string {
  return `${formatClock(hour, minute)} does not exist that day because of daylight saving. Fillip moved it to ${formatWhen(fireAt, timeZone)}.`;
}

function overlapNote(hour: number, minute: number, fireAt: Date, instants: Date[], timeZone: string): string {
  const which = fireAt.getTime() === instants[0]?.getTime() ? "the first" : "the second";
  return `${formatClock(hour, minute)} is ambiguous when daylight saving ends. Fillip chose ${which} one, ${formatWhen(fireAt, timeZone)}.`;
}

function parseRelative(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const match = raw.match(/^(?:in|after)\s+(\d+)\s+(minutes?|mins?|hours?|days?|weeks?)$/i);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(count) || count < 1) throw new WhenError("That time is in the past. Give a future time, such as tomorrow at 9am.");
  if (unit.startsWith("day") || unit.startsWith("week")) {
    const days = unit.startsWith("week") ? count * 7 : count;
    if (days > 366) throw new WhenError("That year is too far out. Reminders use this year or the next one.");
    const parts = zonedParts(now, timeZone);
    const date = addCalendarDays(parts.year, parts.month, parts.day, days);
    const wall = interpretWall(date.year, date.month, date.day, parts.hour, parts.minute, timeZone);
    const fireAt = wall.instants.find((instant) => instant.getTime() > now.getTime()) ?? wall.instants[0];
    if (!fireAt) throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
    const local = zonedParts(fireAt, timeZone);
    const sameClock = local.hour === parts.hour && local.minute === parts.minute && !wall.gap;
    const note = sameClock ? null : wall.gap
      ? gapNote(parts.hour, parts.minute, fireAt, timeZone)
      : `Daylight saving changes the clock that day, so Fillip set ${formatWhen(fireAt, timeZone)} instead of ${formatClock(parts.hour, parts.minute)}.`;
    return { fireAt, recurrence: null, corrected: Boolean(note), note };
  }
  let ms = 0;
  if (unit.startsWith("min")) ms = count * 60_000;
  else ms = count * 3_600_000;
  if (ms > 366 * 86_400_000) throw new WhenError("That year is too far out. Reminders use this year or the next one.");
  return { fireAt: new Date(now.getTime() + ms), recurrence: null, corrected: false, note: null };
}

function parseTodayTomorrow(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const match = raw.match(/^(today|tomorrow)(?:\s+at)?\s*(.*)$/i);
  if (!match) return null;
  const clock = clockOr(match[2] ?? "", { hour: 9, minute: 0 });
  const parts = zonedParts(now, timeZone);
  const date = (match[1] ?? "").toLowerCase() === "tomorrow"
    ? addCalendarDays(parts.year, parts.month, parts.day, 1)
    : parts;
  const wall = interpretWall(date.year, date.month, date.day, clock.hour, clock.minute, timeZone);
  const upcoming = wall.instants.filter((instant) => instant.getTime() > now.getTime());
  const fireAt = upcoming[0];
  if (!fireAt) {
    const tomorrow = addCalendarDays(parts.year, parts.month, parts.day, 1);
    const suggestion = formatWhen(zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, clock.hour, clock.minute, timeZone), timeZone);
    throw new WhenError("That time today has already passed.", suggestion);
  }
  if (wall.gap) return { fireAt, recurrence: null, corrected: true, note: gapNote(clock.hour, clock.minute, fireAt, timeZone) };
  if (wall.ambiguous) return { fireAt, recurrence: null, corrected: true, note: overlapNote(clock.hour, clock.minute, fireAt, wall.instants, timeZone) };
  return { fireAt, recurrence: null, corrected: false, note: null };
}

function parseWeekday(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const match = raw.match(new RegExp(`^(next|this)?\\s*(${WEEKDAY})(?:\\s+at)?\\s*(.*)$`, "i"));
  if (!match) return null;
  const qualifier = (match[1] ?? "").toLowerCase();
  const target = weekdayIndex(match[2] ?? "");
  const clock = clockOr(match[3] ?? "", { hour: 9, minute: 0 });
  const parts = zonedParts(now, timeZone);
  let delta = (target - parts.weekday + 7) % 7;
  if (qualifier === "next" && delta === 0) delta = 7;
  let date = addCalendarDays(parts.year, parts.month, parts.day, delta);
  let instant = zonedTimeToUtc(date.year, date.month, date.day, clock.hour, clock.minute, timeZone);
  let corrected = false;
  if (instant.getTime() <= now.getTime()) {
    date = addCalendarDays(date.year, date.month, date.day, 7);
    instant = zonedTimeToUtc(date.year, date.month, date.day, clock.hour, clock.minute, timeZone);
    corrected = true;
  }
  const note = corrected ? `That time already passed, so Fillip moved it to ${formatWhen(instant, timeZone)}.` : null;
  return { fireAt: instant, recurrence: null, corrected, note };
}

function parseNextWeek(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const match = raw.match(/^next\s+week(?:\s+at)?\s*(.*)$/i);
  if (!match) return null;
  const clock = clockOr(match[1] ?? "", { hour: 9, minute: 0 });
  const parts = zonedParts(now, timeZone);
  const date = addCalendarDays(parts.year, parts.month, parts.day, 7);
  const instant = zonedTimeToUtc(date.year, date.month, date.day, clock.hour, clock.minute, timeZone);
  return { fireAt: instant, recurrence: null, corrected: false, note: null };
}

function fromWall(year: number, month: number, day: number, hour: number, minute: number, timeZone: string, now: Date): ResolvedWhen {
  const wall = interpretWall(year, month, day, hour, minute, timeZone);
  const fireAt = wall.instants.find((instant) => instant.getTime() > now.getTime()) ?? null;
  if (!fireAt) {
    const suggestion = suggestCalendar(month, day, hour, minute, timeZone, now);
    throw new WhenError("That date has already passed.", suggestion);
  }
  if (wall.gap) return { fireAt, recurrence: null, corrected: true, note: gapNote(hour, minute, fireAt, timeZone) };
  if (wall.ambiguous) return { fireAt, recurrence: null, corrected: true, note: overlapNote(hour, minute, fireAt, wall.instants, timeZone) };
  return { fireAt, recurrence: null, corrected: false, note: null };
}

function placeCalendar(month: number, day: number, hour: number, minute: number, explicitYear: number | null, timeZone: string, now: Date): ResolvedWhen {
  const current = zonedParts(now, timeZone).year;
  const year = explicitYear ?? current;
  if (!isRealDate(year, month, day)) throw new WhenError("That date is not a real calendar day.");
  if (explicitYear !== null) {
    rejectBadYear(explicitYear, timeZone, now, month, day, hour, minute);
    return fromWall(year, month, day, hour, minute, timeZone, now);
  }
  try {
    return fromWall(year, month, day, hour, minute, timeZone, now);
  } catch (error) {
    if (!(error instanceof WhenError)) throw error;
    const rolled = year + 1;
    if (!isRealDate(rolled, month, day)) throw error;
    const next = fromWall(rolled, month, day, hour, minute, timeZone, now);
    return {
      fireAt: next.fireAt,
      recurrence: null,
      corrected: true,
      note: next.note ?? `That date already passed this year, so Fillip moved it to ${formatWhen(next.fireAt, timeZone)}.`
    };
  }
}

function parseMonth(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const match = raw.match(new RegExp(`^(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,\\s*|\\s+)?(?:(\\d{4}))?(?:\\s*,\\s*|\\s+)?(?:at\\s+)?(.*)$`, "i"));
  if (!match) return null;
  const month = monthIndex(match[1] ?? "");
  const day = Number(match[2]);
  const explicit = match[3] ? Number(match[3]) : null;
  const clock = clockOr(match[4] ?? "", { hour: 9, minute: 0 });
  return placeCalendar(month, day, clock.hour, clock.minute, explicit, timeZone, now);
}

function parseSlash(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const match = raw.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?(?:\s*,\s*|\s+)?(?:at\s+)?(.*)$/i);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12) return null;
  const explicit = match[3] ? Number(match[3]) : null;
  const clock = clockOr(match[4] ?? "", { hour: 9, minute: 0 });
  return placeCalendar(month, day, clock.hour, clock.minute, explicit, timeZone, now);
}

function parseIso(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t\s](\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?)?(z|[+-]\d{2}:?\d{2})?$/i);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = match[4] === undefined ? 9 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  if (hour > 23 || minute > 59) throw new WhenError("Add a time, such as 9am.");
  if (match[6]) {
    const instant = new Date(raw);
    if (Number.isNaN(instant.getTime())) throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
    const parts = zonedParts(instant, timeZone);
    return finishExplicit(instant, year, timeZone, now, parts.month, parts.day, parts.hour, parts.minute);
  }
  return placeCalendar(month, day, hour, minute, year, timeZone, now);
}

function parseClockOnly(raw: string, timeZone: string, now: Date): ResolvedWhen | null {
  const clock = parseClock(raw);
  if (!clock) return null;
  const parts = zonedParts(now, timeZone);
  let instant = zonedTimeToUtc(parts.year, parts.month, parts.day, clock.hour, clock.minute, timeZone);
  if (instant.getTime() <= now.getTime()) {
    const next = addCalendarDays(parts.year, parts.month, parts.day, 1);
    instant = zonedTimeToUtc(next.year, next.month, next.day, clock.hour, clock.minute, timeZone);
    return {
      fireAt: instant,
      recurrence: null,
      corrected: true,
      note: `That time today has already passed, so Fillip moved it to ${formatWhen(instant, timeZone)}.`
    };
  }
  return { fireAt: instant, recurrence: null, corrected: false, note: null };
}

export function resolveWhen(input: string, timeZone: string, now: Date): ResolvedWhen {
  const zone = assertTimeZone(timeZone);
  const raw = input.trim().replace(/\s+/g, " ");
  if (!raw) throw new WhenError("Say when to ping you, such as next Tuesday at 2pm.");
  if (/^(yesterday|last\b|\d+\s+\w+\s+ago\b)/i.test(raw)) {
    throw new WhenError("That time is in the past. Give a future time, such as tomorrow at 9am.");
  }
  const peeled = peelEnds(raw);
  const parsed = parseMonthly(peeled.body, zone, now)
    ?? parseInterval(peeled.body, zone, now)
    ?? parseEvery(peeled.body, zone, now)
    ?? parseRelative(peeled.body, zone, now)
    ?? parseTodayTomorrow(peeled.body, zone, now)
    ?? parseNextWeek(peeled.body, zone, now)
    ?? parseWeekday(peeled.body, zone, now)
    ?? parseMonth(peeled.body, zone, now)
    ?? parseSlash(peeled.body, zone, now)
    ?? parseIso(peeled.body, zone, now)
    ?? parseClockOnly(peeled.body, zone, now);
  if (!parsed) throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
  const until = peeled.untilText ? parseUntil(peeled.untilText, zone, now) : null;
  return withEnds(parsed, until, peeled.count);
}

export type RepeatChoice = "once" | "daily" | "weekdays" | "weekly";

function repeatAgrees(recurrence: Recurrence, repeat: RepeatChoice, timeZone: string, fireAt: Date): boolean {
  if (repeat === "once") return false;
  if (repeat === "daily") return recurrence.kind === "daily" || (recurrence.kind === "every_n_days" && recurrence.interval === 1);
  if (repeat === "weekdays") return recurrence.kind === "weekdays";
  if (recurrence.kind === "weekly") return true;
  if (recurrence.kind === "every_n_weeks" && recurrence.interval === 1) {
    return recurrence.weekday === zonedParts(fireAt, timeZone).weekday;
  }
  return false;
}

export function applyRepeat(resolved: ResolvedWhen, repeat: RepeatChoice | undefined, timeZone: string): ResolvedWhen {
  if (!repeat) return resolved;
  const existing = resolved.recurrence;
  if (!existing) {
    if (repeat === "once") return { ...resolved, recurrence: null };
    const parts = zonedParts(resolved.fireAt, timeZone);
    if (repeat === "daily") return { ...resolved, recurrence: { kind: "daily", hour: parts.hour, minute: parts.minute } };
    if (repeat === "weekdays") return { ...resolved, recurrence: { kind: "weekdays", hour: parts.hour, minute: parts.minute } };
    return { ...resolved, recurrence: { kind: "weekly", weekday: parts.weekday, hour: parts.hour, minute: parts.minute } };
  }
  if (repeatAgrees(existing, repeat, timeZone, resolved.fireAt)) return resolved;
  throw new WhenError(`Those words already schedule this as ${describeRecurrence(existing)}, which conflicts with repeat "${repeat}". Leave repeat off when the words include the schedule.`);
}

export function recurrenceFromCadence(cadence: string, timeZone: string, now: Date): Recurrence {
  const resolved = resolveWhen(cadence, timeZone, now);
  if (!resolved.recurrence) {
    throw new WhenError("Fillip can repeat every day, every weekday, every N days or weeks, one weekday each week, or a day each month. Try \"every 2 weeks until Dec\" or \"first Monday of every month\".");
  }
  return resolved.recurrence;
}
