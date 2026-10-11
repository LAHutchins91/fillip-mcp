/**
 * QA round 12 against 89d9e4f.
 * Claim, cancel, and cap cases use the in-memory store and Postgres 16 with supabase/schema.sql applied.
 */
import http, { type Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { app } from "../../src/server.js";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { completeOrCancel, removeReminder, setReminder, snoozeOrReschedule } from "../../src/lib/reminders.js";
import type { TelegramSender } from "../../src/lib/telegram.js";
import type { Actor, Reminder } from "../../src/lib/types.js";
import { blankContact } from "../../src/lib/usage.js";

const now = new Date("2026-10-11T16:00:00.000Z");
const earlier = new Date("2026-10-10T16:00:00.000Z");
const actor: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", emailVerified: true };
const database = "fillip_round12";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");

const bootstrap = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid,
  oauth_client_id uuid,
  scopes text
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

function pgClient(db = database) {
  return new pg.Client({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database: db });
}

class RecordingSender implements MailSender {
  sent: OutboundEmail[] = [];
  async send(message: OutboundEmail) {
    this.sent.push(message);
    return { id: `email_${this.sent.length}` };
  }
}

class RecordingTelegram implements TelegramSender {
  sent: string[] = [];
  async send(_chatId: string, text: string) {
    this.sent.push(text);
    return { id: `tg_${this.sent.length}` };
  }
}

function job(
  store: MemoryFillipStore,
  sender: RecordingSender,
  at: Date,
  extra: { telegram?: TelegramSender; maxEmailsPerUserPerDay?: number } = {}
) {
  return runDueJob({
    store,
    sender,
    now: at,
    from: "Fillip <reminders@example.com>",
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: "unsubscribe-secret",
    maxEmailsPerUserPerDay: extra.maxEmailsPerUserPerDay ?? 20,
    maxSends: 40,
    minIntervalMs: 0,
    caps: { trialEmailsPerMonth: 100, proEmailsPerMonth: 100, annualEmailsPerMonth: 100 },
    global: { perDay: 1000, perMonth: 1000 },
    telegram: extra.telegram ? { sender: extra.telegram } : null
  });
}

function arm(who: Actor) {
  return blankContact(who.id, {
    email: who.email,
    emailVerified: true,
    plan: "pro",
    subscriptionStatus: "active",
    unsubscribed: false,
    telegramChatId: "4242"
  });
}

function gate() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class HoldClaim extends MemoryFillipStore {
  armed = false;
  readonly entered = gate();
  readonly release = gate();
  override async claimDelivery(input: Parameters<MemoryFillipStore["claimDelivery"]>[0]) {
    const result = await super.claimDelivery(input);
    if (result.outcome === "send" && !this.armed) {
      this.armed = true;
      this.entered.resolve();
      await this.release.promise;
    }
    return result;
  }
}

async function due(store: MemoryFillipStore, what: string, fireAt: string, channel: Reminder["channel"] = "email") {
  const created = await setReminder(store, actor, { what, when: "tomorrow at 9am", timezone: "UTC" }, earlier);
  const row = await store.getReminder(actor.id, created.id);
  if (!row) throw new Error("missing reminder");
  row.fireAt = fireAt;
  row.channel = channel;
  await store.saveReminder(row);
  return row;
}

describe("QA round 12 a granted send is skipped when the reminder is no longer active", () => {
  it("QA-PASS: remove, pause, cancel, and complete between claim and the provider send nothing and release the ping", async () => {
    for (const action of ["removed", "paused", "cancelled", "completed"] as const) {
      const store = new HoldClaim();
      store.contacts.set(actor.id, arm(actor));
      const target = await due(store, `Stop ${action}`, "2026-10-11T09:00:00.000Z", "both");
      const keeper = await due(store, `Keeper ${action}`, "2026-10-11T10:00:00.000Z", "email");
      const mail = new RecordingSender();
      const telegram = new RecordingTelegram();
      const pending = job(store, mail, now, { telegram, maxEmailsPerUserPerDay: 1 });
      await store.entered.promise;
      if (action === "removed") await removeReminder(store, actor.id, target.id, now);
      if (action === "paused") await snoozeOrReschedule(store, actor.id, target.id, undefined, "UTC", now, "pause");
      if (action === "cancelled") await completeOrCancel(store, actor.id, target.id, "cancel", now);
      if (action === "completed") await completeOrCancel(store, actor.id, target.id, "complete", now);
      const claimed = store.deliveries.filter((item) => item.reminderId === target.id);
      expect(claimed.length).toBeGreaterThan(0);
      if (action === "completed") {
        expect(claimed.every((item) => item.status === "sending")).toBe(true);
      } else {
        expect(claimed.every((item) => item.status === "cancelled")).toBe(true);
      }
      store.release.resolve();
      const report = await pending;
      const stopped = store.deliveries.filter((item) => item.reminderId === target.id);
      expect(mail.sent.map((message) => message.subject).join(" ")).not.toContain(`Stop ${action}`);
      expect(telegram.sent.join(" ")).not.toContain(`Stop ${action}`);
      expect(mail.sent.map((message) => message.subject).join(" ")).toContain(`Keeper ${action}`);
      expect(stopped.map((item) => item.status)).toEqual(["skipped"]);
      expect(report.sent).toBe(1);
      expect((await store.getReminder(actor.id, keeper.id))?.status).toBe("fired");
    }
  });

  it("QA-PASS: twelve workers send a still-active reminder once, and twelve remove races send nothing", async () => {
    const shared = new MemoryFillipStore();
    shared.contacts.set(actor.id, arm(actor));
    const live = await due(shared, "One ping", "2026-10-11T09:00:00.000Z");
    const mail = new RecordingSender();
    const reports = await Promise.all(Array.from({ length: 12 }, () => job(shared, mail, now)));
    expect(mail.sent).toHaveLength(1);
    expect(reports.reduce((sum, report) => sum + report.sent, 0)).toBe(1);
    expect((await shared.getReminder(actor.id, live.id))?.status).toBe("fired");
    expect(shared.deliveries.filter((item) => item.reminderId === live.id && item.status === "sent")).toHaveLength(1);

    const races = await Promise.all(Array.from({ length: 12 }, async (_unused, index) => {
      const store = new HoldClaim();
      store.contacts.set(actor.id, arm(actor));
      const row = await due(store, `Race ${index}`, "2026-10-11T09:00:00.000Z", "both");
      const sender = new RecordingSender();
      const telegram = new RecordingTelegram();
      const pending = job(store, sender, now, { telegram, maxEmailsPerUserPerDay: 1 });
      await store.entered.promise;
      await removeReminder(store, actor.id, row.id, now);
      expect(store.deliveries.filter((item) => item.reminderId === row.id).every((item) => item.status === "cancelled")).toBe(true);
      store.release.resolve();
      await pending;
      const keeper = await due(store, `After ${index}`, "2026-10-11T10:00:00.000Z");
      const again = await job(store, sender, now, { telegram, maxEmailsPerUserPerDay: 1 });
      return {
        stopped: sender.sent.filter((message) => message.subject.includes(`Race ${index}`)).length + telegram.sent.filter((text) => text.includes(`Race ${index}`)).length,
        keeperSent: again.sent === 1 && sender.sent.some((message) => message.subject.includes(`After ${index}`)),
        keeperStatus: (await store.getReminder(actor.id, keeper.id))?.status,
        removed: (await store.getReminder(actor.id, row.id))?.status
      };
    }));
    expect(races.map((race) => race.stopped)).toEqual(Array.from({ length: 12 }, () => 0));
    expect(races.every((race) => race.removed === "removed")).toBe(true);
    expect(races.every((race) => race.keeperSent && race.keeperStatus === "fired")).toBe(true);
  });
});

describe("QA round 12 Postgres cancel is atomic with the status change", () => {
  const db = pgClient();

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
    await db.connect();
    await db.query(bootstrap);
    await db.query(schema);
  }, 60_000);

  afterAll(async () => {
    await db.end().catch(() => undefined);
    const admin = pgClient("postgres");
    await admin.connect();
    try {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
      await admin.query(`drop database if exists ${database}`);
    } finally {
      await admin.end();
    }
  });

  async function pair(status: "active") {
    const owner = randomUUID();
    const reminder = randomUUID();
    const delivery = randomUUID();
    await db.query("insert into auth.users (id) values ($1)", [owner]);
    await db.query(
      `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
       values ($1, $2, 'reminder', 'inflight', 'UTC', now(), $3)`,
      [reminder, owner, status]
    );
    await db.query(
      `insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key, channel)
       values ($1, $2, $3, $4, now(), 'sending', $5, 'email')`,
      [delivery, owner, reminder, `key-${delivery}`, `idem-${delivery}`]
    );
    return { owner, reminder, delivery };
  }

  it("QA-PASS: remove, pause, and cancel mark the sending row cancelled in the same transaction", async () => {
    for (const status of ["removed", "paused", "cancelled"] as const) {
      const row = await pair("active");
      await db.query("begin");
      await db.query("update public.reminders set status = $2 where id = $1", [row.reminder, status]);
      const mid = await db.query<{ status: string }>("select status from public.deliveries where id = $1", [row.delivery]);
      expect(mid.rows[0]?.status).toBe("cancelled");
      await db.query("rollback");
      const reminder = await db.query<{ status: string }>("select status from public.reminders where id = $1", [row.reminder]);
      const delivery = await db.query<{ status: string }>("select status from public.deliveries where id = $1", [row.delivery]);
      expect(reminder.rows[0]?.status).toBe("active");
      expect(delivery.rows[0]?.status).toBe("sending");
    }
    const done = await pair("active");
    await db.query("update public.reminders set status = 'completed' where id = $1", [done.reminder]);
    expect((await db.query<{ status: string }>("select status from public.deliveries where id = $1", [done.delivery])).rows[0]?.status).toBe("sending");
    const confirmed = await db.query<{ ok: boolean }>("select public.fillip_confirm_send($1::uuid) as ok", [done.delivery]);
    expect(confirmed.rows[0]?.ok).toBe(false);
    expect((await db.query<{ status: string }>("select status from public.deliveries where id = $1", [done.delivery])).rows[0]?.status).toBe("skipped");
  });

  it("QA-PASS: twelve remove-versus-confirm races never send twice and never drop a still-active reminder", async () => {
    const rows = [];
    for (let index = 0; index < 12; index += 1) rows.push(await pair("active"));
    const races = await Promise.all(rows.map(async (row) => {
      const left = pgClient();
      const right = pgClient();
      await left.connect();
      await right.connect();
      try {
        const raced = await Promise.allSettled([
          left.query<{ ok: boolean }>("select public.fillip_confirm_send($1::uuid) as ok", [row.delivery]),
          right.query("update public.reminders set status = 'removed' where id = $1 and status = 'active'", [row.reminder])
        ]);
        const confirm = raced[0].status === "fulfilled" ? raced[0].value.rows[0]?.ok === true : false;
        const reminder = await left.query<{ status: string }>("select status from public.reminders where id = $1", [row.reminder]);
        const delivery = await left.query<{ status: string }>("select status from public.deliveries where id = $1", [row.delivery]);
        return {
          confirm,
          reminder: reminder.rows[0]?.status ?? "missing",
          delivery: delivery.rows[0]?.status ?? "missing",
          confirmError: raced[0].status === "rejected" ? String(raced[0].reason) : "",
          removeError: raced[1].status === "rejected" ? String(raced[1].reason) : ""
        };
      } finally {
        await left.end();
        await right.end();
      }
    }));
    const problems: string[] = [];
    for (const [index, race] of races.entries()) {
      if (race.delivery === "sent") problems.push(`${index} delivery was sent`);
      if (race.reminder === "active" && race.delivery !== "sending") {
        problems.push(`${index} active reminder lost its ping (${race.delivery})`);
      }
      if (race.reminder === "active" && !race.confirm && race.delivery !== "sending") {
        problems.push(`${index} active reminder was not confirmed and not still sending`);
      }
      if (race.reminder !== "active" && race.reminder !== "removed") problems.push(`${index} reminder is ${race.reminder}`);
      const unexpected = [race.confirmError, race.removeError].filter((error) => error && !/deadlock detected/i.test(error));
      if (unexpected.length) problems.push(`${index} ${unexpected.join(" | ")}`);
    }
    expect(problems).toEqual([]);
    expect(races.length).toBe(12);
  });
});

describe("QA round 12 status is read-only", () => {
  it("QA-PASS: /internal/status still requires CRON_SECRET and does not write", async () => {
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    const previous = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
      CRON_SECRET: process.env.CRON_SECRET,
      FILLIP_GLOBAL_MAX_EMAILS_PER_DAY: process.env.FILLIP_GLOBAL_MAX_EMAILS_PER_DAY,
      FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH: process.env.FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH
    };
    const calls: string[] = [];
    const original = globalThis.fetch;
    const ask = (pathname: string, authorization?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const url = new URL(pathname, base);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: authorization ? { authorization } : {}
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    process.env.SUPABASE_URL = "https://status.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.SUPABASE_ANON_KEY = "anon-test";
    process.env.FILLIP_GLOBAL_MAX_EMAILS_PER_DAY = "600";
    process.env.FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH = "15000";
    delete process.env.CRON_SECRET;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${String(input)}`);
      const url = String(input);
      if (url.includes("/rest/v1/deliveries")) return new Response("[]", { status: 200 });
      if (url.includes("/rest/v1/fillip_runtime")) {
        return new Response(JSON.stringify([{ last_purge_count: 4, last_purge_at: "2026-10-11T16:00:00.000Z" }]), { status: 200 });
      }
      return new Response("0", { status: 200 });
    }) as typeof fetch;
    try {
      const missing = await ask("/internal/status", "Bearer status-cron");
      expect(missing.status).toBe(503);
      expect(JSON.parse(missing.text)).toEqual({ error: "Status is not configured." });
      expect(calls).toEqual([]);
      process.env.CRON_SECRET = "status-cron";
      const denied = await ask("/internal/status", "Bearer wrong");
      expect(denied.status).toBe(401);
      expect(JSON.parse(denied.text)).toEqual({ error: "Status authorization failed." });
      expect(calls).toEqual([]);
      const ok = await ask("/internal/status", "Bearer status-cron");
      expect(ok.status).toBe(200);
      const body = JSON.parse(ok.text) as { purged: number; purgedAt: string };
      expect(body.purged).toBe(4);
      expect(body.purgedAt).toBe("2026-10-11T16:00:00.000Z");
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
      expect(calls.some((call) => /POST|PATCH|DELETE|fillip_purge_removed|fillip_reserve_ping|fillip_confirm_send/i.test(call))).toBe(false);
    } finally {
      globalThis.fetch = original;
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

describe("QA round 12 regression", () => {
  it("QA-PASS: the granted-send QA-FAIL is unchanged, and copy still has no prices or skipped tests", () => {
    const previous = readFileSync("tests/qa/round10.test.ts", "utf8");
    expect(previous).toContain('it("QA-FAIL: a claim that already returned send does not email after the reminder is removed"');
    expect(previous).toContain("expect(report.sent).toBe(0)");
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("runs `fillip_purge_removed` before it checks the email provider");
    expect(readme).toContain("GET /internal/status` does not delete anything.");
    expect(readme).toContain("account deletion, still remove those rows immediately.");
    const roots = ["README.md", "src", "public", "glama.json", "server.json", "supabase/README-oauth.md", "tests"];
    const offenders: string[] = [];
    const walk = (target: string) => {
      const info = statSync(target, { throwIfNoEntry: false });
      if (!info) return;
      if (!info.isDirectory()) {
        if (!/\.(md|ts|json|html)$/.test(target)) return;
        const text = readFileSync(target, "utf8");
        if (target.startsWith("tests/") && /\bit\.skip\(|\bdescribe\.skip\(|\btest\.skip\(/.test(text)) offenders.push(`${target} skip`);
        if (target.startsWith("tests/")) return;
        if (/\$\s*\d/.test(text) || /\bUSD\b/.test(text) || /\bdollars?\b/i.test(text)) offenders.push(`${target} price`);
        if (/\bSMS\b|Slack notification|push notification|WhatsApp|iMessage/i.test(text)) offenders.push(`${target} channel`);
        return;
      }
      for (const entry of readdirSync(target)) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(path.join(target, entry));
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
