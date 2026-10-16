/**
 * QA round 6 against 09f5abd.
 * Cap, daily, and notice-claim races use Postgres 16 loaded with supabase/schema.sql.
 * QA-FAIL tests assert the behavior a user was promised and fail on this build.
 * QA-PASS tests are observed successes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFillipServer } from "../../src/fillip-tools.js";
import { runDueJob } from "../../src/lib/deliver.js";
import { createResendSender, type MailSender, type OutboundEmail } from "../../src/lib/email.js";
import { NOT_DELIVERED_NOTE, listReminders, setReminder, snoozeOrReschedule } from "../../src/lib/reminders.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import { pkceRejection } from "../../src/plugin-auth.js";
import type { Actor, Delivery, Reminder } from "../../src/lib/types.js";
import { blankContact, STAND_IN_CAPS } from "../../src/lib/usage.js";
import { formatClock, zonedParts } from "../../src/lib/zone.js";

const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const caps = STAND_IN_CAPS;
const now = new Date("2026-10-11T16:00:00.000Z");
const database = "fillip_round6";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const ny = "America/New_York";

class CountingSender implements MailSender {
  sent: OutboundEmail[] = [];
  async send(message: OutboundEmail) {
    this.sent.push(structuredClone(message));
    return { id: `email_${this.sent.length}` };
  }
}

class CountingTelegram {
  sent: Array<{ chatId: string; text: string; key?: string }> = [];
  async send(chatId: string, text: string, key?: string) {
    this.sent.push({ chatId, text, key });
    return { id: `tg_${this.sent.length}` };
  }
}

function pgClient(db = database) {
  return new pg.Client({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database: db });
}

const bootstrap = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

function reminder(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: randomUUID(),
    ownerId: actor.id,
    kind: "reminder",
    what: "pay the invoice",
    context: null,
    timezone: "UTC",
    fireAt: "2026-10-11T15:30:00.000Z",
    recurrence: null,
    channel: "email",
    status: "active",
    holdUntil: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    completedAt: null,
    ...patch
  };
}

function freeUser(store: MemoryFillipStore) {
  store.contacts.set(actor.id, blankContact(actor.id, {
    email: actor.email,
    emailVerified: true,
    plan: "free",
    subscriptionStatus: "none",
    unsubscribed: false
  }));
}

function job(store: MemoryFillipStore, sender: MailSender, at: Date, telegram?: CountingTelegram) {
  return runDueJob({
    store,
    sender,
    now: at,
    from: "Fillip <reminders@example.com>",
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: "unsubscribe-secret",
    maxEmailsPerUserPerDay: 100,
    maxSends: 20,
    minIntervalMs: 0,
    caps,
    global: { perDay: 1_000_000, perMonth: 1_000_000 },
    sleep: async () => {},
    telegram: telegram ? { sender: telegram } : null
  });
}

class WorkerStore extends MemoryFillipStore {
  constructor(shared: MemoryFillipStore) {
    super();
    this.reminders = shared.reminders;
    this.deliveries = shared.deliveries;
    this.contacts = shared.contacts;
  }
}

async function callTool(store: MemoryFillipStore | SupabaseFillipStore, name: string, args: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "qa-round6", version: "0.0.0" });
  const server = createFillipServer(store, actor, () => now, caps);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

function hostedList(ownerId: string, olderId: string, mode: "over" | "under" | "keep") {
  const stored = new Map<string, Record<string, unknown>>();
  stored.set(olderId, {
    id: olderId,
    owner_id: ownerId,
    kind: "reminder",
    what: "older",
    context: null,
    timezone: "UTC",
    fire_at: "2026-10-12T15:00:00.000Z",
    recurrence: null,
    channel: "email",
    status: "active",
    hold_until: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    completed_at: null
  });
  const deleted: string[] = [];
  const db: Db = async (pathname, options) => {
    const method = options?.method ?? "GET";
    const params = new URLSearchParams(pathname.split("?")[1] ?? "");
    if (pathname.includes("/rest/v1/profiles") && method === "GET") {
      return [{ plan: "free", subscription_status: "none", unsubscribed: false, emails_sent_in_period: 0, default_channel: "email" }];
    }
    if (pathname.includes("/rest/v1/profiles")) return [];
    if (pathname.includes("created_at=gte")) return [];
    if (pathname.includes("/rest/v1/reminders") && method === "POST") {
      const body = JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>;
      stored.set(String(body.id), body);
      return [body];
    }
    if (pathname.includes("/rest/v1/reminders") && method === "DELETE") {
      const id = (params.get("id") ?? "").replace(/^eq\./, "");
      deleted.push(id);
      if (mode !== "keep") stored.delete(id);
      return [];
    }
    if (pathname.includes("status=eq.active") && pathname.includes("limit=200")) {
      return [...stored.values()].slice(0, 9).map((row) => ({ id: row.id }));
    }
    if (pathname.includes("status=eq.active")) {
      const ids = [...stored.keys()];
      if (mode !== "under") {
        while (ids.length <= 10) ids.push(`11111111-1111-4111-8111-${String(ids.length).padStart(12, "0")}`);
      }
      return ids.map((id) => ({ id }));
    }
    if (pathname.includes("/rest/v1/reminders") && method === "GET") {
      const id = (params.get("id") ?? "").replace(/^eq\./, "");
      const row = stored.get(id);
      return row ? [row] : [];
    }
    return [];
  };
  return { db, deleted, stored };
}

describe("QA round 6 real Postgres", () => {
  beforeAll(async () => {
    const admin = pgClient("postgres");
    await admin.connect();
    try {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
      await admin.query(`drop database if exists ${database}`);
      await admin.query(`create database ${database}`);
    } finally {
      await admin.end();
    }
    const db = pgClient();
    await db.connect();
    try {
      await db.query(bootstrap);
      await db.query(schema);
    } finally {
      await db.end();
    }
  }, 60_000);

  afterAll(async () => {
    const admin = pgClient("postgres");
    await admin.connect();
    try {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
      await admin.query(`drop database if exists ${database}`);
    } finally {
      await admin.end();
    }
  });

  async function seedOwner(id: string) {
    const db = pgClient();
    await db.connect();
    try {
      await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
      await db.query("insert into public.profiles (id, plan, subscription_status) values ($1, 'free', 'none') on conflict do nothing", [id]);
    } finally {
      await db.end();
    }
  }

  it("QA-PASS: twelve real inserts at nine open leave exactly ten, not nine or eleven", async () => {
    const owner = randomUUID();
    await seedOwner(owner);
    const setup = pgClient();
    await setup.connect();
    const older: string[] = [];
    try {
      for (let index = 0; index < 9; index += 1) {
        const id = randomUUID();
        older.push(id);
        await setup.query(
          `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
           values ($1, $2, 'reminder', $3, 'UTC', now() + interval '2 days', 'active')`,
          [id, owner, `older-${index}`]
        );
      }
    } finally {
      await setup.end();
    }
    const clients = await Promise.all(Array.from({ length: 12 }, async () => {
      const client = pgClient();
      await client.connect();
      return client;
    }));
    try {
      const results = await Promise.all(clients.map(async (client, index) => {
        try {
          const id = randomUUID();
          await client.query(
            `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
             values ($1, $2, 'reminder', $3, 'UTC', now() + interval '3 days', 'active')`,
            [id, owner, `new-${index}`]
          );
          return { ok: true as const, id };
        } catch (error) {
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
        }
      }));
      expect(results.filter((row) => row.ok)).toHaveLength(1);
      expect(results.filter((row) => !row.ok).every((row) => /The free plan allows 10 open reminders/.test(row.message))).toBe(true);
      const active = await clients[0].query("select id from public.reminders where owner_id = $1 and status = 'active'", [owner]);
      expect(active.rows).toHaveLength(10);
      expect(older.every((id) => active.rows.some((row) => row.id === id))).toBe(true);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it("QA-PASS: the old 3-argument reserve cannot skip the daily cap, and a new day starts at one", async () => {
    const owner = randomUUID();
    await seedOwner(owner);
    const db = pgClient();
    await db.connect();
    try {
      await expect(db.query("select public.fillip_reserve_ping($1::uuid, 30, $2::timestamptz)", [owner, "2026-10-01T00:00:00.000Z"])).rejects.toThrow();
      await db.query(
        "update public.profiles set emails_sent_today = 100, email_day_start = $2, emails_sent_in_period = 10, email_period_start = $3 where id = $1",
        [owner, "2026-10-10T04:00:00.000Z", "2026-10-01T00:00:00.000Z"]
      );
      const reset = await db.query(
        "select public.fillip_reserve_ping($1::uuid, 1000, $2::timestamptz, 100, $3::timestamptz) as n",
        [owner, "2026-10-01T00:00:00.000Z", "2026-10-11T04:00:00.000Z"]
      );
      expect(Number(reset.rows[0]?.n)).toBeGreaterThan(0);
      const row = await db.query("select emails_sent_today from public.profiles where id = $1", [owner]);
      expect(Number(row.rows[0]?.emails_sent_today)).toBe(1);
    } finally {
      await db.end();
    }
  });

  it("QA-PASS: one not-delivered claim wins under 14 workers, a retry loses, and ping rows for both channels still insert", async () => {
    const owner = randomUUID();
    await seedOwner(owner);
    const reminderId = randomUUID();
    const fireAt = "2026-10-11T15:30:00.000Z";
    const setup = pgClient();
    await setup.connect();
    try {
      await setup.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
         values ($1, $2, 'reminder', 'telegram miss', 'UTC', $3, 'active')`,
        [reminderId, owner, fireAt]
      );
      await setup.query(
        `insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key, channel, kind)
         values ($1, $2, $3, $4, $5, 'sent', $6, 'email', 'ping'), ($7, $2, $3, $8, $5, 'sent', $9, 'telegram', 'ping')`,
        [
          randomUUID(), owner, reminderId, `reminder:${reminderId}:${fireAt}:email`, fireAt, `fillip/${reminderId}/${fireAt}`,
          randomUUID(), `reminder:${reminderId}:${fireAt}:telegram`, `fillip/${reminderId}/${fireAt}/telegram`
        ]
      );
    } finally {
      await setup.end();
    }
    const pool = new pg.Pool({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database, max: 16 });
    const db: Db = async (pathname, options) => {
      if ((options?.method ?? "GET") !== "POST" || pathname !== "/rest/v1/deliveries") throw new Error(`unexpected ${pathname}`);
      const body = JSON.parse(String(options?.body ?? "{}")) as Record<string, string | null>;
      const client = await pool.connect();
      try {
        await client.query(
          `insert into public.deliveries
             (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key, channel, kind, provider_id, started_at, sent_at, error)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            body.id, body.owner_id, body.reminder_id, body.dedupe_key, body.occurrence_at, body.status,
            body.idempotency_key, body.channel ?? "email", body.kind ?? "ping", body.provider_id,
            body.started_at, body.sent_at, body.error
          ]
        );
        return [];
      } catch (error) {
        const code = typeof error === "object" && error && "code" in error ? String((error as { code: string }).code) : "";
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${code} ${message}`);
      } finally {
        client.release();
      }
    };
    try {
      const stores = Array.from({ length: 14 }, () => new SupabaseFillipStore(null, db, "service"));
      const claimed = await Promise.all(stores.map((store) => store.claimNotice({
        ownerId: owner,
        reminderId,
        fireAt,
        nowIso: now.toISOString()
      })));
      expect(claimed.filter(Boolean)).toHaveLength(1);
      const retry = await new SupabaseFillipStore(null, db, "service").claimNotice({
        ownerId: owner,
        reminderId,
        fireAt,
        nowIso: new Date(now.getTime() + 60_000).toISOString()
      });
      expect(retry).toBe(false);
      const rows = await pool.query(
        "select kind, channel from public.deliveries where reminder_id = $1 and occurrence_at = $2 order by kind, channel",
        [reminderId, fireAt]
      );
      expect(rows.rows).toEqual([
        { kind: "not-delivered", channel: "email" },
        { kind: "ping", channel: "email" },
        { kind: "ping", channel: "telegram" }
      ]);
    } finally {
      await pool.end();
    }
  });
});

describe("QA round 6 cap pass and the missed ping", () => {
  it("QA-PASS: an over-cap read throws, deletes only the inserted id, and does not return a success view", async () => {
    const olderId = randomUUID();
    const hosted = hostedList(actor.id, olderId, "over");
    const store = new SupabaseFillipStore(null, hosted.db, "service");
    const result = await callTool(store, "set_reminder", { what: "should not stick", when: "tomorrow at 9am", timezone: "UTC" });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toMatch(/The free plan allows 10 open reminders/);
    expect(text).not.toMatch(/"status":"active"/);
    expect(hosted.deleted).toHaveLength(1);
    const ownId = hosted.deleted[0] ?? "";
    expect(hosted.deleted).toEqual([ownId]);
    expect(hosted.deleted).not.toContain(olderId);
    expect(hosted.stored.has(olderId)).toBe(true);
    expect(hosted.stored.has(ownId)).toBe(false);
    expect(await store.getReminder(actor.id, ownId)).toBeNull();
    expect((await store.getReminder(actor.id, olderId))?.status).toBe("active");
  });

  it("QA-PASS: a read inside the cap keeps the new row and does not throw", async () => {
    const olderId = randomUUID();
    const hosted = hostedList(actor.id, olderId, "under");
    const store = new SupabaseFillipStore(null, hosted.db, "service");
    const view = await setReminder(store, actor, { what: "kept", when: "tomorrow at 9am", timezone: "UTC" }, now, caps);
    expect(view.status).toBe("active");
    expect(hosted.deleted).toEqual([]);
    expect(hosted.stored.has(view.id)).toBe(true);
    expect(hosted.stored.has(olderId)).toBe(true);
    expect((await store.getReminder(actor.id, view.id))?.id).toBe(view.id);
  });

  it("QA-FAIL: a cap error is not returned when the delete leaves that row in place", async () => {
    const olderId = randomUUID();
    const hosted = hostedList(actor.id, olderId, "keep");
    const store = new SupabaseFillipStore(null, hosted.db, "service");
    let thrown = false;
    try {
      await setReminder(store, actor, { what: "still due", when: "tomorrow at 9am", timezone: "UTC" }, now, caps);
    } catch (error) {
      thrown = true;
      expect(String(error)).toMatch(/The free plan allows 10 open reminders/);
    }
    expect(hosted.deleted).toHaveLength(1);
    const ownId = hosted.deleted[0] ?? "";
    const kept = await store.getReminder(actor.id, ownId);
    if (thrown) expect(kept, "the error says this reminder was not saved").toBeNull();
    else expect(kept?.status).toBe("active");
  });

  it("QA-PASS: twelve workers and a retry send one Telegram miss notice, and Resend gets Idempotency-Key", async () => {
    const shared = new MemoryFillipStore();
    freeUser(shared);
    const contact = shared.contacts.get(actor.id)!;
    shared.contacts.set(actor.id, { ...contact, telegramChatId: "chat-1", defaultChannel: "telegram" });
    const row = reminder({ channel: "telegram" });
    shared.reminders.push(row);
    shared.deliveries.push({
      id: randomUUID(),
      ownerId: actor.id,
      reminderId: row.id,
      dedupeKey: `reminder:${row.id}:${row.fireAt}:telegram`,
      occurrenceAt: row.fireAt,
      status: "sending",
      idempotencyKey: "stale",
      channel: "telegram",
      providerId: "attempt",
      startedAt: "2026-10-11T15:57:00.000Z",
      sentAt: null,
      error: null
    });
    const sender = new CountingSender();
    const telegram = new CountingTelegram();
    const stores = Array.from({ length: 14 }, () => new WorkerStore(shared));
    await Promise.all(stores.map((store) => job(store, sender, now, telegram)));
    const again = new CountingSender();
    await job(shared, again, new Date(now.getTime() + 60_000), telegram);
    const key = `fillip/${row.id}/${row.fireAt}/not-delivered`;
    const notices = sender.sent.filter((message) => message.idempotencyKey === key);
    expect(notices).toHaveLength(1);
    expect(again.sent).toHaveLength(0);
    expect(telegram.sent).toHaveLength(0);
    expect(shared.deliveries.filter((item) => item.dedupeKey.endsWith(":not-delivered"))).toHaveLength(1);
    const seen = new Headers();
    const resend = createResendSender("re_test", async (_url, init) => {
      new Headers(init?.headers).forEach((value, name) => seen.set(name, value));
      return new Response(JSON.stringify({ id: "re_notice" }), { status: 200 });
    });
    await resend.send(notices[0]!);
    expect(seen.get("Idempotency-Key")).toBe(key);
  });

  it("QA-PASS: a missed repeating email lists the local couldn't-be-sent time", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    const fireAt = "2026-10-11T15:30:00.000Z";
    const row = reminder({
      timezone: ny,
      fireAt,
      recurrence: { kind: "daily", hour: 11, minute: 30 },
      channel: "email"
    });
    store.reminders.push(row);
    store.deliveries.push({
      id: randomUUID(),
      ownerId: actor.id,
      reminderId: row.id,
      dedupeKey: `reminder:${row.id}:${fireAt}:email`,
      occurrenceAt: fireAt,
      status: "sending",
      idempotencyKey: "stale",
      channel: "email",
      providerId: "attempt",
      startedAt: "2026-10-11T15:57:00.000Z",
      sentAt: null,
      error: null
    });
    const sender = new CountingSender();
    await job(store, sender, now);
    expect(sender.sent).toHaveLength(0);
    const parts = zonedParts(new Date(fireAt), ny);
    const line = `Your ${formatClock(parts.hour, parts.minute)} ping on ${new Intl.DateTimeFormat("en-US", { timeZone: ny, month: "short" }).format(new Date(fireAt))} ${parts.day} couldn't be sent.`;
    const listed = await listReminders(store, actor.id, { status: "all" }, now, caps);
    const view = listed.find((item) => item.id === row.id);
    expect(view?.status).toBe("delayed");
    expect(view?.note).toContain(line);
    expect(view?.note).toContain(NOT_DELIVERED_NOTE);
    expect(line).toBe("Your 11:30 AM ping on Oct 11 couldn't be sent.");
    expect(view?.note).not.toContain("3:30 PM");
  });

  it("QA-PASS: a one-time miss and a Telegram miss do not use the repeating email clock line", async () => {
    const fireAt = "2026-10-11T15:30:00.000Z";
    const seedAttempt = (store: MemoryFillipStore, row: Reminder, startedAt: string, channel: "email" | "telegram") => {
      store.deliveries.push({
        id: randomUUID(),
        ownerId: actor.id,
        reminderId: row.id,
        dedupeKey: `reminder:${row.id}:${fireAt}:${channel}`,
        occurrenceAt: fireAt,
        status: "sending",
        idempotencyKey: "stale",
        channel,
        providerId: "attempt",
        startedAt,
        sentAt: null,
        error: null
      });
    };
    const once = new MemoryFillipStore();
    freeUser(once);
    const oneTime = reminder({ fireAt, recurrence: null, channel: "email" });
    once.reminders.push(oneTime);
    seedAttempt(once, oneTime, "2026-10-11T15:57:00.000Z", "email");
    const retried = new CountingSender();
    await job(once, retried, now);
    expect(retried.sent.map((message) => message.idempotencyKey)).toEqual([`fillip/${oneTime.id}/${fireAt}`]);
    const retryView = (await listReminders(once, actor.id, { status: "all" }, now, caps)).find((item) => item.id === oneTime.id);
    expect(retryView?.note ?? "").toContain("so Fillip retried it");
    expect(retryView?.note ?? "").not.toContain("couldn't be sent");

    const expired = new MemoryFillipStore();
    freeUser(expired);
    const old = reminder({ fireAt, recurrence: null, channel: "email" });
    expired.reminders.push(old);
    seedAttempt(expired, old, "2026-10-10T15:00:00.000Z", "email");
    const quiet = new CountingSender();
    await job(expired, quiet, now);
    expect(quiet.sent).toHaveLength(0);
    const oldView = (await listReminders(expired, actor.id, { status: "all" }, now, caps)).find((item) => item.id === old.id);
    expect(oldView?.status).toBe("delayed");
    expect(oldView?.note).toContain(NOT_DELIVERED_NOTE);
    expect(oldView?.note ?? "").not.toContain("couldn't be sent");

    const telegram = new MemoryFillipStore();
    freeUser(telegram);
    const telegramContact = telegram.contacts.get(actor.id)!;
    telegram.contacts.set(actor.id, { ...telegramContact, telegramChatId: "chat-1", defaultChannel: "telegram" });
    const series = reminder({
      fireAt,
      timezone: ny,
      recurrence: { kind: "daily", hour: 11, minute: 30 },
      channel: "telegram"
    });
    telegram.reminders.push(series);
    seedAttempt(telegram, series, "2026-10-11T15:57:00.000Z", "telegram");
    const mail = new CountingSender();
    await job(telegram, mail, now, new CountingTelegram());
    const telegramView = (await listReminders(telegram, actor.id, { status: "all" }, now, caps)).find((item) => item.id === series.id);
    expect(telegramView?.status).toBe("delayed");
    expect(telegramView?.note).toContain(NOT_DELIVERED_NOTE);
    expect(telegramView?.note ?? "").not.toContain("11:30 AM");
    expect(mail.sent).toHaveLength(1);
  });
});

describe("QA round 6 regression sweep", () => {
  it("QA-PASS: a spring-gap clock is refused and a fall-back hour is named", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    await expect(setReminder(store, actor, {
      what: "gap",
      when: "March 14, 2027 at 2:30am",
      timezone: ny
    }, now, caps)).rejects.toThrow(/does not exist/);
    expect(store.reminders).toHaveLength(0);
    const saved = await setReminder(store, actor, {
      what: "fold",
      when: "November 1, 2026 at 1:30am",
      timezone: ny
    }, now, caps);
    expect(saved.note ?? "").toMatch(/ambiguous/i);
    expect(saved.note ?? "").not.toMatch(/does not exist/i);
  });

  it("QA-PASS: an end date survives a repeat phrase, and editing a paused reminder leaves it paused", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    const created = await setReminder(store, actor, {
      what: "series",
      when: "every 2 weeks until March 31, 2027",
      timezone: "UTC"
    }, now, caps);
    const stored = store.reminders.find((row) => row.id === created.id);
    const until = stored?.recurrence && "ends" in stored.recurrence ? stored.recurrence.ends?.until : null;
    expect(until).toBe("2027-04-01T00:00:00.000Z");
    const paused = await snoozeOrReschedule(store, actor.id, created.id, undefined, "UTC", now, "pause");
    expect(paused.status).toBe("paused");
    const edited = await snoozeOrReschedule(store, actor.id, created.id, undefined, "UTC", now, "reschedule", { repeat: "weekly" });
    expect(edited.status).toBe("paused");
    expect(store.reminders.find((row) => row.id === created.id)?.status).toBe("paused");
  });

  it("QA-PASS: plain PKCE is still rejected and user-facing copy has no prices or missing channels", () => {
    expect(pkceRejection("plain", "abc")?.error).toBe("invalid_request");
    expect(pkceRejection("S256", "")?.error).toBe("invalid_request");
    expect(pkceRejection("S256", "abc")).toBeNull();
    const roots = ["README.md", "src", "public", "glama.json", "server.json"];
    const files: string[] = [];
    const walk = (target: string) => {
      const info = statSync(target, { throwIfNoEntry: false });
      if (!info) return;
      if (!info.isDirectory()) {
        files.push(target);
        return;
      }
      for (const entry of readdirSync(target)) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(path.join(target, entry));
      }
    };
    for (const root of roots) walk(root);
    const offenders: string[] = [];
    for (const file of files) {
      if (!/\.(md|ts|json|html)$/.test(file)) continue;
      const text = readFileSync(file, "utf8");
      if (/\$\s*\d/.test(text) || /\bUSD\b/.test(text) || /\bdollars?\b/i.test(text)) offenders.push(`${file} price`);
      if (/\bSMS\b|Slack notification|push notification|WhatsApp|iMessage/i.test(text)) offenders.push(`${file} channel`);
    }
    expect(offenders).toEqual([]);
  });
});
