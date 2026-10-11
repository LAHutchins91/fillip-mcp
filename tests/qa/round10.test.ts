/**
 * QA round 10 against dda2ed4.
 * Remove, restore, and purge cases use Postgres 16 with supabase/schema.sql applied.
 * QA-FAIL tests assert the behavior a user was promised and fail on this build.
 */
import http, { type IncomingMessage, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { app } from "../../src/server.js";
import { CODE_LOCKED } from "../../src/code-auth.js";
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
import { OpenCapError, type Db } from "../../src/lib/store.js";
import { SupabaseFillipStore } from "../../src/lib/supabase-store.js";
import { nextFire } from "../../src/lib/time.js";
import type { Actor } from "../../src/lib/types.js";
import { blankContact, FREE_OPEN_REMINDERS, freeOpenMessage } from "../../src/lib/usage.js";
import { pkceSecretProblem } from "../../src/plugin-auth.js";

const now = new Date("2026-10-11T16:00:00.000Z");
const earlier = new Date("2026-10-10T16:00:00.000Z");
const actor: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", emailVerified: true };
const other: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.com", emailVerified: true };
const database = "fillip_round10";
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

function job(store: MemoryFillipStore, sender: RecordingSender, at: Date) {
  return runDueJob({
    store,
    sender,
    now: at,
    from: "Fillip <reminders@example.com>",
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

class RemoveAfterGrantedClaim extends MemoryFillipStore {
  removedBeforeSend = false;
  override async claimDelivery(input: Parameters<MemoryFillipStore["claimDelivery"]>[0]) {
    const result = await super.claimDelivery(input);
    if (result.outcome === "send" && input.reminderId) {
      const row = this.reminders.find((item) => item.id === input.reminderId && item.ownerId === input.ownerId);
      if (row?.status === "active") {
        row.status = "removed";
        row.resumeStatus = "active";
        row.removedAt = now.toISOString();
        row.holdUntil = null;
        this.removedBeforeSend = true;
      }
    }
    return result;
  }
}

describe("QA round 10 remove, restore, and purge", () => {
  it("QA-PASS: a second claim and the due job withhold a reminder removed after the first claim", async () => {
    const store = new MemoryFillipStore();
    const created = await setReminder(store, actor, { what: "Ship the note", when: "tomorrow at 9am", timezone: "UTC" }, earlier);
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing reminder");
    const claim = {
      ownerId: actor.id,
      reminderId: row.id,
      dedupeKey: `reminder:${row.id}:${row.fireAt}:email`,
      occurrenceAt: row.fireAt,
      idempotencyKey: `fillip/${row.id}/${row.fireAt}`,
      channel: "email" as const,
      nowIso: now.toISOString(),
      staleBeforeIso: new Date(now.getTime() - 120_000).toISOString()
    };
    expect((await store.claimDelivery(claim)).outcome).toBe("send");
    await removeReminder(store, actor.id, row.id, now);
    expect((await store.claimDelivery(claim)).outcome).toBe("withheld");
    const sender = new RecordingSender();
    const report = await job(store, sender, now);
    expect(report.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(store.deliveries.some((item) => item.reminderId === row.id && item.status === "sent")).toBe(false);
  });

  it("QA-FAIL: a claim that already returned send does not email after the reminder is removed", async () => {
    const store = new RemoveAfterGrantedClaim();
    const created = await setReminder(store, actor, { what: "Do not send this", when: "tomorrow at 9am", timezone: "UTC" }, earlier);
    const sender = new RecordingSender();
    const report = await job(store, sender, now);
    expect(store.removedBeforeSend).toBe(true);
    expect((await store.getReminder(actor.id, created.id))?.status).toBe("removed");
    expect(report.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
    expect(sender.sent.map((message) => message.subject).join(" ")).not.toContain("Do not send this");
  });

  it("QA-PASS: claimDelivery re-checks sendability after inserting the delivery row", async () => {
    let checks = 0;
    const db: Db = async (pathname, options) => {
      if (pathname.includes("/rpc/fillip_claim_sendable")) {
        checks += 1;
        return checks === 1;
      }
      if (pathname.startsWith("/rest/v1/deliveries") && (options?.method ?? "GET") === "POST") {
        return [JSON.parse(String(options?.body ?? "{}"))];
      }
      return [];
    };
    const store = new SupabaseFillipStore(null, db, "service");
    const claim = await store.claimDelivery({
      ownerId: actor.id,
      reminderId: "33333333-3333-4333-8333-333333333333",
      dedupeKey: "recheck",
      occurrenceAt: now.toISOString(),
      idempotencyKey: "fillip/recheck",
      channel: "email",
      nowIso: now.toISOString(),
      staleBeforeIso: new Date(now.getTime() - 120_000).toISOString()
    });
    expect(checks).toBe(2);
    expect(claim.outcome).toBe("withheld");
  });

  it("QA-PASS: restore keeps the id, skips missed repeats, and refuses a past one-time without writing", async () => {
    const store = new MemoryFillipStore();
    const future = await setReminder(store, actor, { what: "Future", when: "tomorrow at 9am", timezone: "UTC" }, now);
    await removeReminder(store, actor.id, future.id, now);
    const brought = await restoreReminder(store, actor.id, future.id, now);
    expect(brought.id).toBe(future.id);
    expect(brought.status).toBe("active");
    expect(brought.fireAt).toBe(future.fireAt);
    expect((await store.getReminder(actor.id, future.id))?.removedAt ?? null).toBeNull();

    const seriesStore = new MemoryFillipStore();
    const series = await setReminder(seriesStore, actor, { what: "Daily", when: "every day at 9am", timezone: "UTC" }, earlier);
    const daily = await seriesStore.getReminder(actor.id, series.id);
    if (!daily?.recurrence) throw new Error("missing series");
    daily.fireAt = "2026-10-06T09:00:00.000Z";
    await seriesStore.saveReminder(daily);
    await removeReminder(seriesStore, actor.id, daily.id, now);
    const restored = await restoreReminder(seriesStore, actor.id, daily.id, now);
    const upcoming = nextFire(daily.recurrence, "UTC", now);
    if (!upcoming) throw new Error("missing next fire");
    expect(restored.id).toBe(daily.id);
    expect(restored.fireAt).toBe(upcoming.toISOString());
    expect(upcoming.getTime() - now.getTime()).toBeGreaterThan(0);
    expect(upcoming.getTime() - now.getTime()).toBeLessThan(24 * 60 * 60 * 1000);
    const sender = new RecordingSender();
    expect((await job(seriesStore, sender, now)).sent).toBe(0);
    expect((await job(seriesStore, sender, upcoming)).sent).toBe(1);
    expect(sender.sent).toHaveLength(1);

    const pausedStore = new MemoryFillipStore();
    const paused = await setReminder(pausedStore, actor, { what: "Paused", when: "tomorrow at 3pm", timezone: "UTC" }, now);
    await snoozeOrReschedule(pausedStore, actor.id, paused.id, undefined, "UTC", now, "pause");
    const pausedRow = await pausedStore.getReminder(actor.id, paused.id);
    if (!pausedRow) throw new Error("missing paused");
    pausedRow.fireAt = "2026-10-01T15:00:00.000Z";
    await pausedStore.saveReminder(pausedRow);
    await removeReminder(pausedStore, actor.id, paused.id, now);
    const back = await restoreReminder(pausedStore, actor.id, paused.id, now);
    expect(back.id).toBe(paused.id);
    expect(back.status).toBe("paused");
    expect(back.fireAt).toBe("2026-10-01T15:00:00.000Z");
    const pausedSender = new RecordingSender();
    expect((await job(pausedStore, pausedSender, new Date(now.getTime() + 2 * 86_400_000))).sent).toBe(0);

    const once = await setReminder(store, actor, { what: "Once", when: "tomorrow at 11am", timezone: "UTC" }, now);
    await removeReminder(store, actor.id, once.id, now);
    const removed = await store.getReminder(actor.id, once.id);
    if (!removed) throw new Error("missing once");
    const stamp = removed.removedAt;
    removed.fireAt = "2026-10-01T15:00:00.000Z";
    await store.saveReminder(removed);
    await expect(restoreReminder(store, actor.id, once.id, now)).rejects.toThrow(/already in the past/);
    const kept = await store.getReminder(actor.id, once.id);
    expect(kept?.status).toBe("removed");
    expect(kept?.removedAt).toBe(stamp);
    expect(kept?.fireAt).toBe("2026-10-01T15:00:00.000Z");
  });

  it("QA-PASS: restore works at exactly 30 days, refuses a millisecond later, and does not write at the open cap", async () => {
    const store = new MemoryFillipStore();
    free(store, actor);
    const edge = await setReminder(store, actor, { what: "Edge", when: "tomorrow at 9am", timezone: "UTC" }, now);
    const removedAt = new Date(now.getTime() - REMOVE_RETAIN_MS);
    await removeReminder(store, actor.id, edge.id, removedAt);
    const restored = await restoreReminder(store, actor.id, edge.id, now);
    expect(restored.id).toBe(edge.id);
    expect(restored.status).toBe("active");

    const late = await setReminder(store, actor, { what: "Late", when: "tomorrow at 10am", timezone: "UTC" }, now);
    const lateAt = new Date(now.getTime() - REMOVE_RETAIN_MS - 1);
    await removeReminder(store, actor.id, late.id, lateAt);
    const lateStamp = (await store.getReminder(actor.id, late.id))?.removedAt;
    await expect(restoreReminder(store, actor.id, late.id, now)).rejects.toThrow(/can no longer be restored/);
    expect((await store.getReminder(actor.id, late.id))?.status).toBe("removed");
    expect((await store.getReminder(actor.id, late.id))?.removedAt).toBe(lateStamp);

    const paused = await setReminder(store, actor, { what: "Paused cap", when: "tomorrow at 1pm", timezone: "UTC" }, now);
    await snoozeOrReschedule(store, actor.id, paused.id, undefined, "UTC", now, "pause");
    await removeReminder(store, actor.id, paused.id, now);
    const held = await setReminder(store, actor, { what: "Held", when: "tomorrow at 11am", timezone: "UTC" }, now);
    await removeReminder(store, actor.id, held.id, now);
    const heldStamp = (await store.getReminder(actor.id, held.id))?.removedAt;
    for (let index = 0; index < FREE_OPEN_REMINDERS - 1; index += 1) {
      await setReminder(store, actor, { what: `Open ${index}`, when: "tomorrow at 9am", timezone: "UTC" }, now);
    }
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
    await expect(restoreReminder(store, actor.id, held.id, now)).rejects.toBeInstanceOf(OpenCapError);
    await expect(restoreReminder(store, actor.id, held.id, now)).rejects.toThrow(freeOpenMessage(FREE_OPEN_REMINDERS));
    const afterCap = await store.getReminder(actor.id, held.id);
    expect(afterCap?.status).toBe("removed");
    expect(afterCap?.removedAt).toBe(heldStamp);
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);

    const pausedBack = await restoreReminder(store, actor.id, paused.id, now);
    expect(pausedBack.id).toBe(paused.id);
    expect(pausedBack.status).toBe("paused");
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
  });

  it("QA-FAIL: restore returns the reminder to the status it had before it was removed", async () => {
    const store = new MemoryFillipStore();
    const holes: string[] = [];
    const specs = [
      { what: "QA prior cancelled", status: "cancelled" as const, action: "cancel" as const },
      { what: "QA prior completed", status: "completed" as const, action: "complete" as const },
      { what: "QA prior paused", status: "paused" as const, action: "pause" as const },
      { what: "QA prior active", status: "active" as const, action: "active" as const }
    ];
    for (const spec of specs) {
      const created = await setReminder(store, actor, { what: spec.what, when: "tomorrow at 9am", timezone: "UTC" }, now);
      if (spec.action === "cancel" || spec.action === "complete") {
        await completeOrCancel(store, actor.id, created.id, spec.action, now);
      }
      if (spec.action === "pause") await snoozeOrReschedule(store, actor.id, created.id, undefined, "UTC", now, "pause");
      const before = await store.getReminder(actor.id, created.id);
      if (before?.status !== spec.status) holes.push(`${spec.what} was ${before?.status ?? "missing"} before remove`);
      await removeReminder(store, actor.id, created.id, now);
      const restored = await restoreReminder(store, actor.id, created.id, now);
      const row = await store.getReminder(actor.id, created.id);
      if (restored.id !== created.id || restored.status !== spec.status || row?.status !== spec.status) {
        holes.push(`${spec.what} came back ${restored.status} (stored ${row?.status ?? "missing"})`);
      }
    }
    await store.setCalendarToken(actor.id, "prior-status-calendar-123456");
    const feed = (await renderCalendarFeed(store, "prior-status-calendar-123456", now)) ?? "";
    if (feed.includes("QA prior cancelled")) holes.push("a restored cancellation is on the calendar");
    if (feed.includes("QA prior completed")) holes.push("a restored completion is on the calendar");
    if (feed.includes("QA prior paused")) holes.push("a restored pause is on the calendar");
    if (!feed.includes("QA prior active")) holes.push("a restored active reminder is missing from the calendar");
    const listed = await listReminders(store, actor.id, {}, now);
    const doneShown = ["QA prior cancelled", "QA prior completed"].filter((what) => listed.some((item) => item.what === what));
    if (doneShown.length) holes.push(`the default list shows a restored done reminder: ${doneShown.join(", ")}`);
    expect(holes).toEqual([]);
  });

  it("QA-FAIL: restoring a cancelled, completed, or paused reminder does not use the open cap", async () => {
    const store = new MemoryFillipStore();
    free(store, actor);
    const ids: Record<"cancelled" | "completed" | "paused" | "active", string> = {
      cancelled: "",
      completed: "",
      paused: "",
      active: ""
    };
    for (const spec of ["cancelled", "completed", "paused", "active"] as const) {
      const created = await setReminder(store, actor, { what: `Cap ${spec}`, when: "tomorrow at 9am", timezone: "UTC" }, now);
      ids[spec] = created.id;
      if (spec === "cancelled" || spec === "completed") {
        await completeOrCancel(store, actor.id, created.id, spec === "cancelled" ? "cancel" : "complete", now);
      }
      if (spec === "paused") await snoozeOrReschedule(store, actor.id, created.id, undefined, "UTC", now, "pause");
      await removeReminder(store, actor.id, created.id, now);
    }
    for (let index = 0; index < FREE_OPEN_REMINDERS; index += 1) {
      await setReminder(store, actor, { what: `Cap filler ${index}`, when: "tomorrow at 9am", timezone: "UTC" }, now);
    }
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
    const holes: string[] = [];
    for (const spec of ["cancelled", "completed", "paused"] as const) {
      try {
        const restored = await restoreReminder(store, actor.id, ids[spec], now);
        const row = await store.getReminder(actor.id, ids[spec]);
        if (restored.status !== spec || row?.status !== spec) holes.push(`${spec} came back ${restored.status}`);
        const open = await store.countActive(actor.id);
        if (open !== FREE_OPEN_REMINDERS) holes.push(`${spec} changed the open count to ${open}`);
      } catch (error) {
        holes.push(`${spec} was refused at the cap: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let activeRefused = false;
    try {
      await restoreReminder(store, actor.id, ids.active, now);
    } catch (error) {
      activeRefused = error instanceof OpenCapError;
      if (!activeRefused) holes.push(`active restore threw ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!activeRefused) holes.push("active restore succeeded while the open cap was full");
    const activeRow = await store.getReminder(actor.id, ids.active);
    if (activeRow?.status !== "removed") holes.push(`active row is ${activeRow?.status ?? "missing"} after the cap refusal`);
    if ((await store.countActive(actor.id)) !== FREE_OPEN_REMINDERS) holes.push("the open count changed");
    expect(holes).toEqual([]);
  });

  it("QA-PASS: removed reminders stay off the list and the calendar, and another user cannot remove or restore them", async () => {
    const store = new MemoryFillipStore();
    const mine = await setReminder(store, actor, { what: "Mine hidden", when: "tomorrow at 9am", timezone: "UTC" }, now);
    const live = await setReminder(store, actor, { what: "Mine visible", when: "tomorrow at 10am", timezone: "UTC" }, now);
    const theirs = await setReminder(store, other, { what: "Theirs", when: "tomorrow at 11am", timezone: "UTC" }, now);
    const firstRemoved = (await store.getReminder(actor.id, mine.id))?.updatedAt;
    await removeReminder(store, actor.id, mine.id, now);
    const stamp = (await store.getReminder(actor.id, mine.id))?.removedAt;
    await removeReminder(store, actor.id, mine.id, new Date(now.getTime() + 60_000));
    expect((await store.getReminder(actor.id, mine.id))?.removedAt).toBe(stamp);
    expect(firstRemoved).toBeTruthy();
    await expect(removeReminder(store, other.id, mine.id, now)).rejects.toThrow(/Reminder not found/);
    await expect(restoreReminder(store, other.id, mine.id, now)).rejects.toThrow(/Reminder not found/);
    expect((await store.getReminder(actor.id, mine.id))?.status).toBe("removed");
    const listed = await listReminders(store, actor.id, { status: "all", includeDone: true }, now);
    expect(listed.map((item) => item.id)).toEqual([live.id]);
    const asked = await listReminders(store, actor.id, { status: "removed" }, now);
    expect(asked).toEqual([]);
    const otherList = await listReminders(store, other.id, { status: "all", includeDone: true }, now);
    expect(otherList.map((item) => item.id)).toEqual([theirs.id]);
    await store.setCalendarToken(actor.id, "owner-calendar-token-123456");
    await store.setCalendarToken(other.id, "other-calendar-token-123456");
    const feed = await renderCalendarFeed(store, "owner-calendar-token-123456", now);
    expect(feed ?? "").toContain("Mine visible");
    expect(feed ?? "").not.toContain("Mine hidden");
    expect(feed ?? "").not.toContain("Theirs");
    const otherFeed = await renderCalendarFeed(store, "other-calendar-token-123456", now);
    expect(otherFeed ?? "").toContain("Theirs");
    expect(otherFeed ?? "").not.toContain("Mine hidden");
    expect(otherFeed ?? "").not.toContain("Mine visible");
  });
});

describe("QA round 10 Postgres claim, purge, cap, and isolation", () => {
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
    await db.query("insert into auth.users (id) values ($1), ($2) on conflict do nothing", [actor.id, other.id]);
    await db.query(
      "insert into public.profiles (id, plan, subscription_status) values ($1, 'free', 'none'), ($2, 'free', 'none') on conflict do nothing",
      [actor.id, other.id]
    );
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

  async function insertReminder(patch: {
    id?: string;
    ownerId?: string;
    what?: string;
    status?: string;
    fireAt?: string;
    removedAt?: string | null;
    resumeStatus?: string | null;
  }) {
    const id = patch.id ?? randomUUID();
    await db.query(
      `insert into public.reminders
        (id, owner_id, kind, what, timezone, fire_at, status, removed_at, resume_status)
       values ($1, $2, 'reminder', $3, 'UTC', $4, $5, $6, $7)`,
      [
        id,
        patch.ownerId ?? actor.id,
        patch.what ?? "row",
        patch.fireAt ?? "2026-10-12T15:00:00.000Z",
        patch.status ?? "active",
        patch.removedAt ?? null,
        patch.resumeStatus ?? null
      ]
    );
    return id;
  }

  it("QA-PASS: fillip_claim_sendable is true only for the owner's active row and is false after removal", async () => {
    const id = await insertReminder({ what: "Claim me" });
    const paused = await insertReminder({ what: "Paused", status: "paused" });
    const done = await insertReminder({ what: "Done", status: "completed" });
    const missing = randomUUID();
    const claim = (reminder: string, owner = actor.id) => db.query<{ ok: boolean }>(
      "select public.fillip_claim_sendable($1::uuid, $2::uuid) as ok",
      [owner, reminder]
    );
    expect((await claim(id)).rows[0]?.ok).toBe(true);
    expect((await claim(id, other.id)).rows[0]?.ok).toBe(false);
    expect((await claim(paused)).rows[0]?.ok).toBe(false);
    expect((await claim(done)).rows[0]?.ok).toBe(false);
    expect((await claim(missing)).rows[0]?.ok).toBe(false);
    await db.query(
      "update public.reminders set status = 'removed', removed_at = $2, resume_status = 'active' where id = $1",
      [id, "2026-10-11T16:00:00.000Z"]
    );
    expect((await claim(id)).rows[0]?.ok).toBe(false);
  });

  it("QA-PASS: fillip_purge_removed deletes only rows removed before the cutoff, and a concurrent second call is safe", async () => {
    const cutoff = new Date(now.getTime() - REMOVE_RETAIN_MS).toISOString();
    const expired = await insertReminder({
      what: "Expired",
      status: "removed",
      removedAt: new Date(now.getTime() - REMOVE_RETAIN_MS - 1000).toISOString(),
      resumeStatus: "active"
    });
    const otherExpired = await insertReminder({
      ownerId: other.id,
      what: "Other expired",
      status: "removed",
      removedAt: new Date(now.getTime() - REMOVE_RETAIN_MS - 86_400_000).toISOString(),
      resumeStatus: "active"
    });
    const exact = await insertReminder({
      what: "Exact cutoff",
      status: "removed",
      removedAt: cutoff,
      resumeStatus: "active"
    });
    const recent = await insertReminder({
      what: "Recent",
      status: "removed",
      removedAt: new Date(now.getTime() - REMOVE_RETAIN_MS + 1000).toISOString(),
      resumeStatus: "paused"
    });
    const live = await insertReminder({ what: "Live", status: "active", removedAt: new Date(now.getTime() - REMOVE_RETAIN_MS - 86_400_000).toISOString() });
    const paused = await insertReminder({ what: "Still paused", status: "paused" });
    const blank = await insertReminder({ what: "No stamp", status: "removed", removedAt: null, resumeStatus: "active" });
    const ids = [expired, otherExpired, exact, recent, live, paused, blank];
    for (const id of [expired, otherExpired, recent, live]) {
      await db.query(
        `insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key)
         values ($1, $2, $3, $4, now(), 'sent', $5)`,
        [randomUUID(), id === otherExpired ? other.id : actor.id, id, `delivery-${id}`, `key-${id}`]
      );
    }
    await db.query(
      `insert into public.deliveries (id, owner_id, reminder_id, dedupe_key, occurrence_at, status, idempotency_key)
       values ($1, $2, null, 'digest-round10', now(), 'sent', 'digest-round10-key')`,
      [randomUUID(), actor.id]
    );

    const left = pgClient();
    const right = pgClient();
    await left.connect();
    await right.connect();
    try {
      const raced = await Promise.allSettled([
        left.query<{ n: number }>("select public.fillip_purge_removed($1::timestamptz) as n", [cutoff]),
        right.query<{ n: number }>("select public.fillip_purge_removed($1::timestamptz) as n", [cutoff])
      ]);
      expect(raced.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"]);
      const counts = raced.map((item) => item.status === "fulfilled" ? Number(item.value.rows[0]?.n ?? 0) : -1);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(2);
      const again = await db.query<{ n: number }>("select public.fillip_purge_removed($1::timestamptz) as n", [cutoff]);
      expect(Number(again.rows[0]?.n)).toBe(0);
    } finally {
      await left.end();
      await right.end();
    }

    const leftRows = await db.query<{ id: string; status: string }>(
      "select id, status from public.reminders where id = any($1::uuid[]) order by what",
      [ids]
    );
    expect(leftRows.rows.map((row) => row.id).sort()).toEqual([exact, recent, live, paused, blank].sort());
    expect(leftRows.rows.find((row) => row.id === live)?.status).toBe("active");
    expect(leftRows.rows.find((row) => row.id === exact)?.status).toBe("removed");
    const deliveries = await db.query<{ dedupe_key: string }>(
      "select dedupe_key from public.deliveries where dedupe_key = any($1::text[]) order by dedupe_key",
      [[`delivery-${expired}`, `delivery-${otherExpired}`, `delivery-${recent}`, `delivery-${live}`, "digest-round10"]]
    );
    expect(deliveries.rows.map((row) => row.dedupe_key).sort()).toEqual([
      `delivery-${live}`,
      `delivery-${recent}`,
      "digest-round10"
    ].sort());
  });

  it("QA-PASS: restoring into a full free cap rolls back, and user B cannot see or change A's reminder", async () => {
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
    const removedId = randomUUID();
    const removedAt = now.toISOString();
    await db.query(
      `insert into public.reminders
        (id, owner_id, kind, what, timezone, fire_at, status, removed_at, resume_status)
       values ($1, $2, 'reminder', 'restore me', 'UTC', now() + interval '1 day', 'removed', $3, 'active')`,
      [removedId, owner, removedAt]
    );
    await expect(db.query(
      "update public.reminders set status = 'active', removed_at = null, resume_status = null where id = $1",
      [removedId]
    )).rejects.toThrow(/The free plan allows 10 open reminders/);
    const kept = await db.query<{ status: string; removed_at: Date }>(
      "select status, removed_at from public.reminders where id = $1",
      [removedId]
    );
    expect(kept.rows[0]?.status).toBe("removed");
    expect(new Date(kept.rows[0]?.removed_at ?? 0).toISOString()).toBe(removedAt);
    expect(Number((await db.query<{ n: number }>(
      "select count(*)::int as n from public.reminders where owner_id = $1 and status = 'active'",
      [owner]
    )).rows[0]?.n)).toBe(10);

    const pausedId = randomUUID();
    await db.query(
      `insert into public.reminders
        (id, owner_id, kind, what, timezone, fire_at, status, removed_at, resume_status)
       values ($1, $2, 'reminder', 'paused restore', 'UTC', now() + interval '1 day', 'removed', now(), 'paused')`,
      [pausedId, owner]
    );
    await db.query("update public.reminders set status = 'paused', removed_at = null, resume_status = null where id = $1", [pausedId]);
    const pausedRow = await db.query<{ status: string }>("select status from public.reminders where id = $1", [pausedId]);
    expect(pausedRow.rows[0]?.status).toBe("paused");
    expect(Number((await db.query<{ n: number }>(
      "select count(*)::int as n from public.reminders where owner_id = $1 and status = 'active'",
      [owner]
    )).rows[0]?.n)).toBe(10);

    const secret = await insertReminder({ ownerId: actor.id, what: "A secret" });
    const asB = pgClient();
    await asB.connect();
    try {
      await asB.query("select set_config('request.jwt.claim.sub', $1, false)", [other.id]);
      await asB.query("set role authenticated");
      const seen = await asB.query("select id from public.reminders where id = $1", [secret]);
      expect(seen.rowCount).toBe(0);
      await expect(asB.query("update public.reminders set status = 'removed' where id = $1", [secret])).rejects.toThrow(/permission denied|42501/);
      const deleted = await asB.query("delete from public.reminders where id = $1", [secret]);
      expect(deleted.rowCount).toBe(0);
      await expect(asB.query("select public.fillip_purge_removed(now())")).rejects.toThrow(/permission denied|42501/);
      await expect(asB.query("select public.fillip_claim_sendable($1::uuid, $2::uuid)", [actor.id, secret])).rejects.toThrow(/permission denied|42501/);
    } finally {
      await asB.query("reset role").catch(() => undefined);
      await asB.end();
    }
    const still = await db.query<{ status: string }>("select status from public.reminders where id = $1", [secret]);
    expect(still.rows[0]?.status).toBe("active");
  });
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function request(base: string, method: string, pathname: string, body: string, headers: Record<string, string> = {}) {
  const url = new URL(pathname, base);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...headers, "content-length": Buffer.byteLength(body) }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function jwt(claims: Record<string, unknown>): string {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

describe("QA round 10 sign-out, lock copy, and tool text", () => {
  let stub: Server;
  let fillip: Server;
  let base = "";
  const logouts: string[] = [];
  const saved = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  const mcp = jwt({ client_id: "client-1", aud: "https://fillip.example/mcp", sub: "user-1" });
  const audOnly = jwt({ aud: ["https://fillip.example/mcp/"], sub: "user-1" });
  const session = jwt({ aud: "authenticated", sub: "user-1" });
  const badMcp = jwt({ client_id: "client-1", aud: "https://fillip.example/mcp", sub: "nobody" });

  beforeAll(async () => {
    stub = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      await readBody(req);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (url.startsWith("/auth/v1/user/oauth/grants")) {
        if ((req.headers.authorization ?? "") === `Bearer ${session}`) return send(200, []);
        return send(401, { msg: "upstream-grant-detail" });
      }
      if (req.method === "POST" && url.startsWith("/auth/v1/logout")) {
        logouts.push(req.headers.authorization ?? "");
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.startsWith("/auth/v1/user")) {
        const header = req.headers.authorization ?? "";
        if (header === `Bearer ${mcp}` || header === `Bearer ${audOnly}` || header === `Bearer ${session}`) {
          return send(200, { id: "user-1", email: "owner@example.com", msg: "upstream-user-detail" });
        }
        return send(401, { message: "bad-upstream-detail" });
      }
      send(404, { msg: "missing" });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
    const stubAddress = stub.address();
    if (!stubAddress || typeof stubAddress === "string") throw new Error("No stub port");
    process.env.APP_BASE_URL = "https://fillip.example";
    process.env.SUPABASE_URL = `http://127.0.0.1:${stubAddress.port}`;
    process.env.SUPABASE_ANON_KEY = "anon-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
    await new Promise<void>((resolve) => {
      fillip = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fillip.address();
    if (!address || typeof address === "string") throw new Error("No app port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => fillip.close((error) => (error ? reject(error) : resolve())));
  });

  function post(token?: string) {
    return request(base, "POST", "/auth/sign-out-everywhere", "{}", {
      "content-type": "application/json",
      "x-fillip-request": "1",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    });
  }

  it("QA-PASS: sign-out-everywhere is 401 for a bad bearer and 403 for an MCP token", async () => {
    logouts.length = 0;
    const missing = await post();
    expect(missing.status).toBe(401);
    expect(JSON.parse(missing.text).message).toBe("Authentication required.");
    const bad = await post("nope");
    expect(bad.status).toBe(401);
    expect(JSON.parse(bad.text).message).toBe("Authentication required.");
    expect(bad.text).not.toContain("bad-upstream-detail");
    const forged = await post(badMcp);
    expect(forged.status).toBe(401);
    expect(forged.text).not.toContain("bad-upstream-detail");
    const client = await post(mcp);
    expect(client.status).toBe(403);
    expect(client.text).not.toContain("upstream-user-detail");
    expect(client.text).not.toContain(mcp);
    expect(client.text).not.toContain("gotrue");
    const audience = await post(audOnly);
    expect(audience.status).toBe(403);
    expect(audience.text).not.toContain("upstream-user-detail");
    expect(logouts).toEqual([]);
    const signedOut = await post(session);
    expect(signedOut.status).toBe(200);
    expect(logouts).toEqual([`Bearer ${session}`]);
  });

  it("QA-PASS: remove and restore annotations match the 30-day restore, and the lock text does not promise a new code", async () => {
    const listed = await request(base, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    });
    expect(listed.status).toBe(200);
    const body = JSON.parse(listed.text) as { result?: { tools?: Array<{ name: string; description?: string; annotations?: { destructiveHint?: boolean; idempotentHint?: boolean; readOnlyHint?: boolean } }> } };
    const tools = body.result?.tools ?? [];
    const remove = tools.find((tool) => tool.name === "remove_reminder");
    const restore = tools.find((tool) => tool.name === "restore_reminder");
    expect(remove?.description).toBe("Stops a reminder and removes it from the user's list. It can be restored for 30 days.");
    expect(remove?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(restore?.description).toBe("Restores a reminder removed in the last 30 days. The same id comes back, paused if it was paused, and the next time is recomputed when the old one has passed.");
    expect(restore?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true });
    expect(CODE_LOCKED).toBe("Too many tries. Try again in 15 minutes, or sign in with your password.");
    expect(CODE_LOCKED).not.toMatch(/new code|request a new/i);
    for (const file of ["README.md", "src/code-auth.ts", "src/public-pages.ts", "src/plugin-auth.ts", "supabase/README-oauth.md"]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/Request a new one/);
      expect(text).not.toMatch(/new code clears the lock/i);
    }
    expect(readFileSync("README.md", "utf8")).toContain("A new send does not clear that lock.");
  });
});

const booted: ChildProcess[] = [];

function boot(overrides: Record<string, string | undefined>): Promise<{ code: number | null; output: string; listened: boolean }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: "0",
      FILLIP_UNSUBSCRIBE_SECRET: "unsubscribe-secret-not-a-pkce-key",
      CRON_SECRET: "cron-secret-not-a-pkce-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-not-a-pkce-key",
      SUPABASE_ANON_KEY: "anon-key-not-a-pkce-key",
      ...overrides
    };
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete env[key];
    }
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    booted.push(child);
    let output = "";
    let listened = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, listened });
    };
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Fillip listening")) {
        listened = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => finish(code));
    child.on("error", (error) => {
      output += String(error);
      finish(1);
    });
  });
}

describe("QA round 10 production PKCE secret", () => {
  const previous = {
    NODE_ENV: process.env.NODE_ENV,
    VERCEL_ENV: process.env.VERCEL_ENV,
    FILLIP_PKCE_SECRET: process.env.FILLIP_PKCE_SECRET,
    FILLIP_LOCKOUT_SECRET: process.env.FILLIP_LOCKOUT_SECRET
  };

  afterAll(() => {
    for (const child of booted) child.kill("SIGKILL");
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("QA-PASS: production refuses to start without a 32-character FILLIP_PKCE_SECRET and does not fall back", async () => {
    const plugin = readFileSync("src/plugin-auth.ts", "utf8");
    const pkceFn = plugin.slice(plugin.indexOf("function pkceSecret("), plugin.indexOf("export function signPkceProof"));
    expect(pkceFn).not.toMatch(/FILLIP_UNSUBSCRIBE_SECRET|CRON_SECRET|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|"fillip-pkce"/);
    expect(pkceFn).toContain("DEV_PKCE_SECRET");
    expect(pkceFn).toContain("productionPkce()");
    expect(plugin).not.toContain('"fillip-pkce"');
    expect(plugin).toContain('const DEV_PKCE_SECRET = "fillip-dev-pkce"');

    const fallbacks = {
      FILLIP_UNSUBSCRIBE_SECRET: "unsubscribe-secret-not-a-pkce-key",
      CRON_SECRET: "cron-secret-not-a-pkce-key",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-not-a-pkce-key",
      SUPABASE_ANON_KEY: "anon-key-not-a-pkce-key"
    };
    process.env.NODE_ENV = "production";
    process.env.VERCEL_ENV = "";
    delete process.env.FILLIP_PKCE_SECRET;
    for (const [key, value] of Object.entries(fallbacks)) process.env[key] = value;
    process.env.FILLIP_LOCKOUT_SECRET = "l".repeat(32);
    expect(pkceSecretProblem()).toMatch(/FILLIP_PKCE_SECRET/);
    expect(pkceSecretProblem() ?? "").not.toContain("fillip-dev-pkce");
    process.env.FILLIP_PKCE_SECRET = "p".repeat(31);
    expect(pkceSecretProblem()).toMatch(/FILLIP_PKCE_SECRET/);
    process.env.FILLIP_PKCE_SECRET = `  ${"p".repeat(32)}\n`;
    expect(pkceSecretProblem()).toBeNull();

    const missing = await boot({
      NODE_ENV: "production",
      VERCEL_ENV: "",
      FILLIP_LOCKOUT_SECRET: "l".repeat(32),
      FILLIP_PKCE_SECRET: ""
    });
    const short = await boot({
      NODE_ENV: "production",
      VERCEL_ENV: "",
      FILLIP_LOCKOUT_SECRET: "l".repeat(32),
      FILLIP_PKCE_SECRET: "p".repeat(31)
    });
    const vercel = await boot({
      NODE_ENV: "development",
      VERCEL_ENV: "production",
      FILLIP_LOCKOUT_SECRET: "l".repeat(32),
      FILLIP_PKCE_SECRET: undefined
    });
    const lockout = await boot({
      NODE_ENV: "production",
      VERCEL_ENV: "",
      FILLIP_LOCKOUT_SECRET: "",
      FILLIP_PKCE_SECRET: "p".repeat(32)
    });
    const ready = await boot({
      NODE_ENV: "production",
      VERCEL_ENV: "",
      FILLIP_LOCKOUT_SECRET: "l".repeat(32),
      FILLIP_PKCE_SECRET: `  ${"p".repeat(32)}  `
    });
    const problems: string[] = [];
    for (const [name, result] of [["missing", missing], ["short", short], ["vercel", vercel]] as const) {
      if (result.listened) problems.push(`${name} listened: ${result.output.slice(0, 240)}`);
      if (!/FILLIP_PKCE_SECRET/.test(result.output)) problems.push(`${name} did not name FILLIP_PKCE_SECRET`);
      if (/fillip-dev-pkce|fillip-pkce|unsubscribe-secret-not-a-pkce-key|service-role-not-a-pkce-key/.test(result.output)) {
        problems.push(`${name} echoed a secret or a fallback`);
      }
    }
    if (lockout.listened) problems.push("missing lockout secret listened");
    if (!/FILLIP_LOCKOUT_SECRET/.test(lockout.output)) problems.push("missing lockout secret was not named");
    if (!ready.listened) problems.push(`32-character PKCE secret did not listen: ${ready.output.slice(0, 240)}`);
    expect(problems).toEqual([]);
  }, 90_000);
});

describe("QA round 10 copy and regression", () => {
  it("QA-PASS: privacy and the README name the 30-day purge and immediate account deletion, and copy has no prices", () => {
    const readme = readFileSync("README.md", "utf8");
    const privacy = readFileSync("src/public-pages.ts", "utf8");
    expect(readme).toContain("The delivery job deletes removed reminders older than 30 days and their deliveries.");
    expect(readme).toContain("account deletion, still remove those rows immediately.");
    expect(privacy).toContain("Fillip keeps that reminder and its delivery records for 30 days so it can be restored, then deletes them.");
    expect(privacy).toContain("Export or delete your reminders</a> removes them immediately.");
    expect(privacy).toContain("Ask support to delete the account, which removes them immediately.");
    expect(readFileSync("tests/qa/round8.test.ts", "utf8")).toContain('it("QA-FAIL: a client X-Real-IP or x-vercel-forwarded-for cannot mint a new verify budget"');
    expect(readFileSync("tests/qa/round8.test.ts", "utf8")).toContain('it("QA-FAIL: production startup refuses when FILLIP_LOCKOUT_SECRET is missing"');
    expect(readFileSync("tests/qa/round9.test.ts", "utf8")).toContain('expect(source).not.toContain("fillip-pkce")');
    expect(readFileSync("tests/qa/round7.test.ts", "utf8")).not.toMatch(/\bit\.skip\(|\bdescribe\.skip\(|\btest\.skip\(/);
    const roots = ["README.md", "src", "public", "glama.json", "server.json", "supabase/README-oauth.md"];
    const offenders: string[] = [];
    const walk = (target: string) => {
      const info = statSync(target, { throwIfNoEntry: false });
      if (!info) return;
      if (!info.isDirectory()) {
        if (!/\.(md|ts|json|html)$/.test(target)) return;
        const text = readFileSync(target, "utf8");
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
