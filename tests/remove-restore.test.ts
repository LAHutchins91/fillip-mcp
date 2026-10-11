import { describe, expect, it } from "vitest";
import { runDueJob } from "../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../src/lib/email.js";
import { MemoryFillipStore } from "../src/lib/memory-store.js";
import { listReminders, REMOVE_RETAIN_MS, removeReminder, renderCalendarFeed, restoreReminder, setReminder, snoozeOrReschedule } from "../src/lib/reminders.js";
import { OpenCapError } from "../src/lib/store.js";
import type { Actor } from "../src/lib/types.js";
import { blankContact, freeOpenMessage, FREE_OPEN_REMINDERS } from "../src/lib/usage.js";

const now = new Date("2026-10-11T16:00:00.000Z");
const earlier = new Date("2026-10-10T16:00:00.000Z");
const actor: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", emailVerified: true };
const other: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "other@example.com", emailVerified: true };

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
    caps: { trialEmailsPerMonth: 100, proEmailsPerMonth: 100, annualEmailsPerMonth: 100 },
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

describe("remove and restore", () => {
  it("does not send a removed reminder, including one with an in-flight claim", async () => {
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
    expect(store.reserveSend({
      ownerId: actor.id,
      now,
      timeZone: "UTC",
      sinceIso: new Date(now.getTime() - 86_400_000).toISOString(),
      monthlyLimit: 100,
      dailyLimit: 100,
      globalDayStartIso: new Date(now.getTime() - 86_400_000).toISOString(),
      globalMonthStartIso: new Date(now.getTime() - 86_400_000).toISOString(),
      globalDayLimit: 1000,
      globalMonthLimit: 1000,
      countGlobal: true,
      reminderId: row.id
    })).toEqual({ ok: false, reason: "removed" });
    const sender = new RecordingSender();
    const report = await job(store, sender, now);
    expect(report.sent).toBe(0);
    expect(sender.sent).toHaveLength(0);
    const listed = await listReminders(store, actor.id, { status: "all", includeDone: true }, now);
    expect(listed.map((item) => item.id)).not.toContain(row.id);
    await store.setCalendarToken(actor.id, "calendar-token-value-123456");
    const feed = await renderCalendarFeed(store, "calendar-token-value-123456", now);
    expect(feed ?? "").not.toContain("Ship the note");
  });

  it("restores the same id and the next time, and stays paused when it was paused", async () => {
    const store = new MemoryFillipStore();
    const future = await setReminder(store, actor, { what: "Future", when: "tomorrow at 9am", timezone: "UTC" }, now);
    const removedAt = future.fireAt;
    await removeReminder(store, actor.id, future.id, now);
    const brought = await restoreReminder(store, actor.id, future.id, now);
    expect(brought.id).toBe(future.id);
    expect(brought.status).toBe("active");
    expect(brought.fireAt).toBe(removedAt);
    expect((await store.getReminder(actor.id, future.id))?.removedAt ?? null).toBeNull();

    const series = await setReminder(store, actor, { what: "Daily", when: "every day at 9am", timezone: "UTC" }, earlier);
    const daily = await store.getReminder(actor.id, series.id);
    if (!daily) throw new Error("missing series");
    daily.fireAt = "2026-10-11T09:00:00.000Z";
    await store.saveReminder(daily);
    await removeReminder(store, actor.id, daily.id, now);
    const next = await restoreReminder(store, actor.id, daily.id, now);
    expect(next.id).toBe(daily.id);
    expect(new Date(next.fireAt).getTime()).toBeGreaterThan(now.getTime());

    const pausedStore = new MemoryFillipStore();
    const paused = await setReminder(pausedStore, actor, { what: "Paused", when: "tomorrow at 3pm", timezone: "UTC" }, now);
    await snoozeOrReschedule(pausedStore, actor.id, paused.id, undefined, "UTC", now, "pause");
    await removeReminder(pausedStore, actor.id, paused.id, now);
    const back = await restoreReminder(pausedStore, actor.id, paused.id, now);
    expect(back.id).toBe(paused.id);
    expect(back.status).toBe("paused");
    const sender = new RecordingSender();
    expect((await job(pausedStore, sender, new Date(now.getTime() + 2 * 86_400_000))).sent).toBe(0);
  });

  it("purges only removed rows older than 30 days, and a second run deletes nothing", async () => {
    const store = new MemoryFillipStore();
    const expired = await setReminder(store, actor, { what: "Expired", when: "tomorrow at 9am", timezone: "UTC" }, now);
    const recent = await setReminder(store, actor, { what: "Recent", when: "tomorrow at 10am", timezone: "UTC" }, now);
    const live = await setReminder(store, actor, { what: "Live", when: "tomorrow at 11am", timezone: "UTC" }, now);
    await removeReminder(store, actor.id, expired.id, new Date(now.getTime() - REMOVE_RETAIN_MS - 1000));
    await removeReminder(store, actor.id, recent.id, now);
    store.deliveries.push(
      {
        id: "expired-delivery",
        ownerId: actor.id,
        reminderId: expired.id,
        dedupeKey: "expired",
        occurrenceAt: now.toISOString(),
        status: "sent",
        idempotencyKey: "expired-key",
        channel: "email",
        providerId: null,
        startedAt: now.toISOString(),
        sentAt: now.toISOString(),
        error: null
      },
      {
        id: "live-delivery",
        ownerId: actor.id,
        reminderId: live.id,
        dedupeKey: "live",
        occurrenceAt: now.toISOString(),
        status: "sent",
        idempotencyKey: "live-key",
        channel: "email",
        providerId: null,
        startedAt: now.toISOString(),
        sentAt: now.toISOString(),
        error: null
      },
      {
        id: "digest",
        ownerId: actor.id,
        reminderId: null,
        dedupeKey: "digest",
        occurrenceAt: now.toISOString(),
        status: "sent",
        idempotencyKey: "digest-key",
        channel: "email",
        providerId: null,
        startedAt: now.toISOString(),
        sentAt: now.toISOString(),
        error: null
      }
    );
    const cutoff = new Date(now.getTime() - REMOVE_RETAIN_MS).toISOString();
    expect(await store.purgeRemoved(cutoff)).toBe(1);
    expect(store.reminders.map((row) => row.id).sort()).toEqual([live.id, recent.id].sort());
    expect(store.deliveries.map((row) => row.id).sort()).toEqual(["digest", "live-delivery"]);
    expect(await store.purgeRemoved(cutoff)).toBe(0);
    expect(store.reminders).toHaveLength(2);
    await store.deleteOwnerData(actor.id);
    expect(store.reminders).toHaveLength(0);
    expect(store.deliveries).toHaveLength(0);
  });

  it("refuses another user's remove and restore, and removed rows do not count toward the cap", async () => {
    const store = new MemoryFillipStore();
    free(store, actor);
    free(store, other);
    const mine = await setReminder(store, actor, { what: "Mine", when: "tomorrow at 9am", timezone: "UTC" }, now);
    await expect(removeReminder(store, other.id, mine.id, now)).rejects.toThrow(/Reminder not found/);
    expect((await store.getReminder(actor.id, mine.id))?.status).toBe("active");
    await removeReminder(store, actor.id, mine.id, now);
    const stamp = (await store.getReminder(actor.id, mine.id))?.removedAt;
    await removeReminder(store, actor.id, mine.id, new Date(now.getTime() + 60_000));
    expect((await store.getReminder(actor.id, mine.id))?.removedAt).toBe(stamp);
    await expect(restoreReminder(store, other.id, mine.id, now)).rejects.toThrow(/Reminder not found/);

    const ids = [mine.id];
    for (let index = 0; index < FREE_OPEN_REMINDERS - 1; index += 1) {
      const extra = await setReminder(store, actor, { what: `Open ${index}`, when: "tomorrow at 9am", timezone: "UTC" }, now);
      ids.push(extra.id);
    }
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS - 1);
    const room = await setReminder(store, actor, { what: "Fills the cap", when: "tomorrow at 9am", timezone: "UTC" }, now);
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
    await expect(setReminder(store, actor, { what: "Over", when: "tomorrow at 9am", timezone: "UTC" }, now)).rejects.toThrow(/The free plan allows/);
    await expect(restoreReminder(store, actor.id, mine.id, now)).rejects.toBeInstanceOf(OpenCapError);
    await expect(restoreReminder(store, actor.id, mine.id, now)).rejects.toThrow(freeOpenMessage(FREE_OPEN_REMINDERS));
    await removeReminder(store, actor.id, room.id, now);
    const restored = await restoreReminder(store, actor.id, mine.id, now);
    expect(restored.id).toBe(mine.id);
    expect(restored.status).toBe("active");
    expect(await store.countActive(actor.id)).toBe(FREE_OPEN_REMINDERS);
    expect(ids).toContain(mine.id);
  });
});
