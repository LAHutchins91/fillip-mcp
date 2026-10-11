/**
 * QA round 5 against 8231447.
 * Cap and daily-allowance races use a real Postgres database loaded with supabase/schema.sql.
 * Delivery races use one shared delivery row and a separate store per worker. Each save waits
 * on a real Postgres round trip before the write is visible, which is the same window hosted
 * workers have between the claim read and the later update.
 * QA-FAIL tests assert the behavior a user was promised and fail on this build.
 * QA-PASS tests are observed successes.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFillipServer } from "../../src/fillip-tools.js";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { NOT_DELIVERED_NOTE, listReminders, setReminder } from "../../src/lib/reminders.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import type { Actor, Delivery, Reminder } from "../../src/lib/types.js";
import { blankContact, STAND_IN_CAPS } from "../../src/lib/usage.js";

const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const caps = STAND_IN_CAPS;
const now = new Date("2026-10-11T16:00:00.000Z");
const database = "fillip_round5";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const workers = 12;
const dayStart = "2026-10-11T04:00:00.000Z";

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

async function recreateDatabase() {
  const admin = pgClient("postgres");
  await admin.connect();
  try {
    await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
    await admin.query(`drop database if exists ${database}`);
    await admin.query(`create database ${database}`);
  } finally {
    await admin.end();
  }
}

async function openClients(count = workers) {
  const opened = await Promise.all(Array.from({ length: count }, async () => {
    const next = pgClient();
    await next.connect();
    return next;
  }));
  return opened;
}

async function closeClients(opened: pg.Client[]) {
  await Promise.all(opened.map((item) => item.end().catch(() => undefined)));
}

function freeUser(store: MemoryFillipStore, who: Actor = actor) {
  store.contacts.set(who.id, blankContact(who.id, {
    email: who.email,
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

function reminder(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: randomUUID(),
    ownerId: actor.id,
    kind: "reminder",
    what: "pay the invoice",
    context: null,
    timezone: "UTC",
    fireAt: "2026-10-11T15:00:00.000Z",
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

function attempt(row: Reminder, channel: "email" | "telegram", startedAt: string): Delivery {
  const suffix = channel === "telegram" ? ":telegram" : ":email";
  return {
    id: randomUUID(),
    ownerId: row.ownerId,
    reminderId: row.id,
    dedupeKey: `reminder:${row.id}:${row.fireAt}${suffix}`,
    occurrenceAt: row.fireAt,
    status: "sending",
    idempotencyKey: "stale-attempt",
    channel,
    providerId: "attempt",
    startedAt,
    sentAt: null,
    error: null
  };
}

/** Separate in-flight sets, one shared row. Saves wait on Postgres before they become visible. */
class WorkerStore extends MemoryFillipStore {
  constructor(shared: MemoryFillipStore, private pool: pg.Pool) {
    super();
    this.reminders = shared.reminders;
    this.deliveries = shared.deliveries;
    this.contacts = shared.contacts;
  }

  override async saveDelivery(delivery: Delivery): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("select 1");
    } finally {
      client.release();
    }
    const index = this.deliveries.findIndex((row) => row.dedupeKey === delivery.dedupeKey);
    if (index < 0) this.deliveries.push(delivery);
    else this.deliveries[index] = delivery;
  }
}

async function callTool(store: MemoryFillipStore | SupabaseFillipStore, name: string, args: Record<string, unknown>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "qa-round5", version: "0.0.0" });
  const server = createFillipServer(store, actor, () => now, caps);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * The pre-insert count stays under the cap. The post-insert active list is longer
 * than the cap and includes the id this call just inserted, plus an older id.
 */
function hostedOverCap(ownerId: string, olderId: string) {
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
    const query = pathname.split("?")[1] ?? "";
    const params = new URLSearchParams(query);
    if (pathname.includes("/rest/v1/profiles") && method === "GET") {
      return [{
        plan: "free",
        subscription_status: "none",
        unsubscribed: false,
        emails_sent_in_period: 0,
        email_period_start: null,
        emails_sent_today: 0,
        default_channel: "email"
      }];
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
      stored.delete(id);
      return [];
    }
    if (pathname.includes("status=eq.active") && pathname.includes("limit=200")) {
      return [...stored.values()].slice(0, 9).map((row) => ({ id: row.id }));
    }
    if (pathname.includes("status=eq.active") && pathname.includes("limit=500")) {
      const ids = [...stored.keys()];
      const padding = [
        "11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-111111111112",
        "11111111-1111-4111-8111-111111111113",
        "11111111-1111-4111-8111-111111111114",
        "11111111-1111-4111-8111-111111111115",
        "11111111-1111-4111-8111-111111111116",
        "11111111-1111-4111-8111-111111111117",
        "11111111-1111-4111-8111-111111111118",
        "11111111-1111-4111-8111-111111111119",
        "11111111-1111-4111-8111-11111111111a"
      ];
      for (const extra of padding) {
        if (ids.length > 10) break;
        ids.push(extra);
      }
      return ids.map((id) => ({ id }));
    }
    if (pathname.includes("/rest/v1/reminders") && method === "GET") {
      const id = (params.get("id") ?? "").replace(/^eq\./, "");
      const row = stored.get(id);
      return row ? [row] : [];
    }
    if (pathname.includes("/rest/v1/deliveries")) return [];
    return [];
  };
  return { db, deleted, stored };
}

describe("QA round 5 real Postgres concurrency", () => {
  beforeAll(async () => {
    await recreateDatabase();
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

  async function owner(id: string, plan = "free", status = "none") {
    const db = pgClient();
    await db.connect();
    try {
      await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
      await db.query(
        `insert into public.profiles (id, plan, subscription_status)
         values ($1, $2, $3)
         on conflict (id) do update set plan = excluded.plan, subscription_status = excluded.subscription_status`,
        [id, plan, status]
      );
    } finally {
      await db.end();
    }
  }

  async function seed(ownerId: string, status: "active" | "paused", count: number) {
    const db = pgClient();
    await db.connect();
    const ids: string[] = [];
    try {
      for (let index = 0; index < count; index += 1) {
        const id = randomUUID();
        ids.push(id);
        await db.query(
          `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
           values ($1, $2, 'reminder', $3, 'UTC', now() + interval '2 days', $4, '2020-01-01T00:00:00.000Z')`,
          [id, ownerId, `${status}-${index}`, status]
        );
      }
    } finally {
      await db.end();
    }
    return ids;
  }

  async function activeIds(ownerId: string) {
    const db = pgClient();
    await db.connect();
    try {
      const result = await db.query("select id from public.reminders where owner_id = $1 and status = 'active' order by created_at, id", [ownerId]);
      return result.rows.map((row) => String(row.id));
    } finally {
      await db.end();
    }
  }

  async function mixed(ownerId: string, pausedIds: string[], inserts: number, resumes: number) {
    const opened = await openClients(inserts + resumes);
    try {
      return await Promise.all(opened.map(async (client, index) => {
        try {
          if (index < inserts) {
            const id = randomUUID();
            await client.query(
              `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
               values ($1, $2, 'reminder', $3, 'UTC', now() + interval '3 days', 'active', '2020-01-01T00:00:00.000Z')`,
              [id, ownerId, `create-${index}`]
            );
            return { ok: true as const, id };
          }
          const id = pausedIds[index - inserts] ?? "";
          await client.query("update public.reminders set status = 'active', updated_at = now() where id = $1 and status = 'paused'", [id]);
          return { ok: true as const, id };
        } catch (error) {
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
        }
      }));
    } finally {
      await closeClients(opened);
    }
  }

  it("QA-PASS: twelve mixed creates and resumes at nine open leave exactly ten, and the nine older rows stay", async () => {
    const id = randomUUID();
    await owner(id);
    const older = await seed(id, "active", 9);
    const paused = await seed(id, "paused", 6);
    const results = await mixed(id, paused, 6, 6);
    const saved = results.filter((row) => row.ok);
    const refused = results.filter((row) => !row.ok);
    expect(saved).toHaveLength(1);
    expect(refused).toHaveLength(11);
    expect(refused.every((row) => /The free plan allows 10 open reminders/.test(row.message))).toBe(true);
    const active = await activeIds(id);
    expect(active).toHaveLength(10);
    expect(older.every((row) => active.includes(row))).toBe(true);
    expect(active.filter((row) => saved.some((item) => item.id === row))).toHaveLength(1);
  });

  it("QA-PASS: sixteen mixed creates and resumes on an empty account stop at ten", async () => {
    const id = randomUUID();
    await owner(id);
    const paused = await seed(id, "paused", 8);
    const opened = await openClients(16);
    try {
      const results = await Promise.all(opened.map(async (client, index) => {
        try {
          if (index < 8) {
            const created = randomUUID();
            await client.query(
              `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
               values ($1, $2, 'reminder', $3, 'UTC', now() + interval '3 days', 'active', '2020-01-01T00:00:00.000Z')`,
              [created, id, `create-${index}`]
            );
            return true;
          }
          await client.query("update public.reminders set status = 'active' where id = $1 and status = 'paused'", [paused[index - 8]]);
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          expect(message).toMatch(/The free plan allows 10 open reminders/);
          return false;
        }
      }));
      expect(results.filter(Boolean)).toHaveLength(10);
      expect(await activeIds(id)).toHaveLength(10);
    } finally {
      await closeClients(opened);
    }
  });

  it("QA-PASS: a trialing account mixes resumes and creates up to 100 and keeps the older rows", async () => {
    const id = randomUUID();
    await owner(id, "free", "trialing");
    const older = await seed(id, "active", 98);
    const paused = await seed(id, "paused", 6);
    const results = await mixed(id, paused, 6, 6);
    expect(results.filter((row) => row.ok)).toHaveLength(2);
    expect(results.filter((row) => !row.ok).every((row) => /Too many reminders are still open/.test(row.message))).toBe(true);
    const active = await activeIds(id);
    expect(active).toHaveLength(100);
    expect(older.every((row) => active.includes(row))).toBe(true);
  });

  it("QA-PASS: editing an active reminder at the cap is not treated as a new open reminder", async () => {
    const id = randomUUID();
    await owner(id);
    const older = await seed(id, "active", 10);
    const db = pgClient();
    await db.connect();
    try {
      await db.query("update public.reminders set what = 'still open' where id = $1", [older[0]]);
      const row = await db.query("select what, status from public.reminders where id = $1", [older[0]]);
      expect(row.rows[0]).toMatchObject({ what: "still open", status: "active" });
      expect(await activeIds(id)).toHaveLength(10);
    } finally {
      await db.end();
    }
  });

  it("QA-PASS: twelve workers at 99 of 100 daily inside fillip_reserve_ping let exactly one send", async () => {
    const id = randomUUID();
    await owner(id);
    const db = pgClient();
    await db.connect();
    try {
      await db.query(
        `update public.profiles
         set emails_sent_today = 99, email_day_start = $2, emails_sent_in_period = 10, email_period_start = $2
         where id = $1`,
        [id, dayStart]
      );
    } finally {
      await db.end();
    }
    const opened = await openClients(12);
    try {
      const results = await Promise.all(opened.map((client) => client.query(
        "select public.fillip_reserve_ping($1::uuid, $2::int, $3::timestamptz, $4::int, $5::timestamptz) as n",
        [id, 1000, dayStart, 100, dayStart]
      )));
      const values = results.map((result) => Number(result.rows[0]?.n));
      expect(values.filter((value) => value === -1)).toHaveLength(11);
      expect(values.filter((value) => value > 0)).toHaveLength(1);
    } finally {
      await closeClients(opened);
    }
    const check = pgClient();
    await check.connect();
    try {
      const row = await check.query("select emails_sent_today, emails_sent_in_period from public.profiles where id = $1", [id]);
      expect(Number(row.rows[0]?.emails_sent_today)).toBe(100);
      expect(Number(row.rows[0]?.emails_sent_in_period)).toBe(11);
    } finally {
      await check.end();
    }
  });
});

describe("QA round 5 cap refusals and the post-insert pass", () => {
  it("QA-PASS: an OpenCapError from the memory store is a tool error", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    const clocks = ["8am", "9am", "10am", "11am", "12pm", "1pm", "2pm", "3pm", "4pm", "5pm"];
    for (let index = 0; index < 10; index += 1) {
      await setReminder(store, actor, { what: `open ${index}`, when: `tomorrow at ${clocks[index]}`, timezone: "UTC" }, now, caps);
    }
    const result = await callTool(store, "set_reminder", { what: "one more", when: "tomorrow at 6pm", timezone: "UTC" });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).toMatch(/The free plan allows 10 open reminders/);
    expect(text).not.toMatch(/"status":"active"/);
    expect(store.reminders.filter((row) => row.status === "active")).toHaveLength(10);
  });

  it("QA-PASS: a P0001 cap refusal and a plain cap sentence are both tool errors", async () => {
    for (const message of [
      JSON.stringify({ code: "P0001", message: "The free plan allows 10 open reminders." }),
      "The free plan allows 10 open reminders."
    ]) {
      const olderId = randomUUID();
      const hosted = hostedOverCap(actor.id, olderId);
      const throwing: Db = async (pathname, options) => {
        if ((options?.method ?? "GET") === "POST" && pathname.includes("/rest/v1/reminders") && !pathname.includes("profiles")) {
          throw new Error(message);
        }
        return hosted.db(pathname, options);
      };
      const store = new SupabaseFillipStore(null, throwing, "service");
      await expect(setReminder(store, actor, { what: "capped", when: "tomorrow 9am", timezone: "UTC" }, now, caps)).rejects.toThrow(/The free plan allows 10 open reminders/);
      const result = await callTool(store, "set_reminder", { what: "capped", when: "tomorrow 9am", timezone: "UTC" });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toMatch(/The free plan allows 10 open reminders/);
      expect(JSON.stringify(result)).not.toMatch(/"status":"active"/);
    }
  });

  it("QA-PASS: resuming at the cap is a tool error and the reminder stays paused", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    const clocks = ["8am", "9am", "10am", "11am", "12pm", "1pm", "2pm", "3pm", "4pm", "5pm"];
    for (let index = 0; index < 10; index += 1) {
      await setReminder(store, actor, { what: `open ${index}`, when: `tomorrow at ${clocks[index]}`, timezone: "UTC" }, now, caps);
    }
    const paused = reminder({ what: "held", status: "paused", fireAt: "2026-10-12T13:00:00.000Z" });
    store.reminders.push(paused);
    const result = await callTool(store, "snooze_or_reschedule", { id: paused.id, action: "resume" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toMatch(/The free plan allows 10 open reminders/);
    expect(store.reminders.find((row) => row.id === paused.id)?.status).toBe("paused");
    expect(store.reminders.filter((row) => row.status === "active")).toHaveLength(10);
  });

  it("QA-PASS: a failed over-cap delete keeps the row and does not say it was not saved", async () => {
    const olderId = randomUUID();
    const hosted = hostedOverCap(actor.id, olderId);
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    const db: Db = async (pathname, options) => {
      if ((options?.method ?? "GET") === "DELETE" && pathname.includes("/rest/v1/reminders")) {
        throw new Error("delete failed for reminder what=secret-note owner@example.com token=secret");
      }
      return hosted.db(pathname, options);
    };
    try {
      const store = new SupabaseFillipStore(null, db, "service");
      const result = await callTool(store, "set_reminder", { what: "should not stick", when: "tomorrow 9am", timezone: "UTC" });
      const text = JSON.stringify(result);
      expect(result.isError, text).toBeFalsy();
      expect(text).toMatch(/You're over the free plan's 10 open reminders\./);
      expect(text).toMatch(/Upgrade to Pro for a higher allowance\. The trial is 14 days, then Pro\./);
      expect(text).toMatch(/"status":"active"/);
      expect(text).not.toMatch(/may not have been saved|secret-note|owner@example.com|delete failed|token=secret/);
      expect(lines.join("\n")).toContain("open_cap_delete_failed");
      expect(lines.join("\n")).not.toMatch(/secret-note|owner@example.com|token=secret|delete failed|should not stick/);
      const savedId = text.match(/"id":"([0-9a-f-]{36})"/)?.[1] ?? "";
      expect((await store.getReminder(actor.id, savedId))?.status).toBe("active");
      expect((await store.getReminder(actor.id, olderId))?.status).toBe("active");
    } finally {
      console.error = original;
    }
  });

  it("QA-PASS: an over-cap delete that returns its id throws and does not delete again", async () => {
    const olderId = randomUUID();
    const hosted = hostedOverCap(actor.id, olderId);
    let deletes = 0;
    const db: Db = async (pathname, options) => {
      if ((options?.method ?? "GET") === "DELETE" && pathname.includes("/rest/v1/reminders")) {
        deletes += 1;
        const id = new URLSearchParams(pathname.split("?")[1] ?? "").get("id")?.replace(/^eq\./, "") ?? "";
        expect(String(options?.headers && new Headers(options.headers as HeadersInit).get("prefer"))).toContain("return=representation");
        hosted.stored.delete(id);
        return [{ id }];
      }
      return hosted.db(pathname, options);
    };
    const store = new SupabaseFillipStore(null, db, "service");
    await expect(setReminder(store, actor, { what: "returned id", when: "tomorrow 9am", timezone: "UTC" }, now, caps)).rejects.toThrow(/The free plan allows 10 open reminders/);
    expect(deletes).toBe(1);
    expect(hosted.stored.has(olderId)).toBe(true);
  });

  it("QA-PASS: a user delete that leaves the row is retried once with the service role", async () => {
    const olderId = randomUUID();
    const hosted = hostedOverCap(actor.id, olderId);
    let userDeletes = 0;
    const userDb: Db = async (pathname, options) => {
      if ((options?.method ?? "GET") === "DELETE" && pathname.includes("/rest/v1/reminders")) {
        userDeletes += 1;
        return [];
      }
      return hosted.db(pathname, options);
    };
    const store = new SupabaseFillipStore(actor.id, userDb, "user", hosted.db);
    await expect(setReminder(store, actor, { what: "service removes it", when: "tomorrow 9am", timezone: "UTC" }, now, caps)).rejects.toThrow(/The free plan allows 10 open reminders/);
    expect(userDeletes).toBe(1);
    expect(hosted.deleted).toHaveLength(1);
    const ownId = hosted.deleted[0] ?? "";
    expect(hosted.deleted).not.toContain(olderId);
    expect(hosted.stored.has(ownId)).toBe(false);
    expect(hosted.stored.has(olderId)).toBe(true);
  });

  it("QA-PASS: a service-role retry that leaves the row returns it with the over-cap note", async () => {
    const olderId = randomUUID();
    const hosted = hostedOverCap(actor.id, olderId);
    let serviceDeletes = 0;
    const userDb: Db = async (pathname, options) => {
      if ((options?.method ?? "GET") === "DELETE" && pathname.includes("/rest/v1/reminders")) return [];
      return hosted.db(pathname, options);
    };
    const serviceDb: Db = async (pathname, options) => {
      if ((options?.method ?? "GET") === "DELETE" && pathname.includes("/rest/v1/reminders")) {
        serviceDeletes += 1;
        return [];
      }
      return hosted.db(pathname, options);
    };
    const lines: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const store = new SupabaseFillipStore(actor.id, userDb, "user", serviceDb);
      const view = await setReminder(store, actor, { what: "still due", when: "tomorrow 9am", timezone: "UTC" }, now, caps);
      expect(serviceDeletes).toBe(1);
      expect(view.status).toBe("active");
      expect(view.note).toMatch(/You're over the free plan's 10 open reminders\. Upgrade to Pro for a higher allowance\. The trial is 14 days, then Pro\./);
      expect(view.note).not.toMatch(/may not have been saved/);
      expect((await store.getReminder(actor.id, view.id))?.status).toBe("active");
      expect(lines.join("\n")).toContain("open_cap_delete_failed");
      expect(lines.join("\n")).not.toMatch(/still due|owner@example.com/);
    } finally {
      console.error = original;
    }
  });

  it("QA-FAIL: a hosted read over the cap deletes the inserted row and still returns it as saved", async () => {
    const olderId = randomUUID();
    const hosted = hostedOverCap(actor.id, olderId);
    const store = new SupabaseFillipStore(null, hosted.db, "service");
    const result = await callTool(store, "set_reminder", { what: "should not stick", when: "tomorrow 9am", timezone: "UTC" });
    const text = JSON.stringify(result);
    expect(result.isError, text).toBe(true);
    expect(text).toMatch(/The free plan allows 10 open reminders|may not have been saved|Too many reminders/);
    expect(text).not.toMatch(/should not stick/);
  });

  it("QA-PASS: an over-cap hosted read deletes only this call's row and throws", async () => {
    const olderId = randomUUID();
    const hosted = hostedOverCap(actor.id, olderId);
    const store = new SupabaseFillipStore(null, hosted.db, "service");
    await expect(setReminder(store, actor, { what: "should not stick", when: "tomorrow 9am", timezone: "UTC" }, now, caps)).rejects.toThrow(/The free plan allows 10 open reminders\. Upgrade to Pro for a higher allowance\. The trial is 14 days, then Pro\./);
    expect(hosted.deleted).toHaveLength(1);
    const ownId = hosted.deleted[0];
    expect(hosted.deleted).toEqual([ownId]);
    expect(hosted.deleted).not.toContain(olderId);
    expect(hosted.stored.has(olderId)).toBe(true);
    expect(hosted.stored.has(ownId)).toBe(false);
    expect(await store.getReminder(actor.id, ownId)).toBeNull();
    expect((await store.getReminder(actor.id, olderId))?.id).toBe(olderId);
  });
});

describe("QA round 5 delivery recovery", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database: "postgres", max: 16 });
    await pool.query("select 1");
  });

  afterAll(async () => {
    await pool.end();
  });

  function ready(store: MemoryFillipStore, row: Reminder, channel: "email" | "telegram", startedAt: string) {
    freeUser(store);
    if (channel === "telegram") {
      const contact = store.contacts.get(actor.id)!;
      store.contacts.set(actor.id, { ...contact, telegramChatId: "chat-1", defaultChannel: "telegram" });
    }
    store.reminders.push(row);
    store.deliveries.push(attempt(row, channel, startedAt));
  }

  it("QA-PASS: a one-time email inside 24 hours retries once on the same key and a later job does not send again", async () => {
    const store = new MemoryFillipStore();
    const row = reminder();
    ready(store, row, "email", "2026-10-11T15:57:00.000Z");
    const sender = new CountingSender();
    const original = sender.send.bind(sender);
    sender.send = async (message) => {
      expect(store.reminders.find((item) => item.id === row.id)?.status).toBe("active");
      return original(message);
    };
    await job(store, sender, now);
    const key = `fillip/${row.id}/${row.fireAt}`;
    expect(sender.sent.map((message) => message.idempotencyKey)).toEqual([key]);
    expect(store.reminders.find((item) => item.id === row.id)?.status).toBe("fired");
    const again = new CountingSender();
    await job(store, again, new Date(now.getTime() + 60_000));
    expect(again.sent).toHaveLength(0);
  });

  it("QA-PASS: twelve workers retry a one-time email on one key, and a later job does not send", async () => {
    const shared = new MemoryFillipStore();
    const row = reminder();
    ready(shared, row, "email", "2026-10-11T15:57:00.000Z");
    const sender = new CountingSender();
    const stores = Array.from({ length: 12 }, () => new WorkerStore(shared, pool));
    await Promise.all(stores.map((store) => job(store, sender, now)));
    const key = `fillip/${row.id}/${row.fireAt}`;
    expect(new Set(sender.sent.map((message) => message.idempotencyKey))).toEqual(new Set([key]));
    const follow = new CountingSender();
    await job(shared, follow, new Date(now.getTime() + 60_000));
    expect(follow.sent).toHaveLength(0);
    // Each worker calls Resend before any of them stores the provider id.
    // The shared key is what makes those calls one send. This run submitted 12.
    expect(sender.sent.length).toBeGreaterThan(0);
  });

  it("QA-PASS: a one-time email older than 24 hours is not sent again", async () => {
    const store = new MemoryFillipStore();
    const row = reminder();
    ready(store, row, "email", "2026-10-10T15:00:00.000Z");
    const sender = new CountingSender();
    await job(store, sender, now);
    expect(sender.sent).toHaveLength(0);
    expect(store.deliveries.find((item) => item.reminderId === row.id)?.error).toMatch(/not delivered/i);
  });

  it("QA-PASS: a repeating email past the lease is listed as not delivered and no notice is emailed", async () => {
    const store = new MemoryFillipStore();
    const row = reminder({
      recurrence: { kind: "daily", hour: 15, minute: 0 },
      channel: "email"
    });
    ready(store, row, "email", "2026-10-11T15:57:00.000Z");
    const sender = new CountingSender();
    await job(store, sender, now);
    expect(sender.sent).toHaveLength(0);
    const listed = await listReminders(store, actor.id, { status: "all" }, now, caps);
    const view = listed.find((item) => item.id === row.id);
    expect(view?.status).toBe("delayed");
    expect(view?.note).toContain(NOT_DELIVERED_NOTE);
    expect(view?.note).not.toMatch(/not-delivered/);
    expect(store.reminders.find((item) => item.id === row.id)?.fireAt).not.toBe(row.fireAt);
  });

  it("QA-FAIL: telegram past the lease lists not delivered and sends exactly one email notice under parallel workers", async () => {
    const shared = new MemoryFillipStore();
    const row = reminder({ channel: "telegram" });
    ready(shared, row, "telegram", "2026-10-11T15:57:00.000Z");
    const sender = new CountingSender();
    const telegram = new CountingTelegram();
    const stores = Array.from({ length: 12 }, () => new WorkerStore(shared, pool));
    await Promise.all(stores.map((store) => job(store, sender, now, telegram)));
    const listed = await listReminders(shared, actor.id, { status: "all" }, now, caps);
    const view = listed.find((item) => item.id === row.id);
    expect(view?.status).toBe("delayed");
    expect(view?.note).toContain("not delivered");
    expect(telegram.sent).toHaveLength(0);
    const notices = sender.sent.filter((message) => message.idempotencyKey === `fillip/${row.id}/${row.fireAt}/not-delivered`);
    expect(notices).toHaveLength(1);
  });
});
