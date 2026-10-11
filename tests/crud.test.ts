import { describe, expect, it } from "vitest";
import { MemoryFillipStore } from "../src/lib/memory-store.js";
import { completeOrCancel, followUp, listReminders, saveDigestSettings, setReminder, snoozeOrReschedule } from "../src/lib/reminders.js";
import { WhenError } from "../src/lib/time.js";
import { MAX_ACTIVE_REMINDERS, type Actor, type Reminder } from "../src/lib/types.js";
import { ALLOWANCE_REACHED, freeEmailsPerMonth, freeOpenMessage, freeOpenReminders, monthStart, tierCapsFromEnv, UPGRADE_PROMPT } from "../src/lib/usage.js";

const now = new Date("2026-10-11T18:00:00.000Z");
const actor: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com", emailVerified: true };

function storeWithActor() {
  return new MemoryFillipStore();
}

describe("reminder CRUD", () => {
  it("sets, lists, snoozes, completes, and cancels", async () => {
    const store = storeWithActor();
    const created = await setReminder(store, actor, {
      what: "Follow up with Ada",
      when: "next Tue 2pm",
      timezone: "America/New_York",
      context: "She asked for the notes"
    }, now);
    expect(created.localTime).toMatch(/October 13, 2026/);
    expect(created.note).toMatch(/verified address/);
    expect(JSON.stringify(created)).not.toContain("owner@example.com");

    const listed = await listReminders(store, actor.id, {}, now);
    expect(listed.map((row) => row.id)).toContain(created.id);

    const moved = await snoozeOrReschedule(store, actor.id, created.id, "tomorrow 9am", "America/New_York", now);
    expect(moved.localTime).toMatch(/October 12, 2026/);
    expect(moved.status).toBe("active");

    const done = await completeOrCancel(store, actor.id, created.id, "complete", now);
    expect(done.status).toBe("completed");
    expect(done.note).toMatch(/stop nudging/);

    const other = await setReminder(store, actor, { what: "Send the draft", when: "in 2 hours", timezone: "America/New_York" }, now);
    const cancelled = await completeOrCancel(store, actor.id, other.id, "cancel", now);
    expect(cancelled.status).toBe("cancelled");
    await expect(snoozeOrReschedule(store, actor.id, other.id, "tomorrow 9am", undefined, now)).rejects.toThrow(/already cancelled/);
  });

  it("keeps a follow-up repeating until it is marked done", async () => {
    const store = storeWithActor();
    const follow = await followUp(store, actor, {
      topic: "Check the contract",
      after: "next Tue 2pm",
      cadence: "every weekday 9am",
      timezone: "America/New_York"
    }, now);
    expect(follow.kind).toBe("follow_up");
    expect(follow.repeats).toMatch(/weekday/);
    expect(follow.note).toMatch(/until you mark it done/);
    const saved = await store.getReminder(actor.id, follow.id);
    expect(saved?.recurrence).toEqual({ kind: "weekdays", hour: 9, minute: 0 });

    const limited = await followUp(store, actor, {
      topic: "Check the contract twice",
      cadence: "every weekday 9am for 2 times",
      timezone: "America/New_York"
    }, now);
    expect(limited.note).toMatch(/stops at that limit even if it is not marked done/);
    expect(limited.repeats).toMatch(/2 times/);

    const until = await followUp(store, actor, {
      topic: "Check the contract through December",
      cadence: "every 2 weeks until Dec",
      timezone: "America/New_York"
    }, now);
    expect(until.note).toMatch(/stops at that limit even if it is not marked done/);
    expect(until.repeats).toMatch(/until/);
  });

  it("rejects a repeat option that conflicts with the words and does not save it", async () => {
    const store = storeWithActor();
    await expect(setReminder(store, actor, {
      what: "Board meeting",
      when: "first Monday of every month",
      timezone: "America/New_York",
      repeat: "weekly"
    }, now)).rejects.toThrow(/conflicts with repeat "weekly"/);
    await expect(setReminder(store, actor, {
      what: "Invoice",
      when: "every 2 weeks until Dec",
      timezone: "America/New_York",
      repeat: "weekly"
    }, now)).rejects.toThrow(/until/);
    expect(store.reminders).toHaveLength(0);

    const kept = await setReminder(store, actor, {
      what: "Monday review",
      when: "every Monday 9am until Dec",
      timezone: "America/New_York",
      repeat: "weekly"
    }, now);
    expect(kept.repeats).toMatch(/Monday/);
    expect(kept.repeats).toMatch(/until/);
  });

  it("pauses a reminder and resumes it onto the next future occurrence", async () => {
    const store = storeWithActor();
    const created = await setReminder(store, actor, {
      what: "Weekly review",
      when: "every Monday 9am",
      timezone: "America/New_York"
    }, now);
    const paused = await snoozeOrReschedule(store, actor.id, created.id, undefined, undefined, now, "pause");
    expect(paused.status).toBe("paused");
    expect(paused.note).toMatch(/will not send/);
    expect(paused.note).toMatch(/paused \(would next send /);
    const found = await listReminders(store, actor.id, { status: "paused" }, now);
    expect(found.map((row) => row.id)).toEqual([created.id]);
    expect(await listReminders(store, actor.id, { status: "active" }, now)).toHaveLength(0);

    const later = new Date("2026-10-20T18:00:00.000Z");
    const resumed = await snoozeOrReschedule(store, actor.id, created.id, undefined, "America/New_York", later, "resume");
    expect(resumed.status).toBe("active");
    expect(new Date(resumed.fireAt).getTime()).toBeGreaterThan(later.getTime());
    expect(resumed.localTime).toMatch(/October 26, 2026/);
    expect(resumed.note).toMatch(/Next ping/);

    const ahead = await setReminder(store, actor, { what: "Still ahead", when: "tomorrow 9am", timezone: "America/New_York" }, now);
    await snoozeOrReschedule(store, actor.id, ahead.id, undefined, undefined, now, "pause");
    const same = await snoozeOrReschedule(store, actor.id, ahead.id, undefined, undefined, now, "resume");
    expect(same.fireAt).toBe(ahead.fireAt);

    const once = await setReminder(store, actor, { what: "One shot", when: "tomorrow 4pm", timezone: "America/New_York" }, now);
    const row = await store.getReminder(actor.id, once.id);
    if (!row) throw new Error("missing reminder");
    await store.saveReminder({ ...row, fireAt: new Date(now.getTime() - 60_000).toISOString(), status: "paused" });
    await expect(snoozeOrReschedule(store, actor.id, once.id, undefined, undefined, now, "resume"))
      .rejects.toThrow(/one-time reminder is already in the past/);
    await expect(snoozeOrReschedule(store, actor.id, created.id, undefined, undefined, now))
      .rejects.toThrow(/Name a time to move this reminder/);
  });

  it("rejects a wrong year and does not save it", async () => {
    const store = storeWithActor();
    await expect(setReminder(store, actor, {
      what: "Old year",
      when: "October 13, 2024 at 2pm",
      timezone: "America/New_York"
    }, now)).rejects.toBeInstanceOf(WhenError);
    expect(store.reminders).toHaveLength(0);
  });

  it("corrects a past month-day that omitted the year", async () => {
    const store = storeWithActor();
    const created = await setReminder(store, actor, {
      what: "Annual check",
      when: "October 1 at 2pm",
      timezone: "America/New_York"
    }, now);
    expect(created.corrected).toBe(true);
    expect(created.localTime).toMatch(/2027/);
  });

  it("refuses an account without a verified email", async () => {
    const store = storeWithActor();
    await expect(setReminder(store, { ...actor, emailVerified: false }, {
      what: "Nope",
      when: "tomorrow 9am",
      timezone: "America/New_York"
    }, now)).rejects.toThrow(/verified account email/);
  });

  it("caps how many open reminders one account can hold", async () => {
    const store = storeWithActor();
    const seed = await setReminder(store, actor, { what: "Seed", when: "tomorrow 9am", timezone: "UTC" }, now);
    const template = await store.getReminder(actor.id, seed.id);
    if (!template) throw new Error("missing seed");
    for (let i = store.reminders.length; i < MAX_ACTIVE_REMINDERS; i += 1) {
      const copy: Reminder = { ...template, id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, createdAt: "2020-01-01T00:00:00.000Z" };
      store.reminders.push(copy);
    }
    await expect(setReminder(store, actor, { what: "One more", when: "tomorrow 9am", timezone: "UTC" }, now)).rejects.toThrow(/Too many reminders are still open/);
  });

  it("refuses another reminder when the monthly allowance is used up", async () => {
    const store = storeWithActor();
    await store.rememberOwner({
      id: actor.id,
      email: actor.email,
      emailVerified: true,
      plan: "pro",
      subscriptionStatus: "active"
    });
    const contact = store.contacts.get(actor.id);
    if (!contact) throw new Error("missing contact");
    contact.emailsSentInPeriod = 2;
    contact.emailPeriodStart = monthStart(now).toISOString();
    await expect(setReminder(store, actor, {
      what: "One more ping",
      when: "tomorrow 9am",
      timezone: "America/New_York"
    }, now, { trialEmailsPerMonth: 5, proEmailsPerMonth: 2, annualEmailsPerMonth: 9 })).rejects.toThrow(ALLOWANCE_REACHED);
    expect(store.reminders).toHaveLength(0);
  });

  it("keeps a free plan inside its open-reminder cap and says how to upgrade", async () => {
    const store = storeWithActor();
    await store.rememberOwner({
      id: actor.id,
      email: actor.email,
      emailVerified: true,
      plan: "free",
      subscriptionStatus: "none"
    });
    const caps = { trialEmailsPerMonth: 30, proEmailsPerMonth: 60, annualEmailsPerMonth: 60, freeEmailsPerMonth: 30, freeOpenReminders: 2 };
    await setReminder(store, actor, { what: "One", when: "tomorrow 9am", timezone: "UTC" }, now, caps);
    await setReminder(store, actor, { what: "Two", when: "tomorrow 10am", timezone: "UTC" }, now, caps);
    await expect(setReminder(store, actor, { what: "Three", when: "tomorrow 11am", timezone: "UTC" }, now, caps))
      .rejects.toThrow(freeOpenMessage(2));
    await expect(setReminder(store, actor, { what: "Three", when: "tomorrow 11am", timezone: "UTC" }, now, caps))
      .rejects.toThrow(UPGRADE_PROMPT);
    expect(freeOpenReminders(tierCapsFromEnv({}))).toBe(10);
    expect(freeEmailsPerMonth(tierCapsFromEnv({}))).toBe(30);
    expect(tierCapsFromEnv({ FILLIP_CAP_FREE_OPEN_REMINDERS: "4", FILLIP_CAP_FREE_EMAILS_PER_MONTH: "12" }))
      .toMatchObject({ freeOpenReminders: 4, freeEmailsPerMonth: 12 });
  });

  it("shows a delayed state when a reminder is held past its due time", async () => {
    const store = storeWithActor();
    const created = await setReminder(store, actor, { what: "Held ping", when: "tomorrow 9am", timezone: "UTC" }, now);
    const row = await store.getReminder(actor.id, created.id);
    if (!row) throw new Error("missing reminder");
    row.fireAt = new Date(now.getTime() - 3 * 60 * 60 * 1000).toISOString();
    row.holdUntil = new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    await store.saveReminder(row);
    const listed = await listReminders(store, actor.id, {}, now);
    expect(listed[0]?.state).toBe("delayed");
    expect(listed[0]?.delayed).toBe(true);
    expect(listed[0]?.delay).toBe("3 hours");
  });

  it("saves and disables a daily summary", async () => {
    const store = storeWithActor();
    const on = await saveDigestSettings(store, actor, { enabled: true, time: "8am", timezone: "America/New_York" }, now);
    expect(on.enabled).toBe(true);
    expect(on.hour).toBe(8);
    expect(store.contacts.get(actor.id)?.unsubscribed).toBe(false);
    const off = await saveDigestSettings(store, actor, { enabled: false }, now);
    expect(off.enabled).toBe(false);
  });

  it("hides cancelled and completed reminders until include_done, and delete removes deliveries", async () => {
    const store = storeWithActor();
    const open = await setReminder(store, actor, { what: "Still open", when: "tomorrow 9am", timezone: "UTC" }, now);
    const done = await setReminder(store, actor, { what: "Finished", when: "tomorrow 10am", timezone: "UTC" }, now);
    const dropped = await setReminder(store, actor, { what: "Drop me", when: "tomorrow 11am", timezone: "UTC" }, now);
    await completeOrCancel(store, actor.id, done.id, "complete", now);
    await store.saveReminder({ ...(await store.getReminder(actor.id, dropped.id))!, status: "paused" });
    store.deliveries.push({
      id: "delivery-1",
      ownerId: actor.id,
      reminderId: dropped.id,
      dedupeKey: "drop",
      occurrenceAt: now.toISOString(),
      status: "sent",
      idempotencyKey: "drop-key",
      channel: "email",
      providerId: null,
      startedAt: now.toISOString(),
      sentAt: now.toISOString(),
      error: null
    });
    const listed = await listReminders(store, actor.id, {}, now);
    expect(listed.map((row) => row.what).sort()).toEqual(["Drop me", "Still open"]);
    const withDone = await listReminders(store, actor.id, { includeDone: true }, now);
    expect(withDone.map((row) => row.what)).toContain("Finished");
    const removed = await completeOrCancel(store, actor.id, dropped.id, "delete", now);
    expect(removed).toMatchObject({ status: "deleted", what: "Drop me" });
    expect(await store.getReminder(actor.id, dropped.id)).toBeNull();
    expect(store.deliveries.filter((row) => row.reminderId === dropped.id)).toHaveLength(0);
    expect((await listReminders(store, actor.id, {}, now)).map((row) => row.id)).toEqual([open.id]);
  });

  it("changes or removes a repeat and an end date on an existing reminder", async () => {
    const store = storeWithActor();
    const created = await setReminder(store, actor, {
      what: "Standup",
      when: "every weekday 9am until March 31, 2027",
      timezone: "America/New_York"
    }, now);
    expect(created.repeats).toMatch(/March 31, 2027/);
    expect(created.repeats).not.toMatch(/April 1/);
    const weekly = await snoozeOrReschedule(store, actor.id, created.id, undefined, "America/New_York", now, "reschedule", {
      repeat: "every Monday 9am",
      end: "Dec 15, 2026"
    });
    expect(weekly.repeats).toMatch(/Monday/);
    expect(weekly.repeats).toMatch(/December 15, 2026/);
    const cleared = await snoozeOrReschedule(store, actor.id, created.id, undefined, undefined, now, "reschedule", {
      repeat: "once",
      end: "none"
    });
    expect(cleared.repeats).toBe("once");
    await expect(setReminder(store, actor, { what: "Bad", when: "tomorrow 9am", timezone: "UTC", until: "not a date" }, now))
      .rejects.toThrow(/March 31, 2027/);
  });

  it("refuses a missing spring-forward hour unless the caller accepts the shifted time", async () => {
    const store = storeWithActor();
    const at = new Date("2027-03-01T15:00:00.000Z");
    await expect(setReminder(store, actor, {
      what: "Gap",
      when: "2027-03-14 2:30 AM",
      timezone: "America/New_York"
    }, at)).rejects.toBeInstanceOf(WhenError);
    expect(await listReminders(store, actor.id, {}, at)).toHaveLength(0);
    const saved = await setReminder(store, actor, {
      what: "Gap",
      when: "2027-03-14 2:30 AM",
      timezone: "America/New_York",
      acceptShiftedTime: true
    }, at);
    expect(saved.fireAt).toBe("2027-03-14T07:30:00.000Z");
    expect(saved.note).toMatch(/does not exist/);
    expect(saved.note).toMatch(/3:30/);
  });
});
