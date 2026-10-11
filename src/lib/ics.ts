import type { Recurrence, Reminder } from "./types.js";
import { zonedParts, zonedTimeToUtc } from "./zone.js";

function offsetMinutes(date: Date, timeZone: string): number {
  const parts = zonedParts(date, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function formatOffset(totalMinutes: number): string {
  const sign = totalMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(totalMinutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function icsLocal(date: Date, timeZone: string): string {
  const parts = zonedParts(date, timeZone);
  return `${parts.year}${pad(parts.month)}${pad(parts.day)}T${pad(parts.hour)}${pad(parts.minute)}${pad(parts.second)}`;
}

function icsUtc(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeText(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function fold(line: string): string {
  if (Buffer.byteLength(line) <= 75) return line;
  const parts: string[] = [];
  let rest = line;
  parts.push(rest.slice(0, 75));
  rest = rest.slice(75);
  while (rest.length > 0) {
    parts.push(` ${rest.slice(0, 74)}`);
    rest = rest.slice(74);
  }
  return parts.join("\r\n");
}

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

export function rruleFor(recurrence: Recurrence | null): string | null {
  if (!recurrence) return null;
  const parts: string[] = [];
  if (recurrence.kind === "daily" || recurrence.kind === "every_n_days") parts.push("FREQ=DAILY");
  else if (recurrence.kind === "monthly_date" || recurrence.kind === "monthly_nth") parts.push("FREQ=MONTHLY");
  else parts.push("FREQ=WEEKLY");
  if (recurrence.kind === "every_n_days") parts.push(`INTERVAL=${recurrence.interval}`);
  if (recurrence.kind === "every_n_weeks") parts.push(`INTERVAL=${recurrence.interval}`);
  if (recurrence.kind === "weekdays") parts.push("BYDAY=MO,TU,WE,TH,FR");
  if (recurrence.kind === "weekly" || recurrence.kind === "every_n_weeks") parts.push(`BYDAY=${DAY_CODES[recurrence.weekday]}`);
  if (recurrence.kind === "monthly_date") parts.push(`BYMONTHDAY=${recurrence.day}`);
  if (recurrence.kind === "monthly_nth") parts.push(`BYDAY=${recurrence.nth}${DAY_CODES[recurrence.weekday]}`);
  if (recurrence.ends?.count) {
    const remaining = recurrence.ends.count - recurrence.ends.completed;
    if (remaining > 0) parts.push(`COUNT=${remaining}`);
  }
  if (recurrence.ends?.until) {
    const until = new Date(new Date(recurrence.ends.until).getTime() - 1000);
    parts.push(`UNTIL=${icsUtc(until)}`);
  }
  return parts.join(";");
}

function zoneBlock(timeZone: string, around: Date): string[] {
  const start = zonedTimeToUtc(zonedParts(around, timeZone).year, 1, 1, 0, 0, timeZone);
  const end = new Date(start.getTime() + 500 * 24 * 60 * 60 * 1000);
  const lines = ["BEGIN:VTIMEZONE", `TZID:${timeZone}`, `X-LIC-LOCATION:${timeZone}`];
  let prevAt = start;
  let prev = offsetMinutes(start, timeZone);
  const changes: Array<{ at: Date; from: number; to: number }> = [];
  for (let t = start.getTime(); t < end.getTime(); t += 6 * 60 * 60 * 1000) {
    const at = new Date(t);
    const off = offsetMinutes(at, timeZone);
    if (off === prev) continue;
    let lo = prevAt.getTime();
    let hi = at.getTime();
    while (hi - lo > 60_000) {
      const mid = Math.floor((lo + hi) / 2);
      if (offsetMinutes(new Date(mid), timeZone) === off) hi = mid;
      else lo = mid;
    }
    changes.push({ at: new Date(hi), from: prev, to: off });
    prev = off;
    prevAt = new Date(hi);
  }
  if (!changes.length) {
    const off = formatOffset(prev);
    lines.push("BEGIN:STANDARD", `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, "TZNAME:STD", "DTSTART:19700101T000000", "END:STANDARD", "END:VTIMEZONE");
    return lines;
  }
  for (const change of changes) {
    const daylight = change.to > change.from;
    lines.push(
      daylight ? "BEGIN:DAYLIGHT" : "BEGIN:STANDARD",
      `TZOFFSETFROM:${formatOffset(change.from)}`,
      `TZOFFSETTO:${formatOffset(change.to)}`,
      `TZNAME:${daylight ? "DST" : "STD"}`,
      `DTSTART:${icsLocal(change.at, timeZone)}`,
      daylight ? "END:DAYLIGHT" : "END:STANDARD"
    );
  }
  lines.push("END:VTIMEZONE");
  return lines;
}

function eventLines(reminder: Reminder, now: Date): string[] {
  const start = new Date(reminder.fireAt);
  const end = new Date(start.getTime() + 15 * 60 * 1000);
  const lines = [
    "BEGIN:VEVENT",
    `UID:fillip-${reminder.id}@fillip`,
    `DTSTAMP:${icsUtc(now)}`,
    `DTSTART;TZID=${reminder.timezone}:${icsLocal(start, reminder.timezone)}`,
    `DTEND;TZID=${reminder.timezone}:${icsLocal(end, reminder.timezone)}`,
    `SUMMARY:${escapeText(reminder.what)}`
  ];
  const description = [reminder.context, "Fillip, reminders that fire."].filter(Boolean).join("\\n");
  lines.push(`DESCRIPTION:${escapeText(description)}`);
  const rule = rruleFor(reminder.recurrence);
  if (rule) lines.push(`RRULE:${rule}`);
  lines.push(
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Fillip reminder",
    "TRIGGER:PT0S",
    "END:VALARM",
    "END:VEVENT"
  );
  return lines;
}

export function reminderCalendar(reminder: Reminder, now: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ouroboros//Fillip//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    ...zoneBlock(reminder.timezone, new Date(reminder.fireAt)),
    ...eventLines(reminder, now),
    "END:VCALENDAR"
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}

export function calendarFeed(reminders: Reminder[], now: Date): string {
  const active = reminders.filter((row) => row.status === "active");
  const zones = [...new Set(active.map((row) => row.timezone))];
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ouroboros//Fillip//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Fillip",
    ...zones.flatMap((zone) => zoneBlock(zone, now)),
    ...active.flatMap((row) => eventLines(row, now)),
    "END:VCALENDAR"
  ];
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
