import { randomUUID } from "node:crypto";
import type { ClaimResult, Delivery, DeliveryChannel, DigestSettings, OwnerContact, OwnerIdentity, PlanName, Recurrence, Reminder, ReminderStatus } from "./types.js";
import { openCapMessage } from "./errors.js";
import { OpenCapError, type ListQuery, type OpenCap, type SendReserve, type SendReserveResult, type ServiceStore } from "./store.js";
import { sentThisMonth, UPGRADE_PROMPT, usagePeriodCurrent } from "./usage.js";
import { zonedParts, zonedTimeToUtc } from "./zone.js";

export type Db = (pathname: string, options?: RequestInit) => Promise<unknown>;

type Mode = "user" | "service";

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

/**
 * An empty HTTP body on `Prefer: return=representation` is not a lost compare-and-swap.
 * PostgREST returns `[]` when the filter matched nothing. A client that accepts the
 * write and sends no body (the HTTP stand-in) is reported with this marker instead.
 */
export const FILLIP_EMPTY_REPRESENTATION = Object.freeze({ fillipEmptyRepresentation: true });

export function isAcknowledgedWrite(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { fillipEmptyRepresentation?: boolean }).fillipEmptyRepresentation === true
  );
}

function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("23505") || message.toLowerCase().includes("duplicate");
}

/** A claim lock older than this is abandoned and can be taken again. Matches the job's stale window. */
const CLAIM_LEASE_MS = 2 * 60 * 1000;

function leaseCutoff(nowIso: string): string {
  return new Date(new Date(nowIso).getTime() - CLAIM_LEASE_MS).toISOString();
}

function localMonthStartIso(now: Date, timeZone: string): string {
  const parts = zonedParts(now, timeZone);
  return zonedTimeToUtc(parts.year, parts.month, 1, 0, 0, timeZone).toISOString();
}

type ReminderRow = {
  id: string;
  owner_id: string;
  kind: Reminder["kind"];
  what: string;
  context: string | null;
  timezone: string;
  fire_at: string;
  recurrence: Recurrence | null;
  channel?: DeliveryChannel | null;
  status: ReminderStatus;
  hold_until: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type DeliveryRow = {
  id: string;
  owner_id: string;
  reminder_id: string | null;
  dedupe_key: string;
  occurrence_at: string;
  status: Delivery["status"];
  idempotency_key: string;
  channel?: "email" | "telegram" | null;
  provider_id: string | null;
  started_at: string;
  sent_at: string | null;
  error: string | null;
};

function fromReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    what: row.what,
    context: row.context,
    timezone: row.timezone,
    fireAt: row.fire_at,
    recurrence: row.recurrence,
    channel: row.channel === "telegram" || row.channel === "both" ? row.channel : "email",
    status: row.status,
    holdUntil: row.hold_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at
  };
}

function toReminder(reminder: Reminder): ReminderRow {
  return {
    id: reminder.id,
    owner_id: reminder.ownerId,
    kind: reminder.kind,
    what: reminder.what,
    context: reminder.context,
    timezone: reminder.timezone,
    fire_at: reminder.fireAt,
    recurrence: reminder.recurrence,
    channel: reminder.channel,
    status: reminder.status,
    hold_until: reminder.holdUntil,
    created_at: reminder.createdAt,
    updated_at: reminder.updatedAt,
    completed_at: reminder.completedAt
  };
}

function fromDelivery(row: DeliveryRow): Delivery {
  return {
    id: row.id,
    ownerId: row.owner_id,
    reminderId: row.reminder_id,
    dedupeKey: row.dedupe_key,
    occurrenceAt: row.occurrence_at,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    channel: row.channel === "telegram" ? "telegram" : "email",
    providerId: row.provider_id,
    startedAt: row.started_at,
    sentAt: row.sent_at,
    error: row.error
  };
}

function fromDigest(row: {
  owner_id: string;
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
  last_sent_on: string | null;
  updated_at: string;
}): DigestSettings {
  return {
    ownerId: row.owner_id,
    enabled: row.enabled,
    hour: row.hour,
    minute: row.minute,
    timezone: row.timezone,
    lastSentOn: row.last_sent_on,
    updatedAt: row.updated_at
  };
}

export function dueRemindersPath(nowIso: string, limit: number): string {
  const stamp = encodeURIComponent(nowIso);
  return `/rest/v1/reminders?status=eq.active&fire_at=lte.${stamp}&or=(hold_until.is.null,hold_until.lte.${stamp})&order=fire_at.asc&limit=${limit}&select=*`;
}

export class SupabaseFillipStore implements ServiceStore {
  private sendHolds = new Set<string>();
  private inFlight = new Set<string>();
  /** Reservation id to owner, present only while a hosted counter increment should be undone on failure. */
  private reservations = new Map<string, string>();
  /**
   * reserveSend writes emails_sent_in_period. noteSent must not overwrite it
   * from a contact snapshot taken before the increment.
   */
  readonly reservePersistsMonthlyCount = true;
  constructor(private ownerId: string | null, private db: Db, private mode: Mode, private writer: Db | null = null) {}

  /** Reminder and digest writes. The service role when the user token cannot insert or update. */
  private persist(): Db {
    return this.writer ?? this.db;
  }

  private owned(ownerId: string) {
    if (this.mode === "user" && ownerId !== this.ownerId) throw new Error("Reminder not found");
  }

  async listReminders(ownerId: string, query: ListQuery): Promise<Reminder[]> {
    this.owned(ownerId);
    const status = query.status && query.status !== "all" ? `&status=eq.${encodeURIComponent(query.status)}` : "";
    const value = await this.db(`/rest/v1/reminders?owner_id=eq.${encodeURIComponent(ownerId)}${status}&select=*&order=fire_at.asc&limit=500`);
    return rows<ReminderRow>(value).map(fromReminder);
  }

  async getReminder(ownerId: string, id: string): Promise<Reminder | null> {
    this.owned(ownerId);
    const value = await this.db(`/rest/v1/reminders?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}&select=*`);
    const row = rows<ReminderRow>(value)[0];
    return row ? fromReminder(row) : null;
  }

  async createReminder(reminder: Reminder, open?: OpenCap): Promise<Reminder> {
    this.owned(reminder.ownerId);
    const forced = this.mode === "user" && this.ownerId ? { ...reminder, ownerId: this.ownerId } : reminder;
    let value: unknown;
    try {
      value = await this.persist()("/rest/v1/reminders", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(toReminder(forced))
      });
    } catch (error) {
      const cap = openCapMessage(error);
      if (cap) throw new OpenCapError(cap);
      throw error;
    }
    const row = rows<ReminderRow>(value)[0];
    if (!row) throw new Error("Fillip could not complete this request. Your reminder may not have been saved.");
    const saved = fromReminder(row);
    if (open && saved.status === "active") await this.refuseIfReadOverCap(saved, open);
    return saved;
  }

  /**
   * The trigger holds a real insert. A lagging active list can still come back
   * longer than the cap. Delete only the row this call inserted, then throw,
   * so the caller is not told it failed while that row stays due.
   */
  private async refuseIfReadOverCap(saved: Reminder, open: OpenCap): Promise<void> {
    const listed = rows<{ id: string }>(await this.persist()(
      `/rest/v1/reminders?owner_id=eq.${encodeURIComponent(saved.ownerId)}&status=eq.active&select=id&limit=500`
    ));
    if (listed.length <= open.cap) return;
    await this.persist()(`/rest/v1/reminders?id=eq.${encodeURIComponent(saved.id)}&owner_id=eq.${encodeURIComponent(saved.ownerId)}`, {
      method: "DELETE",
      headers: { Prefer: "return=minimal" }
    });
    const message = open.message.startsWith("The free plan") && !open.message.includes(UPGRADE_PROMPT)
      ? `${open.message} ${UPGRADE_PROMPT}`
      : open.message;
    throw new OpenCapError(message);
  }

  async deleteReminder(ownerId: string, id: string): Promise<void> {
    this.owned(ownerId);
    const minimal = { method: "DELETE", headers: { Prefer: "return=minimal" } };
    const write = this.persist();
    await write(`/rest/v1/deliveries?reminder_id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`, minimal);
    await write(`/rest/v1/reminders?id=eq.${encodeURIComponent(id)}&owner_id=eq.${encodeURIComponent(ownerId)}`, minimal);
  }

  async saveReminder(reminder: Reminder): Promise<Reminder> {
    this.owned(reminder.ownerId);
    const value = await this.persist()(`/rest/v1/reminders?id=eq.${encodeURIComponent(reminder.id)}&owner_id=eq.${encodeURIComponent(reminder.ownerId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(toReminder(reminder))
    });
    const row = rows<ReminderRow>(value)[0];
    if (!row) throw new Error("Reminder not found");
    return fromReminder(row);
  }

  async listDeliveryMarks(ownerId: string) {
    this.owned(ownerId);
    const value = await this.db(`/rest/v1/deliveries?owner_id=eq.${encodeURIComponent(ownerId)}&select=reminder_id,occurrence_at,status,error&limit=500`);
    return rows<{ reminder_id: string | null; occurrence_at: string; status: Delivery["status"]; error: string | null }>(value).map((row) => ({
      reminderId: row.reminder_id,
      occurrenceAt: row.occurrence_at,
      status: row.status,
      error: row.error
    }));
  }

  async countCreatedSince(ownerId: string, sinceIso: string): Promise<number> {
    this.owned(ownerId);
    const value = await this.db(`/rest/v1/reminders?owner_id=eq.${encodeURIComponent(ownerId)}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id&limit=100`);
    return rows<{ id: string }>(value).length;
  }

  async countActive(ownerId: string): Promise<number> {
    this.owned(ownerId);
    const value = await this.db(`/rest/v1/reminders?owner_id=eq.${encodeURIComponent(ownerId)}&status=eq.active&select=id&limit=200`);
    return rows<{ id: string }>(value).length;
  }

  async rememberOwner(contact: OwnerIdentity): Promise<void> {
    this.owned(contact.id);
  }

  async setMailOptIn(ownerId: string, enabled: boolean): Promise<void> {
    this.owned(ownerId);
    if (this.mode === "user") {
      await this.db("/rest/v1/rpc/fillip_set_mail_opt_in", {
        method: "POST",
        body: JSON.stringify({ enabled })
      });
      return;
    }
    await this.db("/rest/v1/profiles?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: ownerId, unsubscribed: !enabled, updated_at: new Date().toISOString() })
    });
  }

  async getDigest(ownerId: string): Promise<DigestSettings | null> {
    this.owned(ownerId);
    const value = await this.db(`/rest/v1/digest_settings?owner_id=eq.${encodeURIComponent(ownerId)}&select=*`);
    const row = rows<Parameters<typeof fromDigest>[0]>(value)[0];
    return row ? fromDigest(row) : null;
  }

  async saveDigest(settings: DigestSettings): Promise<void> {
    this.owned(settings.ownerId);
    await this.persist()("/rest/v1/digest_settings?on_conflict=owner_id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({
        owner_id: settings.ownerId,
        enabled: settings.enabled,
        hour: settings.hour,
        minute: settings.minute,
        timezone: settings.timezone,
        last_sent_on: settings.lastSentOn,
        updated_at: settings.updatedAt
      })
    });
  }

  async deleteOwnerData(ownerId: string): Promise<void> {
    // Deliveries have no authenticated write policies. A user-token DELETE
    // matches zero rows and the call still returns success, so this has to
    // run as the service role, which bypasses row level security.
    if (this.mode !== "service") throw new Error("Deleting account data needs the service role");
    this.owned(ownerId);
    const minimal = { method: "DELETE", headers: { Prefer: "return=minimal" } };
    await this.db(`/rest/v1/deliveries?owner_id=eq.${encodeURIComponent(ownerId)}`, minimal);
    await this.db(`/rest/v1/reminders?owner_id=eq.${encodeURIComponent(ownerId)}`, minimal);
    await this.db(`/rest/v1/digest_settings?owner_id=eq.${encodeURIComponent(ownerId)}`, minimal);
  }

  async getContact(ownerId: string): Promise<OwnerContact | null> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const user = await this.db(`/auth/v1/admin/users/${encodeURIComponent(ownerId)}`) as { id?: string; email?: string | null; email_confirmed_at?: string | null };
    if (!user?.id) return null;
    const usage = await this.readUsage(ownerId);
    return {
      id: user.id,
      email: typeof user.email === "string" ? user.email : null,
      emailVerified: Boolean(user.email_confirmed_at),
      unsubscribed: usage.unsubscribed,
      plan: usage.plan,
      subscriptionStatus: usage.subscriptionStatus,
      emailsSentInPeriod: usage.emailsSentInPeriod,
      emailPeriodStart: usage.emailPeriodStart,
      defaultChannel: usage.defaultChannel,
      telegramChatId: usage.telegramChatId,
      telegramLinkToken: usage.telegramLinkToken,
      telegramLinkExpires: usage.telegramLinkExpires,
      calendarToken: usage.calendarToken
    };
  }

  async getUsage(ownerId: string): Promise<OwnerContact | null> {
    this.owned(ownerId);
    const usage = await this.readUsage(ownerId);
    return {
      id: ownerId,
      email: null,
      emailVerified: false,
      ...usage
    };
  }

  private async readUsage(ownerId: string): Promise<Pick<OwnerContact, "unsubscribed" | "plan" | "subscriptionStatus" | "emailsSentInPeriod" | "emailPeriodStart" | "defaultChannel" | "telegramChatId" | "telegramLinkToken" | "telegramLinkExpires" | "calendarToken"> & { emailsSentToday: number }> {
    const profiles = rows<{
      unsubscribed?: boolean;
      plan?: string;
      subscription_status?: string;
      emails_sent_in_period?: number;
      email_period_start?: string | null;
      emails_sent_today?: number;
      email_day_start?: string | null;
      default_channel?: string | null;
      telegram_chat_id?: string | null;
      telegram_link_token?: string | null;
      telegram_link_expires?: string | null;
      calendar_token?: string | null;
    }>(await this.db(`/rest/v1/profiles?id=eq.${encodeURIComponent(ownerId)}&select=unsubscribed,plan,subscription_status,emails_sent_in_period,email_period_start,emails_sent_today,email_day_start,default_channel,telegram_chat_id,telegram_link_token,telegram_link_expires,calendar_token`));
    const row = profiles[0];
    const plan: PlanName = row?.plan === "pro" || row?.plan === "annual" || row?.plan === "free" ? row.plan : "free";
    const channel: DeliveryChannel = row?.default_channel === "telegram" || row?.default_channel === "both" ? row.default_channel : "email";
    return {
      unsubscribed: Boolean(row?.unsubscribed),
      plan,
      subscriptionStatus: typeof row?.subscription_status === "string" ? row.subscription_status : "none",
      emailsSentInPeriod: typeof row?.emails_sent_in_period === "number" ? row.emails_sent_in_period : 0,
      emailPeriodStart: typeof row?.email_period_start === "string" ? row.email_period_start : null,
      emailsSentToday: typeof row?.emails_sent_today === "number" ? row.emails_sent_today : 0,
      defaultChannel: channel,
      telegramChatId: typeof row?.telegram_chat_id === "string" ? row.telegram_chat_id : null,
      telegramLinkToken: typeof row?.telegram_link_token === "string" ? row.telegram_link_token : null,
      telegramLinkExpires: typeof row?.telegram_link_expires === "string" ? row.telegram_link_expires : null,
      calendarToken: typeof row?.calendar_token === "string" ? row.calendar_token : null
    };
  }

  async saveUsage(ownerId: string, usage: { emailsSentInPeriod: number; emailPeriodStart: string }): Promise<void> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    await this.db(`/rest/v1/profiles?id=eq.${encodeURIComponent(ownerId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        emails_sent_in_period: usage.emailsSentInPeriod,
        email_period_start: usage.emailPeriodStart,
        updated_at: new Date().toISOString()
      })
    });
  }

  async listDue(nowIso: string, limit: number): Promise<Reminder[]> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db(dueRemindersPath(nowIso, limit));
    return rows<ReminderRow>(value).map(fromReminder);
  }

  async listHeld(nowIso: string): Promise<Reminder[]> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db(`/rest/v1/reminders?status=eq.active&hold_until=gt.${encodeURIComponent(nowIso)}&select=*&limit=500`);
    return rows<ReminderRow>(value).map(fromReminder);
  }

  async listEnabledDigests(): Promise<DigestSettings[]> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db("/rest/v1/digest_settings?enabled=eq.true&select=*");
    return rows<Parameters<typeof fromDigest>[0]>(value).map(fromDigest);
  }

  async claimDelivery(input: {
    ownerId: string;
    reminderId: string | null;
    dedupeKey: string;
    occurrenceAt: string;
    idempotencyKey: string;
    channel: "email" | "telegram";
    nowIso: string;
    staleBeforeIso: string;
  }): Promise<ClaimResult> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const fresh: DeliveryRow = {
      id: randomUUID(),
      owner_id: input.ownerId,
      reminder_id: input.reminderId,
      dedupe_key: input.dedupeKey,
      occurrence_at: input.occurrenceAt,
      status: "sending",
      idempotency_key: input.idempotencyKey,
      channel: input.channel,
      provider_id: null,
      started_at: input.nowIso,
      sent_at: null,
      error: null
    };
    try {
      const value = await this.db("/rest/v1/deliveries", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify(fresh)
      });
      const row = rows<DeliveryRow>(value)[0];
      if (!row) throw new Error("Fillip could not complete this request. Your reminder may not have been saved.");
      return { delivery: fromDelivery(row), outcome: "send" };
    } catch (error) {
      if (!isDuplicate(error)) throw error;
    }
    const existing = rows<DeliveryRow>(await this.db(`/rest/v1/deliveries?dedupe_key=eq.${encodeURIComponent(input.dedupeKey)}&select=*`))[0];
    if (!existing) throw new Error("Fillip could not complete this request. Your reminder may not have been saved.");
    const attempt = existing.provider_id === "attempt";
    const accepted = Boolean(existing.provider_id) && !attempt;
    if (typeof existing.error === "string" && /not delivered/i.test(existing.error)) return { delivery: fromDelivery(existing), outcome: "already-sent" };
    if (existing.status === "sent" || accepted) return { delivery: fromDelivery(existing), outcome: "already-sent" };
    // A fresh attempt is retried. Email is retried for 24 hours after the
    // lease, on the same idempotency key. Telegram is not submitted again.
    if (attempt && existing.started_at <= input.staleBeforeIso) {
      const age = Date.parse(input.nowIso) - Date.parse(existing.started_at);
      const channel = existing.channel === "telegram" ? "telegram" : "email";
      if (channel === "email" && Number.isFinite(age) && age <= 24 * 60 * 60 * 1000) {
        return {
          delivery: fromDelivery({ ...existing, idempotency_key: input.idempotencyKey }),
          outcome: "send"
        };
      }
      return { delivery: fromDelivery(existing), outcome: "already-sent" };
    }
    if (existing.status === "sending" && !attempt && existing.started_at > input.staleBeforeIso) {
      return { delivery: fromDelivery(existing), outcome: "in-progress" };
    }
    const ticketKey = `claim:${input.dedupeKey}:${existing.started_at}`;
    try {
      await this.db("/rest/v1/deliveries", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: JSON.stringify({
          ...fresh,
          id: randomUUID(),
          dedupe_key: ticketKey,
          idempotency_key: `lock/${ticketKey}`,
          status: "sending"
        })
      });
    } catch (error) {
      if (!isDuplicate(error)) throw error;
      const ticket = rows<DeliveryRow>(await this.db(`/rest/v1/deliveries?dedupe_key=eq.${encodeURIComponent(ticketKey)}&select=*`))[0];
      if (ticket?.started_at && ticket.started_at > leaseCutoff(input.nowIso)) {
        return { delivery: fromDelivery(existing), outcome: "in-progress" };
      }
      const previous = ticket?.started_at ?? "";
      const renewed = rows<DeliveryRow>(await this.db(
        `/rest/v1/deliveries?dedupe_key=eq.${encodeURIComponent(ticketKey)}&started_at=eq.${encodeURIComponent(previous)}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({ status: "sending", started_at: input.nowIso })
        }
      ));
      if (!renewed[0]) return { delivery: fromDelivery(existing), outcome: "in-progress" };
    }
    const taken = rows<DeliveryRow>(await this.db(`/rest/v1/deliveries?dedupe_key=eq.${encodeURIComponent(input.dedupeKey)}&status=neq.sent`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify({ status: "sending", started_at: input.nowIso, error: null, idempotency_key: input.idempotencyKey })
    }));
    const row = taken[0] ?? existing;
    if (row.status === "sent") return { delivery: fromDelivery(row), outcome: "already-sent" };
    return { delivery: fromDelivery({ ...row, status: "sending", started_at: input.nowIso, idempotency_key: input.idempotencyKey }), outcome: "send" };
  }

  async saveDelivery(delivery: Delivery): Promise<void> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    await this.db(`/rest/v1/deliveries?dedupe_key=eq.${encodeURIComponent(delivery.dedupeKey)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({
        status: delivery.status,
        provider_id: delivery.providerId,
        sent_at: delivery.sentAt,
        error: delivery.error,
        started_at: delivery.startedAt
      })
    });
  }

  async claimNotice(input: { ownerId: string; reminderId: string; fireAt: string; nowIso: string }): Promise<boolean> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const key = `fillip/${input.reminderId}/${input.fireAt}/not-delivered`;
    try {
      await this.db("/rest/v1/deliveries", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          id: randomUUID(),
          owner_id: input.ownerId,
          reminder_id: input.reminderId,
          dedupe_key: `reminder:${input.reminderId}:${input.fireAt}:not-delivered`,
          occurrence_at: input.fireAt,
          status: "sending",
          idempotency_key: key,
          channel: "email",
          kind: "not-delivered",
          provider_id: null,
          started_at: input.nowIso,
          sent_at: null,
          error: null
        })
      });
      return true;
    } catch (error) {
      if (isDuplicate(error)) return false;
      throw error;
    }
  }

  async countSentSince(ownerId: string, sinceIso: string): Promise<number> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db(`/rest/v1/deliveries?owner_id=eq.${encodeURIComponent(ownerId)}&status=eq.sent&sent_at=gte.${encodeURIComponent(sinceIso)}&select=id&limit=1000`);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return rows<{ id: string }>(value).length;
  }

  async countAllSentSince(sinceIso: string): Promise<number> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db(
      `/rest/v1/deliveries?status=eq.sent&channel=neq.telegram&sent_at=gte.${encodeURIComponent(sinceIso)}&select=id`,
      { method: "GET", headers: { Prefer: "count=exact", Range: "0-0" } }
    );
    if (typeof value === "number" && Number.isFinite(value)) return value;
    return rows<{ id: string }>(value).length;
  }

  async getProviderBackoffUntil(): Promise<string | null> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db("/rest/v1/fillip_runtime?id=eq.1&select=provider_backoff_until");
    const row = rows<{ provider_backoff_until?: string | null }>(value)[0];
    return typeof row?.provider_backoff_until === "string" ? row.provider_backoff_until : null;
  }

  async setDefaultChannel(ownerId: string, channel: DeliveryChannel): Promise<void> {
    this.owned(ownerId);
    if (this.mode === "user") {
      await this.db("/rest/v1/rpc/fillip_set_default_channel", { method: "POST", body: JSON.stringify({ channel }) });
      return;
    }
    await this.patchProfile(ownerId, { default_channel: channel });
  }

  async beginTelegramLink(ownerId: string, token: string, expiresIso: string): Promise<void> {
    this.owned(ownerId);
    if (this.mode === "user") {
      await this.db("/rest/v1/rpc/fillip_set_telegram_link", {
        method: "POST",
        body: JSON.stringify({ token, expires: expiresIso })
      });
      return;
    }
    await this.patchProfile(ownerId, { telegram_link_token: token, telegram_link_expires: expiresIso });
  }

  async unlinkTelegram(ownerId: string): Promise<void> {
    this.owned(ownerId);
    if (this.mode === "user") {
      await this.db("/rest/v1/rpc/fillip_clear_telegram", { method: "POST", body: JSON.stringify({}) });
      return;
    }
    await this.patchProfile(ownerId, { telegram_chat_id: null, telegram_link_token: null, telegram_link_expires: null, default_channel: "email" });
  }

  async setCalendarToken(ownerId: string, token: string): Promise<void> {
    this.owned(ownerId);
    if (this.mode === "user") {
      await this.db("/rest/v1/rpc/fillip_set_calendar_token", { method: "POST", body: JSON.stringify({ token }) });
      return;
    }
    await this.patchProfile(ownerId, { calendar_token: token });
  }

  async ownerIdForCalendarToken(token: string): Promise<string | null> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const rowsFound = rows<{ id: string }>(await this.db(`/rest/v1/profiles?calendar_token=eq.${encodeURIComponent(token)}&select=id`));
    return rowsFound[0]?.id ?? null;
  }

  async claimTelegramLink(token: string, chatId: string, nowIso: string): Promise<string | null> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const found = rows<{ id: string; telegram_link_expires?: string | null }>(await this.db(
      `/rest/v1/profiles?telegram_link_token=eq.${encodeURIComponent(token)}&select=id,telegram_link_expires`
    ));
    const row = found[0];
    if (!row?.telegram_link_expires || row.telegram_link_expires <= nowIso) return null;
    await this.patchProfile(row.id, { telegram_chat_id: chatId, telegram_link_token: null, telegram_link_expires: null });
    return row.id;
  }

  private async patchProfile(ownerId: string, patch: Record<string, unknown>): Promise<void> {
    await this.db(`/rest/v1/profiles?id=eq.${encodeURIComponent(ownerId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() })
    });
  }

  private rememberHold(ownerId: string): SendReserveResult {
    const id = randomUUID();
    this.sendHolds.add(id);
    this.reservations.set(id, ownerId);
    return { ok: true, id };
  }

  /**
   * A JSON number is the new count. JSON null means the cap held.
   * An array is a client that does not implement the RPC, so the caller
   * falls back to a compare-and-swap patch. Null must not fall back.
   */
  private async reservePing(ownerId: string, maxCount: number, periodStart: string, dailyMax: number, dayStart: string): Promise<"reserved" | "capped" | "day" | "fallback"> {
    let value: unknown;
    try {
      value = await this.db("/rest/v1/rpc/fillip_reserve_ping", {
        method: "POST",
        body: JSON.stringify({
          owner: ownerId,
          max_count: maxCount,
          period_start: periodStart,
          daily_max: dailyMax,
          day_start: dayStart
        })
      });
    } catch {
      return "fallback";
    }
    if (Array.isArray(value)) return "fallback";
    if (value === -1) return "day";
    if (typeof value === "number" && Number.isFinite(value)) return "reserved";
    if (value === null) return "capped";
    return "fallback";
  }

  async reserveSend(input: SendReserve): Promise<SendReserveResult> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const preview = await this.readUsage(input.ownerId);
    const previewUsed = sentThisMonth(
      { emailsSentInPeriod: preview.emailsSentInPeriod, emailPeriodStart: preview.emailPeriodStart, subscriptionStatus: preview.subscriptionStatus },
      input.now,
      input.timeZone
    );
    if (previewUsed >= input.monthlyLimit) return { ok: false, reason: "month" };
    if (input.countGlobal) {
      if ((await this.countAllSentSince(input.globalDayStartIso)) >= input.globalDayLimit) return { ok: false, reason: "global-day" };
      if ((await this.countAllSentSince(input.globalMonthStartIso)) >= input.globalMonthLimit) return { ok: false, reason: "global-month" };
    }
    const periodCurrent = Boolean(preview.emailPeriodStart) && usagePeriodCurrent(preview.emailPeriodStart ?? "", input.now, input.timeZone, preview.subscriptionStatus);
    const periodStart = periodCurrent && preview.emailPeriodStart ? preview.emailPeriodStart : localMonthStartIso(input.now, input.timeZone);
    const rpc = await this.reservePing(input.ownerId, input.monthlyLimit, periodStart, input.dailyLimit, input.sinceIso);
    if (rpc === "reserved") return this.rememberHold(input.ownerId);
    if (rpc === "day") return { ok: false, reason: "day" };
    if (rpc === "capped") return { ok: false, reason: "month" };
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const usage = await this.readUsage(input.ownerId);
      const used = sentThisMonth(
        { emailsSentInPeriod: usage.emailsSentInPeriod, emailPeriodStart: usage.emailPeriodStart, subscriptionStatus: usage.subscriptionStatus },
        input.now,
        input.timeZone
      );
      if (used >= input.monthlyLimit) return { ok: false, reason: "month" };
      if ((await this.countSentSince(input.ownerId, input.sinceIso)) >= input.dailyLimit) return { ok: false, reason: "day" };
      if (input.countGlobal) {
        if ((await this.countAllSentSince(input.globalDayStartIso)) >= input.globalDayLimit) return { ok: false, reason: "global-day" };
        if ((await this.countAllSentSince(input.globalMonthStartIso)) >= input.globalMonthLimit) return { ok: false, reason: "global-month" };
      }
      const periodCurrent = Boolean(usage.emailPeriodStart) && usagePeriodCurrent(usage.emailPeriodStart ?? "", input.now, input.timeZone, usage.subscriptionStatus);
      const stored = usage.emailsSentInPeriod;
      const next = used + 1;
      const periodStart = periodCurrent && usage.emailPeriodStart ? usage.emailPeriodStart : localMonthStartIso(input.now, input.timeZone);
      const updated = await this.db(
        `/rest/v1/profiles?id=eq.${encodeURIComponent(input.ownerId)}&emails_sent_in_period=eq.${stored}`,
        {
          method: "PATCH",
          headers: { Prefer: "return=representation" },
          body: JSON.stringify({
            emails_sent_in_period: next,
            email_period_start: periodStart,
            updated_at: new Date().toISOString()
          })
        }
      );
      // A row means this worker won the compare-and-swap. An empty array or null
      // means another worker already took the count. An acknowledged write with
      // no body still holds the slot: the caller accepted the PATCH.
      if (!isAcknowledgedWrite(updated) && !rows(updated)[0]) continue;
      return this.rememberHold(input.ownerId);
    }
    return { ok: false, reason: "month" };
  }

  async releaseSend(id: string, keep = false): Promise<void> {
    const ownerId = this.reservations.get(id);
    this.reservations.delete(id);
    this.sendHolds.delete(id);
    if (!ownerId || keep || this.mode !== "service") return;
    const usage = await this.readUsage(ownerId);
    const next = Math.max(0, usage.emailsSentInPeriod - 1);
    const nextDay = Math.max(0, usage.emailsSentToday - 1);
    await this.db(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(ownerId)}&emails_sent_in_period=eq.${usage.emailsSentInPeriod}`,
      {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          emails_sent_in_period: next,
          emails_sent_today: nextDay,
          updated_at: new Date().toISOString()
        })
      }
    );
  }

  beginSend(idempotencyKey: string): boolean {
    if (this.inFlight.has(idempotencyKey)) return false;
    this.inFlight.add(idempotencyKey);
    return true;
  }

  finishSend(idempotencyKey: string): void {
    this.inFlight.delete(idempotencyKey);
  }

  async setProviderBackoffUntil(untilIso: string): Promise<void> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    await this.db("/rest/v1/fillip_runtime?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: 1, provider_backoff_until: untilIso, updated_at: new Date().toISOString() })
    });
  }
}
