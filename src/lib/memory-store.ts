import type { ClaimResult, Delivery, DeliveryChannel, DigestSettings, OwnerContact, OwnerIdentity, Reminder, ReminderStatus } from "./types.js";
import type { ListQuery, SendReserve, SendReserveResult, ServiceStore } from "./store.js";
import { blankContact, sentThisMonth } from "./usage.js";
import { randomUUID } from "node:crypto";

export class MemoryFillipStore implements ServiceStore {
  reminders: Reminder[] = [];
  deliveries: Delivery[] = [];
  digests = new Map<string, DigestSettings>();
  contacts = new Map<string, OwnerContact>();
  providerBackoffUntil: string | null = null;
  private holds: Array<{ id: string; ownerId: string; global: boolean }> = [];
  private inFlight = new Set<string>();

  async listReminders(ownerId: string, query: ListQuery): Promise<Reminder[]> {
    return this.reminders
      .filter((row) => row.ownerId === ownerId && (query.status === undefined || query.status === "all" || row.status === query.status))
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }

  async getReminder(ownerId: string, id: string): Promise<Reminder | null> {
    return this.reminders.find((row) => row.ownerId === ownerId && row.id === id) ?? null;
  }

  async createReminder(reminder: Reminder): Promise<Reminder> {
    this.reminders.push(reminder);
    return reminder;
  }

  async saveReminder(reminder: Reminder): Promise<Reminder> {
    const index = this.reminders.findIndex((row) => row.id === reminder.id && row.ownerId === reminder.ownerId);
    if (index < 0) throw new Error("Reminder not found");
    this.reminders[index] = reminder;
    return reminder;
  }

  async countCreatedSince(ownerId: string, sinceIso: string): Promise<number> {
    return this.reminders.filter((row) => row.ownerId === ownerId && row.createdAt >= sinceIso).length;
  }

  async countActive(ownerId: string): Promise<number> {
    return this.reminders.filter((row) => row.ownerId === ownerId && row.status === "active").length;
  }

  async rememberOwner(contact: OwnerIdentity): Promise<void> {
    const existing = this.contacts.get(contact.id) ?? blankContact(contact.id);
    this.contacts.set(contact.id, {
      ...existing,
      email: contact.email,
      emailVerified: contact.emailVerified,
      unsubscribed: contact.unsubscribed ?? existing.unsubscribed,
      plan: contact.plan ?? existing.plan,
      subscriptionStatus: contact.subscriptionStatus ?? existing.subscriptionStatus
    });
  }

  async setMailOptIn(ownerId: string, enabled: boolean): Promise<void> {
    const existing = this.contacts.get(ownerId) ?? blankContact(ownerId, { unsubscribed: !enabled });
    this.contacts.set(ownerId, { ...existing, unsubscribed: !enabled });
  }

  async getDigest(ownerId: string): Promise<DigestSettings | null> {
    return this.digests.get(ownerId) ?? null;
  }

  async saveDigest(settings: DigestSettings): Promise<void> {
    this.digests.set(settings.ownerId, settings);
  }

  async deleteOwnerData(ownerId: string): Promise<void> {
    this.reminders = this.reminders.filter((row) => row.ownerId !== ownerId);
    this.deliveries = this.deliveries.filter((row) => row.ownerId !== ownerId);
    this.digests.delete(ownerId);
  }

  async getContact(ownerId: string): Promise<OwnerContact | null> {
    return this.contacts.get(ownerId) ?? null;
  }

  async getUsage(ownerId: string): Promise<OwnerContact | null> {
    return this.contacts.get(ownerId) ?? null;
  }

  async setDefaultChannel(ownerId: string, channel: DeliveryChannel): Promise<void> {
    const existing = this.contacts.get(ownerId) ?? blankContact(ownerId);
    this.contacts.set(ownerId, { ...existing, defaultChannel: channel });
  }

  async beginTelegramLink(ownerId: string, token: string, expiresIso: string): Promise<void> {
    const existing = this.contacts.get(ownerId) ?? blankContact(ownerId);
    this.contacts.set(ownerId, { ...existing, telegramLinkToken: token, telegramLinkExpires: expiresIso });
  }

  async unlinkTelegram(ownerId: string): Promise<void> {
    const existing = this.contacts.get(ownerId) ?? blankContact(ownerId);
    const defaultChannel = existing.defaultChannel === "email" ? "email" : "email";
    this.contacts.set(ownerId, {
      ...existing,
      telegramChatId: null,
      telegramLinkToken: null,
      telegramLinkExpires: null,
      defaultChannel
    });
  }

  async setCalendarToken(ownerId: string, token: string): Promise<void> {
    for (const [id, contact] of this.contacts) {
      if (id !== ownerId && contact.calendarToken === token) throw new Error("Fillip could not complete this request. Your reminder may not have been saved.");
    }
    const existing = this.contacts.get(ownerId) ?? blankContact(ownerId);
    this.contacts.set(ownerId, { ...existing, calendarToken: token });
  }

  async saveUsage(ownerId: string, usage: { emailsSentInPeriod: number; emailPeriodStart: string }): Promise<void> {
    const existing = this.contacts.get(ownerId) ?? blankContact(ownerId);
    this.contacts.set(ownerId, {
      ...existing,
      emailsSentInPeriod: usage.emailsSentInPeriod,
      emailPeriodStart: usage.emailPeriodStart
    });
  }

  async listDue(nowIso: string, limit: number): Promise<Reminder[]> {
    return this.reminders
      .filter((row) => row.status === "active" && row.fireAt <= nowIso && (row.holdUntil === null || row.holdUntil <= nowIso))
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt))
      .slice(0, limit);
  }

  async listEnabledDigests(): Promise<DigestSettings[]> {
    return [...this.digests.values()].filter((row) => row.enabled);
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
    const existing = this.deliveries.find((row) => row.dedupeKey === input.dedupeKey);
    if (!existing) {
      const delivery: Delivery = {
        id: input.dedupeKey,
        ownerId: input.ownerId,
        reminderId: input.reminderId,
        dedupeKey: input.dedupeKey,
        occurrenceAt: input.occurrenceAt,
        status: "sending",
        idempotencyKey: input.idempotencyKey,
        channel: input.channel,
        providerId: null,
        startedAt: input.nowIso,
        sentAt: null,
        error: null
      };
      this.deliveries.push(delivery);
      return { delivery, outcome: "send" };
    }
    if (existing.status === "sent") return { delivery: existing, outcome: "already-sent" };
    if (existing.status === "sending" && existing.startedAt > input.staleBeforeIso) {
      return { delivery: existing, outcome: "in-progress" };
    }
    existing.status = "sending";
    existing.startedAt = input.nowIso;
    existing.error = null;
    existing.idempotencyKey = input.idempotencyKey;
    return { delivery: existing, outcome: "send" };
  }

  async saveDelivery(delivery: Delivery): Promise<void> {
    const index = this.deliveries.findIndex((row) => row.dedupeKey === delivery.dedupeKey);
    if (index < 0) this.deliveries.push(delivery);
    else this.deliveries[index] = delivery;
  }

  async countSentSince(ownerId: string, sinceIso: string): Promise<number> {
    return this.deliveries.filter((row) => row.ownerId === ownerId && row.status === "sent" && (row.sentAt ?? "") >= sinceIso).length;
  }

  async countAllSentSince(sinceIso: string): Promise<number> {
    return this.deliveries.filter((row) => row.status === "sent" && row.channel !== "telegram" && (row.sentAt ?? "") >= sinceIso).length;
  }

  async ownerIdForCalendarToken(token: string): Promise<string | null> {
    for (const [id, contact] of this.contacts) {
      if (contact.calendarToken === token) return id;
    }
    return null;
  }

  async claimTelegramLink(token: string, chatId: string, nowIso: string): Promise<string | null> {
    for (const [id, contact] of this.contacts) {
      if (contact.telegramLinkToken !== token) continue;
      if (!contact.telegramLinkExpires || contact.telegramLinkExpires <= nowIso) return null;
      this.contacts.set(id, { ...contact, telegramChatId: chatId, telegramLinkToken: null, telegramLinkExpires: null });
      return id;
    }
    return null;
  }

  async getProviderBackoffUntil(): Promise<string | null> {
    return this.providerBackoffUntil;
  }

  async setProviderBackoffUntil(untilIso: string): Promise<void> {
    this.providerBackoffUntil = untilIso;
  }

  reserveSend(input: SendReserve): SendReserveResult {
    const contact = this.contacts.get(input.ownerId) ?? null;
    const ownerHolds = this.holds.filter((hold) => hold.ownerId === input.ownerId).length;
    const monthUsed = sentThisMonth(contact, input.now, input.timeZone) + ownerHolds;
    if (monthUsed >= input.monthlyLimit) return { ok: false, reason: "month" };
    const dayUsed = this.deliveries.filter((row) => row.ownerId === input.ownerId && row.status === "sent" && (row.sentAt ?? "") >= input.sinceIso).length + ownerHolds;
    if (dayUsed >= input.dailyLimit) return { ok: false, reason: "day" };
    if (input.countGlobal) {
      const globalHolds = this.holds.filter((hold) => hold.global).length;
      const globalDay = this.deliveries.filter((row) => row.status === "sent" && row.channel !== "telegram" && (row.sentAt ?? "") >= input.globalDayStartIso).length + globalHolds;
      if (globalDay >= input.globalDayLimit) return { ok: false, reason: "global-day" };
      const globalMonth = this.deliveries.filter((row) => row.status === "sent" && row.channel !== "telegram" && (row.sentAt ?? "") >= input.globalMonthStartIso).length + globalHolds;
      if (globalMonth >= input.globalMonthLimit) return { ok: false, reason: "global-month" };
    }
    const id = randomUUID();
    this.holds.push({ id, ownerId: input.ownerId, global: input.countGlobal });
    return { ok: true, id };
  }

  releaseSend(id: string): void {
    this.holds = this.holds.filter((hold) => hold.id !== id);
  }

  beginSend(idempotencyKey: string): boolean {
    if (this.inFlight.has(idempotencyKey)) return false;
    if (this.deliveries.some((row) => row.idempotencyKey === idempotencyKey && row.status === "sent")) return false;
    this.inFlight.add(idempotencyKey);
    return true;
  }

  finishSend(idempotencyKey: string): void {
    this.inFlight.delete(idempotencyKey);
  }
}

export function statusOrAll(status: string | undefined): ReminderStatus | "all" | undefined {
  if (status === "active" || status === "fired" || status === "completed" || status === "cancelled" || status === "paused" || status === "all") return status;
  return undefined;
}
