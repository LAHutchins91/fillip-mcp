/**
 * QA round 2 against the launch candidate.
 * QA-FAIL tests assert the behavior a user was promised and fail on this build.
 * QA-PASS tests are observed successes, including adversarial cases around the new head.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import ICAL from "ical.js";
import pg from "pg";
import { reminderCalendar } from "../../src/lib/ics.js";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { calendarLink, listReminders, renderCalendarFeed, setReminder, snoozeOrReschedule } from "../../src/lib/reminders.js";
import { signStopToken, verifyStopToken } from "../../src/lib/stop-token.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import { acceptTelegramUpdate, createTelegramSender } from "../../src/lib/telegram.js";
import { applyRepeat, nextFire, resolveWhen, WhenError } from "../../src/lib/time.js";
import type { Actor, DeliveryChannel, Reminder } from "../../src/lib/types.js";
import { STAND_IN_CAPS } from "../../src/lib/usage.js";
import { zonedParts } from "../../src/lib/zone.js";
import { app } from "../../src/server.js";

const ny = "America/New_York";
const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const other: Actor = { id: "33333333-3333-4333-8333-333333333333", email: "other@example.com", emailVerified: true };
const caps = STAND_IN_CAPS;
const now = new Date("2026-10-11T16:00:00.000Z");

class CountingSender implements MailSender {
  sent: OutboundEmail[] = [];
  async send(message: OutboundEmail) {
    this.sent.push(structuredClone(message));
    return { id: `email_${this.sent.length}` };
  }
}

class CountingTelegram {
  sent: Array<{ chatId: string; text: string }> = [];
  failTimes = 0;
  async send(chatId: string, text: string) {
    if (this.failTimes > 0) {
      this.failTimes -= 1;
      throw new Error("telegram down");
    }
    this.sent.push({ chatId, text });
    return { id: `tg_${this.sent.length}` };
  }
}

function job(store: MemoryFillipStore | SupabaseFillipStore, sender: MailSender, at: Date, extra?: {
  caps?: typeof caps;
  maxEmailsPerUserPerDay?: number;
  telegram?: { sender: CountingTelegram } | null;
  global?: { perDay: number; perMonth: number };
}) {
  return runDueJob({
    store,
    sender,
    now: at,
    from: "Fillip <reminders@example.com>",
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: "unsubscribe-secret",
    maxEmailsPerUserPerDay: extra?.maxEmailsPerUserPerDay ?? 100,
    maxSends: 20,
    minIntervalMs: 0,
    caps: extra?.caps ?? caps,
    global: extra?.global ?? { perDay: 1_000_000, perMonth: 1_000_000 },
    sleep: async () => {},
    telegram: extra?.telegram
  });
}

function usePlan(store: MemoryFillipStore, used: number, plan: "free" | "pro" | "annual", status: string) {
  const contact = store.contacts.get(actor.id);
  if (!contact) throw new Error("missing contact");
  contact.plan = plan;
  contact.subscriptionStatus = status;
  contact.emailsSentInPeriod = used;
  contact.emailPeriodStart = "2026-10-01T00:00:00.000Z";
  contact.telegramChatId = "9001";
  return contact;
}

async function due(store: MemoryFillipStore, what: string, channel: DeliveryChannel, at = new Date("2026-10-11T12:00:00.000Z")) {
  return setReminder(store, actor, { what, when: "in 1 hour", timezone: "UTC", channel }, at, caps, true);
}

function parseIcs(ics: string) {
  const comp = new ICAL.Component(ICAL.parse(ics));
  const vevents = comp.getAllSubcomponents("vevent");
  const vevent = vevents[0];
  if (!vevent) throw new Error("no VEVENT");
  const event = new ICAL.Event(vevent);
  const alarm = vevent.getFirstSubcomponent("valarm");
  return { comp, vevents, vevent, event, alarm };
}

describe("QA schedule merge", () => {
  const created = new Date("2026-12-01T15:00:00.000Z");

  it("QA-PASS: a monthly rule and its end date survive an agreeing repeat and a conflict is not saved", async () => {
    const monthly = applyRepeat(resolveWhen("first Monday of every month at 9am until June", ny, created), undefined, ny);
    expect(monthly.recurrence).toMatchObject({ kind: "monthly_nth", nth: 1, weekday: 1, hour: 9, minute: 0 });
    expect(monthly.recurrence?.ends?.until).toBeTruthy();
    const until = new Date(monthly.recurrence?.ends?.until ?? 0);
    expect(zonedParts(until, ny)).toMatchObject({ month: 7, day: 1, hour: 0, minute: 0 });
    const june = nextFire(monthly.recurrence!, ny, new Date("2027-05-15T00:00:00.000Z"));
    expect(june && zonedParts(june, ny)).toMatchObject({ month: 6, hour: 9 });
    expect(nextFire(monthly.recurrence!, ny, new Date("2027-06-15T00:00:00.000Z"))).toBeNull();

    const dailyUntil = applyRepeat(resolveWhen("every day at 9am until March 10", ny, new Date("2026-03-01T15:00:00.000Z")), "daily", ny);
    expect(dailyUntil.recurrence).toMatchObject({ kind: "daily", hour: 9, minute: 0 });
    const march10 = nextFire(dailyUntil.recurrence!, ny, new Date("2026-03-09T14:00:00.000Z"));
    expect(zonedParts(march10!, ny)).toMatchObject({ month: 3, day: 10, hour: 9 });
    expect(nextFire(dailyUntil.recurrence!, ny, march10!)).toBeNull();

    const counted = applyRepeat(resolveWhen("every Monday 9am for 6 times", ny, created), "weekly", ny);
    expect(counted.recurrence?.ends).toMatchObject({ count: 6, completed: 0 });

    const store = new MemoryFillipStore();
    await expect(setReminder(store, actor, {
      what: "Conflict",
      when: "first Monday of every month at 9am until June",
      timezone: ny,
      repeat: "weekly"
    }, created, caps)).rejects.toBeInstanceOf(WhenError);
    await expect(setReminder(store, actor, {
      what: "Strip",
      when: "every Monday 9am until Dec",
      timezone: ny,
      repeat: "once"
    }, created, caps)).rejects.toThrow(/conflicts with repeat "once"/);
    await expect(setReminder(store, actor, {
      what: "Interval",
      when: "every 2 weeks on Tuesday at 9am until Dec",
      timezone: ny,
      repeat: "weekly"
    }, created, caps)).rejects.toThrow(/conflicts/);
    expect(store.reminders).toHaveLength(0);
  });

  it("QA-PASS: end dates stay inclusive of the named day across the spring-forward gap", () => {
    const before = new Date("2026-03-01T15:00:00.000Z");
    const series = applyRepeat(resolveWhen("every day at 2:30am until March 8", ny, before), "daily", ny);
    expect(series.recurrence).toMatchObject({ kind: "daily", hour: 2, minute: 30 });
    const spring = nextFire(series.recurrence!, ny, new Date("2026-03-07T12:00:00.000Z"));
    const local = zonedParts(spring!, ny);
    expect(local).toMatchObject({ month: 3, day: 8 });
    expect(local.hour === 1 && local.minute === 30, `spring fire landed at ${local.hour}:${local.minute}`).toBe(false);
    expect(nextFire(series.recurrence!, ny, spring!)).toBeNull();

    const throughSeventh = applyRepeat(resolveWhen("every day at 2:30am until March 7", ny, before), "daily", ny);
    const last = nextFire(throughSeventh.recurrence!, ny, new Date("2026-03-06T12:00:00.000Z"));
    expect(zonedParts(last!, ny)).toMatchObject({ month: 3, day: 7, hour: 2, minute: 30 });
    expect(nextFire(throughSeventh.recurrence!, ny, last!)).toBeNull();
  });

  it("QA-PASS: Jan 31, leap day, 5th and last weekdays, and every-N catch-up", () => {
    const jan = new Date("2026-01-31T15:00:00.000Z");
    const monthly = resolveWhen("the 31st of every month at 9am", "UTC", new Date("2026-01-01T00:00:00.000Z"));
    const feb = nextFire(monthly.recurrence!, "UTC", jan);
    expect(feb?.toISOString()).toBe("2026-02-28T09:00:00.000Z");
    const march = nextFire(monthly.recurrence!, "UTC", feb!);
    expect(march?.toISOString()).toBe("2026-03-31T09:00:00.000Z");
    const leap = nextFire(monthly.recurrence!, "UTC", new Date("2028-01-31T15:00:00.000Z"));
    expect(leap?.toISOString()).toBe("2028-02-29T09:00:00.000Z");
    expect(() => resolveWhen("February 29, 2027 at 9am", "UTC", new Date("2026-06-01T00:00:00.000Z"))).toThrow(WhenError);

    const fifth = resolveWhen("fifth Monday of every month at 9am", "UTC", new Date("2026-02-01T00:00:00.000Z"));
    const march30 = nextFire(fifth.recurrence!, "UTC", new Date("2026-02-01T00:00:00.000Z"));
    expect(march30?.toISOString()).toBe("2026-03-30T09:00:00.000Z");
    const last = resolveWhen("the last Friday of every month at 9am", "UTC", new Date("2026-02-01T00:00:00.000Z"));
    expect(last.recurrence).toMatchObject({ kind: "monthly_nth", nth: -1, weekday: 5 });
    expect(nextFire(last.recurrence!, "UTC", new Date("2026-02-01T00:00:00.000Z"))?.toISOString()).toBe("2026-02-27T09:00:00.000Z");

    expect(() => resolveWhen("every 2 months at 9am", "UTC", jan)).toThrow(/every N days or weeks/);

    const missed = resolveWhen("every day at 9am", "UTC", new Date("2026-10-01T00:00:00.000Z"));
    const caught = nextFire(missed.recurrence!, "UTC", new Date("2026-10-11T16:00:00.000Z"));
    expect(caught?.toISOString()).toBe("2026-10-12T09:00:00.000Z");
  });

  it("QA-FAIL: the phrase last Friday of every month is a monthly rule, not a past time", () => {
    const resolved = resolveWhen("last Friday of every month at 9am", "UTC", new Date("2026-02-01T00:00:00.000Z"));
    expect(resolved.recurrence).toMatchObject({ kind: "monthly_nth", nth: -1, weekday: 5 });
    expect(nextFire(resolved.recurrence!, "UTC", new Date("2026-02-01T00:00:00.000Z"))?.toISOString()).toBe("2026-02-27T09:00:00.000Z");
  });

  it("QA-FAIL: an every-N series can still be advanced after 400 steps from its anchor", async () => {
    const anchor = new Date("2024-01-01T09:00:00.000Z");
    const recurrence = {
      kind: "every_n_days" as const,
      interval: 2,
      hour: 9,
      minute: 0,
      anchor: anchor.toISOString()
    };
    const far = new Date(anchor.getTime() + 401 * 2 * 24 * 60 * 60 * 1000);
    let upcoming: Date | null = null;
    let thrown: string | null = null;
    try {
      upcoming = nextFire(recurrence, "UTC", far);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    expect(thrown, "next fire should jump ahead instead of dying at 400 steps").toBeNull();
    expect(upcoming && upcoming.getTime() > far.getTime()).toBe(true);
  });

  it("QA-FAIL: an every-N reminder that can no longer advance does not abort the rest of the sweep", async () => {
    const store = new MemoryFillipStore();
    await due(store, "Old series", "email");
    await due(store, "Still due", "email");
    const old = store.reminders.find((row) => row.what === "Old series");
    const later = store.reminders.find((row) => row.what === "Still due");
    if (!old || !later) throw new Error("missing reminders");
    await store.saveReminder({
      ...old,
      fireAt: new Date(now.getTime() - 60_000).toISOString(),
      recurrence: { kind: "every_n_days", interval: 2, hour: 9, minute: 0, anchor: "2024-01-01T09:00:00.000Z" }
    });
    await store.saveReminder({ ...later, fireAt: now.toISOString(), recurrence: null });
    const sender = new CountingSender();
    let jobError: string | null = null;
    try {
      await job(store, sender, now);
    } catch (error) {
      jobError = error instanceof Error ? error.message : String(error);
    }
    expect(jobError, "one old every-N reminder must not abort the rest of the sweep").toBeNull();
    expect(sender.sent.some((message) => message.text.includes("Still due"))).toBe(true);
  });
});

describe("QA calendar file", () => {
  function reminder(patch: Partial<Reminder>): Reminder {
    return {
      id: "44444444-4444-4444-8444-444444444444",
      ownerId: actor.id,
      kind: "reminder",
      what: "Standup",
      context: null,
      timezone: ny,
      fireAt: "2026-03-08T06:50:00.000Z",
      recurrence: { kind: "daily", hour: 1, minute: 50 },
      channel: "email",
      status: "active",
      holdUntil: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null,
      ...patch
    };
  }

  it("QA-PASS: VALARM and a 15-minute DTEND parse, including across the spring-forward gap", () => {
    const row = reminder({});
    const ics = reminderCalendar(row, now);
    const { comp, event, alarm, vevents } = parseIcs(ics);
    expect(vevents).toHaveLength(1);
    expect(comp.getFirstSubcomponent("vtimezone")?.getFirstPropertyValue("tzid")).toBe(ny);
    expect(alarm, "DISPLAY alarms need a VALARM").toBeTruthy();
    expect(String(alarm?.getFirstPropertyValue("action"))).toBe("DISPLAY");
    expect(String(alarm?.getFirstPropertyValue("description") ?? "")).not.toBe("");
    const trigger = alarm?.getFirstPropertyValue("trigger") as { toString?: () => string } | null;
    expect(String(trigger ?? "")).toMatch(/PT0S|^0/);
    const start = new Date(row.fireAt);
    const localEnd = zonedParts(new Date(start.getTime() + 15 * 60 * 1000), ny);
    expect(event.endDate.toString()).toContain(`${localEnd.year}-${String(localEnd.month).padStart(2, "0")}-${String(localEnd.day).padStart(2, "0")}T${String(localEnd.hour).padStart(2, "0")}:${String(localEnd.minute).padStart(2, "0")}`);
    expect(event.startDate.toString()).toContain("T01:50");
  });

  it("QA-PASS: titles and notes with commas, newlines, and semicolons stay inside one event", () => {
    const nasty = "Hello,\nWorld; DROP TABLE\r\nnext, please \\ back";
    const row = reminder({
      what: nasty,
      context: "note, with comma\nand a second line",
      timezone: "UTC",
      fireAt: "2026-10-12T15:00:00.000Z",
      recurrence: null
    });
    const { event, vevents } = parseIcs(reminderCalendar(row, now));
    expect(vevents).toHaveLength(1);
    expect(event.summary).toBe(nasty);
    expect(event.description).toContain("note, with comma");
    expect(event.description).toContain("second line");
  });

  it("QA-PASS: one reminder keeps one series UID and an RRULE, and a retry of the same fire does not change it", () => {
    const firstAt = "2026-10-12T13:00:00.000Z";
    const secondAt = "2026-10-13T13:00:00.000Z";
    const base = reminder({ timezone: "UTC", recurrence: { kind: "daily", hour: 13, minute: 0 }, fireAt: firstAt });
    const first = parseIcs(reminderCalendar(base, now));
    const second = parseIcs(reminderCalendar({ ...base, fireAt: secondAt }, now));
    const again = parseIcs(reminderCalendar(base, new Date("2026-10-12T18:00:00.000Z")));
    const other = parseIcs(reminderCalendar({ ...base, id: "55555555-5555-4555-8555-555555555555" }, now));
    expect(first.event.uid).toBe(again.event.uid);
    expect(second.event.uid).toBe(first.event.uid);
    expect(other.event.uid).not.toBe(first.event.uid);
    expect(reminderCalendar(base, now)).toMatch(/RRULE:FREQ=DAILY/);
  });

  it("QA-FAIL: the calendar description separates the note and the tagline with a real newline", () => {
    const row = reminder({
      context: "bring the card",
      timezone: "UTC",
      fireAt: "2026-10-12T15:00:00.000Z",
      recurrence: null
    });
    const description = parseIcs(reminderCalendar(row, now)).event.description ?? "";
    expect(description).toContain("bring the card\nFillip, reminders that fire.");
    expect(description).not.toContain("\\n");
  });
});

describe("QA both-channel caps", () => {
  it("QA-PASS: two pings are charged only when both channels are delivered, and a retry does not charge again", async () => {
    const store = new MemoryFillipStore();
    await due(store, "Both", "both");
    usePlan(store, 28, "free", "canceled");
    const mail = new CountingSender();
    const telegram = new CountingTelegram();
    const report = await job(store, mail, now, { telegram: { sender: telegram } });
    expect(report.sent).toBe(2);
    expect(mail.sent).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);
    expect(store.contacts.get(actor.id)?.emailsSentInPeriod).toBe(30);
    const again = await job(store, mail, now, { telegram: { sender: telegram } });
    expect(again.sent).toBe(0);
    expect(mail.sent).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);
    expect(store.contacts.get(actor.id)?.emailsSentInPeriod).toBe(30);

    const partial = new MemoryFillipStore();
    await due(partial, "Email only after telegram fails", "both");
    usePlan(partial, 0, "pro", "active");
    const partialMail = new CountingSender();
    const partialTelegram = new CountingTelegram();
    partialTelegram.failTimes = 1;
    await job(partial, partialMail, now, { telegram: { sender: partialTelegram } });
    expect(partialMail.sent).toHaveLength(1);
    expect(partialTelegram.sent).toHaveLength(0);
    expect(partial.contacts.get(actor.id)?.emailsSentInPeriod).toBe(1);
    await job(partial, partialMail, new Date(now.getTime() + 60_000), { telegram: { sender: partialTelegram } });
    expect(partialTelegram.sent).toHaveLength(1);
    expect(partialMail.sent).toHaveLength(1);
    expect(partial.contacts.get(actor.id)?.emailsSentInPeriod).toBe(2);
  });

  it("QA-PASS: email-only free, trial, and paid boundaries stay exact on one worker", async () => {
    for (const [plan, status, limit, used] of [
      ["free", "canceled", 30, 29],
      ["pro", "trialing", 100, 99],
      ["pro", "active", 1000, 999]
    ] as const) {
      const store = new MemoryFillipStore();
      await due(store, plan, "email");
      usePlan(store, used, plan === "free" ? "free" : "pro", status);
      const sender = new CountingSender();
      expect((await job(store, sender, now)).sent, `${plan} at ${used}`).toBe(1);
      expect(store.contacts.get(actor.id)?.emailsSentInPeriod).toBe(limit);
      expect((await job(store, sender, now)).sent).toBe(0);
    }
  });

  it("QA-FAIL: one ping left cannot become two when a reminder is delivered on both channels", async () => {
    const hosted = new SupabaseFillipStore(null, hostedDb({
      used: 29,
      plan: "free",
      status: "canceled"
    }), "service");
    const created = await setReminder(hosted, actor, {
      what: "Last slot",
      when: "in 1 hour",
      timezone: "UTC",
      channel: "both"
    }, new Date("2026-10-11T12:00:00.000Z"), caps, true);
    expect(created.id).toBeTruthy();
    const mail = new CountingSender();
    const telegram = new CountingTelegram();
    await job(hosted, mail, now, { telegram: { sender: telegram } });
    const profile = hostedProfiles(hosted);
    expect(mail.sent.length + telegram.sent.length, "a both-channel send with one ping left must not pass 30").toBeLessThanOrEqual(1);
    expect(profile?.emails_sent_in_period ?? 0).toBeLessThanOrEqual(30);
  });

  it("QA-FAIL: two hosted workers cannot race past the free monthly cap", async () => {
    const db = hostedDb({ used: 29, plan: "free", status: "canceled", stallProfileReads: 2 });
    const first = new SupabaseFillipStore(null, db, "service");
    const second = new SupabaseFillipStore(null, db, "service");
    await setReminder(first, actor, { what: "A", when: "in 1 hour", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"), caps, true);
    await setReminder(first, actor, { what: "B", when: "in 1 hour", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"), caps, true);
    db.armStall();
    const mail = new CountingSender();
    await Promise.all([
      job(first, mail, now),
      job(second, mail, now)
    ]);
    expect(mail.sent.length, "two workers started from 29 of 30").toBeLessThanOrEqual(1);
  });

  it("QA-PASS: reminders already over the free open cap still send, and a new one is refused", async () => {
    const store = new MemoryFillipStore();
    for (let i = 0; i < 12; i += 1) {
      await setReminder(store, actor, { what: `Open ${i}`, when: "tomorrow 9am", timezone: "UTC" }, now, caps);
    }
    usePlan(store, 0, "free", "canceled");
    await expect(setReminder(store, actor, { what: "One more", when: "tomorrow 9am", timezone: "UTC" }, now, caps)).rejects.toThrow(/free plan allows 10/);
    expect(store.reminders.filter((row) => row.status === "active")).toHaveLength(12);
    const row = store.reminders[0];
    if (!row) throw new Error("missing reminder");
    await store.saveReminder({ ...row, fireAt: new Date(now.getTime() - 60_000).toISOString() });
    const sender = new CountingSender();
    expect((await job(store, sender, now)).sent).toBe(1);
  });

  it("QA-FAIL: upgrading releases a reminder the free cap was already holding", async () => {
    const store = new MemoryFillipStore();
    await due(store, "Held", "email");
    usePlan(store, 30, "free", "canceled");
    const sender = new CountingSender();
    expect((await job(store, sender, now)).sent).toBe(0);
    expect((await store.getReminder(actor.id, store.reminders[0]!.id))?.holdUntil).toBeTruthy();
    usePlan(store, 30, "pro", "active");
    expect((await job(store, sender, now)).sent).toBe(1);
  });

  it("QA-FAIL: two creates cannot pass the free open-reminder cap of 10", async () => {
    const store = new MemoryFillipStore();
    for (let i = 0; i < 9; i += 1) {
      await setReminder(store, actor, { what: `Open ${i}`, when: "tomorrow 9am", timezone: "UTC" }, now, caps);
    }
    usePlan(store, 0, "free", "canceled");
    const raced = await Promise.allSettled([
      setReminder(store, actor, { what: "Race A", when: "tomorrow 9am", timezone: "UTC" }, now, caps),
      setReminder(store, actor, { what: "Race B", when: "tomorrow 9am", timezone: "UTC" }, now, caps)
    ]);
    expect(raced.filter((item) => item.status === "rejected")).toHaveLength(1);
    expect(store.reminders.filter((row) => row.status === "active")).toHaveLength(10);
  });
});

describe("QA pause and resume", () => {
  it("QA-PASS: a paused reminder never fires, resume does not replay missed days, and both actions are idempotent", async () => {
    const store = new MemoryFillipStore();
    const created = await setReminder(store, actor, {
      what: "Daily",
      when: "every day at 9am",
      timezone: ny
    }, new Date("2026-10-01T15:00:00.000Z"), caps);
    const fireAt = created.fireAt;
    const paused = await snoozeOrReschedule(store, actor.id, created.id, "tomorrow 9am", ny, now, "pause");
    const again = await snoozeOrReschedule(store, actor.id, created.id, undefined, undefined, now, "pause");
    expect(paused.status).toBe("paused");
    expect(again.status).toBe("paused");
    expect(again.fireAt).toBe(fireAt);
    const sender = new CountingSender();
    for (let day = 0; day < 5; day += 1) {
      const at = new Date(now.getTime() + day * 24 * 60 * 60 * 1000);
      expect((await job(store, sender, at)).sent).toBe(0);
    }
    expect(sender.sent).toHaveLength(0);
    expect((await store.getReminder(actor.id, created.id))?.status).toBe("paused");

    const later = new Date("2026-10-20T15:00:00.000Z");
    const resumed = await snoozeOrReschedule(store, actor.id, created.id, undefined, ny, later, "resume");
    const second = await snoozeOrReschedule(store, actor.id, created.id, undefined, ny, later, "resume");
    expect(second.fireAt).toBe(resumed.fireAt);
    expect(new Date(resumed.fireAt).getTime()).toBeGreaterThan(later.getTime());
    expect(zonedParts(new Date(resumed.fireAt), ny).hour).toBe(9);
    expect((await job(store, sender, later)).sent).toBe(0);
    const dueAt = new Date(new Date(resumed.fireAt).getTime() + 60_000);
    expect((await job(store, sender, dueAt)).sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    const advanced = await store.getReminder(actor.id, created.id);
    expect(new Date(advanced?.fireAt ?? 0).getTime()).toBeGreaterThan(dueAt.getTime());
    expect((await job(store, sender, dueAt)).sent).toBe(0);

    const ended = resolveWhen("every day at 9am until October 12", ny, new Date("2026-10-01T15:00:00.000Z"));
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing");
    await store.saveReminder({ ...row, status: "paused", recurrence: ended.recurrence, fireAt: "2026-10-11T13:00:00.000Z" });
    await expect(snoozeOrReschedule(store, actor.id, created.id, undefined, ny, later, "resume")).rejects.toThrow(/already ended/);
  });

  it("QA-PASS: resume of a 2:30am daily on the spring-forward morning is not 1:30am", async () => {
    const store = new MemoryFillipStore();
    const created = await setReminder(store, actor, {
      what: "Early",
      when: "every day at 2:30am",
      timezone: ny
    }, new Date("2026-03-01T15:00:00.000Z"), caps);
    await snoozeOrReschedule(store, actor.id, created.id, undefined, undefined, new Date("2026-03-06T15:00:00.000Z"), "pause");
    const duringGap = new Date("2026-03-08T06:00:00.000Z");
    const resumed = await snoozeOrReschedule(store, actor.id, created.id, undefined, ny, duringGap, "resume");
    const local = zonedParts(new Date(resumed.fireAt), ny);
    expect(local.hour === 1 && local.minute === 30, `resumed at ${local.hour}:${String(local.minute).padStart(2, "0")}`).toBe(false);
    expect(new Date(resumed.fireAt).getTime()).toBeGreaterThan(duringGap.getTime());
  });
});

describe("QA hosted claim and crash", () => {
  it("QA-FAIL: a crash between the reclaim ticket and the status update does not stick the occurrence", async () => {
    const dedupe = "reminder:rem-1:2026-10-11T13:00:00.000Z";
    const rows = new Map<string, Record<string, unknown>>();
    rows.set(dedupe, {
      id: "existing",
      owner_id: actor.id,
      reminder_id: "rem-1",
      dedupe_key: dedupe,
      occurrence_at: "2026-10-11T13:00:00.000Z",
      status: "failed",
      idempotency_key: "fillip/rem-1/2026-10-11T13:00:00.000Z",
      channel: "email",
      provider_id: null,
      started_at: "2026-10-11T13:00:00.000Z",
      sent_at: null,
      error: "send failed"
    });
    let patches = 0;
    const db: Db = async (pathname, options) => {
      const method = options?.method ?? "GET";
      const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null;
      if (method === "POST" && pathname.startsWith("/rest/v1/deliveries")) {
        const key = String(body?.dedupe_key);
        if (rows.has(key)) throw new Error("duplicate key value violates unique constraint 23505");
        rows.set(key, body ?? {});
        return [body];
      }
      if (method === "PATCH" && pathname.includes("dedupe_key")) {
        patches += 1;
        if (patches === 1) throw new Error("connection reset before the claim was saved");
        const key = decodeURIComponent((pathname.match(/dedupe_key=eq\.([^&]+)/) ?? [])[1] ?? "");
        const current = rows.get(key);
        if (!current) return [];
        Object.assign(current, body);
        return [current];
      }
      if (method === "GET" && pathname.includes("dedupe_key")) {
        const key = decodeURIComponent((pathname.match(/dedupe_key=eq\.([^&]+)/) ?? [])[1] ?? "");
        const current = rows.get(key);
        return current ? [current] : [];
      }
      return [];
    };
    const store = new SupabaseFillipStore(null, db, "service");
    const input = {
      ownerId: actor.id,
      reminderId: "rem-1",
      dedupeKey: dedupe,
      occurrenceAt: "2026-10-11T13:00:00.000Z",
      idempotencyKey: "fillip/rem-1/2026-10-11T13:00:00.000Z",
      channel: "email" as const,
      nowIso: now.toISOString(),
      staleBeforeIso: new Date(now.getTime() - 120_000).toISOString()
    };
    await expect(store.claimDelivery(input)).rejects.toThrow(/connection reset/);
    const recovered = await store.claimDelivery({ ...input, nowIso: new Date(now.getTime() + 180_000).toISOString() });
    expect(recovered.outcome).toBe("send");
  });

  it("QA-FAIL: a kill after the provider accepts and before the sent row is saved does not submit that occurrence again", async () => {
    const store = new MemoryFillipStore();
    await due(store, "Crash", "email");
    usePlan(store, 0, "pro", "active");
    const sender = new CountingSender();
    const original = store.saveDelivery.bind(store);
    let snapshot: { reminders: Reminder[]; deliveries: MemoryFillipStore["deliveries"] } | null = null;
    let release: (error: Error) => void = () => {};
    store.saveDelivery = async (delivery) => {
      if (delivery.status === "sent" && !snapshot) {
        snapshot = {
          reminders: structuredClone(store.reminders),
          deliveries: structuredClone(store.deliveries)
        };
        await new Promise<void>((_resolve, reject) => {
          release = reject;
        });
      }
      return original(delivery);
    };
    const hanging = job(store, sender, now);
    for (let i = 0; i < 50 && !snapshot; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(snapshot).toBeTruthy();
    const recovered = new MemoryFillipStore();
    recovered.reminders = snapshot!.reminders;
    recovered.deliveries = snapshot!.deliveries;
    recovered.contacts = store.contacts;
    const second = new CountingSender();
    const later = new Date(now.getTime() + 3 * 60 * 1000);
    await job(recovered, second, later);
    expect(second.sent, "Resend dedupes this key for 24 hours, so the email is retried").toHaveLength(1);
    expect(second.sent[0]?.idempotencyKey).toBe(sender.sent[0]?.idempotencyKey);
    release(new Error("process killed"));
    await hanging.catch(() => undefined);
  });
});

describe("QA delete, feed, stop, and guard", () => {
  it("QA-PASS: service-role deletion removes digest deliveries and a real Postgres policy does not leak across users", async () => {
    const dbState = hostedDb({ used: 0, plan: "free", status: "canceled" });
    const store = new SupabaseFillipStore(null, dbState, "service");
    await store.saveDigest({
      ownerId: actor.id,
      enabled: true,
      hour: 9,
      minute: 0,
      timezone: "UTC",
      lastSentOn: null,
      updatedAt: now.toISOString()
    });
    await dbState("/rest/v1/deliveries", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        owner_id: actor.id,
        reminder_id: null,
        dedupe_key: `digest:${actor.id}:2026-10-11`,
        occurrence_at: now.toISOString(),
        status: "sent",
        idempotency_key: "digest-key",
        channel: "email",
        provider_id: "p",
        started_at: now.toISOString(),
        sent_at: now.toISOString(),
        error: null
      })
    });
    await dbState("/rest/v1/deliveries", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        owner_id: other.id,
        reminder_id: null,
        dedupe_key: `digest:${other.id}:2026-10-11`,
        occurrence_at: now.toISOString(),
        status: "sent",
        idempotency_key: "other-digest",
        channel: "email",
        provider_id: "p",
        started_at: now.toISOString(),
        sent_at: now.toISOString(),
        error: null
      })
    });
    await store.deleteOwnerData(actor.id);
    const left = await dbState(`/rest/v1/deliveries?owner_id=eq.${other.id}&select=*`) as unknown[];
    const gone = await dbState(`/rest/v1/deliveries?owner_id=eq.${actor.id}&select=*`) as unknown[];
    expect(gone).toHaveLength(0);
    expect(left).toHaveLength(1);
    await expect(new SupabaseFillipStore(actor.id, dbState, "user").deleteOwnerData(actor.id)).rejects.toThrow(/service role/);
  });

  it("QA-FAIL: an authenticated session deletes its own delivery rows and leaves the other user's", async () => {
    const client = new pg.Client({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database: "postgres" });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("insert into auth.users (id) values ($1), ($2) on conflict do nothing", [actor.id, other.id]);
      await client.query("delete from public.deliveries where id in ($1, $2)", [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
      ]);
      await client.query(
        `insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key, started_at)
         values ($1, $2, null, $3, now(), 'sent', $3, now()), ($4, $5, null, $6, now(), 'sent', $6, now())`,
        ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor.id, "qa-digest-a", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", other.id, "qa-digest-b"]
      );
      await client.query("set role authenticated");
      await client.query("select set_config('request.jwt.claim.sub', $1, true)", [actor.id]);
      const removed = await client.query("delete from public.deliveries where owner_id in ($1, $2)", [actor.id, other.id]);
      expect(removed.rowCount).toBe(1);
      await client.query("reset role");
      const remaining = await client.query("select dedupe_key from public.deliveries where dedupe_key like 'qa-digest-%' order by dedupe_key");
      expect(remaining.rows.map((row) => row.dedupe_key)).toEqual(["qa-digest-b"]);
      await client.query("rollback");
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  });

  it("QA-PASS: two Postgres sessions cannot insert the same delivery key", async () => {
    const open = () => new pg.Client({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database: "postgres" });
    const left = open();
    const right = open();
    await left.connect();
    await right.connect();
    try {
      await left.query("insert into auth.users (id) values ($1) on conflict do nothing", [actor.id]);
      await left.query("delete from public.deliveries where dedupe_key = 'qa-race'");
      const inserted = await Promise.allSettled([
        left.query(
          "insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key) values ($1,$2,null,$3,now(),'sending',$3)",
          ["cccccccc-cccc-4ccc-8ccc-cccccccccccc", actor.id, "qa-race"]
        ),
        right.query(
          "insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key) values ($1,$2,null,$3,now(),'sending',$3)",
          ["dddddddd-dddd-4ddd-8ddd-dddddddddddd", actor.id, "qa-race"]
        )
      ]);
      expect(inserted.filter((result) => result.status === "rejected")).toHaveLength(1);
    } finally {
      await left.query("delete from public.deliveries where dedupe_key = 'qa-race'").catch(() => undefined);
      await left.end();
      await right.end();
    }
  });

  it("QA-PASS: the private feed is unguessable, revocable, and not cached as a shared document", async () => {
    const store = new MemoryFillipStore();
    await setReminder(store, actor, { what: "Dentist", when: "tomorrow 9am", timezone: "UTC", context: "bring the x-ray" }, now, caps);
    const link = await calendarLink(store, actor, "get", "https://fillip.example");
    const token = link.url.split("/calendar/")[1]?.replace(/\.ics$/, "") ?? "";
    expect(token.length).toBeGreaterThanOrEqual(43);
    const body = await renderCalendarFeed(store, token, now);
    expect(body).toContain("Dentist");
    expect(body).not.toContain(actor.email!);
    expect(await renderCalendarFeed(store, token, now)).toBe(body);
    const rotated = await calendarLink(store, actor, "rotate", "https://fillip.example");
    expect(await renderCalendarFeed(store, token, now)).toBeNull();
    expect(await renderCalendarFeed(store, rotated.url.split("/calendar/")[1]?.replace(/\.ics$/, "") ?? "", now)).toContain("Dentist");
    expect(await renderCalendarFeed(new MemoryFillipStore(), token, now)).toBeNull();

    const previousFetch = global.fetch;
    const previousUrl = process.env.SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = "https://qa.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    global.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("calendar_token")) return Response.json([{ id: actor.id }]);
      if (url.includes("/rest/v1/reminders")) {
        return Response.json([{
          id: "44444444-4444-4444-8444-444444444444",
          owner_id: actor.id,
          kind: "reminder",
          what: "Dentist",
          context: "bring the x-ray",
          timezone: "UTC",
          fire_at: "2026-10-12T13:00:00.000Z",
          recurrence: null,
          channel: "email",
          status: "active",
          hold_until: null,
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
          completed_at: null
        }]);
      }
      return Response.json([]);
    };
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    try {
      const response = await httpGet(`http://127.0.0.1:${address.port}/calendar/${token}.ics`);
      expect(response.status).toBe(200);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect(response.body).toContain("Dentist");
      expect(response.body).not.toContain("owner@example.com");
      const missing = await httpGet(`http://127.0.0.1:${address.port}/calendar/short`);
      expect(missing.status).toBe(404);
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("QA-PASS: an empty global guard is visible, keeps the reminder, and a rotated stop secret still works in the next process", async () => {
    const store = new MemoryFillipStore();
    await due(store, "Queued", "email");
    usePlan(store, 0, "pro", "active");
    const warnings: string[] = [];
    const sender = new CountingSender();
    const closed = await runDueJob({
      store,
      sender,
      now,
      from: "Fillip <reminders@example.com>",
      appBaseUrl: "https://fillip.example",
      unsubscribeSecret: "unsubscribe-secret",
      maxEmailsPerUserPerDay: 100,
      maxSends: 10,
      minIntervalMs: 0,
      caps,
      global: { perDay: 0, perMonth: 0 },
      sleep: async () => {},
      warn: (message) => warnings.push(message)
    });
    expect(closed.sent).toBe(0);
    expect(closed.global.stopped).toBe(true);
    expect(closed.global.dayLimit).toBe(0);
    expect(closed.global.monthLimit).toBe(0);
    expect(warnings.join("\n")).toMatch(/not set/);
    const queued = await store.getReminder(actor.id, store.reminders[0]!.id);
    expect(queued?.status).toBe("active");
    expect(queued?.holdUntil).toBeTruthy();
    const opened = await job(store, sender, new Date(new Date(queued?.holdUntil ?? 0).getTime() + 1000), { global: { perDay: 600, perMonth: 15000 } });
    expect(opened.sent).toBe(1);
    expect(sender.sent).toHaveLength(1);

    const token = signStopToken(actor.id, "old-secret", now.getTime());
    const dir = mkdtempSync(path.join(tmpdir(), "fillip-stop-"));
    const file = path.join(dir, "verify.ts");
    writeFileSync(file, `
      import { verifyStopToken } from ${JSON.stringify(path.join(process.cwd(), "src/lib/stop-token.ts"))};
      process.env.FILLIP_UNSUBSCRIBE_SECRET = "new-secret";
      process.env.FILLIP_UNSUBSCRIBE_SECRET_PREVIOUS = process.argv[3] ?? "";
      const id = verifyStopToken(process.argv[2] ?? "", "new-secret", Date.now() + 800 * 24 * 60 * 60 * 1000);
      console.log(id ?? "null");
    `);
    const without = spawnSync("npx", ["tsx", file, token, ""], { encoding: "utf8" });
    const withPrevious = spawnSync("npx", ["tsx", file, token, "old-secret"], { encoding: "utf8" });
    expect(without.stdout.trim()).toBe("null");
    expect(withPrevious.stdout.trim()).toBe(actor.id);
    expect(verifyStopToken(token, "new-secret", now.getTime() + 800 * 24 * 60 * 60 * 1000)).toBe(actor.id);
  });

  it("QA-FAIL: the daily summary says the stop link ends every Fillip email for the account", async () => {
    const store = new MemoryFillipStore();
    await setReminder(store, actor, { what: "Summary item", when: "in 4 hours", timezone: "UTC" }, now, caps);
    usePlan(store, 0, "pro", "active");
    await store.saveDigest({
      ownerId: actor.id,
      enabled: true,
      hour: 8,
      minute: 0,
      timezone: "UTC",
      lastSentOn: null,
      updatedAt: now.toISOString()
    });
    const sender = new CountingSender();
    await job(store, sender, now);
    const summary = sender.sent.find((message) => message.subject.includes("today"));
    expect(summary?.text ?? "").toMatch(/whole account/i);
    expect(summary?.html ?? "").toMatch(/whole account/i);
  });

  it("QA-PASS: the bot token is not logged, a used link cannot be claimed twice, and user-facing copy has no prices", async () => {
    const logs: string[] = [];
    const warn = console.warn;
    const error = console.error;
    console.warn = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => logs.push(args.map(String).join(" "));
    try {
      const sender = createTelegramSender("123456:SUPERSECRET", async () => {
        throw new Error("fetch failed");
      });
      await expect(sender.send("1", "hi")).rejects.toThrow(/fetch failed/);
    } finally {
      console.warn = warn;
      console.error = error;
    }
    expect(logs.join("\n")).not.toContain("SUPERSECRET");

    const store = new MemoryFillipStore();
    await due(store, "Chat", "telegram");
    const contact = store.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.telegramLinkToken = "link-token-which-is-not-a-chat-id";
    contact.telegramLinkExpires = new Date(now.getTime() + 60_000).toISOString();
    const first = await acceptTelegramUpdate(store, { message: { text: "/start link-token-which-is-not-a-chat-id", chat: { id: 111 } } }, now);
    const second = await acceptTelegramUpdate(store, { message: { text: "/start link-token-which-is-not-a-chat-id", chat: { id: 222 } } }, now);
    expect(first.replyText).toMatch(/ping this chat/i);
    expect(second.replyText).toMatch(/expired/i);
    expect(store.contacts.get(actor.id)?.telegramChatId).toBe("111");

    const files = ["README.md", "src/public-pages.ts", "src/fillip-tools.ts", "src/landing-page.ts", "glama.json", "server.json"];
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(text).not.toMatch(/\$\d/);
    expect(text).toMatch(/Fillip by Ouroboros/);
    expect(text).not.toMatch(/\bUSD\b|dollars/i);
  });
});

type ProfileRow = {
  id: string;
  unsubscribed: boolean;
  plan: string;
  subscription_status: string;
  emails_sent_in_period: number;
  email_period_start: string | null;
  default_channel: string;
  telegram_chat_id: string | null;
  telegram_link_token: string | null;
  telegram_link_expires: string | null;
  calendar_token: string | null;
};

const profileBook = new WeakMap<Db, ProfileRow[]>();

function hostedProfiles(store: SupabaseFillipStore): ProfileRow | undefined {
  const db = (store as unknown as { db: Db }).db;
  return profileBook.get(db)?.find((row) => row.id === actor.id);
}

function httpGet(url: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
  });
}

function hostedDb(seed: { used: number; plan: string; status: string; stallProfileReads?: number }): Db & { armStall: () => void } {
  const profiles: ProfileRow[] = [{
    id: actor.id,
    unsubscribed: false,
    plan: seed.plan,
    subscription_status: seed.status,
    emails_sent_in_period: seed.used,
    email_period_start: "2026-10-01T00:00:00.000Z",
    default_channel: "email",
    telegram_chat_id: "9001",
    telegram_link_token: null,
    telegram_link_expires: null,
    calendar_token: null
  }];
  const reminders: Record<string, unknown>[] = [];
  const deliveries: Record<string, unknown>[] = [];
  const digests: Record<string, unknown>[] = [];
  let profileReads = 0;
  let stallArmed = false;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const db: Db = async (pathname, options) => {
    await Promise.resolve();
    const method = (options?.method ?? "GET").toUpperCase();
    const prefer = new Headers(options?.headers).get("prefer") ?? "";
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null;
    const url = new URL(pathname, "http://fillip.local");
    if (url.pathname.startsWith("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (id === actor.id) return { id: actor.id, email: actor.email, email_confirmed_at: now.toISOString() };
      return {};
    }
    if (url.pathname === "/rest/v1/profiles" && method === "GET") {
      const selected = profiles.filter((row) => matches(row, url));
      if (stallArmed && seed.stallProfileReads && url.searchParams.get("select")?.includes("emails_sent_in_period")) {
        profileReads += 1;
        const snapshot = structuredClone(selected);
        if (profileReads >= seed.stallProfileReads) release();
        else await gate;
        return snapshot;
      }
      return selected;
    }
    if (url.pathname === "/rest/v1/profiles" && method === "PATCH") {
      const row = profiles.find((item) => matches(item, url));
      if (row && body) Object.assign(row, body);
      return prefer.includes("return=representation") && row ? [row] : null;
    }
    if (url.pathname === "/rest/v1/profiles" && method === "POST") {
      const id = String(body?.id);
      const existing = profiles.find((row) => row.id === id);
      if (existing && body) Object.assign(existing, body);
      else if (body) profiles.push(body as unknown as ProfileRow);
      return null;
    }
    if (url.pathname === "/rest/v1/reminders" && method === "GET") {
      const rows = reminders.filter((row) => matches(row, url));
      const limit = Number(url.searchParams.get("limit") ?? "500");
      return rows.slice(0, limit);
    }
    if (url.pathname === "/rest/v1/reminders" && method === "POST") {
      reminders.push(body ?? {});
      return [body];
    }
    if (url.pathname === "/rest/v1/reminders" && method === "PATCH") {
      const row = reminders.find((item) => matches(item, url));
      if (!row) return [];
      Object.assign(row, body);
      return [row];
    }
    if (url.pathname === "/rest/v1/reminders" && method === "DELETE") {
      const kept = reminders.filter((row) => !matches(row, url));
      reminders.splice(0, reminders.length, ...kept);
      return null;
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "GET") {
      const rows = deliveries.filter((row) => matches(row, url));
      if (prefer.includes("count=exact")) return rows.length;
      const limit = Number(url.searchParams.get("limit") ?? String(rows.length || 1000));
      return rows.slice(0, limit);
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "POST") {
      const key = String(body?.dedupe_key);
      if (deliveries.some((row) => row.dedupe_key === key)) throw new Error("duplicate key value violates unique constraint 23505");
      deliveries.push(body ?? {});
      return [body];
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "PATCH") {
      const row = deliveries.find((item) => matches(item, url));
      if (!row) return [];
      Object.assign(row, body);
      return [row];
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "DELETE") {
      const kept = deliveries.filter((row) => !matches(row, url));
      deliveries.splice(0, deliveries.length, ...kept);
      return null;
    }
    if (url.pathname === "/rest/v1/digest_settings" && method === "GET") {
      return digests.filter((row) => matches(row, url));
    }
    if (url.pathname === "/rest/v1/digest_settings" && method === "POST") {
      const owner = String(body?.owner_id);
      const existing = digests.find((row) => row.owner_id === owner);
      if (existing && body) Object.assign(existing, body);
      else if (body) digests.push(body);
      return null;
    }
    if (url.pathname === "/rest/v1/digest_settings" && method === "DELETE") {
      const kept = digests.filter((row) => !matches(row, url));
      digests.splice(0, digests.length, ...kept);
      return null;
    }
    if (url.pathname === "/rest/v1/fillip_runtime") return [{ provider_backoff_until: null }];
    return [];
  };
  const callable = Object.assign(db, { armStall: () => { stallArmed = true; } });
  profileBook.set(callable, profiles);
  return callable;
}

function matches(row: Record<string, unknown>, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (key === "select" || key === "order" || key === "limit") continue;
    if (key === "or") {
      const parts = raw.replace(/^\(/, "").replace(/\)$/, "").split(",");
      const ok = parts.some((part) => compare(row, part));
      if (!ok) return false;
      continue;
    }
    if (!compare(row, `${key}.${raw}`)) return false;
  }
  return true;
}

function compare(row: Record<string, unknown>, clause: string): boolean {
  const match = clause.match(/^([a-z_]+)\.(eq|neq|lte|gte|gt|lt|is)\.(.*)$/);
  if (!match) return true;
  const [, field, op, expected] = match;
  const value = row[field];
  if (op === "is") return expected === "null" ? value === null || value === undefined : String(value) === expected;
  if (op === "eq") return String(value) === expected;
  if (op === "neq") return String(value) !== expected;
  const left = String(value ?? "");
  if (op === "lte") return left <= expected;
  if (op === "gte") return left >= expected;
  if (op === "lt") return left < expected;
  return left > expected;
}
