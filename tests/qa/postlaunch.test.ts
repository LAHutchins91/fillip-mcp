/**
 * Post-launch QA against d4ba5ee, compared with production behavior.
 * QA-FAIL tests assert the occurrence a user was promised and fail on this build.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { completeOrCancel, removeReminder, restoreReminder, setReminder, snoozeOrReschedule } from "../../src/lib/reminders.js";
import type { TelegramSender } from "../../src/lib/telegram.js";
import type { Actor, Recurrence, Reminder } from "../../src/lib/types.js";
import { ALLOWANCE_REACHED, allowanceReachedMessage, blankContact, freeOpenMessage, upgradePageUrl, upgradePrompt } from "../../src/lib/usage.js";
import { formatNextOccurrence, zonedParts } from "../../src/lib/zone.js";

const actor: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", emailVerified: true };
const ny = "America/New_York";
const database = "fillip_postlaunch";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const prodOrigin = "https://fillip-mcp.vercel.app";

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

function job(store: MemoryFillipStore, sender: RecordingSender, at: Date, extra: { telegram?: TelegramSender; maxEmailsPerUserPerDay?: number } = {}) {
  return runDueJob({
    store,
    sender,
    now: at,
    from: "Fillip <reminders@example.com>",
    appBaseUrl: prodOrigin,
    unsubscribeSecret: "unsubscribe-secret",
    maxEmailsPerUserPerDay: extra.maxEmailsPerUserPerDay ?? 20,
    maxSends: 40,
    minIntervalMs: 0,
    caps: { trialEmailsPerMonth: 100, proEmailsPerMonth: 100, annualEmailsPerMonth: 100 },
    global: { perDay: 1000, perMonth: 1000 },
    telegram: extra.telegram ? { sender: extra.telegram } : null
  });
}

function arm(who: Actor = actor) {
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

/** Twelve readers all see the row from before any of them writes. */
class SameSnapshotStore extends MemoryFillipStore {
  armed = false;
  private arrived = 0;
  private snapshot: Reminder | null = null;
  readonly full = gate();
  private open = gate();
  override async getReminder(ownerId: string, id: string) {
    const row = await super.getReminder(ownerId, id);
    if (!this.armed) return row;
    if (!this.snapshot) this.snapshot = row;
    this.arrived += 1;
    if (this.arrived === 12) this.full.resolve();
    await this.open.promise;
    return this.snapshot;
  }
  go() {
    this.open.resolve();
  }
}

async function make(when: string, zone: string, createdAt: string, what = when) {
  const store = new MemoryFillipStore();
  const created = await setReminder(store, actor, { what, when, timezone: zone }, new Date(createdAt));
  const row = await store.getReminder(actor.id, created.id);
  if (!row?.recurrence) throw new Error(`missing series for ${when}`);
  return { store, row };
}

function clock(iso: string, zone: string) {
  const parts = zonedParts(new Date(iso), zone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function endsOf(recurrence: Recurrence | null) {
  return recurrence && "ends" in recurrence ? recurrence.ends : undefined;
}

describe("post-launch advance of one occurrence", () => {
  it("QA-PASS: daily, weekly, weekday, nth, monthly 31st, and every-N each move one step, including across DST", async () => {
    const cases: Array<{ when: string; zone: string; created: string; completed: string; next: string }> = [
      { when: "every day at 9am", zone: ny, created: "2026-10-12T12:00:00.000Z", completed: "2026-10-12T14:00:00.000Z", next: "2026-10-13 09:00" },
      { when: "every Tuesday at 9am", zone: ny, created: "2026-10-12T12:00:00.000Z", completed: "2026-10-13T14:00:00.000Z", next: "2026-10-20 09:00" },
      { when: "every weekday at 9am", zone: ny, created: "2026-10-16T12:00:00.000Z", completed: "2026-10-16T14:00:00.000Z", next: "2026-10-19 09:00" },
      { when: "first Monday of every month at 9am", zone: ny, created: "2026-10-05T12:00:00.000Z", completed: "2026-10-05T14:00:00.000Z", next: "2026-11-02 09:00" },
      { when: "last Friday of every month at 9am", zone: ny, created: "2026-10-30T12:00:00.000Z", completed: "2026-10-30T14:00:00.000Z", next: "2026-11-27 09:00" },
      { when: "every 3 days at 9am", zone: ny, created: "2026-10-11T12:00:00.000Z", completed: "2026-10-11T14:00:00.000Z", next: "2026-10-14 09:00" },
      { when: "every 2 weeks on Tuesday at 9am", zone: ny, created: "2026-10-12T12:00:00.000Z", completed: "2026-10-13T14:00:00.000Z", next: "2026-10-27 09:00" },
      { when: "every day at 9am", zone: ny, created: "2027-03-13T12:00:00.000Z", completed: "2027-03-13T15:00:00.000Z", next: "2027-03-14 09:00" },
      { when: "every day at 9am", zone: ny, created: "2026-10-31T12:00:00.000Z", completed: "2026-10-31T14:00:00.000Z", next: "2026-11-01 09:00" }
    ];
    for (const spec of cases) {
      const { store, row } = await make(spec.when, spec.zone, spec.created);
      const before = row.fireAt;
      const done = await completeOrCancel(store, actor.id, row.id, "complete", new Date(spec.completed));
      const saved = await store.getReminder(actor.id, row.id);
      expect(done.status, spec.when).toBe("active");
      expect(saved?.status, spec.when).toBe("active");
      expect(saved?.id).toBe(row.id);
      expect(clock(done.fireAt, spec.zone), `${spec.when} from ${clock(before, spec.zone)}`).toBe(spec.next);
      expect(saved?.fireAt).toBe(done.fireAt);
    }

    const month = await make("the 31st of every month at 9am", ny, "2027-01-31T12:00:00.000Z");
    const february = await completeOrCancel(month.store, actor.id, month.row.id, "complete", new Date("2027-01-31T15:00:00.000Z"));
    expect(clock(february.fireAt, ny)).toBe("2027-02-28 09:00");
    const march = await completeOrCancel(month.store, actor.id, month.row.id, "complete", new Date("2027-02-28T15:00:00.000Z"));
    expect(clock(march.fireAt, ny)).toBe("2027-03-31 09:00");
    expect((await month.store.getReminder(actor.id, month.row.id))?.status).toBe("active");

    const gap = await make("every day at 2:30am", ny, "2027-03-13T06:00:00.000Z");
    const shifted = await completeOrCancel(gap.store, actor.id, gap.row.id, "complete", new Date("2027-03-13T07:31:00.000Z"));
    expect(clock(shifted.fireAt, ny)).toBe("2027-03-14 03:30");
    expect(shifted.note).toContain("3:30 AM");
    const afterGap = await completeOrCancel(gap.store, actor.id, gap.row.id, "complete", new Date("2027-03-14T07:31:00.000Z"));
    expect(clock(afterGap.fireAt, ny)).toBe("2027-03-15 02:30");
  });

  it("QA-PASS: an until bound keeps the last included day and does not schedule past the end", async () => {
    const penultimate = await make("every day at 9am until Oct 13 2026", ny, "2026-10-12T12:00:00.000Z");
    const next = await completeOrCancel(penultimate.store, actor.id, penultimate.row.id, "complete", new Date("2026-10-12T14:00:00.000Z"));
    expect(next.status).toBe("active");
    expect(clock(next.fireAt, ny)).toBe("2026-10-13 09:00");

    const last = await make("every day at 9am until Oct 13 2026", ny, "2026-10-13T12:00:00.000Z");
    expect(clock(last.row.fireAt, ny)).toBe("2026-10-13 09:00");
    const finished = await completeOrCancel(last.store, actor.id, last.row.id, "complete", new Date("2026-10-13T14:00:00.000Z"));
    const saved = await last.store.getReminder(actor.id, last.row.id);
    expect(finished.status).toBe("completed");
    expect(finished.note).toBe("Done. That was the last one.");
    expect(saved?.status).toBe("completed");
    expect(clock(saved?.fireAt ?? "", ny)).toBe("2026-10-13 09:00");
    expect(new Date(saved?.fireAt ?? 0).getTime()).toBeLessThan(new Date("2026-10-14T04:00:00.000Z").getTime());
  });

  it("QA-PASS: a counted series ends on the last occurrence and end_series stops it immediately", async () => {
    const counted = await make("every day at 9am for 2 times", "UTC", "2026-10-12T08:00:00.000Z");
    const first = await completeOrCancel(counted.store, actor.id, counted.row.id, "complete", new Date("2026-10-12T10:00:00.000Z"));
    expect(first.status).toBe("active");
    expect(clock(first.fireAt, "UTC")).toBe("2026-10-13 09:00");
    expect(endsOf((await counted.store.getReminder(actor.id, counted.row.id))?.recurrence ?? null)?.completed).toBe(1);
    const second = await completeOrCancel(counted.store, actor.id, counted.row.id, "complete", new Date("2026-10-13T10:00:00.000Z"));
    expect(second.status).toBe("completed");
    expect(second.note).toBe("Done. That was the last one.");

    const series = await make("every day at 9am", "UTC", "2026-10-12T08:00:00.000Z");
    const before = series.row.fireAt;
    const stopped = await completeOrCancel(series.store, actor.id, series.row.id, "complete", new Date("2026-10-12T10:00:00.000Z"), true);
    expect(stopped.status).toBe("completed");
    expect(stopped.note).toBe("Marked done. Fillip will stop this series.");
    expect((await series.store.getReminder(actor.id, series.row.id))?.fireAt).toBe(before);

    const cancelled = await make("every Tuesday at 9am", "UTC", "2026-10-12T08:00:00.000Z");
    const fireAt = cancelled.row.fireAt;
    const cancel = await completeOrCancel(cancelled.store, actor.id, cancelled.row.id, "cancel", new Date("2026-10-13T10:00:00.000Z"));
    expect(cancel.status).toBe("cancelled");
    expect(cancel.note).toBe("Cancelled. Fillip will not email you about this.");
    expect((await cancelled.store.getReminder(actor.id, cancelled.row.id))?.fireAt).toBe(fireAt);
  });

  it("QA-FAIL: completing the same occurrence twice does not skip the next one", async () => {
    const daily = await make("every day at 9am", "UTC", "2026-10-12T08:00:00.000Z");
    const now = new Date("2026-10-12T10:00:00.000Z");
    const first = await completeOrCancel(daily.store, actor.id, daily.row.id, "complete", now);
    const second = await completeOrCancel(daily.store, actor.id, daily.row.id, "complete", now);
    expect(second.fireAt).toBe(first.fireAt);
    expect((await daily.store.getReminder(actor.id, daily.row.id))?.fireAt).toBe(first.fireAt);

    const counted = await make("every day at 9am for 3 times", "UTC", "2026-10-12T08:00:00.000Z");
    await completeOrCancel(counted.store, actor.id, counted.row.id, "complete", now);
    await completeOrCancel(counted.store, actor.id, counted.row.id, "complete", now);
    const saved = await counted.store.getReminder(actor.id, counted.row.id);
    expect(saved?.status).toBe("active");
    expect(endsOf(saved?.recurrence ?? null)?.completed).toBe(1);
    expect(clock(saved?.fireAt ?? "", "UTC")).toBe("2026-10-13 09:00");
  });

  it("QA-PASS: twelve concurrent completes of one occurrence land on the same next time", async () => {
    const store = new SameSnapshotStore();
    const created = await setReminder(store, actor, { what: "race", when: "every Tuesday at 9am", timezone: "UTC" }, new Date("2026-10-12T08:00:00.000Z"));
    const before = await store.getReminder(actor.id, created.id);
    const now = new Date("2026-10-13T14:00:00.000Z");
    store.armed = true;
    const pending = Promise.all(Array.from({ length: 12 }, () => completeOrCancel(store, actor.id, created.id, "complete", now)));
    await store.full.promise;
    store.go();
    const views = await pending;
    store.armed = false;
    const saved = await store.getReminder(actor.id, created.id);
    expect(new Set(views.map((view) => view.fireAt)).size).toBe(1);
    expect(saved?.fireAt).toBe(views[0]?.fireAt);
    expect(clock(saved?.fireAt ?? "", "UTC")).toBe("2026-10-20 09:00");
    expect(saved?.fireAt).not.toBe(before?.fireAt);
    expect(saved?.status).toBe("active");
  });
});

describe("post-launch complete during an in-flight delivery", () => {
  it("QA-PASS: completing one occurrence between the claim and the provider sends once and keeps the next", async () => {
    const store = new HoldClaim();
    store.contacts.set(actor.id, arm());
    const created = await setReminder(store, actor, { what: "Standup", when: "every day at 9am", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing");
    row.fireAt = "2026-10-11T09:00:00.000Z";
    await store.saveReminder(row);
    const mail = new RecordingSender();
    const at = new Date("2026-10-11T09:00:00.000Z");
    const pending = job(store, mail, at);
    await store.entered.promise;
    const done = await completeOrCancel(store, actor.id, row.id, "complete", at);
    expect(clock(done.fireAt, "UTC")).toBe("2026-10-12 09:00");
    store.release.resolve();
    const report = await pending;
    expect(report.sent).toBe(1);
    expect(mail.sent).toHaveLength(1);
    const saved = await store.getReminder(actor.id, row.id);
    expect(saved?.status).toBe("active");
    expect(saved?.fireAt).toBe(done.fireAt);
    const later = new RecordingSender();
    const nextReport = await job(store, later, new Date("2026-10-12T09:00:00.000Z"));
    expect(nextReport.sent).toBe(1);
    expect(later.sent).toHaveLength(1);
    expect(clock((await store.getReminder(actor.id, row.id))?.fireAt ?? "", "UTC")).toBe("2026-10-13 09:00");
  });

  it("QA-FAIL: the in-flight email still describes the occurrence that was claimed", async () => {
    const store = new HoldClaim();
    store.contacts.set(actor.id, arm());
    const created = await setReminder(store, actor, { what: "Standup", when: "every day at 9am", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing");
    row.fireAt = "2026-10-11T09:00:00.000Z";
    await store.saveReminder(row);
    const mail = new RecordingSender();
    const at = new Date("2026-10-11T09:00:00.000Z");
    const pending = job(store, mail, at);
    await store.entered.promise;
    await completeOrCancel(store, actor.id, row.id, "complete", at);
    store.release.resolve();
    await pending;
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.text).toContain("Due Sunday, October 11, 2026 at 9:00 AM.");
    expect(mail.sent[0]?.text ?? "").not.toContain("October 12, 2026");
  });

  it("QA-PASS: completing after the provider accepts does not skip an extra occurrence", async () => {
    const store = new MemoryFillipStore();
    store.contacts.set(actor.id, arm());
    const created = await setReminder(store, actor, { what: "After send", when: "every day at 9am", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing");
    row.fireAt = "2026-10-11T09:00:00.000Z";
    await store.saveReminder(row);
    const mail = new RecordingSender();
    const at = new Date("2026-10-11T09:00:00.000Z");
    const original = mail.send.bind(mail);
    mail.send = async (message) => {
      await completeOrCancel(store, actor.id, row.id, "complete", at);
      return original(message);
    };
    const report = await job(store, mail, at);
    expect(report.sent).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(clock((await store.getReminder(actor.id, row.id))?.fireAt ?? "", "UTC")).toBe("2026-10-12 09:00");
  });

  it("QA-PASS: end_series between the claim and the provider sends nothing and releases the ping", async () => {
    const store = new HoldClaim();
    store.contacts.set(actor.id, arm());
    const created = await setReminder(store, actor, { what: "Stop series", when: "every day at 9am", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing");
    row.fireAt = "2026-10-11T09:00:00.000Z";
    row.channel = "both";
    await store.saveReminder(row);
    const keeper = await setReminder(store, actor, { what: "Keeper", when: "tomorrow at 10am", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const keeperRow = await store.getReminder(actor.id, keeper.id);
    if (!keeperRow) throw new Error("missing keeper");
    keeperRow.fireAt = "2026-10-11T10:00:00.000Z";
    await store.saveReminder(keeperRow);
    const mail = new RecordingSender();
    const telegram = new RecordingTelegram();
    const at = new Date("2026-10-11T10:00:00.000Z");
    const pending = job(store, mail, at, { telegram, maxEmailsPerUserPerDay: 1 });
    await store.entered.promise;
    await completeOrCancel(store, actor.id, row.id, "complete", at, true);
    expect((await store.getReminder(actor.id, row.id))?.status).toBe("completed");
    store.release.resolve();
    const report = await pending;
    expect(mail.sent.map((message) => message.subject).join(" ")).not.toContain("Stop series");
    expect(telegram.sent.join(" ")).not.toContain("Stop series");
    expect(mail.sent.map((message) => message.subject).join(" ")).toContain("Keeper");
    expect(report.sent).toBe(1);
    const stopped = store.deliveries.filter((item) => item.reminderId === row.id);
    expect(stopped.map((item) => item.status)).toEqual(["skipped"]);
    const later = new RecordingSender();
    const again = await job(store, later, new Date("2026-10-12T09:00:00.000Z"));
    expect(again.sent).toBe(0);
    expect(later.sent).toHaveLength(0);
    expect((await store.getReminder(actor.id, row.id))?.status).toBe("completed");
  });

  it("QA-PASS: end_series after the provider accepts does not leave a later ping", async () => {
    const store = new MemoryFillipStore();
    store.contacts.set(actor.id, arm());
    const created = await setReminder(store, actor, { what: "Already out", when: "every day at 9am", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing");
    row.fireAt = "2026-10-11T09:00:00.000Z";
    await store.saveReminder(row);
    const mail = new RecordingSender();
    const at = new Date("2026-10-11T09:00:00.000Z");
    const original = mail.send.bind(mail);
    mail.send = async (message) => {
      const result = await original(message);
      await completeOrCancel(store, actor.id, row.id, "complete", at, true);
      return result;
    };
    const report = await job(store, mail, at);
    expect(report.sent).toBe(1);
    expect((await store.getReminder(actor.id, row.id))?.status).toBe("completed");
    const later = new RecordingSender();
    expect((await job(store, later, new Date("2026-10-12T09:00:00.000Z"))).sent).toBe(0);
    expect(later.sent).toHaveLength(0);
  });

  it("QA-PASS: finishing the last occurrence before the provider releases the held ping", async () => {
    const store = new HoldClaim();
    store.contacts.set(actor.id, arm());
    const created = await setReminder(store, actor, { what: "Last one", when: "every day at 9am for 1 times", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing");
    row.fireAt = "2026-10-11T09:00:00.000Z";
    await store.saveReminder(row);
    const keeper = await setReminder(store, actor, { what: "Keeper last", when: "tomorrow at 10am", timezone: "UTC" }, new Date("2026-10-10T08:00:00.000Z"));
    const keeperRow = await store.getReminder(actor.id, keeper.id);
    if (!keeperRow) throw new Error("missing keeper");
    keeperRow.fireAt = "2026-10-11T10:00:00.000Z";
    await store.saveReminder(keeperRow);
    const mail = new RecordingSender();
    const at = new Date("2026-10-11T10:00:00.000Z");
    const pending = job(store, mail, at, { maxEmailsPerUserPerDay: 1 });
    await store.entered.promise;
    const done = await completeOrCancel(store, actor.id, row.id, "complete", at);
    expect(done.status).toBe("completed");
    store.release.resolve();
    const report = await pending;
    expect(mail.sent.map((message) => message.subject).join(" ")).not.toContain("Last one");
    expect(mail.sent.map((message) => message.subject).join(" ")).toContain("Keeper last");
    expect(report.sent).toBe(1);
    expect(store.deliveries.filter((item) => item.reminderId === row.id).map((item) => item.status)).toEqual(["skipped"]);
  });
});

describe("post-launch complete on a reminder that is not active", () => {
  it("QA-PASS: paused advances one step and stays paused; removed is refused; cancelled does not start sending", async () => {
    const paused = await make("every day at 9am", "UTC", "2026-10-12T08:00:00.000Z");
    await snoozeOrReschedule(paused.store, actor.id, paused.row.id, undefined, "UTC", new Date("2026-10-12T09:00:00.000Z"), "pause");
    const held = await paused.store.getReminder(actor.id, paused.row.id);
    const done = await completeOrCancel(paused.store, actor.id, paused.row.id, "complete", new Date("2026-10-12T10:00:00.000Z"));
    const saved = await paused.store.getReminder(actor.id, paused.row.id);
    expect(done.status).toBe("paused");
    expect(saved?.status).toBe("paused");
    expect(clock(saved?.fireAt ?? "", "UTC")).toBe("2026-10-13 09:00");
    expect(saved?.holdUntil ?? null).toBe(held?.holdUntil ?? null);

    const removed = await make("every day at 9am", "UTC", "2026-10-12T08:00:00.000Z");
    const fireAt = removed.row.fireAt;
    await removeReminder(removed.store, actor.id, removed.row.id, new Date("2026-10-12T09:00:00.000Z"));
    await expect(completeOrCancel(removed.store, actor.id, removed.row.id, "complete", new Date("2026-10-12T10:00:00.000Z"))).rejects.toThrow(/removed/i);
    const still = await removed.store.getReminder(actor.id, removed.row.id);
    expect(still?.status).toBe("removed");
    expect(still?.fireAt).toBe(fireAt);

    const cancelled = await make("every Tuesday at 9am", "UTC", "2026-10-12T08:00:00.000Z");
    const cancelFire = cancelled.row.fireAt;
    await completeOrCancel(cancelled.store, actor.id, cancelled.row.id, "cancel", new Date("2026-10-12T10:00:00.000Z"));
    const after = await completeOrCancel(cancelled.store, actor.id, cancelled.row.id, "complete", new Date("2026-10-12T11:00:00.000Z"));
    const finalRow = await cancelled.store.getReminder(actor.id, cancelled.row.id);
    expect(after.status).not.toBe("active");
    expect(finalRow?.status).not.toBe("active");
    expect(finalRow?.fireAt).toBe(cancelFire);
  });
});

describe("post-launch copy", () => {
  it("QA-FAIL: a weekly or monthly complete does not say today", async () => {
    const specs = [
      { when: "every Tuesday at 9am", created: "2026-10-12T12:00:00.000Z", completed: "2026-10-13T14:00:00.000Z" },
      { when: "first Monday of every month at 9am", created: "2026-10-05T12:00:00.000Z", completed: "2026-10-05T14:00:00.000Z" },
      { when: "the 31st of every month at 9am", created: "2027-01-31T12:00:00.000Z", completed: "2027-01-31T15:00:00.000Z" },
      { when: "every 2 weeks on Tuesday at 9am", created: "2026-10-12T12:00:00.000Z", completed: "2026-10-13T14:00:00.000Z" }
    ];
    for (const spec of specs) {
      const { store, row } = await make(spec.when, ny, spec.created);
      const done = await completeOrCancel(store, actor.id, row.id, "complete", new Date(spec.completed));
      expect(done.note, spec.when).toBe(`Done. Next reminder: ${formatNextOccurrence(new Date(done.fireAt), ny)}.`);
      expect(done.note, spec.when).not.toMatch(/today/i);
    }
  });

  it("QA-FAIL: completing a daily 1:30 during the fall-back hour schedules the next morning, not the repeated hour", async () => {
    const { store, row } = await make("every day at 1:30am", ny, "2026-10-31T04:00:00.000Z");
    row.fireAt = "2026-11-01T05:30:00.000Z";
    await store.saveReminder(row);
    const done = await completeOrCancel(store, actor.id, row.id, "complete", new Date("2026-11-01T05:31:00.000Z"));
    expect(done.fireAt).toBe("2026-11-02T06:30:00.000Z");
    expect(clock(done.fireAt, ny)).toBe("2026-11-02 01:30");
  });

  it("QA-PASS: free and trial cap messages use the production home page as plain text", () => {
    const env = { APP_BASE_URL: prodOrigin } as NodeJS.ProcessEnv;
    const url = upgradePageUrl(env);
    expect(url).toBe(`${prodOrigin}/`);
    const prompt = upgradePrompt(env);
    expect(prompt).toBe(`Upgrade to Pro at ${prodOrigin}/. The trial is 14 days, then Pro.`);
    expect(prompt).not.toMatch(/\$\s*\d|\bUSD\b|\bdollars?\b/i);
    expect(prompt).not.toMatch(/\[|\]\(|<a |<\/a>|\/account|\/upgrade/);
    expect(allowanceReachedMessage("free").replace(upgradePrompt(), prompt)).toContain(prompt);
    expect(allowanceReachedMessage("trial").replace(upgradePrompt(), prompt)).toContain(`${prodOrigin}/`);
    expect(allowanceReachedMessage("pro")).toBe(ALLOWANCE_REACHED);
    expect(allowanceReachedMessage("pro")).not.toContain(prodOrigin);
    expect(freeOpenMessage(10).replace(upgradePrompt(), prompt)).toContain(`Upgrade to Pro at ${prodOrigin}/`);
    expect(upgradePageUrl({ APP_BASE_URL: `${prodOrigin}/` } as NodeJS.ProcessEnv)).toBe(`${prodOrigin}/`);
    const previous = process.env.APP_BASE_URL;
    process.env.APP_BASE_URL = prodOrigin;
    try {
      expect(allowanceReachedMessage("free")).toContain(`${prodOrigin}/`);
      expect(allowanceReachedMessage("free")).not.toContain("localhost");
    } finally {
      if (previous === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = previous;
    }
  });
});

describe("post-launch restore after a completed occurrence", () => {
  it("QA-PASS: restore brings back the next time that complete scheduled", async () => {
    const { store, row } = await make("every Tuesday at 9am", ny, "2026-10-12T12:00:00.000Z", "Weekly");
    const done = await completeOrCancel(store, actor.id, row.id, "complete", new Date("2026-10-13T14:00:00.000Z"));
    expect(clock(done.fireAt, ny)).toBe("2026-10-20 09:00");
    await removeReminder(store, actor.id, row.id, new Date("2026-10-13T15:00:00.000Z"));
    const restored = await restoreReminder(store, actor.id, row.id, new Date("2026-10-13T16:00:00.000Z"));
    expect(restored.status).toBe("active");
    expect(restored.fireAt).toBe(done.fireAt);
    expect(clock(restored.fireAt, ny)).toBe("2026-10-20 09:00");

    const daily = await make("every day at 9am", ny, "2026-10-12T12:00:00.000Z", "Daily");
    const advanced = await completeOrCancel(daily.store, actor.id, daily.row.id, "complete", new Date("2026-10-12T14:00:00.000Z"));
    expect(clock(advanced.fireAt, ny)).toBe("2026-10-13 09:00");
    await removeReminder(daily.store, actor.id, daily.row.id, new Date("2026-10-13T15:00:00.000Z"));
    const later = await restoreReminder(daily.store, actor.id, daily.row.id, new Date("2026-10-15T16:00:00.000Z"));
    expect(later.status).toBe("active");
    expect(clock(later.fireAt, ny)).toBe("2026-10-16 09:00");
  });
});

describe("post-launch open cap on Postgres 16", () => {
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

  it("QA-PASS: advancing an active series at the free cap is allowed, and ending it frees a slot", async () => {
    const owner = randomUUID();
    await db.query("insert into auth.users (id) values ($1)", [owner]);
    await db.query("update public.profiles set plan = 'free', subscription_status = 'none' where id = $1", [owner]);
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const id = randomUUID();
      ids.push(id);
      await db.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, recurrence, status)
         values ($1, $2, 'reminder', $3, 'UTC', '2026-10-12T09:00:00Z', $4::jsonb, 'active')`,
        [id, owner, `Open ${index}`, index === 0 ? JSON.stringify({ kind: "daily", hour: 9, minute: 0 }) : null]
      );
    }
    const series = ids[0];
    await db.query("update public.reminders set fire_at = '2026-10-13T09:00:00Z', updated_at = now() where id = $1", [series]);
    const open = await db.query<{ count: string }>("select count(*)::text as count from public.reminders where owner_id = $1 and status = 'active'", [owner]);
    expect(open.rows[0]?.count).toBe("10");
    const extra = randomUUID();
    await expect(db.query(
      `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
       values ($1, $2, 'reminder', 'eleventh', 'UTC', '2026-10-20T09:00:00Z', 'active')`,
      [extra, owner]
    )).rejects.toThrow(/free plan allows 10/);
    await db.query("update public.reminders set status = 'completed', completed_at = now(), updated_at = now() where id = $1", [series]);
    await db.query(
      `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
       values ($1, $2, 'reminder', 'after the series ended', 'UTC', '2026-10-20T09:00:00Z', 'active')`,
      [extra, owner]
    );
    const after = await db.query<{ count: string }>("select count(*)::text as count from public.reminders where owner_id = $1 and status = 'active'", [owner]);
    expect(after.rows[0]?.count).toBe("10");
  });
});

describe("post-launch regression", () => {
  it("QA-PASS: the granted-send expect is unchanged and the new cap sentence still has no price", () => {
    const previous = readFileSync("tests/qa/round10.test.ts", "utf8");
    expect(previous).toContain('it("QA-FAIL: a claim that already returned send does not email after the reminder is removed"');
    expect(previous).toContain("expect(report.sent).toBe(0)");
    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("complete finishes this occurrence");
    expect(readme).toContain("includes the address of this site");
    expect(readme).not.toMatch(/\$\s*\d/);
    const tools = readFileSync("src/fillip-tools.ts", "utf8");
    expect(tools).toContain("end_series");
    expect(tools).not.toMatch(/\$\s*\d/);
    const note = formatNextOccurrence(new Date("2026-10-13T13:00:00.000Z"), ny);
    expect(note).toBe("Tue Oct 13 at 9:00 AM");
    expect(note).not.toMatch(/\$\s*\d/);
  });
});
