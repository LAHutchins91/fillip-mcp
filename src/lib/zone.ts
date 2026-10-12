export type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
};

const WEEKDAY_INDEX: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
};

/** Zones ICU accepts that some Node builds omit from supportedValuesOf. */
const CANONICAL_UTC = new Set(["UTC", "Etc/UTC", "GMT", "Etc/GMT"]);

export function assertTimeZone(timeZone: string): string {
  const zone = timeZone.trim();
  if (!zone) throw new Error("Choose a timezone from the IANA list, such as America/New_York.");
  if (CANONICAL_UTC.has(zone)) return zone;
  let listed = false;
  try {
    listed = Intl.supportedValuesOf("timeZone").includes(zone);
  } catch {
    listed = false;
  }
  if (!listed) throw new Error("Choose a timezone from the IANA list, such as America/New_York.");
  return zone;
}

export function zonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const bag: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) bag[part.type] = part.value;
  let hour = Number(bag.hour);
  if (hour === 24) hour = 0;
  const weekday = WEEKDAY_INDEX[(bag.weekday ?? "").slice(0, 3).toLowerCase()] ?? 0;
  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour,
    minute: Number(bag.minute),
    second: Number(bag.second),
    weekday
  };
}

function offsetMs(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - date.getTime();
}

export type WallClock = {
  instants: Date[];
  /** The named clock does not exist because the zone sprang forward. */
  gap: boolean;
  /** The named clock happens twice because the zone fell back. */
  ambiguous: boolean;
};

function matchesWall(date: Date, year: number, month: number, day: number, hour: number, minute: number, timeZone: string): boolean {
  const parts = zonedParts(date, timeZone);
  return parts.year === year && parts.month === month && parts.day === day && parts.hour === hour && parts.minute === minute;
}

/** Every UTC instant that reads as this wall clock, earliest first. Empty when the clock is skipped. */
export function matchingInstants(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date[] {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const found = new Map<number, Date>();
  for (let hours = -14; hours <= 14; hours += 1) {
    const off = offsetMs(new Date(utcGuess + hours * 3_600_000), timeZone);
    const date = new Date(utcGuess - off);
    if (!matchesWall(date, year, month, day, hour, minute, timeZone)) continue;
    found.set(date.getTime(), date);
  }
  return [...found.values()].sort((a, b) => a.getTime() - b.getTime());
}

/**
 * Wall-clock time in an IANA zone.
 * A spring-forward gap moves forward one hour and is marked `gap`.
 * A fall-back overlap returns both instants, earlier first.
 */
export function interpretWall(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): WallClock {
  const instants = matchingInstants(year, month, day, hour, minute, timeZone);
  if (instants.length > 0) return { instants, gap: false, ambiguous: instants.length > 1 };
  const forwardHour = hour + 1;
  const rolled = forwardHour <= 23
    ? matchingInstants(year, month, day, forwardHour, minute, timeZone)
    : [];
  if (rolled.length > 0) return { instants: [rolled[0]!], gap: true, ambiguous: false };
  const next = addCalendarDays(year, month, day, 1);
  const skipped = matchingInstants(next.year, next.month, next.day, hour, minute, timeZone);
  const fallback = skipped[0] ?? new Date(Date.UTC(year, month - 1, day, hour, minute));
  return { instants: [fallback], gap: true, ambiguous: false };
}

/** Wall-clock time in an IANA zone, as a UTC instant. Gaps move forward. Overlaps use the earlier instant. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): Date {
  return interpretWall(year, month, day, hour, minute, timeZone).instants[0] ?? new Date(Date.UTC(year, month - 1, day, hour, minute));
}

export function localDayStart(now: Date, timeZone: string): Date {
  const parts = zonedParts(now, timeZone);
  return zonedTimeToUtc(parts.year, parts.month, parts.day, 0, 0, timeZone);
}

export function nextLocalDayStart(now: Date, timeZone: string): Date {
  const parts = zonedParts(now, timeZone);
  const next = addCalendarDays(parts.year, parts.month, parts.day, 1);
  return zonedTimeToUtc(next.year, next.month, next.day, 0, 0, timeZone);
}

export function nextLocalMonthStart(now: Date, timeZone: string): Date {
  const parts = zonedParts(now, timeZone);
  const month = parts.month === 12 ? 1 : parts.month + 1;
  const year = parts.month === 12 ? parts.year + 1 : parts.year;
  return zonedTimeToUtc(year, month, 1, 0, 0, timeZone);
}

export function addCalendarDays(year: number, month: number, day: number, days: number) {
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

/** "Nov 2 at 9:00 AM" — month, day, and clock, without the weekday or year. */
export function formatShortWhen(date: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
  return formatted.replace(",", " at");
}

/** "Tue Oct 13 at 9:00 AM" in the reminder's timezone. */
export function formatNextOccurrence(date: Date, timeZone: string): string {
  const formatted = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date).replace(/,/g, "");
  const clockAt = formatted.search(/\d{1,2}:\d{2}\s*[AP]M$/);
  if (clockAt < 0) return formatted;
  return `${formatted.slice(0, clockAt).trimEnd()} at ${formatted.slice(clockAt)}`;
}

export function formatWhen(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function formatClock(hour: number, minute: number): string {
  const suffix = hour >= 12 ? "PM" : "AM";
  const h = hour % 12 === 0 ? 12 : hour % 12;
  return `${h}:${String(minute).padStart(2, "0")} ${suffix}`;
}

export function localDateKey(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}
