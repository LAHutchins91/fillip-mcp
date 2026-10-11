/**
 * QA round 11 against 19c625b.
 * Restore, cap, and purge cases use the in-memory store and Postgres 16 with supabase/schema.sql applied.
 * QA-FAIL tests assert the behavior a user was promised and fail on this build.
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
import {
  completeOrCancel,
  listReminders,
  REMOVE_RETAIN_MS,
  removeReminder,
  renderCalendarFeed,
  restoreReminder,
  setReminder,
  snoozeOrReschedule
} from "../../src/lib/reminders.js";
import { OpenCapError } from "../../src/lib/store.js";
import { nextFire } from "../../src/lib/time.js";
import type { Actor, Reminder } from "../../src/lib/types.js";
import { blankContact, FREE_OPEN_REMINDERS, freeOpenMessage } from "../../src/lib/usage.js";

const now = new Date("2026-10-11T16:00:00.000Z");
const earlier = new Date("2026-10-10T16:00:00.000Z");
const actor: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", emailVerified: true };
const other: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.com", emailVerified: true };
const database = "fillip_round11";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const restoreDescription = "Restores a reminder removed in the last 30 days to the status it had before. Only an active reminder gets a new next time when the old one has passed, and only that one goes through the open cap. A paused reminder stays paused. A cancelled or completed reminder stays that way, does not send, and does not count toward the cap. Restoring one that is already back succeeds.";

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
  order: string[] = [];
  async send(message: OutboundEmail) {
    this.order.push("send");
    this.sent.push(message);
    return { id: `email_${this.sent.length}` };
  }
}

class OrderStore extends MemoryFillipStore {
  order: string[] = [];
  override async purgeRemoved(cutoffIso: string): Promise<number> {
    this.order.push("purge");
    return super.purgeRemoved(cutoffIso);
  }
}

function job(store: MemoryFillipStore, sender: RecordingSender, at: Date, from = "Fillip <reminders@example.com>") {
  return runDueJob({
    store,
    sender,
    now: at,
    from,
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: "unsubscribe-secret",
    maxEmailsPerUserPerDay: 20,
    maxSends: 40,
    minIntervalMs: 0,
    caps: { trialEmailsPerMonth: 100, proEmailsPerMonth: 1000, annualEmailsPerMonth: 1000 },
    global: { perDay: 1000, perMonth: 1000 }
  });
}

function free(store: MemoryFillipStore, who: Actor) {
  store.contacts.set(who.id, blankContact(who.id, {
    email: who.email,
    emailVerified: true,
    plan: "free",
    subscriptionStatus: "none",
    unsubscribed: false
  }));
}

async function rowOf(store: MemoryFillipStore, id: string): Promise<Reminder> {
  const row = await store.getReminder(actor.id, id);
  if (!row) throw new Error("missing reminder");
  return row;
}

describe("QA round 11 restore returns the exact prior status", () => {
  it("QA-PASS: an active series restores to the next future time, sends once, and still hits the open cap", async () => {
    const store = new MemoryFillipStore();
    const created = await setReminder(store, actor, { what: "Daily standup", when: "every day at 9am", timezone: "UTC" }, earlier);
    const daily = await rowOf(store, created.id);
    if (!daily.recurrence) throw new Error("missing series");
    daily.fireAt = "2026-10-06T09:00:00.000Z";
    await store.saveReminder(daily);
    await removeReminder(store, actor.id, daily.id, now);
    const restored = await restoreReminder(store, actor.id, daily.id, now);
    const upcoming = nextFire(daily.recurrence, "UTC", now);
    if (!upcoming) throw new Error("missing next fire");
    expect(restored.id).toBe(daily.id);
    expect(restored.status).toBe("active");
    expect(restored.fireAt).toBe(upcoming.toISOString());
    expect(upcoming.getTime()).toBeGreaterThan(now.getTime());
    expect(upcoming.getTime() - now.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
    expect(store.reminders.filter((item) => item.ownerId === actor.id)).toHaveLength(1);
    const sender = new RecordingSender();
    expect((await job(store, sender, now)).sent).toBe(0);
    expect((await job(store, sender, upcoming)).sent).toBe(1);
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]?.subject ?? "").toContain("Daily standup");

    const once = await setReminder(store, actor, { what: "Once past", when: "tomorrow at 11am", timezone: "UTC" }, now);
    await removeReminder(store, actor.id, once.id, now);
    const removed = await rowOf(store, once.id);
    const stamp = removed.removedAt;
    removed.fireAt = "2026-10-01T15:00:00.000Z";
    await store.saveReminder(removed);
    await expect(restoreReminder(store, actor.id, once.id, now)).rejects.toThrow(/already in the past/);
    const kept = await rowOf(store, once.id);
    expect(kept.status).toBe("removed");
    expect(kept.removedAt).toBe(stamp);
    expect(kept.fireAt).toBe("2026-10-01T15:00:00.000Z");

    const capped = new MemoryFillipStore();
    free(capped, actor);
    const held = await setReminder(capped, actor, { what: "Held active", when: "tomorrow at 9am", timezone: "UTC" }, now);
    await removeReminder(capped, actor.id, held.id, now);
    const heldStamp = (await capped.getReminder(actor.id, held.id))?.removedAt;
    for (let index = 0; index < FREE_OPEN_REMINDERS; index += 1) {
      await setReminder(capped, actor, { what: `Open ${index}`, when: "tomorrow at 8am", timezone: "UTC" }, now);
    }
    expect(await capped.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
    await expect(restoreReminder(capped, actor.id, held.id, now)).rejects.toBeInstanceOf(OpenCapError);
    await expect(restoreReminder(capped, actor.id, held.id, now)).rejects.toThrow(freeOpenMessage(FREE_OPEN_REMINDERS));
    const after = await capped.getReminder(actor.id, held.id);
    expect(after?.status).toBe("removed");
    expect(after?.removedAt).toBe(heldStamp);
    expect(await capped.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
  });

  it("QA-PASS: a paused reminder stays paused, keeps its time, skips the cap, and does not send", async () => {
    const store = new MemoryFillipStore();
    free(store, actor);
    const created = await setReminder(store, actor, { what: "Paused past", when: "every day at 11am", timezone: "UTC" }, earlier);
    await snoozeOrReschedule(store, actor.id, created.id, undefined, "UTC", now, "pause");
    const paused = await rowOf(store, created.id);
    paused.fireAt = "2026-10-01T15:00:00.000Z";
    paused.holdUntil = "2026-12-01T00:00:00.000Z";
    await store.saveReminder(paused);
    await removeReminder(store, actor.id, created.id, now);
    const removed = await rowOf(store, created.id);
    removed.holdUntil = "2026-12-01T00:00:00.000Z";
    await store.saveReminder(removed);
    for (let index = 0; index < FREE_OPEN_REMINDERS; index += 1) {
      await setReminder(store, actor, { what: `Paused filler ${index}`, when: "tomorrow at 8am", timezone: "UTC" }, now);
    }
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
    const back = await restoreReminder(store, actor.id, created.id, now);
    expect(back.id).toBe(created.id);
    expect(back.status).toBe("paused");
    expect(back.fireAt).toBe("2026-10-01T15:00:00.000Z");
    expect(back.note ?? "").toMatch(/^Restored\. It stays paused until you resume it\./);
    const stored = await rowOf(store, created.id);
    expect(stored.status).toBe("paused");
    expect(stored.holdUntil).toBe("2026-12-01T00:00:00.000Z");
    expect(stored.resumeStatus ?? null).toBeNull();
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
    await store.setCalendarToken(actor.id, "paused-calendar-token-123456");
    const feed = (await renderCalendarFeed(store, "paused-calendar-token-123456", now)) ?? "";
    expect(feed).not.toContain("Paused past");
    const sender = new RecordingSender();
    const report = await job(store, sender, new Date(now.getTime() + 2 * 86_400_000));
    expect(report.sent).toBe(FREE_OPEN_REMINDERS);
    expect(sender.sent.map((message) => message.subject).join(" ")).not.toContain("Paused past");
  });

  it("QA-PASS: cancelled, completed, and fired come back unchanged, stay off the calendar, and do not send", async () => {
      const specs = [
      { what: "Fired row", status: "fired" as const },
      { what: "Completed row", status: "completed" as const },
      { what: "Cancelled row", status: "cancelled" as const }
    ];
    for (const spec of specs) {
      const store = new MemoryFillipStore();
      free(store, actor);
      const created = await setReminder(store, actor, { what: spec.what, when: "every day at 11am", timezone: "UTC" }, earlier);
      if (spec.status === "completed") await completeOrCancel(store, actor.id, created.id, "complete", now);
      if (spec.status === "cancelled") await completeOrCancel(store, actor.id, created.id, "cancel", now);
      const before = await rowOf(store, created.id);
      if (spec.status === "fired") {
        before.status = "fired";
        before.fireAt = "2026-10-09T15:00:00.000Z";
        await store.saveReminder(before);
      }
      const prior = await rowOf(store, created.id);
      expect(prior.status).toBe(spec.status);
      const fireAt = prior.fireAt;
      const completedAt = prior.completedAt;
      await removeReminder(store, actor.id, created.id, now);
      expect((await rowOf(store, created.id)).resumeStatus).toBe(spec.status);
      for (let index = 0; index < FREE_OPEN_REMINDERS; index += 1) {
        await setReminder(store, actor, { what: `Cap filler ${spec.status} ${index}`, when: "tomorrow at 8am", timezone: "UTC" }, now);
      }
      expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
      const back = await restoreReminder(store, actor.id, created.id, now);
      const stored = await rowOf(store, created.id);
      expect(back.id).toBe(created.id);
      expect(back.status).toBe(spec.status);
      expect(back.fireAt).toBe(fireAt);
      expect(back.note).toBe("Restored. It will not send.");
      expect(stored.status).toBe(spec.status);
      expect(stored.fireAt).toBe(fireAt);
      expect(stored.completedAt).toBe(completedAt);
      expect(stored.removedAt ?? null).toBeNull();
      expect(stored.resumeStatus ?? null).toBeNull();
      expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
      const listed = await listReminders(store, actor.id, {}, now);
      if (spec.status === "fired") expect(listed.some((item) => item.what === spec.what)).toBe(true);
      else expect(listed.some((item) => item.what === spec.what)).toBe(false);
      await store.setCalendarToken(actor.id, `calendar-${spec.status}-123456789`);
      const feed = (await renderCalendarFeed(store, `calendar-${spec.status}-123456789`, now)) ?? "";
      expect(feed).not.toContain(spec.what);
      const sender = new RecordingSender();
      const report = await job(store, sender, new Date(now.getTime() + 2 * 86_400_000));
      expect(report.sent).toBe(FREE_OPEN_REMINDERS);
      expect(sender.sent.map((message) => message.subject).join(" ")).not.toContain(spec.what);
    }
  }, 30_000);

  it("QA-PASS: a repeated restore says Already restored and does not rewrite the reminder", async () => {
    const store = new MemoryFillipStore();
    const live = await setReminder(store, actor, { what: "Never removed", when: "tomorrow at 9am", timezone: "UTC" }, now);
    const liveBefore = await rowOf(store, live.id);
    const already = await restoreReminder(store, actor.id, live.id, now);
    const liveAfter = await rowOf(store, live.id);
    expect(already.note).toBe("Already restored.");
    expect(already.status).toBe("active");
    expect(liveAfter.fireAt).toBe(liveBefore.fireAt);
    expect(liveAfter.status).toBe("active");
    expect(liveAfter.updatedAt).toBe(liveBefore.updatedAt);

    const created = await setReminder(store, actor, { what: "Bring back", when: "every day at 9am", timezone: "UTC" }, earlier);
    const series = await rowOf(store, created.id);
    series.fireAt = "2026-10-06T09:00:00.000Z";
    await store.saveReminder(series);
    await removeReminder(store, actor.id, created.id, now);
    const first = await restoreReminder(store, actor.id, created.id, now);
    const afterFirst = await rowOf(store, created.id);
    const second = await restoreReminder(store, actor.id, created.id, new Date(now.getTime() + 60_000));
    const afterSecond = await rowOf(store, created.id);
    expect(second.note).toBe("Already restored.");
    expect(second.id).toBe(created.id);
    expect(second.status).toBe("active");
    expect(afterSecond.fireAt).toBe(first.fireAt);
    expect(afterSecond.fireAt).toBe(afterFirst.fireAt);
    expect(afterSecond.status).toBe("active");
    expect(afterSecond.updatedAt).toBe(afterFirst.updatedAt);

    const done = await setReminder(store, actor, { what: "Done twice", when: "tomorrow at 4pm", timezone: "UTC" }, now);
    await completeOrCancel(store, actor.id, done.id, "cancel", now);
    await removeReminder(store, actor.id, done.id, now);
    const restored = await restoreReminder(store, actor.id, done.id, now);
    expect(restored.status).toBe("cancelled");
    const again = await restoreReminder(store, actor.id, done.id, now);
    expect(again.note).toBe("Already restored.");
    expect((await rowOf(store, done.id)).status).toBe("cancelled");
    expect((await rowOf(store, done.id)).fireAt).toBe(restored.fireAt);
  });

  it("QA-PASS: another user's id and an unknown id are not found, and a restore after 30 days does not write", async () => {
    const store = new MemoryFillipStore();
    const mine = await setReminder(store, actor, { what: "Mine", when: "tomorrow at 9am", timezone: "UTC" }, now);
    await completeOrCancel(store, actor.id, mine.id, "cancel", now);
    await removeReminder(store, actor.id, mine.id, now);
    const stamp = (await rowOf(store, mine.id)).removedAt;
    await expect(restoreReminder(store, other.id, mine.id, now)).rejects.toThrow(/Reminder not found/);
    await expect(removeReminder(store, other.id, mine.id, now)).rejects.toThrow(/Reminder not found/);
    await expect(restoreReminder(store, actor.id, "33333333-3333-4333-8333-333333333333", now)).rejects.toThrow(/Reminder not found/);
    const untouched = await rowOf(store, mine.id);
    expect(untouched.status).toBe("removed");
    expect(untouched.resumeStatus).toBe("cancelled");
    expect(untouched.removedAt).toBe(stamp);

    const late = await setReminder(store, actor, { what: "Too late", when: "tomorrow at 10am", timezone: "UTC" }, now);
    await completeOrCancel(store, actor.id, late.id, "cancel", now);
    const lateAt = new Date(now.getTime() - REMOVE_RETAIN_MS - 1);
    await removeReminder(store, actor.id, late.id, lateAt);
    const lateRow = await rowOf(store, late.id);
    await expect(restoreReminder(store, actor.id, late.id, now)).rejects.toThrow(/can no longer be restored/);
    const still = await rowOf(store, late.id);
    expect(still.status).toBe("removed");
    expect(still.resumeStatus).toBe("cancelled");
    expect(still.removedAt).toBe(lateRow.removedAt);
    expect(still.fireAt).toBe(lateRow.fireAt);

    const fired = await setReminder(store, actor, { what: "Fired late", when: "tomorrow at 1pm", timezone: "UTC" }, now);
    const firedRow = await rowOf(store, fired.id);
    firedRow.status = "fired";
    await store.saveReminder(firedRow);
    await removeReminder(store, actor.id, fired.id, lateAt);
    await expect(restoreReminder(store, actor.id, fired.id, now)).rejects.toThrow(/can no longer be restored/);
    expect((await rowOf(store, fired.id)).status).toBe("removed");

    const edge = await setReminder(store, actor, { what: "Edge cancelled", when: "tomorrow at 2pm", timezone: "UTC" }, now);
    await completeOrCancel(store, actor.id, edge.id, "cancel", now);
    const edgeFire = (await rowOf(store, edge.id)).fireAt;
    await removeReminder(store, actor.id, edge.id, new Date(now.getTime() - REMOVE_RETAIN_MS));
    const edgeBack = await restoreReminder(store, actor.id, edge.id, now);
    expect(edgeBack.status).toBe("cancelled");
    expect(edgeBack.fireAt).toBe(edgeFire);
    expect(edgeBack.note).toBe("Restored. It will not send.");

    const blank = await setReminder(store, actor, { what: "No prior", when: "tomorrow at 3pm", timezone: "UTC" }, now);
    await removeReminder(store, actor.id, blank.id, now);
    const blankRow = await rowOf(store, blank.id);
    blankRow.resumeStatus = null;
    await store.saveReminder(blankRow);
    await expect(restoreReminder(store, actor.id, blank.id, now)).rejects.toThrow(/can no longer be restored/);
    expect((await rowOf(store, blank.id)).status).toBe("removed");
    expect((await rowOf(store, blank.id)).resumeStatus ?? null).toBeNull();
  });
});

describe("QA round 11 purge runs before the provider check", () => {
  it("QA-PASS: the due job deletes expired removed rows before it checks the sender or calls send", async () => {
    const store = new OrderStore();
    free(store, actor);
    const expired = await setReminder(store, actor, { what: "Expired removed", when: "tomorrow at 9am", timezone: "UTC" }, earlier);
    const recent = await setReminder(store, actor, { what: "Recent removed", when: "tomorrow at 10am", timezone: "UTC" }, earlier);
    const due = await setReminder(store, actor, { what: "Still due", when: "tomorrow at 9am", timezone: "UTC" }, earlier);
    await removeReminder(store, actor.id, expired.id, new Date(now.getTime() - REMOVE_RETAIN_MS - 1000));
    await removeReminder(store, actor.id, recent.id, new Date(now.getTime() - REMOVE_RETAIN_MS + 1000));
    const exact = await setReminder(store, actor, { what: "Exact cutoff", when: "tomorrow at 11am", timezone: "UTC" }, earlier);
    await removeReminder(store, actor.id, exact.id, new Date(now.getTime() - REMOVE_RETAIN_MS));
    const sender = new RecordingSender();
    sender.order = store.order;
    await expect(job(store, sender, now, "  ")).rejects.toThrow(/Sender identity is not configured/);
    expect(store.order).toEqual(["purge"]);
    expect(sender.sent).toHaveLength(0);
    expect(store.reminders.some((item) => item.id === expired.id)).toBe(false);
    expect((await store.getReminder(actor.id, recent.id))?.status).toBe("removed");
    expect((await store.getReminder(actor.id, exact.id))?.status).toBe("removed");
    expect((await store.getReminder(actor.id, due.id))?.status).toBe("active");

    const sending = new OrderStore();
    free(sending, actor);
    const gone = await setReminder(sending, actor, { what: "Do not email removed", when: "tomorrow at 9am", timezone: "UTC" }, earlier);
    const live = await setReminder(sending, actor, { what: "Email the live one", when: "tomorrow at 9am", timezone: "UTC" }, earlier);
    await removeReminder(sending, actor.id, gone.id, new Date(now.getTime() - REMOVE_RETAIN_MS - 1000));
    const mail = new RecordingSender();
    mail.order = sending.order;
    const report = await job(sending, mail, now);
    expect(sending.order[0]).toBe("purge");
    expect(sending.order).toContain("send");
    expect(report.purged).toBe(1);
    expect(report.sent).toBe(1);
    expect(sending.reminders.some((item) => item.id === gone.id)).toBe(false);
    expect(mail.sent.map((message) => message.subject).join(" ")).toContain("Email the live one");
    expect(mail.sent.map((message) => message.subject).join(" ")).not.toContain("Do not email removed");
    expect(live.id).toBeTruthy();
  });

  it("QA-PASS: a bad bearer and a missing cron secret do not purge, and a purge error stays out of the provider response", async () => {
    const server: Server = await new Promise((resolve) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    const base = `http://127.0.0.1:${address.port}`;
    const previous = {
      SUPABASE_URL: process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      RESEND_API_KEY: process.env.RESEND_API_KEY,
      CRON_SECRET: process.env.CRON_SECRET
    };
    const calls: string[] = [];
    const original = globalThis.fetch;
    const ask = (authorization?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      const url = new URL("/internal/deliver", base);
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
    process.env.SUPABASE_URL = "https://purge.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test";
    process.env.CRON_SECRET = "purge-cron";
    delete process.env.RESEND_API_KEY;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      if (String(input).includes("qa-purge-boom")) throw new Error("qa-purge-boom-detail");
      return new Response("1", { status: 200 });
    }) as typeof fetch;
    try {
      const denied = await ask("Bearer wrong-cron");
      expect(denied.status).toBe(401);
      expect(denied.text).toContain("Delivery authorization failed.");
      expect(calls).toEqual([]);
      delete process.env.CRON_SECRET;
      const unconfigured = await ask("Bearer purge-cron");
      expect(unconfigured.status).toBe(503);
      expect(JSON.parse(unconfigured.text)).toEqual({ error: "Delivery is not configured." });
      expect(calls).toEqual([]);
      process.env.CRON_SECRET = "purge-cron";
      process.env.SUPABASE_URL = "https://qa-purge-boom.supabase.co";
      const failed = await ask("Bearer purge-cron");
      expect(failed.status).toBe(503);
      expect(JSON.parse(failed.text)).toEqual({ error: "Email provider is not configured." });
      expect(failed.text).not.toContain("qa-purge-boom-detail");
      expect(calls.some((call) => call.includes("qa-purge-boom"))).toBe(true);
      expect(calls.some((call) => call.includes("api.resend.com"))).toBe(false);
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

describe("QA round 11 Postgres prior status and cap", () => {
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

  it("QA-PASS: fired, completed, and cancelled can be stored and restored at a full open cap", async () => {
    const definition = await db.query<{ def: string }>(
      "select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'reminders_resume_status_check'"
    );
    expect(definition.rows[0]?.def ?? "").toContain("fired");
    expect(definition.rows[0]?.def ?? "").toContain("completed");
    expect(definition.rows[0]?.def ?? "").toContain("cancelled");
    await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [actor.id]);
    await expect(db.query(
      `insert into public.reminders
        (id, owner_id, kind, what, timezone, fire_at, status, removed_at, resume_status)
       values ($1, $2, 'reminder', 'bad prior', 'UTC', now() + interval '1 day', 'removed', now(), 'removed')`,
      [randomUUID(), actor.id]
    )).rejects.toThrow(/reminders_resume_status_check|check constraint/);

    const owner = randomUUID();
    await db.query("insert into auth.users (id) values ($1)", [owner]);
    await db.query(
      "insert into public.profiles (id, plan, subscription_status) values ($1, 'free', 'none') on conflict (id) do update set plan = 'free', subscription_status = 'none'",
      [owner]
    );
    await db.query(
      `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
       select gen_random_uuid(), $1, 'reminder', 'open ' || g, 'UTC', now() + interval '1 day', 'active'
       from generate_series(1, 10) g`,
      [owner]
    );
    for (const status of ["fired", "completed", "cancelled", "paused"] as const) {
      const id = randomUUID();
      const fireAt = "2026-10-01T15:00:00.000Z";
      await db.query(
        `insert into public.reminders
          (id, owner_id, kind, what, timezone, fire_at, status, removed_at, resume_status, completed_at)
         values ($1, $2, 'reminder', $3, 'UTC', $4, 'removed', now(), $5, $6)`,
        [id, owner, status, fireAt, status, status === "completed" ? now.toISOString() : null]
      );
      await db.query(
        "update public.reminders set status = $2, removed_at = null, resume_status = null where id = $1",
        [id, status]
      );
      const saved = await db.query<{ status: string; fire_at: Date }>(
        "select status, fire_at from public.reminders where id = $1",
        [id]
      );
      expect(saved.rows[0]?.status).toBe(status);
      expect(new Date(saved.rows[0]?.fire_at ?? 0).toISOString()).toBe(fireAt);
      expect((await db.query<{ ok: boolean }>(
        "select public.fillip_claim_sendable($1::uuid, $2::uuid) as ok",
        [owner, id]
      )).rows[0]?.ok).toBe(false);
    }
    expect(Number((await db.query<{ n: number }>(
      "select count(*)::int as n from public.reminders where owner_id = $1 and status = 'active'",
      [owner]
    )).rows[0]?.n)).toBe(10);

    const activeId = randomUUID();
    await db.query(
      `insert into public.reminders
        (id, owner_id, kind, what, timezone, fire_at, status, removed_at, resume_status)
       values ($1, $2, 'reminder', 'would be active', 'UTC', now() + interval '1 day', 'removed', now(), 'active')`,
      [activeId, owner]
    );
    await expect(db.query(
      "update public.reminders set status = 'active', removed_at = null, resume_status = null where id = $1",
      [activeId]
    )).rejects.toThrow(/The free plan allows 10 open reminders/);
    const kept = await db.query<{ status: string }>("select status from public.reminders where id = $1", [activeId]);
    expect(kept.rows[0]?.status).toBe("removed");
    expect(Number((await db.query<{ n: number }>(
      "select count(*)::int as n from public.reminders where owner_id = $1 and status = 'active'",
      [owner]
    )).rows[0]?.n)).toBe(10);
  });
});

describe("QA round 11 regression", () => {
  it("QA-PASS: copy still names the 30-day purge and immediate deletion, and nothing is skipped", () => {
    const readme = readFileSync("README.md", "utf8");
    const privacy = readFileSync("src/public-pages.ts", "utf8");
    const tools = readFileSync("src/fillip-tools.ts", "utf8");
    expect(tools).toContain(restoreDescription);
    expect(readme).toContain("runs `fillip_purge_removed` before it checks the email provider");
    expect(readme).toContain("deletes removed reminders older than 30 days and their deliveries.");
    expect(readme).toContain("account deletion, still remove those rows immediately.");
    expect(readme).toContain("in the exact status it had before");
    expect(privacy).toContain("Fillip keeps that reminder and its delivery records for 30 days so it can be restored, then deletes them.");
    expect(privacy).toContain("Export or delete your reminders</a> removes them immediately.");
    expect(privacy).toContain("Ask support to delete the account, which removes them immediately.");
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
