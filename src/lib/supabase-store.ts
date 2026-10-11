import { randomUUID } from "node:crypto";
import type { ClaimResult, Delivery, DigestSettings, OwnerContact, OwnerIdentity, PlanName, Recurrence, Reminder, ReminderStatus } from "./types.js";
import type { ListQuery, ServiceStore } from "./store.js";

export type Db = (pathname: string, options?: RequestInit) => Promise<unknown>;

type Mode = "user" | "service";

function rows<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function isDuplicate(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("23505") || message.toLowerCase().includes("duplicate");
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
  constructor(private ownerId: string | null, private db: Db, private mode: Mode) {}

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

  async createReminder(reminder: Reminder): Promise<Reminder> {
    this.owned(reminder.ownerId);
    const forced = this.mode === "user" && this.ownerId ? { ...reminder, ownerId: this.ownerId } : reminder;
    const value = await this.db("/rest/v1/reminders", {
      method: "POST",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(toReminder(forced))
    });
    const row = rows<ReminderRow>(value)[0];
    if (!row) throw new Error("Fillip could not complete this request. Your reminder may not have been saved.");
    return fromReminder(row);
  }

  async saveReminder(reminder: Reminder): Promise<Reminder> {
    this.owned(reminder.ownerId);
    const value = await this.db(`/rest/v1/reminders?id=eq.${encodeURIComponent(reminder.id)}&owner_id=eq.${encodeURIComponent(reminder.ownerId)}`, {
      method: "PATCH",
      headers: { Prefer: "return=representation" },
      body: JSON.stringify(toReminder(reminder))
    });
    const row = rows<ReminderRow>(value)[0];
    if (!row) throw new Error("Reminder not found");
    return fromReminder(row);
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
    await this.db("/rest/v1/digest_settings?on_conflict=owner_id", {
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
    this.owned(ownerId);
    await this.db(`/rest/v1/reminders?owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await this.db(`/rest/v1/deliveries?owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await this.db(`/rest/v1/digest_settings?owner_id=eq.${encodeURIComponent(ownerId)}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
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
      emailPeriodStart: usage.emailPeriodStart
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

  private async readUsage(ownerId: string): Promise<Pick<OwnerContact, "unsubscribed" | "plan" | "subscriptionStatus" | "emailsSentInPeriod" | "emailPeriodStart">> {
    const profiles = rows<{
      unsubscribed?: boolean;
      plan?: string;
      subscription_status?: string;
      emails_sent_in_period?: number;
      email_period_start?: string | null;
    }>(await this.db(`/rest/v1/profiles?id=eq.${encodeURIComponent(ownerId)}&select=unsubscribed,plan,subscription_status,emails_sent_in_period,email_period_start`));
    const row = profiles[0];
    const plan: PlanName = row?.plan === "pro" || row?.plan === "annual" ? row.plan : "none";
    return {
      unsubscribed: Boolean(row?.unsubscribed),
      plan,
      subscriptionStatus: typeof row?.subscription_status === "string" ? row.subscription_status : "none",
      emailsSentInPeriod: typeof row?.emails_sent_in_period === "number" ? row.emails_sent_in_period : 0,
      emailPeriodStart: typeof row?.email_period_start === "string" ? row.email_period_start : null
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
    if (existing.status === "sent") return { delivery: fromDelivery(existing), outcome: "already-sent" };
    if (existing.status === "sending" && existing.started_at > input.staleBeforeIso) {
      return { delivery: fromDelivery(existing), outcome: "in-progress" };
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

  async countSentSince(ownerId: string, sinceIso: string): Promise<number> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db(`/rest/v1/deliveries?owner_id=eq.${encodeURIComponent(ownerId)}&status=eq.sent&sent_at=gte.${encodeURIComponent(sinceIso)}&select=id&limit=100`);
    return rows<{ id: string }>(value).length;
  }

  async countAllSentSince(sinceIso: string): Promise<number> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    const value = await this.db(
      `/rest/v1/deliveries?status=eq.sent&sent_at=gte.${encodeURIComponent(sinceIso)}&select=id`,
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

  async setProviderBackoffUntil(untilIso: string): Promise<void> {
    if (this.mode !== "service") throw new Error("Reminder not found");
    await this.db("/rest/v1/fillip_runtime?on_conflict=id", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ id: 1, provider_backoff_until: untilIso, updated_at: new Date().toISOString() })
    });
  }
}
