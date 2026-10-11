/**
 * QA round 4 against 01eec0e.
 * Concurrency cases use a real Postgres database loaded with supabase/schema.sql.
 * QA-FAIL tests assert the behavior a user was promised and fail on this build.
 * QA-PASS tests are observed successes.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import type { Server } from "node:http";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { app } from "../../src/server.js";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { listReminders, setReminder, snoozeOrReschedule } from "../../src/lib/reminders.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import { OpenCapError } from "../../src/lib/store.js";
import { validateMcpClaims } from "../../src/mcp-claims.js";
import { pkceRejection } from "../../src/plugin-auth.js";
import { WhenError } from "../../src/lib/time.js";
import type { Actor, Reminder } from "../../src/lib/types.js";
import { blankContact, STAND_IN_CAPS } from "../../src/lib/usage.js";

const ny = "America/New_York";
const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const other: Actor = { id: "33333333-3333-4333-8333-333333333333", email: "other@example.com", emailVerified: true };
const caps = STAND_IN_CAPS;
const now = new Date("2026-10-11T16:00:00.000Z");
const database = "fillip_round4";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const workers = 12;

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

function client(db = database) {
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
  const admin = client("postgres");
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
    const next = client();
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

function token(claims: Record<string, unknown>) {
  return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

describe("QA round 4 real Postgres concurrency", () => {
  beforeAll(async () => {
    await recreateDatabase();
    const db = client();
    await db.connect();
    try {
      await db.query(bootstrap);
      await db.query(schema);
    } finally {
      await db.end();
    }
  }, 60_000);

  afterAll(async () => {
    const admin = client("postgres");
    await admin.connect();
    try {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
      await admin.query(`drop database if exists ${database}`);
    } finally {
      await admin.end();
    }
  });

  async function user(id: string) {
    const db = client();
    await db.connect();
    try {
      await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [id]);
    } finally {
      await db.end();
    }
  }

  it("QA-PASS: twelve parallel inserts at an equal timestamp keep the nine older rows and reject the rest", async () => {
    const owner = randomUUID();
    await user(owner);
    const stamp = "2020-01-01T00:00:00.000Z";
    const setup = client();
    await setup.connect();
    const older: string[] = [];
    try {
      for (let index = 0; index < 9; index += 1) {
        const id = randomUUID();
        older.push(id);
        await setup.query(
          `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
           values ($1, $2, 'reminder', $3, 'UTC', now() + interval '1 day', 'active', $4)`,
          [id, owner, `older-${index}`, stamp]
        );
      }
    } finally {
      await setup.end();
    }
    const fresh = Array.from({ length: workers }, () => randomUUID());
    const opened = await openClients();
    try {
      const raced = await Promise.all(opened.map((item, index) => item.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
         values ($1, $2, 'reminder', $3, 'UTC', now() + interval '1 day', 'active', $4)`,
        [fresh[index], owner, `new-${index}`, stamp]
      ).then(() => "ok" as const, (error: Error) => error.message)));
      expect(raced.filter((item) => item === "ok")).toHaveLength(1);
      expect(raced.filter((item) => item !== "ok").every((item) => item.includes("The free plan allows 10 open reminders."))).toBe(true);
      const left = await opened[0].query<{ id: string }>(
        "select id::text from public.reminders where owner_id = $1 and status = 'active' order by id",
        [owner]
      );
      const ids = left.rows.map((row) => row.id);
      expect(ids).toHaveLength(10);
      for (const id of older) expect(ids).toContain(id);
      expect(ids.filter((id) => fresh.includes(id))).toHaveLength(1);
    } finally {
      await closeClients(opened);
    }
  });

  it("QA-PASS: twelve parallel inserts from an empty account stop at 10, including equal timestamps", async () => {
    const owner = randomUUID();
    await user(owner);
    const stamp = "2024-06-01T00:00:00.000Z";
    const fresh = Array.from({ length: workers }, () => randomUUID());
    const opened = await openClients();
    try {
      const raced = await Promise.all(opened.map((item, index) => item.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
         values ($1, $2, 'reminder', $3, 'UTC', now() + interval '1 day', 'active', $4)`,
        [fresh[index], owner, `n-${index}`, stamp]
      ).then(() => "ok" as const, (error: Error) => error.message)));
      expect(raced.filter((item) => item === "ok")).toHaveLength(10);
      expect(raced.filter((item) => item !== "ok")).toHaveLength(2);
      expect(raced.filter((item) => item !== "ok").every((item) => item.includes("The free plan allows 10 open reminders."))).toBe(true);
      const left = await opened[0].query<{ n: number }>(
        "select count(*)::int as n from public.reminders where owner_id = $1 and status = 'active'",
        [owner]
      );
      expect(left.rows[0]?.n).toBe(10);
    } finally {
      await closeClients(opened);
    }
  });

  it("QA-PASS: a trialing account keeps its 99 older rows when twelve inserts race the cap of 100", async () => {
    const owner = randomUUID();
    await user(owner);
    const setup = client();
    await setup.connect();
    try {
      await setup.query("update public.profiles set plan = 'free', subscription_status = 'trialing' where id = $1", [owner]);
      await setup.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
         select gen_random_uuid(), $1, 'reminder', 'old', 'UTC', now() + interval '1 day', 'active', '2019-01-01T00:00:00Z'
         from generate_series(1, 99)`,
        [owner]
      );
    } finally {
      await setup.end();
    }
    const opened = await openClients();
    try {
      const raced = await Promise.all(opened.map((item, index) => item.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status, created_at)
         values (gen_random_uuid(), $1, 'reminder', $2, 'UTC', now() + interval '1 day', 'active', '2020-01-01T00:00:00Z')`,
        [owner, `trial-${index}`]
      ).then(() => "ok" as const, (error: Error) => error.message)));
      expect(raced.filter((item) => item === "ok")).toHaveLength(1);
      expect(raced.filter((item) => item !== "ok").every((item) => item.includes("Too many reminders are still open"))).toBe(true);
      const counts = await opened[0].query<{ old: number; total: number }>(
        `select count(*) filter (where created_at = '2019-01-01T00:00:00Z')::int as old,
                count(*)::int as total
         from public.reminders where owner_id = $1 and status = 'active'`,
        [owner]
      );
      expect(counts.rows[0]).toEqual({ old: 99, total: 100 });
    } finally {
      await closeClients(opened);
    }
  });

  it("QA-FAIL: resuming paused reminders walks past the open cap because the trigger is insert-only", async () => {
    const owner = randomUUID();
    await user(owner);
    const setup = client();
    await setup.connect();
    const paused: string[] = [];
    try {
      await setup.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
         select gen_random_uuid(), $1, 'reminder', 'open', 'UTC', now() + interval '1 day', 'active'
         from generate_series(1, 10)`,
        [owner]
      );
      for (let index = 0; index < workers; index += 1) {
        const id = randomUUID();
        paused.push(id);
        await setup.query(
          `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
           values ($1, $2, 'reminder', $3, 'UTC', now() + interval '1 day', 'paused')`,
          [id, owner, `paused-${index}`]
        );
      }
    } finally {
      await setup.end();
    }
    const opened = await openClients();
    try {
      const raced = await Promise.all(opened.map((item, index) => item.query(
        "update public.reminders set status = 'active' where id = $1 and owner_id = $2",
        [paused[index], owner]
      ).then((result) => result.rowCount ?? 0, (error: Error) => error.message)));
      const active = await opened[0].query<{ n: number }>(
        "select count(*)::int as n from public.reminders where owner_id = $1 and status = 'active'",
        [owner]
      );
      expect(active.rows[0]?.n, `resume updates returned ${JSON.stringify(raced)}`).toBeLessThanOrEqual(10);
    } finally {
      await closeClients(opened);
    }
  });

  it("QA-FAIL: the app resume path also turns a paused reminder back on when the account is already at 10", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    const created = [];
    for (let index = 0; index < 10; index += 1) {
      created.push(await setReminder(store, actor, { what: `Open ${index}`, when: "tomorrow at 9am", timezone: "UTC" }, now, caps));
    }
    await snoozeOrReschedule(store, actor.id, created[0].id, undefined, "UTC", now, "pause");
    await setReminder(store, actor, { what: "Replacement", when: "tomorrow at 10am", timezone: "UTC" }, now, caps);
    const resumed = await snoozeOrReschedule(store, actor.id, created[0].id, undefined, "UTC", now, "resume");
    const active = store.reminders.filter((row) => row.ownerId === actor.id && row.status === "active");
    expect(active.length, `resume returned ${resumed.status} ${resumed.note ?? ""}`).toBeLessThanOrEqual(10);
  });

  it("QA-FAIL: an over-cap read with matching timestamps deletes only the inserted row and throws", async () => {
    const owner = actor.id;
    const stamp = "2026-10-11T16:00:00.000Z";
    const freshId = "00000000-0000-4000-8000-000000000010";
    const olderIds = Array.from({ length: 10 }, (_, index) => `ffffffff-ffff-4fff-8fff-${String(index + 1).padStart(12, "0")}`);
    const deleted: string[] = [];
    const row = (id: string, createdAt: string) => ({
      id,
      owner_id: owner,
      kind: "reminder",
      what: id,
      context: null,
      timezone: "UTC",
      fire_at: "2026-10-12T16:00:00.000Z",
      recurrence: null,
      channel: "email",
      status: "active",
      hold_until: null,
      created_at: createdAt,
      updated_at: stamp,
      completed_at: null
    });
    const db: Db = async (pathname, options) => {
      const method = options?.method ?? "GET";
      if (method === "POST") return [row(freshId, stamp)];
      if (method === "DELETE") {
        const id = pathname.match(/id=eq\.([^&]+)/)?.[1];
        if (id) deleted.push(decodeURIComponent(id));
        return [];
      }
      return [row(freshId, stamp), ...olderIds.map((id) => row(id, stamp))].map((item) => ({ id: item.id, created_at: item.created_at }));
    };
    const store = new SupabaseFillipStore(null, db, "service");
    await expect(store.createReminder(row(freshId, stamp) as unknown as Reminder, {
      cap: 10,
      message: "The free plan allows 10 open reminders."
    })).rejects.toThrow(/The free plan allows 10 open reminders\. Upgrade to Pro for a higher allowance\. The trial is 14 days, then Pro\./);
    expect(deleted, "only the row this call inserted is removed").toEqual([freshId]);
    for (const id of olderIds) expect(deleted, "an older row stays").not.toContain(id);
  });

  it("QA-FAIL: a caller that loses the open cap is told the reminder was not saved", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    let held = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = store.countActive.bind(store);
    store.countActive = async (ownerId: string) => {
      if (held < workers) {
        held += 1;
        await gate;
      }
      return waiting(ownerId);
    };
    for (let index = 0; index < 9; index += 1) {
      store.reminders.push({
        id: randomUUID(),
        ownerId: actor.id,
        kind: "reminder",
        what: `seed ${index}`,
        context: null,
        timezone: "UTC",
        fireAt: "2026-10-12T13:00:00.000Z",
        recurrence: null,
        channel: "email",
        status: "active",
        holdUntil: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        completedAt: null
      });
    }
    const pending = Array.from({ length: workers }, (_, index) => setReminder(
      store,
      actor,
      { what: `race ${index}`, when: "tomorrow at 9am", timezone: "UTC" },
      now,
      caps
    ).then((view) => ({ view, error: null as Error | null }), (error: Error) => ({ view: null, error })));
    while (held < workers) await new Promise((resolve) => setTimeout(resolve, 5));
    release();
    const results = await Promise.all(pending);
    const stored = new Set(store.reminders.map((row) => row.id));
    const phantom = results.filter((item) => item.view && !stored.has(item.view.id));
    expect(phantom, "a refused create must throw, not return a reminder that was not stored").toEqual([]);
    expect(store.reminders.filter((row) => row.status === "active")).toHaveLength(10);
  });

  it("QA-PASS: twelve workers reserving pings stop at the monthly cap and do not reset each other", async () => {
    const owner = randomUUID();
    await user(owner);
    const period = "2026-10-01T04:00:00.000Z";
    const opened = await openClients();
    try {
      const batches = await Promise.all(opened.map(async (item) => {
        const counts: Array<number | null> = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const result = await item.query<{ n: number | null }>(
            "select public.fillip_reserve_ping($1::uuid, 30, $2::timestamptz, null::integer, null::timestamptz) as n",
            [owner, period]
          );
          counts.push(result.rows[0]?.n ?? null);
        }
        return counts;
      }));
      const flat = batches.flat();
      const won = flat.filter((item): item is number => item !== null);
      expect(won).toHaveLength(30);
      expect(Math.max(...won)).toBe(30);
      expect(new Set(won).size).toBe(30);
      const stored = await opened[0].query<{ n: number }>("select emails_sent_in_period as n from public.profiles where id = $1", [owner]);
      expect(stored.rows[0]?.n).toBe(30);
      const again = await Promise.all(opened.map((item) => item.query<{ n: number | null }>(
        "select public.fillip_reserve_ping($1::uuid, 30, $2::timestamptz, null::integer, null::timestamptz) as n",
        [owner, period]
      )));
      expect(again.every((item) => item.rows[0]?.n == null)).toBe(true);
      const still = await opened[0].query<{ n: number }>("select emails_sent_in_period as n from public.profiles where id = $1", [owner]);
      expect(still.rows[0]?.n).toBe(30);
    } finally {
      await closeClients(opened);
    }
  });

  it("QA-PASS: one stale claim lease is taken by exactly one of twelve workers", async () => {
    const owner = randomUUID();
    await user(owner);
    const dedupe = `qa-claim-${owner}`;
    const started = "2026-10-11T15:00:00.000Z";
    const nowIso = "2026-10-11T15:06:00.000Z";
    const leaseCutoff = new Date(new Date(nowIso).getTime() - 2 * 60_000).toISOString();
    const ticketKey = `claim:${dedupe}:${started}`;
    const setup = client();
    await setup.connect();
    try {
      await setup.query(
        `insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key, provider_id, started_at)
         values ($1, $2, null, $3, $4, 'sending', $3, null, $4)`,
        [randomUUID(), owner, dedupe, started]
      );
    } finally {
      await setup.end();
    }
    const opened = await openClients();
    try {
      const outcomes = await Promise.all(opened.map(async (item) => {
        let won = false;
        try {
          await item.query(
            `insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key, started_at)
             values ($1, $2, null, $3, $4, 'sending', $5, $6)`,
            [randomUUID(), owner, ticketKey, started, `lock/${ticketKey}`, nowIso]
          );
          won = true;
        } catch (error) {
          const code = (error as { code?: string }).code;
          if (code !== "23505") throw error;
          const ticket = await item.query<{ started_at: Date }>("select started_at from public.deliveries where dedupe_key = $1", [ticketKey]);
          const previous = ticket.rows[0]?.started_at?.toISOString() ?? "";
          if (previous > leaseCutoff) return "in-progress";
          const renewed = await item.query(
            "update public.deliveries set started_at = $1 where dedupe_key = $2 and started_at = $3",
            [nowIso, ticketKey, previous]
          );
          if ((renewed.rowCount ?? 0) !== 1) return "in-progress";
          won = true;
        }
        if (!won) return "in-progress";
        const taken = await item.query(
          "update public.deliveries set status = 'sending', started_at = $1 where dedupe_key = $2 and status <> 'sent'",
          [nowIso, dedupe]
        );
        return (taken.rowCount ?? 0) === 1 ? "send" : "lost";
      }));
      expect(outcomes.filter((item) => item === "send")).toHaveLength(1);
      const rows = await opened[0].query<{ n: number }>("select count(*)::int as n from public.deliveries where dedupe_key = $1", [dedupe]);
      expect(rows.rows[0]?.n).toBe(1);
    } finally {
      await closeClients(opened);
    }
  });

  it("QA-PASS: authenticated insert and update are revoked on every public table, and select plus delete stay on the owner tables", async () => {
    const db = client();
    await db.connect();
    try {
      const tables = await db.query<{ relname: string }>(
        `select c.relname from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
         order by c.relname`
      );
      const names = tables.rows.map((row) => row.relname);
      expect(names).toEqual(expect.arrayContaining([
        "deliveries",
        "digest_settings",
        "fillip_runtime",
        "fillip_support_requests",
        "profiles",
        "reminders"
      ]));
      const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
      const matrix: Record<string, Record<string, boolean>> = {};
      for (const name of names) {
        matrix[name] = {};
        for (const role of ["anon", "authenticated"]) {
          for (const privilege of privileges) {
            const result = await db.query<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [
              role,
              `public.${name}`,
              privilege
            ]);
            matrix[name][`${role}:${privilege}`] = result.rows[0]?.ok === true;
          }
        }
      }
      for (const name of names) {
        for (const privilege of privileges) expect(matrix[name][`anon:${privilege}`], `anon ${privilege} ${name}`).toBe(false);
        expect(matrix[name]["authenticated:INSERT"], name).toBe(false);
        expect(matrix[name]["authenticated:UPDATE"], name).toBe(false);
      }
      expect(matrix.reminders["authenticated:SELECT"]).toBe(true);
      expect(matrix.reminders["authenticated:DELETE"]).toBe(true);
      expect(matrix.deliveries["authenticated:SELECT"]).toBe(true);
      expect(matrix.deliveries["authenticated:DELETE"]).toBe(true);
      expect(matrix.digest_settings["authenticated:SELECT"]).toBe(true);
      expect(matrix.digest_settings["authenticated:DELETE"]).toBe(true);
      expect(matrix.profiles["authenticated:SELECT"]).toBe(true);
      expect(matrix.profiles["authenticated:DELETE"]).toBe(false);
      expect(matrix.fillip_runtime["authenticated:SELECT"]).toBe(false);
      expect(matrix.fillip_support_requests["authenticated:SELECT"]).toBe(false);
      const execute = await db.query<{ ok: boolean }>(
        "select has_function_privilege('service_role', 'public.fillip_reserve_ping(uuid, integer, timestamptz, integer, timestamptz)', 'EXECUTE') as ok"
      );
      expect(execute.rows[0]?.ok).toBe(true);
      const hidden = await db.query<{ ok: boolean }>(
        "select has_function_privilege('authenticated', 'public.fillip_reserve_ping(uuid, integer, timestamptz, integer, timestamptz)', 'EXECUTE') as ok"
      );
      expect(hidden.rows[0]?.ok).toBe(false);
    } finally {
      await db.end();
    }
  });
});

describe("QA round 4 crash recovery and schedule edits", () => {
  function seedDue(store: MemoryFillipStore, what: string, fireAt = "2026-10-11T15:00:00.000Z") {
    const reminder: Reminder = {
      id: randomUUID(),
      ownerId: actor.id,
      kind: "reminder",
      what,
      context: null,
      timezone: "UTC",
      fireAt,
      recurrence: null,
      channel: "email",
      status: "active",
      holdUntil: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      completedAt: null
    };
    store.reminders.push(reminder);
    store.contacts.set(actor.id, blankContact(actor.id, { email: actor.email, emailVerified: true, plan: "pro", subscriptionStatus: "active" }));
    return reminder;
  }

  it("QA-PASS: an attempt still inside the two-minute lease is retried once and stays due until the provider accepts", async () => {
    const store = new MemoryFillipStore();
    const reminder = seedDue(store, "Fresh attempt");
    store.deliveries.push({
      id: "fresh",
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
    });
    const sender = new CountingSender();
    await job(store, sender, now);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.idempotencyKey).toBe(`fillip/${reminder.id}/${reminder.fireAt}`);
  });

  it("QA-FAIL: after the two-minute lease a never-accepted ping is dropped without a failed or delayed notice", async () => {
    const store = new MemoryFillipStore();
    const reminder = seedDue(store, "Stale attempt");
    const started = new Date(now.getTime() - 3 * 60_000).toISOString();
    store.deliveries.push({
      id: "stale",
      ownerId: actor.id,
      reminderId: reminder.id,
      dedupeKey: `reminder:${reminder.id}:${reminder.fireAt}:email`,
      occurrenceAt: reminder.fireAt,
      status: "sending",
      idempotencyKey: `fillip/${reminder.id}/${reminder.fireAt}`,
      channel: "email",
      providerId: "attempt",
      startedAt: started,
      sentAt: null,
      error: null
    });
    const senders = Array.from({ length: workers }, () => new CountingSender());
    await Promise.all(senders.map((sender) => job(store, sender, now)));
    const listed = await listReminders(store, actor.id, {}, now, caps);
    const row = listed.find((item) => item.id === reminder.id);
    const sent = senders.reduce((sum, sender) => sum + sender.sent.length, 0);
    const notice = `${row?.note ?? ""} ${row?.state ?? ""} ${row?.status ?? ""}`;
    expect({ sent, status: row?.status ?? null, note: row?.note ?? null, state: row?.state ?? null, notice }).toMatchObject({
      status: expect.stringMatching(/failed|delayed/),
      note: expect.stringMatching(/fail|delay|not sent|could not/i)
    });
  });

  it("QA-FAIL: a repeating occurrence past the lease is skipped with no failed notice", async () => {
    const store = new MemoryFillipStore();
    const created = await setReminder(store, actor, {
      what: "Daily stale",
      when: "every day at 9am",
      timezone: "UTC"
    }, new Date("2026-10-10T12:00:00.000Z"), caps);
    const reminder = store.reminders.find((row) => row.id === created.id);
    if (!reminder) throw new Error("missing reminder");
    reminder.fireAt = "2026-10-11T13:00:00.000Z";
    store.contacts.set(actor.id, blankContact(actor.id, { email: actor.email, emailVerified: true, plan: "pro", subscriptionStatus: "active" }));
    store.deliveries.push({
      id: "series",
      ownerId: actor.id,
      reminderId: reminder.id,
      dedupeKey: `reminder:${reminder.id}:${reminder.fireAt}:email`,
      occurrenceAt: reminder.fireAt,
      status: "sending",
      idempotencyKey: `fillip/${reminder.id}/${reminder.fireAt}`,
      channel: "email",
      providerId: "attempt",
      startedAt: new Date(now.getTime() - 3 * 60_000).toISOString(),
      sentAt: null,
      error: null
    });
    const sender = new CountingSender();
    await job(store, sender, now);
    const after = store.reminders.find((row) => row.id === reminder.id);
    const listed = await listReminders(store, actor.id, {}, now, caps);
    const row = listed.find((item) => item.id === reminder.id);
    expect(sender.sent).toHaveLength(0);
    expect(after?.fireAt).not.toBe(reminder.fireAt);
    expect(`${row?.note ?? ""} ${row?.status ?? ""}`).toMatch(/fail|delay|not sent|could not/i);
  });

  it("QA-PASS: the Telegram double-send window is the two-minute lease and not longer", async () => {
    const store = new MemoryFillipStore();
    const reminder = seedDue(store, "Telegram");
    reminder.channel = "telegram";
    const contact = store.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.telegramChatId = "9001";
    contact.defaultChannel = "telegram";
    const fireAt = reminder.fireAt;
    const dedupeKey = `reminder:${reminder.id}:${fireAt}:telegram`;
    store.deliveries.push({
      id: "tg",
      ownerId: actor.id,
      reminderId: reminder.id,
      dedupeKey,
      occurrenceAt: fireAt,
      status: "sending",
      idempotencyKey: `fillip/${reminder.id}/${fireAt}/telegram`,
      channel: "telegram",
      providerId: "attempt",
      startedAt: now.toISOString(),
      sentAt: null,
      error: null
    });
    const inside = await store.claimDelivery({
      ownerId: actor.id,
      reminderId: reminder.id,
      dedupeKey,
      occurrenceAt: fireAt,
      idempotencyKey: `fillip/${reminder.id}/${fireAt}/telegram`,
      channel: "telegram",
      nowIso: new Date(now.getTime() + 30_000).toISOString(),
      staleBeforeIso: new Date(now.getTime() + 30_000 - 2 * 60_000).toISOString()
    });
    const later = new Date(now.getTime() + 3 * 60_000);
    const outside = await store.claimDelivery({
      ownerId: actor.id,
      reminderId: reminder.id,
      dedupeKey,
      occurrenceAt: fireAt,
      idempotencyKey: `fillip/${reminder.id}/${fireAt}/telegram`,
      channel: "telegram",
      nowIso: later.toISOString(),
      staleBeforeIso: new Date(later.getTime() - 2 * 60_000).toISOString()
    });
    expect(inside.outcome).toBe("send");
    expect(outside.outcome).toBe("already-sent");
  });

  it("QA-PASS: phrase edits keep an existing until date, and a paused reminder stays paused", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    const created = await setReminder(store, actor, {
      what: "Standup",
      when: "every weekday at 9am until March 31, 2027",
      timezone: ny
    }, new Date("2026-10-01T15:00:00.000Z"), caps);
    await snoozeOrReschedule(store, actor.id, created.id, undefined, ny, now, "pause");
    const phrases = ["every 2 weeks", "first Monday of every month", "every Monday 9am", "weekly"];
    await Promise.all(phrases.map((repeat) => snoozeOrReschedule(
      store,
      actor.id,
      created.id,
      undefined,
      ny,
      now,
      "reschedule",
      { repeat }
    )));
    const saved = store.reminders.find((row) => row.id === created.id);
    expect(saved?.status).toBe("paused");
    expect(saved?.recurrence?.ends?.until).toBeTruthy();
    const listed = await listReminders(store, actor.id, { status: "paused" }, now, caps);
    expect(listed[0]?.note ?? "").toMatch(/paused \(would next send /);
    expect(listed[0]?.repeats ?? "").toMatch(/March 31, 2027/);
  });

  it("QA-PASS: a spring-forward clock is rejected unless accept_shifted_time is set, and the fall-back names both hours", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    await expect(setReminder(store, actor, {
      what: "Gap",
      when: "March 14, 2027 at 2:30am",
      timezone: ny
    }, new Date("2027-03-01T15:00:00.000Z"), caps)).rejects.toBeInstanceOf(WhenError);
    const shifted = await setReminder(store, actor, {
      what: "Gap",
      when: "March 14, 2027 at 2:30am",
      timezone: ny,
      acceptShiftedTime: true
    }, new Date("2027-03-01T15:00:00.000Z"), caps);
    expect(shifted.fireAt).toBe("2027-03-14T07:30:00.000Z");
    expect(shifted.note).toMatch(/does not exist/);
    const overlap = await setReminder(store, actor, {
      what: "Overlap",
      when: "November 1, 2026 at 1:30am",
      timezone: ny
    }, new Date("2026-10-01T15:00:00.000Z"), caps);
    expect(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]).toContain(overlap.fireAt);
    expect(overlap.note).toMatch(/ambiguous/);
  });

  it("QA-PASS: delete_reminder removes one user's reminder and is marked destructive", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    freeUser(store, other);
    const mine = await setReminder(store, actor, { what: "Mine", when: "tomorrow at 9am", timezone: "UTC" }, now, caps);
    const theirs = await setReminder(store, other, { what: "Theirs", when: "tomorrow at 9am", timezone: "UTC" }, now, caps);
    const { completeOrCancel } = await import("../../src/lib/reminders.js");
    const removed = await completeOrCancel(store, actor.id, mine.id, "delete", now);
    expect(removed).toMatchObject({ status: "deleted" });
    expect(store.reminders.map((row) => row.id)).toEqual([theirs.id]);
    expect(OpenCapError).toBeTruthy();
  });
});

describe("QA round 4 auth, logs, and copy", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  function post(method: string, body: unknown, authorization?: string) {
    const headers: Record<string, string> = { accept: "application/json, text/event-stream" };
    if (method !== "GET") headers["content-type"] = "application/json";
    if (authorization) headers.authorization = authorization;
    return fetch(`${base}/mcp`, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body)
    }).then(async (res) => ({
      status: res.status,
      text: await res.text(),
      www: res.headers.get("www-authenticate") ?? undefined
    }));
  }

  it("QA-PASS: tools/list is public and initialize, calls, resources, and GET /mcp are 401", async () => {
    const listed = await post("POST", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    const tools = JSON.parse(listed.text) as { result?: { tools?: Array<{ name: string; annotations?: { destructiveHint?: boolean } }> } };
    const names = tools.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("delete_reminder");
    const deleting = tools.result?.tools?.find((tool) => tool.name === "delete_reminder");
    expect(deleting?.annotations?.destructiveHint).toBe(true);
    const methods = ["initialize", "tools/call", "resources/list", "ping", "notifications/initialized"];
    for (const method of methods) {
      const response = await post("POST", { jsonrpc: "2.0", id: 2, method, params: method === "tools/call" ? { name: "list_reminders", arguments: {} } : {} });
      expect(response.status, method).toBe(401);
      expect(response.www ?? "").toMatch(/resource_metadata=.*oauth-protected-resource\/mcp/);
      expect(response.www ?? "").not.toMatch(/invalid_token/);
      expect(response.text).toContain("Authentication required.");
    }
    const get = await post("GET", {});
    expect(get.status).toBe(401);
  });

  it("QA-PASS: plain, missing, and lowercase pkce are invalid_request, and consent is shown before any redirect", async () => {
    expect(pkceRejection("plain", "abc")?.error).toBe("invalid_request");
    expect(pkceRejection("s256", "abc")?.error).toBe("invalid_request");
    expect(pkceRejection("", "abc")?.error).toBe("invalid_request");
    expect(pkceRejection("S256", "")?.error).toBe("invalid_request");
    expect(pkceRejection("S256", "abc")).toBeNull();
    const plain = await fetch(`${base}/oauth/authorize?redirect_uri=${encodeURIComponent("https://client.example/cb")}&code_challenge_method=s256&code_challenge=abc&state=xyz`, { redirect: "manual" });
    expect(plain.headers.get("location") ?? "").toContain("error=invalid_request");
    const consent = await fetch(`${base}/oauth/consent?authorization_id=auth-1`);
    const html = await consent.text();
    const assign = html.indexOf("if(details.data&&details.data.redirect_url){location.assign(details.data.redirect_url);return}");
    const proof = html.indexOf("/oauth/pkce-proof");
    const clientName = html.indexOf("details.data.client||{}");
    const shown = html.indexOf("el('consent').hidden=false");
    expect(assign).toBeGreaterThan(0);
    expect(assign).toBeLessThan(proof);
    expect(proof).toBeLessThan(clientName);
    expect(clientName).toBeLessThan(shown);
    expect(html).not.toContain("details.data.client.name||");
  });

  it("QA-PASS: the audience must equal a configured resource, not a prefix or another host", () => {
    const resource = "https://fillip.example/mcp";
    const issuer = "https://qa.supabase.co/auth/v1";
    const baseClaims = {
      sub: actor.id,
      iss: issuer,
      role: "authenticated",
      exp: 2_000_000_000,
      client_id: "chatgpt",
      session_id: "session-1",
      scope: "email"
    };
    expect(validateMcpClaims(token({ ...baseClaims, aud: resource }), actor.id, issuer, resource, 1_700_000_000).sub).toBe(actor.id);
    for (const aud of [`${resource}/extra`, "https://evil.example/mcp", "https://fillip.example/mcp?x=1", "http://fillip.example/mcp"]) {
      expect(() => validateMcpClaims(token({ ...baseClaims, aud }), actor.id, issuer, resource, 1_700_000_000), aud).toThrow(/Reconnect Fillip/);
    }
  });

  it("QA-PASS: the per-call log has no token, email, reminder text, or feed token", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map((item) => String(item)).join(" "));
    };
    const secret = "feed-token-super-secret";
    const email = "owner@example.com";
    const reminder = "buy milk and the calendar token";
    const bearer = token({ sub: actor.id, client_id: "chatgpt", email, calendar_token: secret });
    try {
      await post("POST", {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "set_reminder", arguments: { what: reminder, when: "tomorrow", timezone: "UTC", context: secret } }
      }, `Bearer ${bearer}`);
    } finally {
      console.log = original;
    }
    const logged = lines.filter((line) => line.includes("\"event\":\"mcp\"")).join("\n");
    expect(logged).toContain("\"tool\":\"set_reminder\"");
    expect(logged).not.toContain(bearer);
    expect(logged).not.toContain(email);
    expect(logged).not.toContain(reminder);
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain("Bearer");
  });

  it("QA-PASS: user-facing copy has no dollar prices and does not advertise a missing channel", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (name === "node_modules" || name === "dist" || name === "tests") continue;
        const stat = statSync(full);
        if (stat.isDirectory()) walk(full);
        else if (/\.(md|ts|json|html)$/.test(name)) files.push(full);
      }
    };
    walk(process.cwd());
    const wanted = files.filter((file) => /README|public-pages|connect-page|plugin-auth|fillip-tools|glama\.json|server\.json|landing/.test(file));
    expect(wanted.length).toBeGreaterThan(3);
    for (const file of wanted) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\$\s*\d/);
      expect(text, file).not.toMatch(/\bUSD\b|\bdollars?\b/i);
      expect(text, file).not.toMatch(/\bSMS\b|Slack notification|push notification/i);
    }
  });
});
