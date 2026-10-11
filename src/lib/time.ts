import {
  addCalendarDays,
  assertTimeZone,
  formatClock,
  formatWhen,
  isRealDate,
  weekdayOf,
  zonedParts,
  zonedTimeToUtc
} from "./zone.js";
import type { Recurrence } from "./types.js";

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

export function describeRecurrence(recurrence: Recurrence | null): string {
  if (!recurrence) return "once";
  const clock = formatClock(recurrence.hour, recurrence.minute);
  if (recurrence.kind === "daily") return `every day at ${clock}`;
  if (recurrence.kind === "weekdays") return `every weekday at ${clock}`;
  return `every ${WEEKDAY_NAMES[recurrence.weekday]} at ${clock}`;
}

/** Next instant strictly after `after` that matches the recurrence. */
export function nextFire(recurrence: Recurrence, timeZone: string, after: Date): Date {
  const start = zonedParts(after, timeZone);
  for (let i = 0; i < 21; i += 1) {
    const date = addCalendarDays(start.year, start.month, start.day, i);
    const weekday = weekdayOf(date.year, date.month, date.day);
    const matches = recurrence.kind === "daily"
      || (recurrence.kind === "weekdays" && weekday >= 1 && weekday <= 5)
      || (recurrence.kind === "weekly" && weekday === recurrence.weekday);
    if (!matches) continue;
    const instant = zonedTimeToUtc(date.year, date.month, date.day, recurrence.hour, recurrence.minute, timeZone);
    if (instant.getTime() > after.getTime()) return instant;
  }
  throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
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
    throw new WhenError("Fillip can repeat every day, every weekday, or one weekday each week. Try \"every weekday 9am\".");
  } else {
    return null;
  }
  if (!parseClock(rest.trim() || "9am")) throw new WhenError("Add a time, such as 9am.");
  const fireAt = nextFire(recurrence, timeZone, now);
  return { fireAt, recurrence, corrected: false, note: null };
}

function parseRelative(raw: string, now: Date): ResolvedWhen | null {
  const match = raw.match(/^(?:in|after)\s+(\d+)\s+(minutes?|mins?|hours?|days?|weeks?)$/i);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = (match[2] ?? "").toLowerCase();
  if (!Number.isFinite(count) || count < 1) throw new WhenError("That time is in the past. Give a future time, such as tomorrow at 9am.");
  let ms = 0;
  if (unit.startsWith("min")) ms = count * 60_000;
  else if (unit.startsWith("hour")) ms = count * 3_600_000;
  else if (unit.startsWith("day")) ms = count * 86_400_000;
  else ms = count * 7 * 86_400_000;
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
  const instant = zonedTimeToUtc(date.year, date.month, date.day, clock.hour, clock.minute, timeZone);
  if (instant.getTime() <= now.getTime()) {
    const tomorrow = addCalendarDays(parts.year, parts.month, parts.day, 1);
    const suggestion = formatWhen(zonedTimeToUtc(tomorrow.year, tomorrow.month, tomorrow.day, clock.hour, clock.minute, timeZone), timeZone);
    throw new WhenError("That time today has already passed.", suggestion);
  }
  return { fireAt: instant, recurrence: null, corrected: false, note: null };
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

function placeCalendar(month: number, day: number, hour: number, minute: number, explicitYear: number | null, timeZone: string, now: Date): ResolvedWhen {
  const current = zonedParts(now, timeZone).year;
  const year = explicitYear ?? current;
  if (!isRealDate(year, month, day)) throw new WhenError("That date is not a real calendar day.");
  if (explicitYear !== null) {
    const instant = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
    return finishExplicit(instant, explicitYear, timeZone, now, month, day, hour, minute);
  }
  let instant = zonedTimeToUtc(year, month, day, hour, minute, timeZone);
  if (instant.getTime() <= now.getTime()) {
    const rolled = year + 1;
    if (!isRealDate(rolled, month, day)) throw new WhenError("That date is not a real calendar day.");
    instant = zonedTimeToUtc(rolled, month, day, hour, minute, timeZone);
    if (instant.getTime() <= now.getTime()) throw new WhenError("That date has already passed.");
    return {
      fireAt: instant,
      recurrence: null,
      corrected: true,
      note: `That date already passed this year, so Fillip moved it to ${formatWhen(instant, timeZone)}.`
    };
  }
  return { fireAt: instant, recurrence: null, corrected: false, note: null };
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
  const parsed = parseEvery(raw, zone, now)
    ?? parseRelative(raw, now)
    ?? parseTodayTomorrow(raw, zone, now)
    ?? parseNextWeek(raw, zone, now)
    ?? parseWeekday(raw, zone, now)
    ?? parseMonth(raw, zone, now)
    ?? parseSlash(raw, zone, now)
    ?? parseIso(raw, zone, now)
    ?? parseClockOnly(raw, zone, now);
  if (!parsed) throw new WhenError("Fillip could not read that time. Try \"next Tue 2pm\" or \"every weekday 9am\".");
  return parsed;
}

export type RepeatChoice = "once" | "daily" | "weekdays" | "weekly";

export function applyRepeat(resolved: ResolvedWhen, repeat: RepeatChoice | undefined, timeZone: string): ResolvedWhen {
  if (!repeat) return resolved;
  if (repeat === "once") return { ...resolved, recurrence: null };
  const parts = zonedParts(resolved.fireAt, timeZone);
  if (repeat === "daily") return { ...resolved, recurrence: { kind: "daily", hour: parts.hour, minute: parts.minute } };
  if (repeat === "weekdays") return { ...resolved, recurrence: { kind: "weekdays", hour: parts.hour, minute: parts.minute } };
  return { ...resolved, recurrence: { kind: "weekly", weekday: parts.weekday, hour: parts.hour, minute: parts.minute } };
}

export function recurrenceFromCadence(cadence: string, timeZone: string, now: Date): Recurrence {
  const resolved = resolveWhen(cadence, timeZone, now);
  if (!resolved.recurrence) {
    throw new WhenError("Fillip can repeat every day, every weekday, or one weekday each week. Try \"every weekday 9am\".");
  }
  return resolved.recurrence;
}
