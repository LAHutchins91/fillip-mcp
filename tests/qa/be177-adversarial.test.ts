/**
 * QA against be177c95: adversarial pass. QA-FAIL marks a test that asserts promised behavior.
 */
import { describe, expect, it, vi } from "vitest";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { completeOrCancel, removeReminder, restoreReminder, setReminder, snoozeOrReschedule } from "../../src/lib/reminders.js";
import type { Actor, Recurrence } from "../../src/lib/types.js";
import { blankContact } from "../../src/lib/usage.js";
import { zonedParts } from "../../src/lib/zone.js";

const A: Actor = { id: "11111111-1111-4111-8111-111111111111", email: "a@example.com", emailVerified: true };
const B: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "b@example.com", emailVerified: true };
const SECRET = "re_SUPERSECRET_" + "x".repeat(24);

class Rec implements MailSender {
  sent: OutboundEmail[] = [];
  fail: Error | null = null;
  async send(m: OutboundEmail) { if (this.fail) throw this.fail; this.sent.push(m); return { id: `e${this.sent.length}` }; }
}
function job(store: MemoryFillipStore, sender: MailSender, at: Date, warn?: (m: string) => void) {
  return runDueJob({ store, sender, now: at, from: "Fillip <r@example.com>", appBaseUrl: "https://fillip.example",
    unsubscribeSecret: "unsub", maxEmailsPerUserPerDay: 20, maxSends: 40, minIntervalMs: 0,
    caps: { trialEmailsPerMonth: 100, proEmailsPerMonth: 100, annualEmailsPerMonth: 100 },
    global: { perDay: 1000, perMonth: 1000 }, telegram: null, ...(warn ? { warn } : {}) } as Parameters<typeof runDueJob>[0]);
}
async function arm(store: MemoryFillipStore, who: Actor) {
  const c = blankContact(who.id, { email: who.email, emailVerified: true, plan: "pro", subscriptionStatus: "active", unsubscribed: false });
  const s = store as unknown as { saveContact?: (c: unknown) => Promise<unknown>; upsertContact?: (c: unknown) => Promise<unknown>; contacts?: Map<string, unknown> };
  if (s.saveContact) await s.saveContact(c); else if (s.upsertContact) await s.upsertContact(c); else if (s.contacts) s.contacts.set(who.id, c);
}
function clock(iso: string, zone: string) {
  const p = zonedParts(new Date(iso), zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}
async function make(when: string, zone: string, created: string, who = A, store = new MemoryFillipStore()) {
  const r = await setReminder(store, who, { what: when, when, timezone: zone }, new Date(created));
  return { store, id: r.id, row: (await store.getReminder(who.id, r.id))! };
}
const ends = (r: Recurrence | null | undefined) => (r && "ends" in r ? r.ends : undefined);

describe("be177 notes on every repeat type", () => {
  it("QA-PASS: every repeat kind says 'Done. Next reminder:' and never 'today'", async () => {
    const cases = [
      ["every day at 9am", "2026-10-12T12:00:00Z", "2026-10-12T14:00:00Z"],
      ["every weekday at 9am", "2026-10-16T12:00:00Z", "2026-10-16T14:00:00Z"],
      ["every Tuesday at 9am", "2026-10-12T12:00:00Z", "2026-10-13T14:00:00Z"],
      ["every 3 days at 9am", "2026-10-11T12:00:00Z", "2026-10-11T14:00:00Z"],
      ["every 2 weeks on Tuesday at 9am", "2026-10-12T12:00:00Z", "2026-10-13T14:00:00Z"],
      ["the 15th of every month at 9am", "2026-10-14T12:00:00Z", "2026-10-15T14:00:00Z"],
      ["first Monday of every month at 9am", "2026-10-05T12:00:00Z", "2026-10-05T14:00:00Z"]
    ];
    for (const [when, created, done] of cases) {
      const { store, id } = await make(when, "America/New_York", created);
      const v = await completeOrCancel(store, A.id, id, "complete", new Date(done));
      expect(v.note, when).toMatch(/^Done\. Next reminder: /);
      expect(v.note, when).not.toMatch(/today/i);
    }
  });
});

describe("be177 leap days and odd zones", () => {
  it("QA-PASS: the 29th of every month hits Feb 29 in a leap year and Feb 28 otherwise", async () => {
    const leap = await make("the 29th of every month at 9am", "UTC", "2028-01-29T08:00:00Z");
    const feb = await completeOrCancel(leap.store, A.id, leap.id, "complete", new Date("2028-01-29T10:00:00Z"));
    expect(clock(feb.fireAt, "UTC")).toBe("2028-02-29 09:00");
    const mar = await completeOrCancel(leap.store, A.id, leap.id, "complete", new Date("2028-02-29T10:00:00Z"));
    expect(clock(mar.fireAt, "UTC")).toBe("2028-03-29 09:00");
    const plain = await make("the 29th of every month at 9am", "UTC", "2027-01-29T08:00:00Z");
    const feb27 = await completeOrCancel(plain.store, A.id, plain.id, "complete", new Date("2027-01-29T10:00:00Z"));
    expect(clock(feb27.fireAt, "UTC")).toBe("2027-02-28 09:00");
    const mar27 = await completeOrCancel(plain.store, A.id, plain.id, "complete", new Date("2027-02-28T10:00:00Z"));
    expect(clock(mar27.fireAt, "UTC")).toBe("2027-03-29 09:00");
  });
  it("QA-PASS: every 2 days walks through Feb 29 2028", async () => {
    const s = await make("every 2 days at 9am", "UTC", "2028-02-27T08:00:00Z");
    expect(clock(s.row.fireAt, "UTC")).toBe("2028-02-27 09:00");
    const n = await completeOrCancel(s.store, A.id, s.id, "complete", new Date("2028-02-27T10:00:00Z"));
    expect(clock(n.fireAt, "UTC")).toBe("2028-02-29 09:00");
    const n2 = await completeOrCancel(s.store, A.id, s.id, "complete", new Date("2028-02-29T10:00:00Z"));
    expect(clock(n2.fireAt, "UTC")).toBe("2028-03-02 09:00");
  });
  it("QA-FAIL: current IANA names (Asia/Kolkata, Asia/Kathmandu, Europe/Kyiv, Asia/Ho_Chi_Minh) are accepted", async () => {
    for (const tz of ["Asia/Kolkata", "Asia/Kathmandu", "Europe/Kyiv", "Asia/Ho_Chi_Minh", "America/Argentina/Buenos_Aires"]) {
      const k = await make("every day at 9am", tz, "2026-10-12T00:00:00Z");
      expect(clock(k.row.fireAt, tz).slice(11), tz).toBe("09:00");
    }
  });
  it("QA-PASS: Lord Howe (30-minute DST shift on Oct 4 2026) keeps 9:00 local", async () => {
    const lh = await make("every day at 9am", "Australia/Lord_Howe", "2026-10-02T20:00:00Z");
    let at = lh.row.fireAt;
    for (let i = 0; i < 4; i++) {
      const v = await completeOrCancel(lh.store, A.id, lh.id, "complete", new Date(new Date(at).getTime() + 60000));
      expect(clock(v.fireAt, "Australia/Lord_Howe").slice(11)).toBe("09:00");
      at = v.fireAt;
    }
  });
  it("QA-PASS: an unknown or offset-only timezone is refused", async () => {
    const store = new MemoryFillipStore();
    for (const tz of ["Mars/Olympus", "", "../../etc/passwd"]) {
      await expect(setReminder(store, A, { what: "x", when: "tomorrow at 9am", timezone: tz }, new Date("2026-10-12T00:00:00Z"))).rejects.toThrow();
    }
  });
});

describe("be177 until and count limits", () => {
  it("QA-PASS: a count of 1 finishes on the first complete and a second complete does not reopen it", async () => {
    const c = await make("every day at 9am for 1 times", "UTC", "2026-10-12T08:00:00Z");
    const one = await completeOrCancel(c.store, A.id, c.id, "complete", new Date("2026-10-12T10:00:00Z"));
    expect(one.status).toBe("completed");
    const again = await completeOrCancel(c.store, A.id, c.id, "complete", new Date("2026-10-13T10:00:00Z")).catch((e) => e);
    const row = await c.store.getReminder(A.id, c.id);
    expect(row?.status).toBe("completed");
    expect(again instanceof Error || again.status === "completed").toBe(true);
  });
  it("QA-PASS: the due job sends a 3-count series exactly 3 times and stops", async () => {
    const c = await make("every day at 9am for 3 times", "UTC", "2026-10-12T08:00:00Z");
    await arm(c.store, A);
    const s = new Rec();
    for (let d = 12; d <= 17; d++) await job(c.store, s, new Date(`2026-10-${d}T09:01:00Z`));
    expect(s.sent.length).toBe(3);
    const row = await c.store.getReminder(A.id, c.id);
    expect(["completed", "fired"]).toContain(row?.status);
  });
  it("QA-PASS: an until that falls exactly on an occurrence excludes it", async () => {
    const c = await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z");
    const r = c.row;
    const until = "2026-10-14T09:00:00.000Z";
    (r.recurrence as { ends?: unknown }).ends = { until, count: null, completed: 0 };
    await c.store.saveReminder(r);
    await completeOrCancel(c.store, A.id, c.id, "complete", new Date("2026-10-12T10:00:00Z"));
    const last = await completeOrCancel(c.store, A.id, c.id, "complete", new Date("2026-10-13T10:00:00Z"));
    expect(last.status).toBe("completed");
    expect(ends((await c.store.getReminder(A.id, c.id))?.recurrence)?.until).toBe(until);
  });
});

describe("be177 stopped reminders never send", () => {
  it("QA-PASS: paused, cancelled, removed, and end_series rows are skipped by the due job", async () => {
    const store = new MemoryFillipStore();
    await arm(store, A);
    const p = await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z", A, store);
    const c = await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z", A, store);
    const r = await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z", A, store);
    const e = await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z", A, store);
    await snoozeOrReschedule(store, A.id, p.id, undefined, undefined, new Date("2026-10-12T08:10:00Z"), "pause" as never).catch(async () => {
      const row = (await store.getReminder(A.id, p.id))!; await store.saveReminder({ ...row, status: "paused" });
    });
    await completeOrCancel(store, A.id, c.id, "cancel", new Date("2026-10-12T08:10:00Z"));
    await removeReminder(store, A.id, r.id, new Date("2026-10-12T08:10:00Z"));
    await completeOrCancel(store, A.id, e.id, "complete", new Date("2026-10-12T08:10:00Z"), true);
    const s = new Rec();
    await job(store, s, new Date("2026-10-12T09:05:00Z"));
    await job(store, s, new Date("2026-10-13T09:05:00Z"));
    expect(s.sent.length).toBe(0);
  });
  it("QA-PASS: a restored cancelled reminder still does not send", async () => {
    const store = new MemoryFillipStore();
    await arm(store, A);
    const c = await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z", A, store);
    await completeOrCancel(store, A.id, c.id, "cancel", new Date("2026-10-12T08:10:00Z"));
    await removeReminder(store, A.id, c.id, new Date("2026-10-12T08:20:00Z"));
    const back = await restoreReminder(store, A.id, c.id, new Date("2026-10-12T08:30:00Z"));
    expect(back.status).toBe("cancelled");
    const s = new Rec();
    await job(store, s, new Date("2026-10-12T09:05:00Z"));
    expect(s.sent.length).toBe(0);
  });
});

describe("be177 tenant isolation", () => {
  it("QA-PASS: user B cannot complete, cancel, snooze, remove, restore or read user A's reminder", async () => {
    const a = await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z");
    const now = new Date("2026-10-12T08:30:00Z");
    const before = JSON.stringify(await a.store.getReminder(A.id, a.id));
    await expect(completeOrCancel(a.store, B.id, a.id, "complete", now)).rejects.toThrow();
    await expect(completeOrCancel(a.store, B.id, a.id, "cancel", now)).rejects.toThrow();
    await expect(completeOrCancel(a.store, B.id, a.id, "complete", now, true)).rejects.toThrow();
    await expect(snoozeOrReschedule(a.store, B.id, a.id, "tomorrow at 10am", "UTC", now)).rejects.toThrow();
    await expect(removeReminder(a.store, B.id, a.id, now)).rejects.toThrow();
    await expect(restoreReminder(a.store, B.id, a.id, now)).rejects.toThrow();
    expect(await a.store.getReminder(B.id, a.id)).toBeFalsy();
    expect(JSON.stringify(await a.store.getReminder(A.id, a.id))).toBe(before);
  });
});

describe("be177 secret leaks", () => {
  it("QA-PASS: a provider error carrying an API key is not logged or stored", async () => {
    const store = new MemoryFillipStore();
    await arm(store, A);
    await make("every day at 9am", "UTC", "2026-10-12T08:00:00Z", A, store);
    const s = new Rec();
    s.fail = new Error(`401 invalid key ${SECRET} Authorization: Bearer ${SECRET}`);
    const lines: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(" ")); }));
    try {
      const result = await job(store, s, new Date("2026-10-12T09:05:00Z"), (m) => lines.push(m));
      lines.push(JSON.stringify(result ?? null));
    } finally { spies.forEach((x) => x.mockRestore()); }
    const st = store as unknown as Record<string, unknown>;
    const dump = JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v instanceof Map ? [...v.values()] : v])));
    expect(lines.join("\n")).not.toContain("SUPERSECRET");
    expect(dump).not.toContain("SUPERSECRET");
  });
});
