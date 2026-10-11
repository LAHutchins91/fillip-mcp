import { assertSingleRecipient, ProviderQuotaError, type MailSender, type OutboundEmail } from "./email.js";
import type { ServiceStore } from "./store.js";
import { signStopToken } from "./stop-token.js";
import { nextFire } from "./time.js";
import type { DigestSettings, OwnerContact, Reminder } from "./types.js";
import { allowanceFor, monthStart, nextMonthStart, type TierCaps } from "./usage.js";
import { formatClock, formatWhen, localDateKey, zonedParts } from "./zone.js";

export type GlobalEmailLimits = { perDay: number; perMonth: number };

export type GlobalEmailSnapshot = {
  daySent: number;
  dayLimit: number;
  monthSent: number;
  monthLimit: number;
  dayResetsAt: string;
  monthResetsAt: string;
  stopped: boolean;
  close: boolean;
  reason: "day" | "month" | "provider" | null;
};

export type JobReport = {
  sent: number;
  skipped: number;
  failed: number;
  deferred: number;
  digests: number;
  global: GlobalEmailSnapshot;
};

/** How long to wait after Resend returns 429 or a quota error before trying again. */
export const PROVIDER_BACKOFF_MS = 15 * 60 * 1000;

export function globalEmailLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): GlobalEmailLimits {
  const read = (name: string) => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === "") return 0;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return 0;
    return Math.floor(value);
  };
  return {
    perDay: read("FILLIP_GLOBAL_MAX_EMAILS_PER_DAY"),
    perMonth: read("FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH")
  };
}

export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextUtcDay(now: Date): Date {
  return new Date(utcDayStart(now).getTime() + 24 * 60 * 60 * 1000);
}

function globalClose(sent: number, limit: number): boolean {
  if (limit <= 0) return true;
  return limit - sent <= Math.max(1, Math.ceil(limit * 0.1));
}

export async function readGlobalEmailSnapshot(store: ServiceStore, now: Date, limits: GlobalEmailLimits): Promise<GlobalEmailSnapshot> {
  const daySent = await store.countAllSentSince(utcDayStart(now).toISOString());
  const monthSent = await store.countAllSentSince(monthStart(now).toISOString());
  const dayHit = daySent >= limits.perDay;
  const monthHit = monthSent >= limits.perMonth;
  return {
    daySent,
    dayLimit: limits.perDay,
    monthSent,
    monthLimit: limits.perMonth,
    dayResetsAt: nextUtcDay(now).toISOString(),
    monthResetsAt: nextMonthStart(now).toISOString(),
    stopped: dayHit || monthHit,
    close: globalClose(daySent, limits.perDay) || globalClose(monthSent, limits.perMonth),
    reason: monthHit ? "month" : dayHit ? "day" : null
  };
}

const STALE_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function sentThisPeriod(contact: OwnerContact, now: Date): number {
  const start = monthStart(now).toISOString();
  if (!contact.emailPeriodStart || contact.emailPeriodStart < start) return 0;
  return contact.emailsSentInPeriod;
}

async function noteSent(store: ServiceStore, contact: OwnerContact, now: Date) {
  const emailPeriodStart = monthStart(now).toISOString();
  const emailsSentInPeriod = sentThisPeriod(contact, now) + 1;
  contact.emailsSentInPeriod = emailsSentInPeriod;
  contact.emailPeriodStart = emailPeriodStart;
  await store.saveUsage(contact.id, { emailsSentInPeriod, emailPeriodStart });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] ?? ch));
}

function stopLink(appBaseUrl: string, userId: string, secret: string, now: Date) {
  const token = signStopToken(userId, secret, now.getTime());
  return `${appBaseUrl.replace(/\/$/, "")}/stop?token=${encodeURIComponent(token)}`;
}

function messageForReminder(reminder: Reminder, from: string, to: string, stopUrl: string): OutboundEmail {
  const when = formatWhen(new Date(reminder.fireAt), reminder.timezone);
  const subject = `Fillip: ${reminder.what}`.slice(0, 140);
  const context = reminder.context ? `\n\n${reminder.context}` : "";
  const text = [
    "Fillip, reminders that fire.",
    "",
    reminder.what,
    context,
    "",
    `Due ${when}.`,
    "",
    "This ping goes only to the verified address on your Fillip account.",
    `Stop these emails: ${stopUrl}`,
    "Setting another reminder turns them back on."
  ].join("\n");
  const html = `<p><strong>Fillip, reminders that fire.</strong></p><p>${escapeHtml(reminder.what)}</p>${reminder.context ? `<p>${escapeHtml(reminder.context)}</p>` : ""}<p>Due ${escapeHtml(when)}.</p><p>This ping goes only to the verified address on your Fillip account.</p><p><a href="${escapeHtml(stopUrl)}">Stop these emails</a>. Setting another reminder turns them back on.</p>`;
  return {
    from,
    to,
    subject,
    text,
    html,
    idempotencyKey: `fillip/${reminder.id}/${reminder.fireAt}`,
    headers: {
      "List-Unsubscribe": `<${stopUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
    }
  };
}

async function advanceIfSent(store: ServiceStore, reminder: Reminder, occurrenceAt: string, now: Date) {
  if (reminder.fireAt !== occurrenceAt || reminder.status !== "active") return;
  if (reminder.recurrence) {
    const next = nextFire(reminder.recurrence, reminder.timezone, new Date(occurrenceAt));
    await store.saveReminder({ ...reminder, fireAt: next.toISOString(), holdUntil: null, updatedAt: now.toISOString() });
    return;
  }
  await store.saveReminder({ ...reminder, status: "fired", holdUntil: null, updatedAt: now.toISOString() });
}

export async function runDueJob(options: {
  store: ServiceStore;
  sender: MailSender;
  now: Date;
  from: string;
  appBaseUrl: string;
  unsubscribeSecret: string;
  maxEmailsPerUserPerDay: number;
  maxSends: number;
  minIntervalMs: number;
  caps: TierCaps;
  global: GlobalEmailLimits;
  warn?: (message: string) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<JobReport> {
  if (!options.from.trim()) throw new Error("Sender identity is not configured");
  if (!options.unsubscribeSecret.trim()) throw new Error("Unsubscribe secret is not configured");
  const nowIso = options.now.toISOString();
  const since = new Date(options.now.getTime() - DAY_MS).toISOString();
  const staleBefore = new Date(options.now.getTime() - STALE_MS).toISOString();
  const due = await options.store.listDue(nowIso, Math.max(options.maxSends, 1) * 3);
  const global = await readGlobalEmailSnapshot(options.store, options.now, options.global);
  const report: JobReport = { sent: 0, skipped: 0, failed: 0, deferred: 0, digests: 0, global };
  let providerCalls = 0;
  let warned = false;
  let providerHold: string | null = null;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const note = (message: string) => {
    if (warned) return;
    warned = true;
    warn(message);
  };
  const guardText = () => `Fillip global email guard: ${global.daySent} of ${global.dayLimit} emails sent today, ${global.monthSent} of ${global.monthLimit} this month. Due reminders stay queued until the window resets.`;

  const refreshStop = () => {
    const monthHit = global.monthSent >= global.monthLimit;
    const dayHit = global.daySent >= global.dayLimit;
    global.stopped = monthHit || dayHit;
    global.close = globalClose(global.daySent, global.dayLimit) || globalClose(global.monthSent, global.monthLimit);
    global.reason = providerHold ? "provider" : monthHit ? "month" : dayHit ? "day" : null;
  };

  const holdActive = async (until: string) => {
    for (const reminder of due) {
      const current = await options.store.getReminder(reminder.ownerId, reminder.id);
      if (!current || current.status !== "active") continue;
      const holdUntil = current.holdUntil && current.holdUntil > until ? current.holdUntil : until;
      if (current.holdUntil === holdUntil) continue;
      await options.store.saveReminder({ ...current, status: "active", holdUntil, updatedAt: nowIso });
    }
  };

  const beginProviderBackoff = async () => {
    providerHold = new Date(options.now.getTime() + PROVIDER_BACKOFF_MS).toISOString();
    await options.store.setProviderBackoffUntil(providerHold);
    refreshStop();
    note(`Fillip email provider returned a quota or rate limit. Backing off until ${providerHold}. Due reminders stay queued and were not marked sent. ${guardText()}`);
    await holdActive(providerHold);
  };

  if (global.dayLimit <= 0 || global.monthLimit <= 0) {
    note("Fillip global email guard is closed because FILLIP_GLOBAL_MAX_EMAILS_PER_DAY or FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH is not set. Due reminders stay queued.");
  } else if (global.stopped) {
    note(guardText());
  } else if (global.close) {
    note(`Fillip global email guard is close. ${guardText()}`);
  }

  const existingBackoff = await options.store.getProviderBackoffUntil();
  if (existingBackoff && existingBackoff > nowIso) {
    providerHold = existingBackoff;
    refreshStop();
    note(`Fillip email provider asked for a backoff until ${existingBackoff}. Due reminders stay queued and were not marked sent. ${guardText()}`);
    await holdActive(existingBackoff);
    return report;
  }

  if (global.stopped) {
    const until = global.reason === "month" ? global.monthResetsAt : global.dayResetsAt;
    await holdActive(until);
    return report;
  }

  const pause = async () => {
    if (providerCalls > 0 && options.minIntervalMs > 0) {
      await (options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(options.minIntervalMs);
    }
  };
  const takeSlot = async () => {
    await pause();
    providerCalls += 1;
  };

  for (const reminder of due) {
    if (providerCalls >= options.maxSends) break;
    let contact: Awaited<ReturnType<ServiceStore["getContact"]>> = null;
    try {
      contact = await options.store.getContact(reminder.ownerId);
    } catch {
      report.failed += 1;
      continue;
    }
    if (!contact || contact.unsubscribed || !contact.emailVerified || !contact.email) {
      if (contact && !contact.emailVerified) {
        await options.store.saveReminder({
          ...reminder,
          holdUntil: new Date(options.now.getTime() + DAY_MS).toISOString(),
          updatedAt: nowIso
        });
      }
      report.skipped += 1;
      continue;
    }
    const allowance = allowanceFor(contact, options.now, options.caps);
    if (allowance.reached) {
      await options.store.saveReminder({
        ...reminder,
        holdUntil: nextMonthStart(options.now).toISOString(),
        updatedAt: nowIso
      });
      report.deferred += 1;
      continue;
    }
    const sentToday = await options.store.countSentSince(reminder.ownerId, since);
    if (sentToday >= options.maxEmailsPerUserPerDay) {
      await options.store.saveReminder({
        ...reminder,
        holdUntil: new Date(options.now.getTime() + DAY_MS).toISOString(),
        updatedAt: nowIso
      });
      report.deferred += 1;
      continue;
    }
    refreshStop();
    if (global.stopped) {
      note(guardText());
      const until = global.reason === "month" ? global.monthResetsAt : global.dayResetsAt;
      await holdActive(until);
      break;
    }
    const to = assertSingleRecipient(contact.email);
    const idempotencyKey = `fillip/${reminder.id}/${reminder.fireAt}`;
    const claim = await options.store.claimDelivery({
      ownerId: reminder.ownerId,
      reminderId: reminder.id,
      dedupeKey: `reminder:${reminder.id}:${reminder.fireAt}`,
      occurrenceAt: reminder.fireAt,
      idempotencyKey,
      nowIso,
      staleBeforeIso: staleBefore
    });
    if (claim.outcome === "already-sent") {
      await advanceIfSent(options.store, reminder, reminder.fireAt, options.now);
      report.skipped += 1;
      continue;
    }
    if (claim.outcome === "in-progress") {
      report.skipped += 1;
      continue;
    }
    const stopUrl = stopLink(options.appBaseUrl, reminder.ownerId, options.unsubscribeSecret, options.now);
    const message = messageForReminder(reminder, options.from, to, stopUrl);
    try {
      await takeSlot();
      const result = await options.sender.send(message);
      await options.store.saveDelivery({
        ...claim.delivery,
        status: "sent",
        providerId: result.id,
        sentAt: nowIso,
        error: null
      });
      await noteSent(options.store, contact, options.now);
      global.daySent += 1;
      global.monthSent += 1;
      refreshStop();
      await advanceIfSent(options.store, reminder, reminder.fireAt, options.now);
      report.sent += 1;
    } catch (error) {
      if (error instanceof ProviderQuotaError) {
        await options.store.saveDelivery({
          ...claim.delivery,
          status: "failed",
          error: "provider backoff",
          providerId: null,
          sentAt: null,
          startedAt: nowIso
        });
        await beginProviderBackoff();
        report.deferred += 1;
        break;
      }
      await options.store.saveDelivery({
        ...claim.delivery,
        status: "failed",
        error: "send failed",
        startedAt: nowIso
      });
      report.failed += 1;
    }
  }

  if (!providerHold && !global.stopped && providerCalls < options.maxSends) {
    const digests = await options.store.listEnabledDigests();
    for (const digest of digests) {
      if (providerCalls >= options.maxSends || providerHold || global.stopped) break;
      let outcome: "sent" | "skipped" | "failed" | "deferred" = "failed";
      try {
        outcome = await sendDigest(options, digest, since, staleBefore, nowIso, takeSlot, () => {
          global.daySent += 1;
          global.monthSent += 1;
          refreshStop();
        });
      } catch (error) {
        if (error instanceof ProviderQuotaError) {
          await beginProviderBackoff();
          report.deferred += 1;
          break;
        }
        outcome = "failed";
      }
      if (outcome === "sent") {
        report.sent += 1;
        report.digests += 1;
      } else if (outcome === "failed") report.failed += 1;
      else if (outcome === "deferred") report.deferred += 1;
      else report.skipped += 1;
    }
  }
  return report;
}

async function sendDigest(
  options: {
    store: ServiceStore;
    sender: MailSender;
    now: Date;
    from: string;
    appBaseUrl: string;
    unsubscribeSecret: string;
    maxEmailsPerUserPerDay: number;
    caps: TierCaps;
    global: GlobalEmailLimits;
  },
  digest: DigestSettings,
  since: string,
  staleBefore: string,
  nowIso: string,
  beginSend: () => Promise<void>,
  onSent: () => void
): Promise<"sent" | "skipped" | "failed" | "deferred"> {
  const parts = zonedParts(options.now, digest.timezone);
  const minutesNow = parts.hour * 60 + parts.minute;
  const minutesDue = digest.hour * 60 + digest.minute;
  const today = localDateKey(options.now, digest.timezone);
  if (minutesNow < minutesDue || digest.lastSentOn === today) return "skipped";
  const contact = await options.store.getContact(digest.ownerId);
  if (!contact || contact.unsubscribed || !contact.emailVerified || !contact.email) return "skipped";
  if (options.global.perDay <= 0 || options.global.perMonth <= 0) return "deferred";
  if (allowanceFor(contact, options.now, options.caps).reached) return "deferred";
  const sentToday = await options.store.countSentSince(digest.ownerId, since);
  if (sentToday >= options.maxEmailsPerUserPerDay) return "deferred";
  const rows = await options.store.listReminders(digest.ownerId, { status: "active" });
  const todays = rows.filter((row) => localDateKey(new Date(row.fireAt), digest.timezone) === today || row.fireAt <= nowIso);
  if (!todays.length) {
    await options.store.saveDigest({ ...digest, lastSentOn: today, updatedAt: nowIso });
    return "skipped";
  }
  const to = assertSingleRecipient(contact.email);
  const idempotencyKey = `fillip/digest/${digest.ownerId}/${today}`;
  const claim = await options.store.claimDelivery({
    ownerId: digest.ownerId,
    reminderId: null,
    dedupeKey: `digest:${digest.ownerId}:${today}`,
    occurrenceAt: `${today}T${String(digest.hour).padStart(2, "0")}:${String(digest.minute).padStart(2, "0")}:00.000Z`,
    idempotencyKey,
    nowIso,
    staleBeforeIso: staleBefore
  });
  if (claim.outcome !== "send") {
    if (claim.outcome === "already-sent" && digest.lastSentOn !== today) {
      await options.store.saveDigest({ ...digest, lastSentOn: today, updatedAt: nowIso });
    }
    return "skipped";
  }
  const stopUrl = stopLink(options.appBaseUrl, digest.ownerId, options.unsubscribeSecret, options.now);
  const lines = todays.map((row) => `- ${row.what} (${formatWhen(new Date(row.fireAt), row.timezone)})`);
  const text = [
    "Fillip, reminders that fire.",
    "",
    `Daily summary for ${today}, ${formatClock(digest.hour, digest.minute)}.`,
    "",
    ...lines,
    "",
    "This summary goes only to the verified address on your Fillip account.",
    `Stop these emails: ${stopUrl}`
  ].join("\n");
  try {
    await beginSend();
    const result = await options.sender.send({
      from: options.from,
      to,
      subject: "Fillip: today's reminders",
      text,
      html: `<p><strong>Fillip, reminders that fire.</strong></p><p>Daily summary for ${escapeHtml(today)}.</p><ul>${todays.map((row) => `<li>${escapeHtml(row.what)} (${escapeHtml(formatWhen(new Date(row.fireAt), row.timezone))})</li>`).join("")}</ul><p><a href="${escapeHtml(stopUrl)}">Stop these emails</a></p>`,
      idempotencyKey,
      headers: {
        "List-Unsubscribe": `<${stopUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click"
      }
    });
    await options.store.saveDelivery({ ...claim.delivery, status: "sent", providerId: result.id, sentAt: nowIso, error: null });
    await noteSent(options.store, contact, options.now);
    onSent();
    await options.store.saveDigest({ ...digest, lastSentOn: today, updatedAt: nowIso });
    return "sent";
  } catch (error) {
    await options.store.saveDelivery({
      ...claim.delivery,
      status: "failed",
      error: error instanceof ProviderQuotaError ? "provider backoff" : "send failed",
      sentAt: null,
      startedAt: nowIso
    });
    if (error instanceof ProviderQuotaError) throw error;
    return "failed";
  }
}
