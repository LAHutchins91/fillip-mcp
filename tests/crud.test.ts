import { describe, expect, it } from "vitest";
import { MemoryFillipStore } from "../src/lib/memory-store.js";
import { completeOrCancel, followUp, listReminders, saveDigestSettings, setReminder, snoozeOrReschedule } from "../src/lib/reminders.js";
import { WhenError } from "../src/lib/time.js";
import { MAX_ACTIVE_REMINDERS, type Actor, type Reminder } from "../src/lib/types.js";
import { ALLOWANCE_REACHED, monthStart } from "../src/lib/usage.js";

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
    const saved = await store.getReminder(actor.id, follow.id);
    expect(saved?.recurrence).toEqual({ kind: "weekdays", hour: 9, minute: 0 });
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

  it("saves and disables a daily summary", async () => {
    const store = storeWithActor();
    const on = await saveDigestSettings(store, actor, { enabled: true, time: "8am", timezone: "America/New_York" }, now);
    expect(on.enabled).toBe(true);
    expect(on.hour).toBe(8);
    expect(store.contacts.get(actor.id)?.unsubscribed).toBe(false);
    const off = await saveDigestSettings(store, actor, { enabled: false }, now);
    expect(off.enabled).toBe(false);
  });
});
