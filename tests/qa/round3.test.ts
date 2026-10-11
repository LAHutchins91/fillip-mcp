/**
 * QA round 3 against 68dd9ed.
 * QA-FAIL tests assert promised behavior and fail on this build.
 * QA-PASS tests are adversarial checks that held.
 */
import { readFileSync } from "node:fs";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import {
  calendarLink,
  completeOrCancel,
  listReminders,
  renderCalendarFeed,
  setReminder,
  snoozeOrReschedule
} from "../../src/lib/reminders.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import { nextFire, resolveWhen } from "../../src/lib/time.js";
import type { Actor, Delivery, Reminder } from "../../src/lib/types.js";
import { STAND_IN_CAPS } from "../../src/lib/usage.js";
import { zonedParts } from "../../src/lib/zone.js";
import { otpFailure, protectedResourceMetadata } from "../../src/plugin-auth.js";
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

class KeyTelegram {
  sent: Array<{ chatId: string; text: string; key: string }> = [];
  async send(chatId: string, text: string, key: string) {
    this.sent.push({ chatId, text, key });
    return { id: `tg_${this.sent.length}` };
  }
}

function job(store: MemoryFillipStore | SupabaseFillipStore, sender: MailSender, at: Date, extra?: {
  telegram?: { sender: KeyTelegram } | null;
  global?: { perDay: number; perMonth: number };
  maxEmailsPerUserPerDay?: number;
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
    caps,
    global: extra?.global ?? { perDay: 1_000_000, perMonth: 1_000_000 },
    sleep: async () => {},
    telegram: extra?.telegram
  });
}

function usePlan(store: MemoryFillipStore, used: number, plan: "free" | "pro", status: string) {
  const contact = store.contacts.get(actor.id);
  if (!contact) throw new Error("missing contact");
  contact.plan = plan;
  contact.subscriptionStatus = status;
  contact.emailsSentInPeriod = used;
  contact.emailPeriodStart = "2026-10-01T00:00:00.000Z";
  contact.telegramChatId = "9001";
  return contact;
}

async function due(store: MemoryFillipStore, what: string, at = new Date("2026-10-11T12:00:00.000Z")) {
  return setReminder(store, actor, { what, when: "in 1 hour", timezone: "UTC" }, at, caps, true);
}

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

type Books = {
  profiles: ProfileRow[];
  reminders: Record<string, unknown>[];
  deliveries: Record<string, unknown>[];
  digests: Record<string, unknown>[];
};

const books = new WeakMap<Db, Books>();

function hostedDb(seed: {
  used: number;
  plan: string;
  status: string;
  stallProfileReads?: number;
}): Db & { armStall: () => void; armActiveStall: () => void; armTicketBarrier: () => void } {
  const data: Books = {
    profiles: [{
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
    }],
    reminders: [],
    deliveries: [],
    digests: []
  };
  let profileReads = 0;
  let stallArmed = false;
  let activeStall = false;
  let activeReads = 0;
  let ticketBarrier = false;
  let releaseProfiles: () => void = () => {};
  let releaseActive: () => void = () => {};
  const profileGate = new Promise<void>((resolve) => {
    releaseProfiles = resolve;
  });
  const activeGate = new Promise<void>((resolve) => {
    releaseActive = resolve;
  });
  const ticketWaits = new Map<string, { reads: number; release: () => void; gate: Promise<void> }>();
  const db: Db = async (pathname, options) => {
    await Promise.resolve();
    const method = (options?.method ?? "GET").toUpperCase();
    const prefer = new Headers(options?.headers).get("prefer") ?? "";
    const body = options?.body ? JSON.parse(String(options.body)) as Record<string, unknown> : null;
    const url = new URL(pathname, "http://fillip.local");
    if (url.pathname.startsWith("/auth/v1/admin/users/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
      if (id === actor.id) return { id: actor.id, email: actor.email, email_confirmed_at: now.toISOString() };
      if (id === other.id) return { id: other.id, email: other.email, email_confirmed_at: now.toISOString() };
      return {};
    }
    if (url.pathname === "/rest/v1/profiles" && method === "GET") {
      const selected = data.profiles.filter((row) => matches(row, url));
      if (stallArmed && seed.stallProfileReads && url.searchParams.get("select")?.includes("emails_sent_in_period")) {
        profileReads += 1;
        const snapshot = structuredClone(selected);
        if (profileReads >= seed.stallProfileReads) releaseProfiles();
        else await profileGate;
        return snapshot;
      }
      return selected;
    }
    if (url.pathname === "/rest/v1/profiles" && method === "PATCH") {
      const row = data.profiles.find((item) => matches(item, url));
      if (row && body) Object.assign(row, body);
      return prefer.includes("return=representation") && row ? [structuredClone(row)] : null;
    }
    if (url.pathname === "/rest/v1/profiles" && method === "POST") {
      const id = String(body?.id);
      const existing = data.profiles.find((row) => row.id === id);
      if (existing && body) Object.assign(existing, body);
      else if (body) data.profiles.push(body as unknown as ProfileRow);
      return null;
    }
    if (url.pathname === "/rest/v1/reminders" && method === "GET") {
      const rows = data.reminders.filter((row) => matches(row, url));
      const limit = Number(url.searchParams.get("limit") ?? "500");
      const activeCount = url.searchParams.get("select") === "id" && url.searchParams.get("status") === "eq.active";
      if (activeStall && activeCount) {
        activeReads += 1;
        const snapshot = structuredClone(rows);
        if (activeReads >= 2) releaseActive();
        else await activeGate;
        return snapshot.slice(0, limit);
      }
      return rows.slice(0, limit);
    }
    if (url.pathname === "/rest/v1/reminders" && method === "POST") {
      data.reminders.push(body ?? {});
      return [body];
    }
    if (url.pathname === "/rest/v1/reminders" && method === "PATCH") {
      const row = data.reminders.find((item) => matches(item, url));
      if (!row) return [];
      Object.assign(row, body);
      return [row];
    }
    if (url.pathname === "/rest/v1/reminders" && method === "DELETE") {
      const kept = data.reminders.filter((row) => !matches(row, url));
      data.reminders.splice(0, data.reminders.length, ...kept);
      return null;
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "GET") {
      const rows = data.deliveries.filter((row) => matches(row, url));
      const key = url.searchParams.get("dedupe_key");
      if (ticketBarrier && key?.startsWith("eq.claim:")) {
        let wait = ticketWaits.get(key);
        if (!wait) {
          let release = () => {};
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          wait = { reads: 0, release, gate };
          ticketWaits.set(key, wait);
        }
        wait.reads += 1;
        const snapshot = structuredClone(rows);
        if (wait.reads >= 2) wait.release();
        else await wait.gate;
        return snapshot;
      }
      if (prefer.includes("count=exact")) return rows.length;
      const limit = Number(url.searchParams.get("limit") ?? String(rows.length || 1000));
      return rows.slice(0, limit);
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "POST") {
      const key = String(body?.dedupe_key);
      if (data.deliveries.some((row) => row.dedupe_key === key)) throw new Error("duplicate key value violates unique constraint 23505");
      data.deliveries.push(body ?? {});
      return [body];
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "PATCH") {
      const row = data.deliveries.find((item) => matches(item, url));
      if (!row) return [];
      Object.assign(row, body);
      return [structuredClone(row)];
    }
    if (url.pathname === "/rest/v1/deliveries" && method === "DELETE") {
      const kept = data.deliveries.filter((row) => !matches(row, url));
      data.deliveries.splice(0, data.deliveries.length, ...kept);
      return null;
    }
    if (url.pathname === "/rest/v1/digest_settings" && method === "GET") return data.digests.filter((row) => matches(row, url));
    if (url.pathname === "/rest/v1/digest_settings" && method === "POST") {
      const owner = String(body?.owner_id);
      const existing = data.digests.find((row) => row.owner_id === owner);
      if (existing && body) Object.assign(existing, body);
      else if (body) data.digests.push(body);
      return null;
    }
    if (url.pathname === "/rest/v1/digest_settings" && method === "DELETE") {
      const kept = data.digests.filter((row) => !matches(row, url));
      data.digests.splice(0, data.digests.length, ...kept);
      return null;
    }
    if (url.pathname === "/rest/v1/fillip_runtime") return [{ provider_backoff_until: null }];
    return [];
  };
  const callable = Object.assign(db, {
    armStall: () => {
      stallArmed = true;
    },
    armActiveStall: () => {
      activeStall = true;
    },
    armTicketBarrier: () => {
      ticketBarrier = true;
    }
  });
  books.set(callable, data);
  return callable;
}

function matches(row: Record<string, unknown>, url: URL): boolean {
  for (const [key, raw] of url.searchParams) {
    if (key === "select" || key === "order" || key === "limit") continue;
    if (key === "or") {
      const parts = raw.replace(/^\(/, "").replace(/\)$/, "").split(",");
      if (!parts.some((part) => compare(row, part))) return false;
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

function httpGet(url: string, headers?: http.OutgoingHttpHeaders) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
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

function httpPost(url: string, body: unknown, headers?: http.OutgoingHttpHeaders) {
  const payload = JSON.stringify(body);
  const target = new URL(url);
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = http.request({
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "content-length": Buffer.byteLength(payload),
        ...headers
      }
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8")
      }));
    });
    request.on("error", reject);
    request.end(payload);
  });
}

describe("QA round 3 reservations, claims, and caps", () => {
  it("QA-FAIL: two hosted creates cannot pass the free open-reminder cap of 10", async () => {
    const db = hostedDb({ used: 0, plan: "free", status: "canceled" });
    const store = new SupabaseFillipStore(null, db, "service");
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    for (let i = 0; i < 9; i += 1) {
      await setReminder(store, actor, { what: `Open ${i}`, when: "tomorrow 9am", timezone: "UTC" }, createdAt, caps);
    }
    db.armActiveStall();
    const raced = await Promise.allSettled([
      setReminder(store, actor, { what: "Tenth", when: "tomorrow 9am", timezone: "UTC" }, createdAt, caps),
      setReminder(store, actor, { what: "Eleventh", when: "tomorrow 9am", timezone: "UTC" }, createdAt, caps)
    ]);
    const activeRows = books.get(db)?.reminders.filter((row) => row.status === "active") ?? [];
    const older = activeRows.filter((row) => String(row.what).startsWith("Open"));
    expect(older, "an older row is not deleted").toHaveLength(9);
    expect(activeRows.length, "each refusal deletes only the row that call inserted").toBeLessThanOrEqual(10);
    expect(activeRows.length).toBeGreaterThanOrEqual(9);
    const stored = new Set(activeRows.map((row) => row.id));
    const rejected = raced.filter((item) => item.status === "rejected");
    expect(rejected.length, "a cap refusal is a tool error").toBeGreaterThanOrEqual(1);
    for (const item of raced) {
      if (item.status === "fulfilled") expect(stored.has(item.value.id), "a saved view must still be stored").toBe(true);
      else expect(String(item.reason)).toMatch(/The free plan allows 10 open reminders/);
    }
  });

  it("QA-FAIL: two hosted workers that both send keep one counter increment per ping", async () => {
    const db = hostedDb({ used: 0, plan: "pro", status: "active", stallProfileReads: 2 });
    const first = new SupabaseFillipStore(null, db, "service");
    const second = new SupabaseFillipStore(null, db, "service");
    const createdAt = new Date("2026-10-11T12:00:00.000Z");
    await setReminder(first, actor, { what: "A", when: "in 1 hour", timezone: "UTC" }, createdAt, caps, true);
    await setReminder(first, actor, { what: "B", when: "in 1 hour", timezone: "UTC" }, createdAt, caps, true);
    db.armStall();
    const mail = new CountingSender();
    await Promise.all([job(first, mail, now), job(second, mail, now)]);
    const keys = new Set(mail.sent.map((message) => message.idempotencyKey));
    expect(keys.size, "each occurrence is submitted once").toBe(mail.sent.length);
    expect(mail.sent.length, "both reminders send").toBe(2);
    expect(books.get(db)?.profiles[0]?.emails_sent_in_period, "counter matches the two pings").toBe(2);
  });

  it("QA-PASS: one hosted ping left on both channels stays at the cap", async () => {
    const db = hostedDb({ used: 29, plan: "free", status: "canceled" });
    const store = new SupabaseFillipStore(null, db, "service");
    await setReminder(store, actor, {
      what: "Last slot",
      when: "in 1 hour",
      timezone: "UTC",
      channel: "both"
    }, new Date("2026-10-11T12:00:00.000Z"), caps, true);
    const mail = new CountingSender();
    const telegram = new KeyTelegram();
    await job(store, mail, now, { telegram: { sender: telegram } });
    expect(mail.sent.length + telegram.sent.length).toBeLessThanOrEqual(1);
    expect(books.get(db)?.profiles[0]?.emails_sent_in_period ?? 0).toBeLessThanOrEqual(30);
    const emailKey = mail.sent[0]?.idempotencyKey ?? "";
    const telegramKey = telegram.sent[0]?.key ?? "";
    if (emailKey && telegramKey) expect(emailKey).not.toBe(telegramKey);
  });

  it("QA-FAIL: two workers renewing one stale claim lease send that occurrence once", async () => {
    const db = hostedDb({ used: 0, plan: "pro", status: "active" });
    const started = new Date(now.getTime() - 5 * 60_000).toISOString();
    const dedupe = "reminder:r1:2026-10-11T15:00:00.000Z:email";
    const ticket = `claim:${dedupe}:${started}`;
    const data = books.get(db);
    data?.deliveries.push(
      {
        id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        owner_id: actor.id,
        reminder_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dedupe_key: dedupe,
        occurrence_at: "2026-10-11T15:00:00.000Z",
        status: "sending",
        idempotency_key: "fillip/r1/2026-10-11T15:00:00.000Z",
        channel: "email",
        provider_id: null,
        started_at: started,
        sent_at: null,
        error: null
      },
      {
        id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        owner_id: actor.id,
        reminder_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dedupe_key: ticket,
        occurrence_at: "2026-10-11T15:00:00.000Z",
        status: "sending",
        idempotency_key: `lock/${ticket}`,
        channel: "email",
        provider_id: null,
        started_at: started,
        sent_at: null,
        error: null
      }
    );
    db.armTicketBarrier();
    const input = {
      ownerId: actor.id,
      reminderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      dedupeKey: dedupe,
      occurrenceAt: "2026-10-11T15:00:00.000Z",
      idempotencyKey: "fillip/r1/2026-10-11T15:00:00.000Z",
      channel: "email" as const,
      nowIso: now.toISOString(),
      staleBeforeIso: new Date(now.getTime() - 2 * 60_000).toISOString()
    };
    const [left, right] = await Promise.all([
      new SupabaseFillipStore(null, db, "service").claimDelivery(input),
      new SupabaseFillipStore(null, db, "service").claimDelivery(input)
    ]);
    expect([left.outcome, right.outcome].filter((outcome) => outcome === "send")).toHaveLength(1);
  });

  it("QA-PASS: a fresh reclaim lease stays in progress, and a real provider id is not sent again", async () => {
    const db = hostedDb({ used: 0, plan: "pro", status: "active" });
    const recent = new Date(now.getTime() - 30_000).toISOString();
    const dedupe = "reminder:r2:2026-10-11T15:00:00.000Z:email";
    const ticket = `claim:${dedupe}:${new Date(now.getTime() - 5 * 60_000).toISOString()}`;
    books.get(db)?.deliveries.push(
      {
        id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        owner_id: actor.id,
        reminder_id: null,
        dedupe_key: dedupe,
        occurrence_at: "2026-10-11T15:00:00.000Z",
        status: "failed",
        idempotency_key: "fillip/r2/2026-10-11T15:00:00.000Z",
        channel: "email",
        provider_id: null,
        started_at: new Date(now.getTime() - 5 * 60_000).toISOString(),
        sent_at: null,
        error: "send failed"
      },
      {
        id: "99999999-9999-4999-8999-999999999999",
        owner_id: actor.id,
        reminder_id: null,
        dedupe_key: ticket,
        occurrence_at: "2026-10-11T15:00:00.000Z",
        status: "sending",
        idempotency_key: `lock/${ticket}`,
        channel: "email",
        provider_id: null,
        started_at: recent,
        sent_at: null,
        error: null
      }
    );
    const held = await new SupabaseFillipStore(null, db, "service").claimDelivery({
      ownerId: actor.id,
      reminderId: null,
      dedupeKey: dedupe,
      occurrenceAt: "2026-10-11T15:00:00.000Z",
      idempotencyKey: "fillip/r2/2026-10-11T15:00:00.000Z",
      channel: "email",
      nowIso: now.toISOString(),
      staleBeforeIso: new Date(now.getTime() - 2 * 60_000).toISOString()
    });
    expect(held.outcome).toBe("in-progress");

    const store = new MemoryFillipStore();
    const created = await due(store, "Accepted");
    const reminder = store.reminders.find((row) => row.id === created.id);
    if (!reminder) throw new Error("missing reminder");
    store.deliveries.push({
      id: "accepted",
      ownerId: actor.id,
      reminderId: reminder.id,
      dedupeKey: `reminder:${reminder.id}:${reminder.fireAt}:email`,
      occurrenceAt: reminder.fireAt,
      status: "sending",
      idempotencyKey: `fillip/${reminder.id}/${reminder.fireAt}`,
      channel: "email",
      providerId: "re_accepted",
      startedAt: now.toISOString(),
      sentAt: null,
      error: null
    });
    const sender = new CountingSender();
    await job(store, sender, now);
    expect(sender.sent).toHaveLength(0);
  });

  it("QA-FAIL: a crash after the attempt mark and before the provider accepts does not skip that ping", async () => {
    const store = new MemoryFillipStore();
    const created = await due(store, "Killed before accept");
    const reminder = store.reminders.find((row) => row.id === created.id);
    if (!reminder) throw new Error("missing reminder");
    const delivery: Delivery = {
      id: "attempt",
      ownerId: actor.id,
      reminderId: reminder.id,
      dedupeKey: `reminder:${reminder.id}:${reminder.fireAt}:email`,
      occurrenceAt: reminder.fireAt,
      status: "sending",
      idempotencyKey: `fillip/${reminder.id}/${reminder.fireAt}`,
      channel: "email",
      providerId: "attempt",
      startedAt: now.toISOString(),
      sentAt: null,
      error: null
    };
    store.deliveries.push(delivery);
    const sender = new CountingSender();
    await job(store, sender, now);
    const after = store.reminders.find((row) => row.id === reminder.id);
    expect(after?.status, "a ping the provider never accepted must stay due").toBe("active");
    expect(after?.fireAt).toBe(reminder.fireAt);
    expect(sender.sent, "the provider never accepted, so the ping is still owed").toHaveLength(1);
    expect(sender.sent[0]?.idempotencyKey).toBe(`fillip/${reminder.id}/${reminder.fireAt}`);
  });

  it("QA-PASS: email and telegram idempotency keys differ, and a retry reuses the email key", async () => {
    const store = new MemoryFillipStore();
    const created = await setReminder(store, actor, {
      what: "Both channels",
      when: "in 1 hour",
      timezone: "UTC",
      channel: "both"
    }, new Date("2026-10-11T12:00:00.000Z"), caps, true);
    usePlan(store, 0, "pro", "active");
    const mail = new CountingSender();
    const telegram = new KeyTelegram();
    await job(store, mail, now, { telegram: { sender: telegram } });
    const reminder = store.reminders.find((row) => row.id === created.id);
    expect(mail.sent).toHaveLength(1);
    expect(telegram.sent).toHaveLength(1);
    expect(mail.sent[0]?.idempotencyKey).toBe(`fillip/${created.id}/${created.fireAt}`);
    expect(telegram.sent[0]?.key).toBe(`fillip/${created.id}/${created.fireAt}/telegram`);
    expect(mail.sent[0]?.idempotencyKey).not.toBe(telegram.sent[0]?.key);
    if (reminder?.recurrence) {
      const nextAt = new Date(reminder.fireAt);
      const again = new CountingSender();
      await job(store, again, new Date(nextAt.getTime() + 60_000));
      expect(again.sent[0]?.idempotencyKey).toBe(`fillip/${created.id}/${reminder.fireAt}`);
    } else {
      const again = new CountingSender();
      await job(store, again, now);
      expect(again.sent).toHaveLength(0);
    }
  });
});

describe("QA round 3 series, holds, and pause", () => {
  it("QA-PASS: an every-2-days series far from its anchor still has a next fire, including the spring-forward gap", () => {
    const anchor = new Date("2024-01-01T09:00:00.000Z");
    const after = new Date("2026-10-11T16:00:00.000Z");
    const recurrence = {
      kind: "every_n_days" as const,
      interval: 2,
      hour: 9,
      minute: 0,
      anchor: anchor.toISOString()
    };
    let expected = anchor.getTime();
    while (expected <= after.getTime()) expected += 2 * 86_400_000;
    const next = nextFire(recurrence, "UTC", after);
    expect(next?.toISOString()).toBe(new Date(expected).toISOString());

    const gap = nextFire({
      kind: "every_n_days",
      interval: 2,
      hour: 2,
      minute: 30,
      anchor: "2027-03-12T07:30:00.000Z"
    }, ny, new Date("2027-03-13T12:00:00.000Z"));
    expect(gap?.toISOString(), "2:30am on the spring-forward morning moves to 3:30, not an hour early").toBe("2027-03-14T07:30:00.000Z");
  });

  it("QA-PASS: one reminder that cannot advance does not abort the rest of the sweep", async () => {
    const store = new MemoryFillipStore();
    await due(store, "boom", new Date("2026-10-11T11:00:00.000Z"));
    await due(store, "ok", new Date("2026-10-11T12:00:00.000Z"));
    const original = store.saveReminder.bind(store);
    store.saveReminder = async (reminder) => {
      if (reminder.what === "boom" && reminder.status === "fired") throw new Error("advance failed");
      return original(reminder);
    };
    const sender = new CountingSender();
    const report = await job(store, sender, now);
    expect(sender.sent.map((message) => message.subject)).toEqual(expect.arrayContaining([
      expect.stringContaining("boom"),
      expect.stringContaining("ok")
    ]));
    expect(report.failed).toBeGreaterThanOrEqual(1);
    expect(report.sent).toBe(2);
  });

  it("QA-PASS: upgrading releases a monthly allowance hold and leaves a daily hold and a short backoff", async () => {
    const monthly = new MemoryFillipStore();
    const created = await due(monthly, "Held by the free month");
    usePlan(monthly, 30, "free", "canceled");
    const row = monthly.reminders.find((item) => item.id === created.id);
    if (!row) throw new Error("missing reminder");
    row.holdUntil = "2026-11-01T00:00:00.000Z";
    usePlan(monthly, 0, "pro", "active");
    const sender = new CountingSender();
    expect((await job(monthly, sender, now)).sent).toBe(1);

    const daily = new MemoryFillipStore();
    const held = await due(daily, "Held until tomorrow");
    usePlan(daily, 0, "pro", "active");
    const tomorrow = daily.reminders.find((item) => item.id === held.id);
    if (!tomorrow) throw new Error("missing reminder");
    tomorrow.holdUntil = "2026-10-12T04:00:00.000Z";
    const dailySender = new CountingSender();
    expect((await job(daily, dailySender, now)).sent).toBe(0);
    expect(daily.reminders.find((item) => item.id === held.id)?.holdUntil).toBe("2026-10-12T04:00:00.000Z");

    const backoff = new MemoryFillipStore();
    const waiting = await due(backoff, "Provider hold");
    usePlan(backoff, 0, "pro", "active");
    const paused = backoff.reminders.find((item) => item.id === waiting.id);
    if (!paused) throw new Error("missing reminder");
    paused.holdUntil = new Date(now.getTime() + 15 * 60_000).toISOString();
    expect((await job(backoff, new CountingSender(), now)).sent).toBe(0);

    const closed = new MemoryFillipStore();
    const queued = await due(closed, "Global hold");
    usePlan(closed, 0, "pro", "active");
    const globalRow = closed.reminders.find((item) => item.id === queued.id);
    if (!globalRow) throw new Error("missing reminder");
    globalRow.holdUntil = "2026-11-01T00:00:00.000Z";
    const closedSender = new CountingSender();
    expect((await job(closed, closedSender, now, { global: { perDay: 0, perMonth: 0 } })).sent).toBe(0);
    expect(closed.reminders.find((item) => item.id === queued.id)?.status).toBe("active");
  });

  it("QA-PASS: pausing across a due time does not send, and resume keeps one future occurrence", async () => {
    const store = new MemoryFillipStore();
    const created = await setReminder(store, actor, {
      what: "Standup",
      when: "every day at 9am",
      timezone: ny
    }, new Date("2026-10-01T15:00:00.000Z"), caps);
    const row = store.reminders.find((item) => item.id === created.id);
    if (!row) throw new Error("missing reminder");
    row.fireAt = "2026-10-11T13:00:00.000Z";
    const paused = await snoozeOrReschedule(store, actor.id, created.id, undefined, ny, now, "pause");
    expect(paused.status).toBe("paused");
    expect(paused.fireAt).toBe("2026-10-11T13:00:00.000Z");
    const sender = new CountingSender();
    expect((await job(store, sender, now)).sent).toBe(0);
    expect((await job(store, sender, new Date(now.getTime() + 86_400_000))).sent).toBe(0);
    const resumed = await snoozeOrReschedule(store, actor.id, created.id, undefined, ny, now, "resume");
    const again = await snoozeOrReschedule(store, actor.id, created.id, undefined, ny, now, "resume");
    expect(again.fireAt).toBe(resumed.fireAt);
    expect(new Date(resumed.fireAt).getTime()).toBeGreaterThan(now.getTime());
    expect(zonedParts(new Date(resumed.fireAt), ny).hour).toBe(9);
    const before = new CountingSender();
    expect((await job(store, before, new Date(new Date(resumed.fireAt).getTime() - 60_000))).sent).toBe(0);
    const atFire = new CountingSender();
    expect((await job(store, atFire, new Date(new Date(resumed.fireAt).getTime() + 60_000))).sent).toBe(1);
    const saved = store.reminders.find((item) => item.id === created.id);
    const following = new CountingSender();
    expect((await job(store, following, new Date(new Date(saved?.fireAt ?? resumed.fireAt).getTime() - 60_000))).sent).toBe(0);
    expect(atFire.sent).toHaveLength(1);
  });
});

describe("QA round 3 product behavior", () => {
  it("QA-PASS: delete removes that reminder's deliveries and leaves the other user", async () => {
    const memory = new MemoryFillipStore();
    const mine = await due(memory, "Mine");
    const theirs = await setReminder(memory, other, { what: "Theirs", when: "tomorrow 9am", timezone: "UTC" }, now, caps);
    memory.deliveries.push(
      {
        id: "mine-delivery",
        ownerId: actor.id,
        reminderId: mine.id,
        dedupeKey: "mine",
        occurrenceAt: mine.fireAt,
        status: "sent",
        idempotencyKey: "mine-key",
        channel: "email",
        providerId: "re_mine",
        startedAt: now.toISOString(),
        sentAt: now.toISOString(),
        error: null
      },
      {
        id: "digest",
        ownerId: actor.id,
        reminderId: null,
        dedupeKey: "digest:a",
        occurrenceAt: now.toISOString(),
        status: "sent",
        idempotencyKey: "digest-key",
        channel: "email",
        providerId: "re_digest",
        startedAt: now.toISOString(),
        sentAt: now.toISOString(),
        error: null
      },
      {
        id: "theirs-delivery",
        ownerId: other.id,
        reminderId: theirs.id,
        dedupeKey: "theirs",
        occurrenceAt: theirs.fireAt,
        status: "sent",
        idempotencyKey: "theirs-key",
        channel: "email",
        providerId: "re_theirs",
        startedAt: now.toISOString(),
        sentAt: now.toISOString(),
        error: null
      }
    );
    await completeOrCancel(memory, actor.id, mine.id, "delete", now);
    expect(memory.reminders.some((row) => row.id === mine.id)).toBe(false);
    expect(memory.deliveries.some((row) => row.reminderId === mine.id)).toBe(false);
    expect(memory.deliveries.some((row) => row.dedupeKey === "digest:a")).toBe(true);
    expect(memory.reminders.some((row) => row.id === theirs.id)).toBe(true);
    expect(memory.deliveries.some((row) => row.ownerId === other.id)).toBe(true);
    await memory.deleteOwnerData(actor.id);
    expect(memory.deliveries.some((row) => row.ownerId === actor.id)).toBe(false);
    expect(memory.deliveries.some((row) => row.ownerId === other.id)).toBe(true);

    const db = hostedDb({ used: 0, plan: "free", status: "canceled" });
    const hosted = new SupabaseFillipStore(null, db, "service");
    const hostedMine = await setReminder(hosted, actor, { what: "Mine", when: "tomorrow 9am", timezone: "UTC" }, now, caps);
    const data = books.get(db);
    data?.reminders.push({
      id: theirs.id,
      owner_id: other.id,
      kind: "reminder",
      what: "Theirs",
      context: null,
      timezone: "UTC",
      fire_at: theirs.fireAt,
      recurrence: null,
      channel: "email",
      status: "active",
      hold_until: null,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      completed_at: null
    });
    data?.deliveries.push(
      {
        id: "h1",
        owner_id: actor.id,
        reminder_id: hostedMine.id,
        dedupe_key: "hosted-mine",
        occurrence_at: hostedMine.fireAt,
        status: "sent",
        idempotency_key: "hosted-mine"
      },
      {
        id: "h2",
        owner_id: actor.id,
        reminder_id: null,
        dedupe_key: "hosted-digest",
        occurrence_at: now.toISOString(),
        status: "sent",
        idempotency_key: "hosted-digest"
      },
      {
        id: "h3",
        owner_id: other.id,
        reminder_id: theirs.id,
        dedupe_key: "hosted-theirs",
        occurrence_at: theirs.fireAt,
        status: "sent",
        idempotency_key: "hosted-theirs"
      }
    );
    data?.digests.push({ owner_id: actor.id, enabled: true, hour: 8, minute: 0, timezone: "UTC" });
    await completeOrCancel(hosted, actor.id, hostedMine.id, "delete", now);
    expect(data?.reminders.some((row) => row.id === hostedMine.id)).toBe(false);
    expect(data?.deliveries.some((row) => row.dedupe_key === "hosted-mine")).toBe(false);
    expect(data?.deliveries.some((row) => row.dedupe_key === "hosted-digest")).toBe(true);
    expect(data?.deliveries.some((row) => row.dedupe_key === "hosted-theirs")).toBe(true);
    expect(data?.reminders.some((row) => row.owner_id === other.id)).toBe(true);
    await hosted.deleteOwnerData(actor.id);
    expect(data?.deliveries.some((row) => row.owner_id === actor.id)).toBe(false);
    expect(data?.deliveries.some((row) => row.dedupe_key === "hosted-theirs")).toBe(true);
    expect(data?.digests.some((row) => row.owner_id === actor.id)).toBe(false);
    expect(data?.reminders.some((row) => row.owner_id === other.id)).toBe(true);
  });

  it("QA-PASS: done reminders are hidden until include_done, and a keyword repeat edit keeps the end", async () => {
    const store = new MemoryFillipStore();
    const open = await setReminder(store, actor, {
      what: "Standup",
      when: "every weekday at 9am until March 31, 2027",
      timezone: ny
    }, new Date("2026-10-01T15:00:00.000Z"), caps);
    const finished = await due(store, "Finished");
    await completeOrCancel(store, actor.id, finished.id, "complete", now);
    const cancelled = await due(store, "Cancelled", new Date("2026-10-11T13:00:00.000Z"));
    await completeOrCancel(store, actor.id, cancelled.id, "cancel", now);
    await snoozeOrReschedule(store, actor.id, open.id, undefined, ny, now, "pause");
    const hidden = await listReminders(store, actor.id, {}, now, caps);
    expect(hidden.map((row) => row.what)).toEqual(["Standup"]);
    expect(hidden.every((row) => row.status !== "completed" && row.status !== "cancelled")).toBe(true);
    const shown = await listReminders(store, actor.id, { includeDone: true }, now, caps);
    expect(shown.map((row) => row.what).sort()).toEqual(["Cancelled", "Finished", "Standup"]);
    const weekly = await snoozeOrReschedule(store, actor.id, open.id, undefined, ny, now, "reschedule", { repeat: "weekly" });
    expect(weekly.id).toBe(open.id);
    expect(weekly.repeats).toMatch(/March 31, 2027/);
  });

  it("QA-FAIL: editing a repeat phrase keeps the end date already on that reminder", async () => {
    const store = new MemoryFillipStore();
    const open = await setReminder(store, actor, {
      what: "Standup",
      when: "every weekday at 9am until March 31, 2027",
      timezone: ny
    }, new Date("2026-10-01T15:00:00.000Z"), caps);
    const edited = await snoozeOrReschedule(store, actor.id, open.id, undefined, ny, now, "reschedule", { repeat: "every Monday 9am" });
    expect(edited.id).toBe(open.id);
    expect(edited.repeats).toMatch(/Monday/);
    expect(edited.repeats, "the March 31 end was not removed").toMatch(/March 31, 2027/);
  });

  it("QA-FAIL: editing the repeat of a paused reminder does not resume it quietly", async () => {
    const store = new MemoryFillipStore();
    const open = await setReminder(store, actor, {
      what: "Standup",
      when: "every weekday at 9am",
      timezone: ny
    }, new Date("2026-10-01T15:00:00.000Z"), caps);
    await snoozeOrReschedule(store, actor.id, open.id, undefined, ny, now, "pause");
    const changed = await snoozeOrReschedule(store, actor.id, open.id, undefined, ny, now, "reschedule", { repeat: "daily" });
    expect(changed.status === "paused" || /resum/i.test(changed.note ?? ""), changed.note ?? changed.status).toBe(true);
  });

  it("QA-PASS: named end dates include that local day across a year boundary and a daylight-saving change", () => {
    const year = resolveWhen("every day at 9am until January 1, 2027", ny, new Date("2026-11-15T15:00:00.000Z"));
    const lastYear = nextFire(year.recurrence!, ny, new Date("2026-12-31T15:00:00.000Z"));
    expect(zonedParts(lastYear!, ny)).toMatchObject({ year: 2027, month: 1, day: 1, hour: 9 });
    expect(nextFire(year.recurrence!, ny, lastYear!)).toBeNull();

    const december = resolveWhen("every day at 9am until Dec 31, 2026", ny, new Date("2026-11-15T15:00:00.000Z"));
    const nye = nextFire(december.recurrence!, ny, new Date("2026-12-30T15:00:00.000Z"));
    expect(zonedParts(nye!, ny)).toMatchObject({ year: 2026, month: 12, day: 31, hour: 9 });
    expect(nextFire(december.recurrence!, ny, nye!)).toBeNull();

    const spring = resolveWhen("every day at 9am until March 14, 2027", ny, new Date("2027-03-01T15:00:00.000Z"));
    const march14 = nextFire(spring.recurrence!, ny, new Date("2027-03-13T16:00:00.000Z"));
    expect(zonedParts(march14!, ny)).toMatchObject({ year: 2027, month: 3, day: 14, hour: 9 });
    expect(nextFire(spring.recurrence!, ny, march14!)).toBeNull();

    const gapEnd = resolveWhen("every day at 2:30am until March 14, 2027", ny, new Date("2027-03-01T15:00:00.000Z"));
    const gapDay = nextFire(gapEnd.recurrence!, ny, new Date("2027-03-13T12:00:00.000Z"));
    expect(gapDay?.toISOString()).toBe("2027-03-14T07:30:00.000Z");
    expect(nextFire(gapEnd.recurrence!, ny, gapDay!)).toBeNull();
  });

  it("QA-PASS: a missing spring-forward hour and an ambiguous fall-back hour are both named", () => {
    const gap = resolveWhen("March 14, 2027 at 2:30am", ny, new Date("2027-03-01T15:00:00.000Z"));
    expect(gap.corrected).toBe(true);
    expect(gap.note).toMatch(/does not exist/i);
    expect(gap.note).toMatch(/3:30/);
    expect(gap.fireAt.toISOString()).toBe("2027-03-14T07:30:00.000Z");
    expect(zonedParts(gap.fireAt, ny).hour).not.toBe(1);

    const overlap = resolveWhen("November 1, 2026 at 1:30am", ny, new Date("2026-10-15T15:00:00.000Z"));
    expect(overlap.note).toMatch(/ambiguous/i);
    expect(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]).toContain(overlap.fireAt.toISOString());
    expect(overlap.corrected).toBe(true);
  });

  it("QA-PASS: rotating the calendar feed kills the previous URL", async () => {
    const store = new MemoryFillipStore();
    await setReminder(store, actor, { what: "Dentist", when: "tomorrow 9am", timezone: "UTC" }, now, caps);
    const link = await calendarLink(store, actor, "get", "https://fillip.example");
    const oldToken = link.url.split("/calendar/")[1]?.replace(/\.ics$/, "") ?? "";
    const rotated = await calendarLink(store, actor, "rotate", "https://fillip.example");
    const newToken = rotated.url.split("/calendar/")[1]?.replace(/\.ics$/, "") ?? "";
    expect(oldToken).not.toBe(newToken);
    expect(await renderCalendarFeed(store, oldToken, now)).toBeNull();
    expect(await renderCalendarFeed(store, newToken, now)).toContain("Dentist");

    const previousFetch = global.fetch;
    const previousUrl = process.env.SUPABASE_URL;
    const previousKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_URL = "https://qa.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    global.fetch = async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("calendar_token") && url.includes(newToken)) return Response.json([{ id: actor.id }]);
      if (url.includes("/rest/v1/reminders") && url.includes(actor.id)) {
        return Response.json([{
          id: "44444444-4444-4444-8444-444444444444",
          owner_id: actor.id,
          kind: "reminder",
          what: "Dentist",
          context: null,
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
      const oldUrl = await httpGet(`http://127.0.0.1:${address.port}/calendar/${oldToken}.ics`);
      const fresh = await httpGet(`http://127.0.0.1:${address.port}/calendar/${newToken}.ics`);
      expect(oldUrl.status).toBe(404);
      expect(fresh.status).toBe(200);
      expect(fresh.headers["cache-control"]).toBe("private, no-store");
      expect(fresh.body).toContain("Dentist");
    } finally {
      global.fetch = previousFetch;
      if (previousUrl === undefined) delete process.env.SUPABASE_URL;
      else process.env.SUPABASE_URL = previousUrl;
      if (previousKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = previousKey;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("QA round 3 auth, health, and copy", () => {
  it("QA-PASS: emailed-code errors do not reveal whether an account exists", () => {
    expect(otpFailure("Token has expired or is invalid")).toMatch(/expired/i);
    expect(otpFailure("Invalid otp")).toMatch(/not right/i);
    expect(otpFailure("For security purposes, you can only request this after 60 seconds")).toMatch(/Wait a minute/i);
    const hidden = [
      "User not found",
      "Email not found",
      "User already registered",
      "Signups not allowed for otp",
      "No user found with this email"
    ].map((message) => otpFailure(message));
    for (const text of hidden) {
      expect(text).not.toMatch(/not found|already registered|signups not allowed|no user|does not exist|no account/i);
    }
    const page = readFileSync("src/plugin-auth.ts", "utf8");
    expect(page).toMatch(/shouldCreateUser:\s*true/);
    expect(page).toMatch(/verifyOtp/);
    expect(page).not.toMatch(/attempts|lockout|usedCodes/i);
  });

  it("QA-PASS: Google is hidden unless the flag is exactly true, initialize is 401, and health is locked", async () => {
    const server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    const base = `http://127.0.0.1:${address.port}`;
    const previousGoogle = process.env.FILLIP_AUTH_GOOGLE_ENABLED;
    const previousCron = process.env.CRON_SECRET;
    try {
      delete process.env.FILLIP_AUTH_GOOGLE_ENABLED;
      expect((await httpGet(`${base}/oauth/consent`)).body).not.toContain("Continue with Google");
      process.env.FILLIP_AUTH_GOOGLE_ENABLED = "TRUE";
      expect((await httpGet(`${base}/oauth/consent`)).body).not.toContain("Continue with Google");
      process.env.FILLIP_AUTH_GOOGLE_ENABLED = "1";
      expect((await httpGet(`${base}/oauth/consent`)).body).not.toContain("Continue with Google");
      process.env.FILLIP_AUTH_GOOGLE_ENABLED = "true";
      expect((await httpGet(`${base}/oauth/consent`)).body).toContain("Continue with Google");

      const initialize = await httpPost(`${base}/mcp`, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "qa", version: "0" } }
      });
      expect(initialize.status).toBe(401);
      expect(initialize.headers["www-authenticate"]).toMatch(/resource_metadata=.*oauth-protected-resource\/mcp/);
      const listed = await httpPost(`${base}/mcp`, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      expect(listed.status).toBe(200);
      expect(listed.body).toMatch(/securitySchemes/);
      expect(listed.body).not.toMatch(/owner@example.com/);

      const metadata = await httpGet(`${base}/.well-known/oauth-protected-resource/mcp`);
      const resource = JSON.parse(metadata.body) as Record<string, unknown>;
      expect(resource.code_challenge_methods_supported).toBeUndefined();
      expect(resource.authorization_response_iss_parameter_supported).toBeUndefined();
      expect(protectedResourceMetadata("https://fillip.example", "https://qa.supabase.co").authorization_servers).toEqual(["https://qa.supabase.co/auth/v1"]);
      const oauthReadme = readFileSync("supabase/README-oauth.md", "utf8");
      expect(oauthReadme).toMatch(/S256/);
      expect(oauthReadme).toMatch(/plain/);
      expect(oauthReadme).toMatch(/authorization_response_iss_parameter_supported/);
      expect(oauthReadme).toMatch(/cannot remove `plain`/);

      delete process.env.CRON_SECRET;
      const health = await httpGet(`${base}/health`);
      expect(JSON.parse(health.body)).toEqual({ ok: true, service: "fillip", version: expect.any(String) });
      expect(health.body).not.toMatch(/globalEmails|service_role|RESEND|sk_live|email/i);
      expect((await httpGet(`${base}/internal/status`)).status).toBe(503);
      expect((await httpGet(`${base}/internal/deliver`)).status).toBe(503);
      process.env.CRON_SECRET = "cron-secret-round3";
      expect((await httpGet(`${base}/internal/status`, { authorization: "Bearer wrong-secret" })).status).toBe(401);
      expect((await httpGet(`${base}/internal/deliver`, { authorization: "Bearer nope" })).status).toBe(401);
      const status = await httpGet(`${base}/internal/status`, { authorization: "Bearer cron-secret-round3" });
      expect(status.status).toBe(200);
      expect(status.body).not.toContain("cron-secret-round3");
      expect(status.body).toMatch(/globalEmails/);
      expect(status.body).not.toMatch(/owner@example.com|service-role-test|re_[A-Za-z0-9]/);
    } finally {
      if (previousGoogle === undefined) delete process.env.FILLIP_AUTH_GOOGLE_ENABLED;
      else process.env.FILLIP_AUTH_GOOGLE_ENABLED = previousGoogle;
      if (previousCron === undefined) delete process.env.CRON_SECRET;
      else process.env.CRON_SECRET = previousCron;
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("QA-PASS: user-facing copy has no dollar prices", () => {
    const files = [
      "README.md",
      "src/public-pages.ts",
      "src/fillip-tools.ts",
      "src/landing-page.ts",
      "src/plugin-auth.ts",
      "src/connect-page.ts",
      "glama.json",
      "server.json"
    ];
    const text = files.map((file) => readFileSync(file, "utf8")).join("\n");
    expect(text).not.toMatch(/\$\d/);
    expect(text).not.toMatch(/\bUSD\b|\bdollars\b/i);
    expect(text).toMatch(/Fillip by Ouroboros/);
  });
});
