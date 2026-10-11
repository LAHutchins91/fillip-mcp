/**
 * Independent QA for Fillip time parsing and email caps.
 * Tests named QA-FAIL assert the behavior a user was promised.
 * They fail on this build. Tests named QA-PASS are observed successes.
 */
import { describe, expect, it } from "vitest";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { listReminders, setReminder } from "../../src/lib/reminders.js";
import { nextFire, resolveWhen, WhenError } from "../../src/lib/time.js";
import type { Actor } from "../../src/lib/types.js";
import { STAND_IN_CAPS, tierCapsFromEnv, type TierCaps } from "../../src/lib/usage.js";
import { assertTimeZone, zonedParts, zonedTimeToUtc } from "../../src/lib/zone.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";

const ny = "America/New_York";
const statedCaps: TierCaps = { trialEmailsPerMonth: 100, proEmailsPerMonth: 1000, annualEmailsPerMonth: 1000 };
const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };

class CountingSender implements MailSender {
  sent: OutboundEmail[] = [];
  async send(message: OutboundEmail) {
    this.sent.push(message);
    return { id: `email_${this.sent.length}` };
  }
}

function job(store: MemoryFillipStore, sender: MailSender, now: Date, limits?: { maxEmailsPerUserPerDay?: number; caps?: TierCaps }) {
  return runDueJob({
    store,
    sender,
    now,
    from: "Fillip <reminders@example.com>",
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: "unsubscribe-secret",
    maxEmailsPerUserPerDay: limits?.maxEmailsPerUserPerDay ?? 100,
    maxSends: 50,
    minIntervalMs: 0,
    caps: limits?.caps ?? statedCaps,
    global: { perDay: 1_000_000, perMonth: 1_000_000 },
    sleep: async () => {}
  });
}

/** Supabase getContact returns a snapshot. Increments must not share one object. */
class SnapshotStore extends MemoryFillipStore {
  override async getContact(ownerId: string) {
    const row = await super.getContact(ownerId);
    return row ? { ...row } : null;
  }
}

describe("QA time parsing", () => {
  it("QA-PASS: Jan 5 entered in December rolls to next year and says so", () => {
    const december = new Date("2026-12-15T18:00:00.000Z");
    const resolved = resolveWhen("Jan 5", ny, december);
    const local = zonedParts(resolved.fireAt, ny);
    expect(local).toMatchObject({ year: 2027, month: 1, day: 5, hour: 9, minute: 0 });
    expect(resolved.corrected).toBe(true);
    expect(resolved.note).toMatch(/2027/);
  });

  it("QA-PASS: an explicit past date and a nonsense zone are rejected", () => {
    const now = new Date("2026-10-11T18:00:00.000Z");
    expect(() => resolveWhen("October 1, 2026 at 2pm", ny, now)).toThrow(WhenError);
    expect(() => resolveWhen("yesterday at 9am", ny, now)).toThrow(/past/);
    expect(() => assertTimeZone("Not/AZone")).toThrow(/IANA/);
    expect(() => assertTimeZone("America/NewYork")).toThrow(/IANA/);
    expect(() => assertTimeZone("EDT")).toThrow(/IANA/);
  });

  it("QA-PASS: relative phrases in 2 hours and tomorrow 9am land on that clock", () => {
    const now = new Date("2026-03-07T15:00:00.000Z");
    const relative = resolveWhen("in 2 hours", ny, now);
    expect(relative.fireAt.toISOString()).toBe("2026-03-07T17:00:00.000Z");
    const tomorrow = resolveWhen("tomorrow at 9am", ny, now);
    expect(zonedParts(tomorrow.fireAt, ny)).toMatchObject({ month: 3, day: 8, hour: 9, minute: 0 });
  });

  it("QA-PASS: a daily 9am reminder stays at 9am across both 2026 DST changes", () => {
    let spring = zonedTimeToUtc(2026, 3, 7, 9, 0, ny);
    for (const day of [8, 9, 10]) {
      spring = nextFire({ kind: "daily", hour: 9, minute: 0 }, ny, spring);
      expect(zonedParts(spring, ny)).toMatchObject({ month: 3, day, hour: 9, minute: 0 });
    }
    let fall = zonedTimeToUtc(2026, 10, 31, 9, 0, ny);
    for (const day of [1, 2, 3]) {
      fall = nextFire({ kind: "daily", hour: 9, minute: 0 }, ny, fall);
      expect(zonedParts(fall, ny)).toMatchObject({ month: 11, day, hour: 9, minute: 0 });
    }
  });

  it("QA-FAIL: a spring-forward gap is rejected or moved forward, not silently set an hour early", () => {
    const now = new Date("2026-02-01T15:00:00.000Z");
    try {
      const resolved = resolveWhen("March 8, 2026 at 2:30am", ny, now);
      const local = zonedParts(resolved.fireAt, ny);
      expect(resolved.corrected, "a nonexistent 2:30am must be flagged").toBe(true);
      expect(resolved.note ?? "", "the user must be told the real time").toMatch(/2:30|3:30|does not exist|daylight/i);
      expect(local.hour, "2:30am must not be stored as 1:30am").not.toBe(1);
      expect(local).toMatchObject({ month: 3, day: 8, minute: 30 });
      expect([3]).toContain(local.hour);
    } catch (error) {
      if (!(error instanceof WhenError)) throw error;
    }
  });

  it("QA-FAIL: a daily 2:30am reminder does not fire at 1:30am on the spring-forward day", () => {
    const march7 = zonedTimeToUtc(2026, 3, 7, 2, 30, ny);
    const next = nextFire({ kind: "daily", hour: 2, minute: 30 }, ny, march7);
    const local = zonedParts(next, ny);
    const kept = local.day === 8 && local.hour === 2 && local.minute === 30;
    const rolledTo330 = local.day === 8 && local.hour === 3 && local.minute === 30;
    const skippedToNextDay = local.day === 9 && local.hour === 2 && local.minute === 30;
    expect(kept || rolledTo330 || skippedToNextDay, `actual local ${local.month}-${local.day} ${local.hour}:${local.minute}`).toBe(true);
  });

  it("QA-FAIL: during the fall-back overlap a still-future 1:30am can be scheduled", () => {
    const between = new Date("2026-11-01T06:00:00.000Z");
    const resolved = resolveWhen("today at 1:30am", ny, between);
    expect(resolved.fireAt.getTime()).toBeGreaterThan(between.getTime());
    expect(zonedParts(resolved.fireAt, ny)).toMatchObject({ month: 11, day: 1, hour: 1, minute: 30 });
  });

  it("QA-FAIL: an ambiguous fall-back time says which 1:30am was chosen", () => {
    const october = new Date("2026-10-15T15:00:00.000Z");
    const resolved = resolveWhen("November 1, 2026 at 1:30am", ny, october);
    expect(zonedParts(resolved.fireAt, ny)).toMatchObject({ hour: 1, minute: 30 });
    expect(resolved.note ?? "").toMatch(/daylight|standard|ambiguous|first|second|EDT|EST/i);
  });

  it("QA-FAIL: EST and PST are not accepted as IANA timezones", () => {
    const listed = new Set(Intl.supportedValuesOf("timeZone"));
    expect(listed.has("EST")).toBe(false);
    expect(listed.has("PST")).toBe(false);
    expect(() => assertTimeZone("EST")).toThrow(/IANA/);
    expect(() => assertTimeZone("PST")).toThrow(/IANA/);
  });

  it("QA-FAIL: in 1 day keeps the local clock across spring forward, or explains the shift", () => {
    const at230 = new Date("2026-03-07T07:30:00.000Z");
    const resolved = resolveWhen("in 1 day", ny, at230);
    const local = zonedParts(resolved.fireAt, ny);
    const sameClock = local.hour === 2 && local.minute === 30;
    const explained = Boolean(resolved.note);
    expect(sameClock || explained, `actual ${local.hour}:${String(local.minute).padStart(2, "0")} note=${resolved.note}`).toBe(true);
  });
});

describe("QA email caps", () => {
  async function dueReminder(store: MemoryFillipStore, what: string) {
    return setReminder(store, actor, { what, when: "in 1 hour", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"), statedCaps);
  }

  function usage(store: MemoryFillipStore, used: number, status = "active", plan: "pro" | "annual" = "pro") {
    const contact = store.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.plan = plan;
    contact.subscriptionStatus = status;
    contact.emailsSentInPeriod = used;
    contact.emailPeriodStart = "2026-10-01T00:00:00.000Z";
    return contact;
  }

  it("QA-PASS: with a 1,000 monthly cap, 999 sends and 1,000 and 1,001 do not", async () => {
    for (const used of [999, 1000, 1001]) {
      const store = new MemoryFillipStore();
      const sender = new CountingSender();
      await dueReminder(store, `m${used}`);
      usage(store, used);
      const report = await job(store, sender, new Date("2026-10-11T16:00:00.000Z"));
      expect(report.sent, `used ${used}`).toBe(used < 1000 ? 1 : 0);
      expect(sender.sent).toHaveLength(used < 1000 ? 1 : 0);
    }
  });

  it("QA-PASS: with a 100 daily cap, 99 sends and 100 and 101 do not", async () => {
    for (const sent of [99, 100, 101]) {
      const store = new MemoryFillipStore();
      const sender = new CountingSender();
      await dueReminder(store, `d${sent}`);
      const at = "2026-10-11T13:00:00.000Z";
      for (let i = 0; i < sent; i += 1) {
        store.deliveries.push({
          id: `prior-${i}`,
          ownerId: actor.id,
          reminderId: null,
          dedupeKey: `prior:${i}`,
          occurrenceAt: at,
          status: "sent",
          idempotencyKey: `prior/${i}`,
          providerId: "p",
          startedAt: at,
          sentAt: at,
          error: null
        });
      }
      const report = await job(store, sender, new Date("2026-10-11T16:00:00.000Z"));
      expect(report.sent, `already sent ${sent}`).toBe(sent < 100 ? 1 : 0);
    }
  });

  it("QA-FAIL: a trial user is limited to 100 emails total, including across a month boundary", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    await setReminder(store, actor, { what: "trial ping", when: "in 1 hour", timezone: "UTC" }, new Date("2026-01-20T15:00:00.000Z"), statedCaps);
    const contact = store.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.plan = "pro";
    contact.subscriptionStatus = "trialing";
    contact.emailsSentInPeriod = 100;
    contact.emailPeriodStart = "2026-01-01T00:00:00.000Z";
    const report = await job(store, sender, new Date("2026-02-02T15:00:00.000Z"));
    expect(report.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(contact.emailsSentInPeriod).toBe(100);
  });

  it("QA-FAIL: an unset environment enforces 1,000 a month, 100 a day, and 100 trial emails", () => {
    expect(STAND_IN_CAPS).toEqual({ trialEmailsPerMonth: 100, proEmailsPerMonth: 1000, annualEmailsPerMonth: 1000 });
    expect(tierCapsFromEnv({})).toEqual({ trialEmailsPerMonth: 100, proEmailsPerMonth: 1000, annualEmailsPerMonth: 1000 });
  });

  it("QA-FAIL: two workers cannot race past the monthly or daily cap", async () => {
    const monthly = new SnapshotStore();
    const monthlySender = new CountingSender();
    await dueReminder(monthly, "A");
    await dueReminder(monthly, "B");
    usage(monthly, 999);
    await Promise.all([
      job(monthly, monthlySender, new Date("2026-10-11T16:00:00.000Z")),
      job(monthly, monthlySender, new Date("2026-10-11T16:00:00.000Z"))
    ]);
    expect(monthlySender.sent.length).toBeLessThanOrEqual(1);
    expect(monthly.contacts.get(actor.id)?.emailsSentInPeriod ?? 0).toBeLessThanOrEqual(1000);

    const daily = new SnapshotStore();
    const dailySender = new CountingSender();
    await dueReminder(daily, "C");
    await dueReminder(daily, "D");
    const at = "2026-10-11T15:00:00.000Z";
    for (let i = 0; i < 99; i += 1) {
      daily.deliveries.push({
        id: `day-${i}`,
        ownerId: actor.id,
        reminderId: null,
        dedupeKey: `day:${i}`,
        occurrenceAt: at,
        status: "sent",
        idempotencyKey: `day/${i}`,
        providerId: "p",
        startedAt: at,
        sentAt: at,
        error: null
      });
    }
    await Promise.all([
      job(daily, dailySender, new Date("2026-10-11T16:00:00.000Z")),
      job(daily, dailySender, new Date("2026-10-11T16:00:00.000Z"))
    ]);
    expect(dailySender.sent.length).toBeLessThanOrEqual(1);
  });

  it("QA-FAIL: the daily cap resets at local midnight rather than a rolling 24 hours", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    await setReminder(store, actor, { what: "local day", when: "in 1 hour", timezone: ny }, new Date("2026-03-08T20:00:00.000Z"), statedCaps);
    const sentAt = "2026-03-09T03:30:00.000Z";
    for (let i = 0; i < 100; i += 1) {
      store.deliveries.push({
        id: `ny-${i}`,
        ownerId: actor.id,
        reminderId: null,
        dedupeKey: `ny:${i}`,
        occurrenceAt: sentAt,
        status: "sent",
        idempotencyKey: `ny/${i}`,
        providerId: "p",
        startedAt: sentAt,
        sentAt,
        error: null
      });
    }
    const afterLocalMidnight = new Date("2026-03-09T04:15:00.000Z");
    expect(zonedParts(new Date(sentAt), ny)).toMatchObject({ month: 3, day: 8, hour: 23, minute: 30 });
    expect(zonedParts(afterLocalMidnight, ny)).toMatchObject({ month: 3, day: 9, hour: 0, minute: 15 });
    const daily = await job(store, sender, afterLocalMidnight);
    expect(daily.sent, "a new America/New_York day should allow another 100").toBe(1);
  });

  it("QA-FAIL: the monthly cap uses the account timezone", async () => {
    const pacific = new MemoryFillipStore();
    const pacificSender = new CountingSender();
    await setReminder(pacific, actor, { what: "local month", when: "in 1 hour", timezone: "America/Los_Angeles" }, new Date("2026-02-27T20:00:00.000Z"), statedCaps);
    const contact = pacific.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.plan = "pro";
    contact.subscriptionStatus = "active";
    contact.emailsSentInPeriod = 1000;
    contact.emailPeriodStart = "2026-02-01T00:00:00.000Z";
    const stillFebruaryLocal = new Date("2026-03-01T07:30:00.000Z");
    expect(zonedParts(stillFebruaryLocal, "America/Los_Angeles")).toMatchObject({ month: 2, day: 28 });
    const monthly = await job(pacific, pacificSender, stillFebruaryLocal);
    expect(monthly.sent, "Pacific is still in February, so the 1,000 cap still applies").toBe(0);
  });

  it("QA-FAIL: a reminder blocked by the cap tells the user why it did not send", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    const created = await dueReminder(store, "held reminder");
    usage(store, 1000);
    const now = new Date("2026-10-11T16:00:00.000Z");
    await job(store, sender, now);
    const saved = await store.getReminder(actor.id, created.id);
    expect(saved?.status).toBe("active");
    const listed = await listReminders(store, actor.id, {}, now);
    const note = listed.find((row) => row.id === created.id)?.note ?? "";
    const explainedInEmail = sender.sent.some((message) => /used up|allowance/i.test(message.text));
    expect(note || explainedInEmail ? note || "email" : "", "the user is told the cap blocked this reminder").toMatch(/used up|allowance|email/);
  });

  it("QA-FAIL: a daily reminder held across missed days does not replay the backlog", async () => {
    const series = new MemoryFillipStore();
    const seriesSender = new CountingSender();
    const follow = await setReminder(series, actor, { what: "every morning", when: "every day 9am", timezone: "UTC" }, new Date("2026-09-01T12:00:00.000Z"), statedCaps);
    const row = await series.getReminder(actor.id, follow.id);
    if (!row) throw new Error("missing reminder");
    row.fireAt = "2026-09-10T09:00:00.000Z";
    row.holdUntil = null;
    await series.saveReminder(row);
    const later = new Date("2026-10-11T14:00:00.000Z");
    for (let run = 0; run < 3; run += 1) await job(series, seriesSender, new Date(later.getTime() + run * 60_000));
    const advanced = await series.getReminder(actor.id, follow.id);
    expect(seriesSender.sent.length, "missed days must not each become their own email").toBeLessThanOrEqual(1);
    expect(advanced && advanced.fireAt > later.toISOString(), `next fire stayed in the past at ${advanced?.fireAt}`).toBe(true);
  });

  it("QA-PASS: a cap-blocked reminder is kept and creating another one explains the cap", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    const created = await dueReminder(store, "kept");
    usage(store, 1000);
    const now = new Date("2026-10-11T16:00:00.000Z");
    const report = await job(store, sender, now);
    expect(report.deferred).toBe(1);
    expect(report.sent).toBe(0);
    const saved = await store.getReminder(actor.id, created.id);
    expect(saved?.status).toBe("active");
    expect(saved?.holdUntil).toBeTruthy();
    await expect(setReminder(store, actor, { what: "another", when: "tomorrow 9am", timezone: "UTC" }, now, statedCaps)).rejects.toThrow(/used up/);
  });

  it("QA-FAIL: the hosted daily counter can see more than 100 sends", async () => {
    const db: Db = async (pathname) => {
      if (!pathname.includes("/rest/v1/deliveries")) return [];
      const limit = Number((pathname.match(/limit=(\d+)/) ?? [])[1] ?? "1000");
      return Array.from({ length: Math.min(150, limit) }, (_, index) => ({ id: `sent-${index}` }));
    };
    const store = new SupabaseFillipStore(null, db, "service");
    const count = await store.countSentSince(actor.id, "2026-10-01T00:00:00.000Z");
    expect(count).toBe(150);
  });
});
