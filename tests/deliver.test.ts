import { describe, expect, it } from "vitest";
import { globalEmailLimitsFromEnv, PROVIDER_BACKOFF_MS, runDueJob, type GlobalEmailLimits } from "../src/lib/deliver.js";
import { createResendSender, ProviderQuotaError, type MailSender, type OutboundEmail } from "../src/lib/email.js";
import { MemoryFillipStore } from "../src/lib/memory-store.js";
import { followUp, saveDigestSettings, setReminder } from "../src/lib/reminders.js";
import { verifyStopToken } from "../src/lib/stop-token.js";
import type { Actor, Delivery } from "../src/lib/types.js";
import { nextMonthStart, type TierCaps } from "../src/lib/usage.js";

const openCaps: TierCaps = { trialEmailsPerMonth: 100, proEmailsPerMonth: 100, annualEmailsPerMonth: 100 };
const openGlobal: GlobalEmailLimits = { perDay: 1000, perMonth: 1000 };

const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const secret = "unsubscribe-secret";
const from = "Fillip <reminders@example.com>";

class RecordingSender implements MailSender {
  sent: OutboundEmail[] = [];
  failuresLeft = 0;
  quotaLeft = 0;
  async send(message: OutboundEmail) {
    if (this.quotaLeft > 0) {
      this.quotaLeft -= 1;
      throw new ProviderQuotaError(429);
    }
    if (this.failuresLeft > 0) {
      this.failuresLeft -= 1;
      throw new Error("provider down");
    }
    const prior = this.sent.find((row) => row.idempotencyKey === message.idempotencyKey);
    if (prior) return { id: "duplicate-suppressed" };
    this.sent.push(message);
    return { id: `email_${this.sent.length}` };
  }
}

function job(store: MemoryFillipStore, sender: RecordingSender, now: Date, limits?: { maxEmailsPerUserPerDay?: number; maxSends?: number; minIntervalMs?: number; caps?: TierCaps; global?: GlobalEmailLimits; sleep?: (ms: number) => Promise<void>; warn?: (message: string) => void }) {
  return runDueJob({
    store,
    sender,
    now,
    from,
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: secret,
    maxEmailsPerUserPerDay: limits?.maxEmailsPerUserPerDay ?? 20,
    maxSends: limits?.maxSends ?? 40,
    minIntervalMs: limits?.minIntervalMs ?? 0,
    caps: limits?.caps ?? openCaps,
    global: limits?.global ?? openGlobal,
    warn: limits?.warn,
    sleep: limits?.sleep
  });
}

describe("due reminder job", () => {
  it("emails the owner once and does not email again on retry", async () => {
    const store = new MemoryFillipStore();
    const now = new Date("2026-10-13T18:05:00.000Z");
    const created = await setReminder(store, actor, {
      what: "Follow up with Ada about bob@evil.test",
      when: "next Tue 2pm",
      timezone: "America/New_York",
      context: "notes"
    }, new Date("2026-10-11T18:00:00.000Z"));
    const sender = new RecordingSender();
    const first = await job(store, sender, now);
    expect(first.sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    const message = sender.sent[0];
    expect(message?.to).toBe("owner@example.com");
    expect(message?.to).not.toContain("bob@evil.test");
    expect(message?.from).toBe(from);
    expect(message?.text).toMatch(/Fillip, reminders that fire/);
    expect(message?.headers["List-Unsubscribe"]).toMatch(/https:\/\/fillip\.example\/stop\?token=/);
    const token = decodeURIComponent((message?.text.match(/token=([^\s]+)/) ?? [])[1] ?? "");
    expect(verifyStopToken(token, secret, now.getTime())).toBe(actor.id);
    const saved = await store.getReminder(actor.id, created.id);
    expect(saved?.status).toBe("fired");

    const second = await job(store, sender, now);
    expect(second.sent).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it("retries a failed send with the same idempotency key and still sends once", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T18:00:00.000Z");
    const due = new Date("2026-10-13T18:05:00.000Z");
    await setReminder(store, actor, { what: "Call back", when: "next Tue 2pm", timezone: "America/New_York" }, createdAt);
    const sender = new RecordingSender();
    sender.failuresLeft = 1;
    const failed = await job(store, sender, due);
    expect(failed.failed).toBe(1);
    expect(sender.sent).toHaveLength(0);
    const retried = await job(store, sender, due);
    expect(retried.sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.idempotencyKey).toMatch(/^fillip\//);
    const again = await job(store, sender, due);
    expect(again.sent).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it("advances a follow-up and stops after it is marked done", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T18:00:00.000Z");
    const follow = await followUp(store, actor, {
      topic: "Check the contract",
      after: "next Tue 2pm",
      timezone: "America/New_York"
    }, createdAt);
    const sender = new RecordingSender();
    await job(store, sender, new Date("2026-10-13T18:05:00.000Z"));
    expect(sender.sent).toHaveLength(1);
    const saved = await store.getReminder(actor.id, follow.id);
    expect(saved?.status).toBe("active");
    expect(saved && saved.fireAt > "2026-10-13T18:00:00.000Z").toBe(true);
    saved!.status = "completed";
    await store.saveReminder(saved!);
    await job(store, sender, new Date("2026-10-20T18:05:00.000Z"));
    expect(sender.sent).toHaveLength(1);
  });

  it("does not email an unsubscribed account or an address named in the reminder", async () => {
    const store = new MemoryFillipStore();
    await setReminder(store, actor, {
      what: "Ping other@example.net",
      when: "in 1 hour",
      timezone: "UTC"
    }, new Date("2026-10-11T18:00:00.000Z"));
    await store.setMailOptIn(actor.id, false);
    const sender = new RecordingSender();
    const report = await job(store, sender, new Date("2026-10-11T20:00:00.000Z"));
    expect(report.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it("defers the rest of an account once the daily cap is hit", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    await setReminder(store, actor, { what: "First", when: "in 1 hour", timezone: "UTC" }, createdAt);
    await setReminder(store, actor, { what: "Second", when: "in 2 hours", timezone: "UTC" }, createdAt);
    const sender = new RecordingSender();
    const report = await job(store, sender, new Date("2026-10-11T16:00:00.000Z"), { maxEmailsPerUserPerDay: 1 });
    expect(report.sent).toBe(1);
    expect(report.deferred).toBe(1);
    expect(sender.sent).toHaveLength(1);
    const held = store.reminders.find((row) => row.what === "Second");
    expect(held?.holdUntil).toBeTruthy();
  });

  it("paces provider calls", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    await setReminder(store, actor, { what: "First", when: "in 1 hour", timezone: "UTC" }, createdAt);
    await setReminder(store, actor, { what: "Second", when: "in 2 hours", timezone: "UTC" }, createdAt);
    const sender = new RecordingSender();
    const sleeps: number[] = [];
    await job(store, sender, new Date("2026-10-11T16:00:00.000Z"), {
      minIntervalMs: 25,
      sleep: async (ms) => { sleeps.push(ms); }
    });
    expect(sender.sent).toHaveLength(2);
    expect(sleeps).toEqual([25]);
  });

  it("sends a daily summary once", async () => {
    const store = new MemoryFillipStore();
    const morning = new Date("2026-10-12T13:30:00.000Z");
    await setReminder(store, actor, { what: "Standup notes", when: "tomorrow 4pm", timezone: "America/New_York" }, new Date("2026-10-11T18:00:00.000Z"));
    await saveDigestSettings(store, actor, { enabled: true, time: "8am", timezone: "America/New_York" }, morning);
    const sender = new RecordingSender();
    const first = await job(store, sender, morning);
    expect(first.digests).toBe(1);
    expect(sender.sent.some((row) => row.subject.includes("today"))).toBe(true);
    const second = await job(store, sender, morning);
    expect(second.digests).toBe(0);
    expect(sender.sent.filter((row) => row.subject.includes("today"))).toHaveLength(1);
  });

  it("refuses to send without a configured from address", async () => {
    const store = new MemoryFillipStore();
    await expect(runDueJob({
      store,
      sender: new RecordingSender(),
      now: new Date(),
      from: "  ",
      appBaseUrl: "https://fillip.example",
      unsubscribeSecret: secret,
      maxEmailsPerUserPerDay: 20,
      maxSends: 10,
      minIntervalMs: 0,
      caps: openCaps,
      global: openGlobal
    })).rejects.toThrow(/Sender identity is not configured/);
  });

  it("stops at the plan's monthly allowance and does not send the rest on retry", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    await setReminder(store, actor, { what: "First", when: "in 1 hour", timezone: "UTC" }, createdAt);
    await setReminder(store, actor, { what: "Second", when: "in 2 hours", timezone: "UTC" }, createdAt);
    const contact = store.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.plan = "pro";
    contact.subscriptionStatus = "active";
    const sender = new RecordingSender();
    const caps: TierCaps = { trialEmailsPerMonth: 8, proEmailsPerMonth: 1, annualEmailsPerMonth: 8 };
    const now = new Date("2026-10-11T16:00:00.000Z");
    const report = await job(store, sender, now, { caps });
    expect(report.sent).toBe(1);
    expect(report.deferred).toBe(1);
    expect(sender.sent).toHaveLength(1);
    const held = store.reminders.find((row) => row.what === "Second");
    expect(held?.holdUntil).toBe("2026-11-01T00:00:00.000Z");
    const again = await job(store, sender, now, { caps });
    expect(again.sent).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it("uses the trial allowance while the subscription is still trialing", async () => {
    const store = new MemoryFillipStore();
    await setReminder(store, actor, { what: "Trial ping", when: "in 1 hour", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"));
    const contact = store.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.plan = "annual";
    contact.subscriptionStatus = "trialing";
    const sender = new RecordingSender();
    const report = await job(store, sender, new Date("2026-10-11T16:00:00.000Z"), {
      caps: { trialEmailsPerMonth: 0, proEmailsPerMonth: 50, annualEmailsPerMonth: 50 }
    });
    expect(report.sent).toBe(0);
    expect(report.deferred).toBe(1);
    expect(sender.sent).toHaveLength(0);
  });

  it("counts every account toward the shared daily guard and sends the rest in order the next day", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    const now = new Date("2026-10-11T16:00:00.000Z");
    const other: Actor = { id: "33333333-3333-4333-8333-333333333333", email: "other@example.com", emailVerified: true };
    await setReminder(store, other, { what: "Already mailed", when: "in 1 hour", timezone: "UTC" }, createdAt);
    const prior = store.reminders.find((row) => row.what === "Already mailed");
    if (!prior) throw new Error("missing prior");
    prior.status = "fired";
    store.deliveries.push(sentDelivery(other.id, prior.id, now.toISOString()));
    store.deliveries.push(sentDelivery(other.id, null, now.toISOString()));
    await followUp(store, actor, { topic: "Earlier", after: "in 1 hour", timezone: "UTC" }, createdAt);
    await setReminder(store, actor, { what: "Later", when: "in 2 hours", timezone: "UTC" }, createdAt);
    const sender = new RecordingSender();
    const warnings: string[] = [];
    const global = { perDay: 2, perMonth: 50 };
    const first = await job(store, sender, now, { global, warn: (message) => warnings.push(message) });
    expect(first.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(store.reminders.filter((row) => row.ownerId === actor.id).every((row) => row.status === "active")).toBe(true);
    expect(store.deliveries.filter((row) => row.ownerId === actor.id && row.status === "sent")).toHaveLength(0);
    expect(warnings.join("\n")).toMatch(/global email guard/);
    expect(first.global.daySent).toBe(2);
    expect(first.global.stopped).toBe(true);
    expect(first.global.close).toBe(true);
    const earlier = store.reminders.find((row) => row.what === "Earlier");
    const later = store.reminders.find((row) => row.what === "Later");
    const earlierFireAt = earlier?.fireAt;
    expect(earlier?.holdUntil).toBe("2026-10-12T00:00:00.000Z");
    expect(later?.holdUntil).toBe("2026-10-12T00:00:00.000Z");

    const sameDay = await job(store, sender, new Date("2026-10-11T18:00:00.000Z"), { global, warn: () => undefined });
    expect(sameDay.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);

    const nextDay = await job(store, sender, new Date("2026-10-12T00:05:00.000Z"), { global, warn: () => undefined });
    expect(nextDay.sent).toBe(2);
    expect(sender.sent.map((row) => row.subject)).toEqual(["Fillip: Earlier", "Fillip: Later"]);
    expect(store.reminders.find((row) => row.what === "Earlier")?.status).toBe("active");
    expect(store.reminders.find((row) => row.what === "Later")?.status).toBe("fired");
    const keys = sender.sent.map((row) => row.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(`fillip/${earlier?.id}/${earlierFireAt}`);
  });

  it("keeps reminders queued until the shared month resets", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    const now = new Date("2026-10-11T16:00:00.000Z");
    await setReminder(store, actor, { what: "Earlier", when: "in 1 hour", timezone: "UTC" }, createdAt);
    await setReminder(store, actor, { what: "Later", when: "in 2 hours", timezone: "UTC" }, createdAt);
    const sender = new RecordingSender();
    const global = { perDay: 20, perMonth: 1 };
    await job(store, sender, now, { global, warn: () => undefined });
    expect(sender.sent).toHaveLength(1);
    const later = store.reminders.find((row) => row.what === "Later");
    expect(later?.status).toBe("active");
    expect(later?.holdUntil).toBe(nextMonthStart(now).toISOString());
    const stillOctober = await job(store, sender, new Date("2026-10-20T16:00:00.000Z"), { global, warn: () => undefined });
    expect(stillOctober.sent).toBe(0);
    expect(sender.sent).toHaveLength(1);
    const november = await job(store, sender, new Date("2026-11-01T00:05:00.000Z"), { global, warn: () => undefined });
    expect(november.sent).toBe(1);
    expect(sender.sent.map((row) => row.subject)).toEqual(["Fillip: Earlier", "Fillip: Later"]);
  });

  it("backs off on a provider quota error and retries once with the same idempotency key", async () => {
    const store = new MemoryFillipStore();
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    const now = new Date("2026-10-11T16:00:00.000Z");
    await setReminder(store, actor, { what: "Earlier", when: "in 1 hour", timezone: "UTC" }, createdAt);
    await setReminder(store, actor, { what: "Later", when: "in 2 hours", timezone: "UTC" }, createdAt);
    const earlier = store.reminders.find((row) => row.what === "Earlier");
    if (!earlier) throw new Error("missing earlier");
    const sender = new RecordingSender();
    sender.quotaLeft = 1;
    const warnings: string[] = [];
    const blocked = await job(store, sender, now, { warn: (message) => warnings.push(message) });
    expect(blocked.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(store.reminders.every((row) => row.status === "active")).toBe(true);
    expect(store.deliveries.filter((row) => row.status === "sent")).toHaveLength(0);
    expect(store.deliveries.find((row) => row.reminderId === earlier.id)?.status).toBe("failed");
    expect(store.reminders.find((row) => row.what === "Later")?.holdUntil).toBe(new Date(now.getTime() + PROVIDER_BACKOFF_MS).toISOString());
    expect(warnings.join("\n")).toMatch(/quota or rate limit/);

    const during = await job(store, sender, new Date(now.getTime() + 60_000), { warn: () => undefined });
    expect(during.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);

    const after = await job(store, sender, new Date(now.getTime() + PROVIDER_BACKOFF_MS + 1000), { warn: () => undefined });
    expect(after.sent).toBe(2);
    expect(sender.sent.map((row) => row.subject)).toEqual(["Fillip: Earlier", "Fillip: Later"]);
    const keys = sender.sent.map((row) => row.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toBe(`fillip/${earlier.id}/${earlier.fireAt}`);
    expect(store.deliveries.filter((row) => row.status === "sent")).toHaveLength(2);
  });

  it("queues a due digest when the shared day is full and sends it once the day resets", async () => {
    const store = new MemoryFillipStore();
    const other: Actor = { id: "33333333-3333-4333-8333-333333333333", email: "other@example.com", emailVerified: true };
    const morning = new Date("2026-10-12T13:30:00.000Z");
    await setReminder(store, actor, { what: "Standup notes", when: "tomorrow 4pm", timezone: "America/New_York" }, new Date("2026-10-11T18:00:00.000Z"));
    await saveDigestSettings(store, actor, { enabled: true, time: "8am", timezone: "America/New_York" }, morning);
    store.deliveries.push(sentDelivery(other.id, null, morning.toISOString()));
    const sender = new RecordingSender();
    const global = { perDay: 1, perMonth: 50 };
    const blocked = await job(store, sender, morning, { global, warn: () => undefined });
    expect(blocked.sent).toBe(0);
    expect(blocked.digests).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(store.digests.get(actor.id)?.lastSentOn).toBeNull();

    const notes = store.reminders.find((row) => row.what === "Standup notes");
    if (!notes) throw new Error("missing notes");
    notes.fireAt = "2026-10-13T20:00:00.000Z";
    notes.holdUntil = null;
    const nextDay = new Date("2026-10-13T13:30:00.000Z");
    const sent = await job(store, sender, nextDay, { global, warn: () => undefined });
    expect(sent.digests).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.idempotencyKey).toBe(`fillip/digest/${actor.id}/2026-10-13`);
    expect(store.digests.get(actor.id)?.lastSentOn).toBe("2026-10-13");
    const again = await job(store, sender, nextDay, { global, warn: () => undefined });
    expect(again.digests).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it("queues due reminders when the shared limits are unset", async () => {
    const store = new MemoryFillipStore();
    await setReminder(store, actor, { what: "Stay queued", when: "in 1 hour", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"));
    const sender = new RecordingSender();
    const warnings: string[] = [];
    const report = await job(store, sender, new Date("2026-10-11T16:00:00.000Z"), {
      global: { perDay: 0, perMonth: 0 },
      warn: (message) => warnings.push(message)
    });
    expect(report.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(report.global.stopped).toBe(true);
    expect(store.reminders[0]?.status).toBe("active");
    expect(warnings.join("\n")).toMatch(/not set/);
  });
});

function sentDelivery(ownerId: string, reminderId: string | null, sentAt: string): Delivery {
  const key = `prior:${ownerId}:${reminderId ?? "digest"}:${sentAt}`;
  return {
    id: key,
    ownerId,
    reminderId,
    dedupeKey: key,
    occurrenceAt: sentAt,
    status: "sent",
    idempotencyKey: key,
    providerId: "email_prior",
    startedAt: sentAt,
    sentAt,
    error: null
  };
}

describe("global email limits", () => {
  it("reads the shared caps from the environment and fails closed when they are blank", () => {
    expect(globalEmailLimitsFromEnv({})).toEqual({ perDay: 0, perMonth: 0 });
    expect(globalEmailLimitsFromEnv({
      FILLIP_GLOBAL_MAX_EMAILS_PER_DAY: "40",
      FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH: "800"
    })).toEqual({ perDay: 40, perMonth: 800 });
    expect(globalEmailLimitsFromEnv({
      FILLIP_GLOBAL_MAX_EMAILS_PER_DAY: " ",
      FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH: "nope"
    })).toEqual({ perDay: 0, perMonth: 0 });
  });
});

describe("Resend sender", () => {
  it("posts one recipient and the idempotency key", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ id: "re_1" }), { status: 200 });
    }) as typeof fetch;
    const sender = createResendSender("test-token", fetchImpl);
    await sender.send({
      from,
      to: "owner@example.com",
      subject: "Fillip: hello",
      text: "hello",
      html: "<p>hello</p>",
      idempotencyKey: "fillip/abc/2026",
      headers: { "List-Unsubscribe": "<https://fillip.example/stop?token=abc>" }
    });
    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect(calls[0]?.body.to).toEqual(["owner@example.com"]);
    expect(calls[0]?.body.from).toBe(from);
    expect(calls[0]?.headers.get("Idempotency-Key")).toBe("fillip/abc/2026");
  });

  it("treats a 429 or a quota response as a backoff and leaves other failures as send errors", async () => {
    const message = {
      from,
      to: "owner@example.com",
      subject: "Fillip: hello",
      text: "hello",
      html: "<p>hello</p>",
      idempotencyKey: "fillip/abc/2026",
      headers: {}
    };
    const fetchStatus = (status: number, body: string) => (async () => new Response(body, { status })) as typeof fetch;
    const sender = createResendSender("test-token", fetchStatus(429, "{\"message\":\"Too many requests\"}"));
    await expect(sender.send(message)).rejects.toBeInstanceOf(ProviderQuotaError);

    const quota = createResendSender("test-token", fetchStatus(403, "{\"message\":\"You have reached your monthly quota.\"}"));
    await expect(quota.send(message)).rejects.toBeInstanceOf(ProviderQuotaError);

    const other = createResendSender("test-token", fetchStatus(500, "{\"message\":\"upstream down\"}"));
    await expect(other.send(message)).rejects.toThrow(/Email provider rejected the reminder/);
    await expect(other.send(message)).rejects.not.toBeInstanceOf(ProviderQuotaError);
  });

  it("rejects more than one recipient", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ id: "re_1" }), { status: 200 })) as typeof fetch;
    const sender = createResendSender("test-token", fetchImpl);
    await expect(sender.send({
      from,
      to: "owner@example.com, other@example.net",
      subject: "nope",
      text: "nope",
      html: "nope",
      idempotencyKey: "fillip/nope",
      headers: {}
    })).rejects.toThrow(/one verified address/);
  });
});
