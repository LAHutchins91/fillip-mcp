import { describe, expect, it } from "vitest";
import { advanceSeries, applyRepeat, nextFire, WhenError, resolveWhen } from "../src/lib/time.js";
import { zonedParts, zonedTimeToUtc } from "../src/lib/zone.js";

const zone = "America/New_York";
const now = new Date("2026-10-11T18:00:00.000Z");

function expectParts(date: Date, parts: { year: number; month: number; day: number; hour: number; minute: number }) {
  const actual = zonedParts(date, zone);
  expect(actual.year).toBe(parts.year);
  expect(actual.month).toBe(parts.month);
  expect(actual.day).toBe(parts.day);
  expect(actual.hour).toBe(parts.hour);
  expect(actual.minute).toBe(parts.minute);
}

describe("natural language times", () => {
  it("reads next Tue 2pm in the user's timezone", () => {
    const resolved = resolveWhen("next Tue 2pm", zone, now);
    expect(resolved.corrected).toBe(false);
    expect(resolved.recurrence).toBeNull();
    expectParts(resolved.fireAt, { year: 2026, month: 10, day: 13, hour: 14, minute: 0 });
    expect(resolved.fireAt.toISOString()).toBe("2026-10-13T18:00:00.000Z");
  });

  it("reads next Tuesday at 2pm the same way", () => {
    const resolved = resolveWhen("next Tuesday at 2pm", zone, now);
    expectParts(resolved.fireAt, { year: 2026, month: 10, day: 13, hour: 14, minute: 0 });
  });

  it("schedules every weekday 9am on the next weekday", () => {
    const resolved = resolveWhen("every weekday 9am", zone, now);
    expect(resolved.recurrence).toEqual({ kind: "weekdays", hour: 9, minute: 0 });
    expectParts(resolved.fireAt, { year: 2026, month: 10, day: 12, hour: 9, minute: 0 });
  });

  it("keeps a weekly cadence on the named weekday", () => {
    const resolved = resolveWhen("every Monday 9am", zone, now);
    expect(resolved.recurrence).toMatchObject({ kind: "weekly", weekday: 1, hour: 9, minute: 0 });
    expectParts(resolved.fireAt, { year: 2026, month: 10, day: 12, hour: 9, minute: 0 });
  });

  it("uses the zone you pass, not a hardcoded offset", () => {
    const east = resolveWhen("next Tue 2pm", "America/New_York", now);
    const west = resolveWhen("next Tue 2pm", "America/Los_Angeles", now);
    expect(east.fireAt.toISOString()).not.toBe(west.fireAt.toISOString());
    expect(zonedParts(west.fireAt, "America/Los_Angeles").hour).toBe(14);
  });

  it("rounds a wall clock through the zone and back", () => {
    const instant = zonedTimeToUtc(2026, 10, 13, 14, 0, zone);
    expectParts(instant, { year: 2026, month: 10, day: 13, hour: 14, minute: 0 });
  });
});

describe("past and wrong-year guards", () => {
  it("rejects an explicit past year and suggests a future occurrence", () => {
    try {
      resolveWhen("October 13, 2024 at 2pm", zone, now);
      throw new Error("should have rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(WhenError);
      const when = error as WhenError;
      expect(when.message).toMatch(/That year \(2024\)/);
      expect(when.suggestion).toMatch(/October 13, 2026/);
    }
  });

  it("rejects an ISO timestamp whose year is wrong", () => {
    expect(() => resolveWhen("2024-10-13T14:00:00", zone, now)).toThrow(/That year \(2024\)/);
    expect(() => resolveWhen("2024-10-13T18:00:00Z", zone, now)).toThrow(/That year \(2024\)/);
  });

  it("rejects a fully specified date that has already passed", () => {
    try {
      resolveWhen("October 1, 2026 at 2pm", zone, now);
      throw new Error("should have rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(WhenError);
      expect((error as WhenError).message).toMatch(/already passed/);
      expect((error as WhenError).suggestion).toMatch(/2027/);
    }
  });

  it("rejects today once that clock time has passed", () => {
    expect(() => resolveWhen("today at 9am", zone, now)).toThrow(/That time today has already passed/);
  });

  it("rejects yesterday", () => {
    expect(() => resolveWhen("yesterday at 2pm", zone, now)).toThrow(/in the past/);
  });

  it("moves a month and day with no year forward when this year has passed", () => {
    const resolved = resolveWhen("October 1 at 2pm", zone, now);
    expect(resolved.corrected).toBe(true);
    expectParts(resolved.fireAt, { year: 2027, month: 10, day: 1, hour: 14, minute: 0 });
    expect(resolved.note).toMatch(/moved it/);
  });

  it("moves a bare clock time that already passed today to tomorrow", () => {
    const later = new Date("2026-10-11T19:00:00.000Z");
    const resolved = resolveWhen("2pm", zone, later);
    expect(resolved.corrected).toBe(true);
    expectParts(resolved.fireAt, { year: 2026, month: 10, day: 12, hour: 14, minute: 0 });
  });

  it("accepts a date in the next year when the year is explicit and still ahead", () => {
    const resolved = resolveWhen("March 3, 2027 at 8am", zone, now);
    expect(resolved.corrected).toBe(false);
    expectParts(resolved.fireAt, { year: 2027, month: 3, day: 3, hour: 8, minute: 0 });
  });

  it("rejects a year more than one year out", () => {
    expect(() => resolveWhen("March 3, 2030 at 8am", zone, now)).toThrow(/That year \(2030\)/);
  });

  it("reads the first Monday of every month", () => {
    const resolved = resolveWhen("first Monday of every month", zone, now);
    expect(resolved.recurrence).toMatchObject({ kind: "monthly_nth", nth: 1, weekday: 1, hour: 9, minute: 0 });
    expectParts(resolved.fireAt, { year: 2026, month: 11, day: 2, hour: 9, minute: 0 });
  });

  it("reads a monthly date", () => {
    const resolved = resolveWhen("the 15th of every month", zone, now);
    expect(resolved.recurrence).toMatchObject({ kind: "monthly_date", day: 15, hour: 9, minute: 0 });
    expectParts(resolved.fireAt, { year: 2026, month: 10, day: 15, hour: 9, minute: 0 });
  });

  it("reads every N days and every N weeks until a month", () => {
    const days = resolveWhen("every 3 days", zone, now);
    expect(days.recurrence).toMatchObject({ kind: "every_n_days", interval: 3, hour: 9, minute: 0 });
    expectParts(days.fireAt, { year: 2026, month: 10, day: 12, hour: 9, minute: 0 });

    const weeks = resolveWhen("every 2 weeks until Dec", zone, now);
    expect(weeks.recurrence).toMatchObject({
      kind: "every_n_weeks",
      interval: 2,
      weekday: 1,
      hour: 9,
      minute: 0,
      ends: { until: "2027-01-01T05:00:00.000Z", count: null, completed: 0 }
    });
    expectParts(weeks.fireAt, { year: 2026, month: 10, day: 12, hour: 9, minute: 0 });
  });

  it("stops a series on a count and refuses an end date on a one-shot", () => {
    const counted = resolveWhen("every weekday 9am for 4 times", zone, now);
    expect(counted.recurrence?.ends).toEqual({ until: null, count: 4, completed: 0 });
    expect(() => resolveWhen("tomorrow 9am until Dec", zone, now)).toThrow(/end date needs a repeating reminder/);
    const ended = {
      kind: "every_n_days" as const,
      interval: 1,
      hour: 9,
      minute: 0,
      anchor: "2026-10-12T13:00:00.000Z",
      ends: { until: "2026-10-12T13:00:00.000Z", count: null, completed: 0 }
    };
    expect(nextFire(ended, zone, now)).toBeNull();
    const series = advanceSeries({
      kind: "daily",
      hour: 9,
      minute: 0,
      ends: { until: null, count: 2, completed: 1 }
    });
    expect(series.done).toBe(true);
    expect(series.recurrence.ends?.completed).toBe(2);
  });
});

describe("repeat merged with free text", () => {
  it("keeps a monthly rule and an end date when repeat agrees", () => {
    const monthly = applyRepeat(resolveWhen("first Monday of every month", zone, now), undefined, zone);
    expect(monthly.recurrence).toMatchObject({ kind: "monthly_nth", nth: 1, weekday: 1 });

    const daily = applyRepeat(resolveWhen("every day until Dec", zone, now), "daily", zone);
    expect(daily.recurrence).toMatchObject({ kind: "daily", ends: { count: null, completed: 0 } });
    expect(daily.recurrence && "ends" in daily.recurrence ? daily.recurrence.ends?.until : null).toBeTruthy();

    const weekly = applyRepeat(resolveWhen("every Monday 9am until Dec", zone, now), "weekly", zone);
    expect(weekly.recurrence).toMatchObject({ kind: "weekly", weekday: 1 });
    expect(weekly.recurrence && "ends" in weekly.recurrence ? weekly.recurrence.ends?.until : null).toBeTruthy();
  });

  it("still applies repeat when the words have no schedule of their own", () => {
    const resolved = applyRepeat(resolveWhen("tomorrow 9am", zone, now), "daily", zone);
    expect(resolved.recurrence).toEqual({ kind: "daily", hour: 9, minute: 0 });
  });

  it("rejects a repeat that would drop a monthly rule or an end date", () => {
    expect(() => applyRepeat(resolveWhen("first Monday of every month", zone, now), "weekly", zone))
      .toThrow(/first Monday of every month[\s\S]*conflicts with repeat "weekly"/);
    expect(() => applyRepeat(resolveWhen("every 2 weeks until Dec", zone, now), "weekly", zone))
      .toThrow(/every 2 weeks[\s\S]*until[\s\S]*conflicts with repeat "weekly"/);
    expect(() => applyRepeat(resolveWhen("every Monday 9am", zone, now), "once", zone))
      .toThrow(/conflicts with repeat "once"/);
  });
});
