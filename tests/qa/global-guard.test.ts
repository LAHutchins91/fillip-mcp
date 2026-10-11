/**
 * Independent QA for the shared Resend guard: 60 emails a UTC day,
 * 1,800 a UTC month, queue instead of drop, and a 15-minute 429 back-off.
 * Tests named QA-FAIL assert the behavior a user was promised.
 * They fail on this build. Tests named QA-PASS are observed successes.
 */
import { describe, expect, it } from "vitest";
import { globalEmailLimitsFromEnv, PROVIDER_BACKOFF_MS, runDueJob, type GlobalEmailLimits } from "../../src/lib/deliver.js";
import { ProviderQuotaError, type MailSender, type OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { listReminders, setReminder } from "../../src/lib/reminders.js";
import type { Actor, Delivery } from "../../src/lib/types.js";
import type { TierCaps } from "../../src/lib/usage.js";

const caps: TierCaps = { trialEmailsPerMonth: 100, proEmailsPerMonth: 1000, annualEmailsPerMonth: 1000 };
const fillipShare: GlobalEmailLimits = { perDay: 60, perMonth: 1800 };
const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const other: Actor = { id: "33333333-3333-4333-8333-333333333333", email: "other@example.com", emailVerified: true };
const from = "Fillip <reminders@example.com>";
const createdAt = new Date("2026-10-11T12:00:00.000Z");
const now = new Date("2026-10-11T16:00:00.000Z");

class QuotaSender implements MailSender {
  sent: OutboundEmail[] = [];
  calls = 0;
  quotaLeft = Number.POSITIVE_INFINITY;
  async send(message: OutboundEmail) {
    this.calls += 1;
    if (this.quotaLeft <= 0) throw new ProviderQuotaError(429);
    this.quotaLeft -= 1;
    this.sent.push(structuredClone(message));
    return { id: `email_${this.calls}` };
  }
}

class RacyStore extends MemoryFillipStore {
  override async claimDelivery(input: Parameters<MemoryFillipStore["claimDelivery"]>[0]) {
    const existing = this.deliveries.find((row) => row.dedupeKey === input.dedupeKey);
    if (!existing || existing.status === "sent" || (existing.status === "sending" && existing.startedAt > input.staleBeforeIso)) {
      return super.claimDelivery(input);
    }
    await Promise.resolve();
    existing.status = "sending";
    existing.startedAt = input.nowIso;
    existing.error = null;
    existing.idempotencyKey = input.idempotencyKey;
    return { delivery: { ...existing }, outcome: "send" as const };
  }
}

function job(store: MemoryFillipStore, sender: MailSender, at: Date, global: GlobalEmailLimits = fillipShare, maxSends = 50) {
  return runDueJob({
    store,
    sender,
    now: at,
    from,
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: "unsubscribe-secret",
    maxEmailsPerUserPerDay: 100,
    maxSends,
    minIntervalMs: 0,
    caps,
    global,
    sleep: async () => {},
    warn: () => undefined
  });
}

function priorSends(store: MemoryFillipStore, count: number, sentAt: string) {
  for (let index = 0; index < count; index += 1) {
    const sent: Delivery = {
      id: `prior-${sentAt}-${index}`,
      ownerId: other.id,
      reminderId: null,
      dedupeKey: `prior:${sentAt}:${index}`,
      occurrenceAt: sentAt,
      status: "sent",
      idempotencyKey: `prior:${sentAt}:${index}`,
      providerId: "email_prior",
      startedAt: sentAt,
      sentAt,
      error: null
    };
    store.deliveries.push(sent);
  }
}

async function queuePair(store: MemoryFillipStore) {
  await setReminder(store, actor, { what: "Earlier", when: "in 1 hour", timezone: "UTC" }, createdAt, caps);
  await setReminder(store, actor, { what: "Later", when: "in 2 hours", timezone: "UTC" }, createdAt, caps);
}

describe("QA global email guard", () => {
  it("QA-FAIL: the shared guard ships at 60 a day and 1,800 a month", () => {
    expect(globalEmailLimitsFromEnv({})).toEqual({ perDay: 60, perMonth: 1800 });
  });

  it("QA-PASS: 59 sends and the 60th goes out, and 60 or 61 already sent stay queued", async () => {
    const under = new MemoryFillipStore();
    priorSends(under, 59, now.toISOString());
    await queuePair(under);
    const underSender = new QuotaSender();
    const first = await job(under, underSender, now);
    expect(first.sent).toBe(1);
    expect(underSender.sent.map((row) => row.subject)).toEqual(["Fillip: Earlier"]);
    expect(under.reminders.find((row) => row.what === "Later")?.status).toBe("active");

    const full = new MemoryFillipStore();
    priorSends(full, 60, now.toISOString());
    await queuePair(full);
    const fullSender = new QuotaSender();
    const blocked = await job(full, fullSender, now);
    expect(blocked.sent).toBe(0);
    expect(fullSender.sent).toHaveLength(0);
    expect(full.reminders.filter((row) => row.ownerId === actor.id).map((row) => row.status)).toEqual(["active", "active"]);
    expect(full.reminders.find((row) => row.what === "Earlier")?.holdUntil).toBe("2026-10-12T00:00:00.000Z");

    const over = new MemoryFillipStore();
    priorSends(over, 61, now.toISOString());
    await setReminder(over, actor, { what: "Extra", when: "in 1 hour", timezone: "UTC" }, createdAt, caps);
    const overSender = new QuotaSender();
    expect((await job(over, overSender, now)).sent).toBe(0);
    expect(over.reminders[0]?.status).toBe("active");
  });

  it("QA-PASS: 1,799 sends and the 1,800th goes out, and the rest wait for the next UTC month", async () => {
    const store = new MemoryFillipStore();
    priorSends(store, 1799, "2026-10-01T00:10:00.000Z");
    await queuePair(store);
    const sender = new QuotaSender();
    const october = await job(store, sender, now);
    expect(october.sent).toBe(1);
    expect(store.reminders.find((row) => row.what === "Later")?.holdUntil).toBe("2026-11-01T00:00:00.000Z");
    const stillOctober = await job(store, sender, new Date("2026-10-31T23:00:00.000Z"));
    expect(stillOctober.sent).toBe(0);
    const november = await job(store, sender, new Date("2026-11-01T00:00:00.000Z"));
    expect(november.sent).toBe(1);
    expect(sender.sent.map((row) => row.subject)).toEqual(["Fillip: Earlier", "Fillip: Later"]);
    const again = await job(store, sender, new Date("2026-11-01T00:00:00.000Z"));
    expect(again.sent).toBe(0);
    expect(sender.sent).toHaveLength(2);
  });

  it("QA-PASS: a full UTC day releases the queue at midnight in fire order and does not send the same reminder twice", async () => {
    const store = new MemoryFillipStore();
    priorSends(store, 60, now.toISOString());
    await setReminder(store, actor, { what: "First", when: "in 1 hour", timezone: "UTC" }, createdAt, caps);
    await setReminder(store, actor, { what: "Second", when: "in 2 hours", timezone: "UTC" }, createdAt, caps);
    await setReminder(store, actor, { what: "Third", when: "in 3 hours", timezone: "UTC" }, createdAt, caps);
    const sender = new QuotaSender();
    expect((await job(store, sender, now)).sent).toBe(0);
    const sameDay = await job(store, sender, new Date("2026-10-11T23:59:59.000Z"));
    expect(sameDay.sent).toBe(0);
    const midnight = new Date("2026-10-12T00:00:00.000Z");
    const released = await job(store, sender, midnight, fillipShare, 1);
    expect(released.sent).toBe(1);
    expect(sender.sent.map((row) => row.subject)).toEqual(["Fillip: First"]);
    await job(store, sender, midnight, fillipShare, 1);
    await job(store, sender, midnight, fillipShare, 1);
    expect(sender.sent.map((row) => row.subject)).toEqual(["Fillip: First", "Fillip: Second", "Fillip: Third"]);
    const keys = sender.sent.map((row) => row.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
    expect((await job(store, sender, midnight)).sent).toBe(0);
  });

  it("QA-FAIL: two workers cannot pass a shared cap of 60 or 1,800", async () => {
    const daily = new MemoryFillipStore();
    priorSends(daily, 59, now.toISOString());
    await queuePair(daily);
    const dailySender = new QuotaSender();
    await Promise.all([job(daily, dailySender, now), job(daily, dailySender, now)]);
    const monthly = new MemoryFillipStore();
    priorSends(monthly, 1799, "2026-10-01T00:10:00.000Z");
    await queuePair(monthly);
    const monthlySender = new QuotaSender();
    await Promise.all([job(monthly, monthlySender, now), job(monthly, monthlySender, now)]);
    expect({
      dailySent: dailySender.sent.length,
      dailyTotal: daily.deliveries.filter((row) => row.status === "sent").length,
      monthlySent: monthlySender.sent.length,
      monthlyTotal: monthly.deliveries.filter((row) => row.status === "sent").length
    }).toEqual({ dailySent: 1, dailyTotal: 60, monthlySent: 1, monthlyTotal: 1800 });
  });

  it("QA-FAIL: the user can tell that a queued reminder was delayed", async () => {
    const store = new MemoryFillipStore();
    priorSends(store, 60, now.toISOString());
    await setReminder(store, actor, { what: "Call Ada", when: "in 1 hour", timezone: "UTC" }, createdAt, caps);
    const sender = new QuotaSender();
    await job(store, sender, now);
    const whileHeld = await listReminders(store, actor.id, { status: "active" }, now);
    const nextDay = new Date("2026-10-12T00:05:00.000Z");
    await job(store, sender, nextDay);
    const signal = `${whileHeld[0]?.note ?? ""}\n${sender.sent[0]?.text ?? ""}`;
    expect(signal).toMatch(/delayed|queued|held|backoff|email guard/i);
  });

  it("QA-PASS: a 429 holds every due reminder for the full 15 minutes and does not call the provider again until then", async () => {
    const store = new MemoryFillipStore();
    await queuePair(store);
    const sender = new QuotaSender();
    sender.quotaLeft = 0;
    const blocked = await job(store, sender, now);
    expect(blocked.sent).toBe(0);
    expect(store.providerBackoffUntil).toBe(new Date(now.getTime() + PROVIDER_BACKOFF_MS).toISOString());
    expect(store.reminders.every((row) => row.status === "active")).toBe(true);
    expect(PROVIDER_BACKOFF_MS).toBe(15 * 60 * 1000);
    for (let minute = 1; minute <= 14; minute += 1) {
      await job(store, sender, new Date(now.getTime() + minute * 60 * 1000));
    }
    await job(store, sender, new Date(now.getTime() + PROVIDER_BACKOFF_MS - 1));
    expect(sender.calls).toBe(1);
    expect(sender.sent).toHaveLength(0);
    sender.quotaLeft = 10;
    const released = await job(store, sender, new Date(now.getTime() + PROVIDER_BACKOFF_MS));
    expect(released.sent).toBe(2);
    expect(sender.sent.map((row) => row.subject)).toEqual(["Fillip: Earlier", "Fillip: Later"]);
    expect(new Set(sender.sent.map((row) => row.idempotencyKey)).size).toBe(2);
    expect(sender.calls).toBe(3);
  });

  it("QA-FAIL: two workers clearing a 429 back-off do not send the same reminder twice", async () => {
    const store = new RacyStore();
    await queuePair(store);
    const sender = new QuotaSender();
    sender.quotaLeft = 0;
    await job(store, sender, now);
    expect(store.deliveries.filter((row) => row.status === "failed")).toHaveLength(1);
    sender.quotaLeft = 10;
    const after = new Date(now.getTime() + PROVIDER_BACKOFF_MS);
    await Promise.all([job(store, sender, after), job(store, sender, after)]);
    const keys = sender.sent.map((row) => row.idempotencyKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(sender.sent.length).toBeLessThanOrEqual(2);
  });
});
