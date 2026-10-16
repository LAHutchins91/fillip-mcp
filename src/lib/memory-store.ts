import type { ClaimResult, Delivery, DeliveryChannel, DigestSettings, OwnerContact, OwnerIdentity, Reminder, ReminderStatus } from "./types.js";
import { OpenCapError, ReminderConflictError, type ListQuery, type OpenCap, type SendReserve, type SendReserveResult, type ServiceStore } from "./store.js";
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
  private writes: Promise<void> = Promise.resolve();

  private enqueue<T>(run: () => T): Promise<T> {
    const result = this.writes.then(() => run());
    this.writes = result.then(() => undefined, () => undefined);
    return result;
  }

  async listReminders(ownerId: string, query: ListQuery): Promise<Reminder[]> {
    return this.reminders
      .filter((row) => row.ownerId === ownerId && (query.status === undefined || query.status === "all" || row.status === query.status))
      .sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  }

  async getReminder(ownerId: string, id: string): Promise<Reminder | null> {
    return this.reminders.find((row) => row.ownerId === ownerId && row.id === id) ?? null;
  }

  async createReminder(reminder: Reminder, open?: OpenCap): Promise<Reminder> {
    return this.enqueue(() => {
      if (open && reminder.status === "active") {
        const active = this.reminders.filter((row) => row.ownerId === reminder.ownerId && row.status === "active").length;
        if (active >= open.cap) throw new OpenCapError(open.message);
      }
      this.reminders.push(reminder);
      return reminder;
    });
  }

  async saveReminder(reminder: Reminder, expectedUpdatedAt?: string): Promise<Reminder> {
    const index = this.reminders.findIndex((row) => row.id === reminder.id && row.ownerId === reminder.ownerId);
    if (index < 0) throw new Error("Reminder not found");
    if (expectedUpdatedAt !== undefined && this.reminders[index]?.updatedAt !== expectedUpdatedAt) {
      throw new ReminderConflictError();
    }
    const previous = this.reminders[index];
    this.reminders[index] = reminder;
    if (
      previous
      && previous.status !== reminder.status
      && (reminder.status === "removed" || reminder.status === "paused" || reminder.status === "cancelled")
    ) {
      this.cancelInFlight(reminder.ownerId, reminder.id);
    }
    return reminder;
  }

  /** Same moment as the status write: an in-progress claim cannot still look sendable. */
  private cancelInFlight(ownerId: string, reminderId: string): void {
    for (const delivery of this.deliveries) {
      if (delivery.ownerId === ownerId && delivery.reminderId === reminderId && delivery.status === "sending") {
        delivery.status = "cancelled";
      }
    }
  }

  async reminderSendInFlight(ownerId: string, reminderId: string, now: Date): Promise<boolean> {
    const staleBefore = now.getTime() - 2 * 60 * 1000;
    return this.deliveries.some((row) =>
      row.ownerId === ownerId
      && row.reminderId === reminderId
      && row.status === "sending"
      && Date.parse(row.startedAt) > staleBefore
    );
  }

  async deleteReminder(ownerId: string, id: string): Promise<void> {
    const index = this.reminders.findIndex((row) => row.id === id && row.ownerId === ownerId);
    if (index < 0) throw new Error("Reminder not found");
    this.reminders.splice(index, 1);
    this.deliveries = this.deliveries.filter((row) => !(row.ownerId === ownerId && row.reminderId === id));
  }

  async countCreatedSince(ownerId: string, sinceIso: string): Promise<number> {
    return this.reminders.filter((row) => row.ownerId === ownerId && row.createdAt >= sinceIso).length;
  }

  async countActive(ownerId: string): Promise<number> {
    return this.reminders.filter((row) => row.ownerId === ownerId && row.status === "active").length;
  }

  async listDeliveryMarks(ownerId: string) {
    return this.deliveries
      .filter((row) => row.ownerId === ownerId)
      .map((row) => ({
        reminderId: row.reminderId,
        occurrenceAt: row.occurrenceAt,
        status: row.status,
        error: row.error
      }));
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

  async listHeld(nowIso: string): Promise<Reminder[]> {
    return this.reminders.filter((row) => row.status === "active" && row.holdUntil !== null && row.holdUntil > nowIso);
  }

  async listEnabledDigests(): Promise<DigestSettings[]> {
    return [...this.digests.values()].filter((row) => row.enabled);
  }

  private reminderIsActive(ownerId: string, reminderId: string | null): boolean {
    if (!reminderId) return true;
    return this.reminders.some((row) => row.ownerId === ownerId && row.id === reminderId && row.status === "active");
  }

  private withheldClaim(input: {
    ownerId: string;
    reminderId: string | null;
    dedupeKey: string;
    occurrenceAt: string;
    idempotencyKey: string;
    channel: "email" | "telegram";
    nowIso: string;
  }): ClaimResult {
    const existing = this.deliveries.find((row) => row.dedupeKey === input.dedupeKey);
    const delivery: Delivery = existing ?? {
      id: input.dedupeKey,
      ownerId: input.ownerId,
      reminderId: input.reminderId,
      dedupeKey: input.dedupeKey,
      occurrenceAt: input.occurrenceAt,
      status: "skipped",
      idempotencyKey: input.idempotencyKey,
      channel: input.channel,
      providerId: null,
      startedAt: input.nowIso,
      sentAt: null,
      error: null
    };
    return { delivery, outcome: "withheld" };
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
    if (!this.reminderIsActive(input.ownerId, input.reminderId)) return this.withheldClaim(input);
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
      if (!this.reminderIsActive(input.ownerId, input.reminderId)) return this.withheldClaim(input);
      return { delivery, outcome: "send" };
    }
    const attempt = existing.providerId === "attempt";
    const accepted = Boolean(existing.providerId) && !attempt;
    if (typeof existing.error === "string" && /not delivered/i.test(existing.error)) return { delivery: existing, outcome: "already-sent" };
    if (existing.status === "sent" || accepted) return { delivery: existing, outcome: "already-sent" };
    // Inside the claim lease, "attempt" means the provider may never have been
    // called, so retry it. Email stays retryable for 24 hours after the lease
    // because Resend dedupes that idempotency key. Telegram cannot dedupe, so
    // a stale attempt is not submitted again.
    if (attempt && existing.startedAt <= input.staleBeforeIso) {
      const age = Date.parse(input.nowIso) - Date.parse(existing.startedAt);
      if (existing.channel === "email" && Number.isFinite(age) && age <= 24 * 60 * 60 * 1000) {
        existing.idempotencyKey = input.idempotencyKey;
        if (!this.reminderIsActive(input.ownerId, input.reminderId)) return this.withheldClaim(input);
        return { delivery: existing, outcome: "send" };
      }
      return { delivery: existing, outcome: "already-sent" };
    }
    if (existing.status === "sending" && !attempt && existing.startedAt > input.staleBeforeIso) {
      return { delivery: existing, outcome: "in-progress" };
    }
    existing.status = "sending";
    existing.startedAt = input.nowIso;
    existing.error = null;
    existing.idempotencyKey = input.idempotencyKey;
    if (!this.reminderIsActive(input.ownerId, input.reminderId)) return this.withheldClaim(input);
    return { delivery: existing, outcome: "send" };
  }

  async confirmActiveSend(delivery: Delivery): Promise<boolean> {
    if (!delivery.reminderId) return true;
    const row = this.deliveries.find((item) => item.ownerId === delivery.ownerId && item.dedupeKey === delivery.dedupeKey);
    if (row && row.status !== "sending") return false;
    if (!this.reminderIsActive(delivery.ownerId, delivery.reminderId)) {
      if (row?.status === "sending") {
        row.status = "skipped";
        row.providerId = null;
      }
      return false;
    }
    return true;
  }

  async saveDelivery(delivery: Delivery): Promise<void> {
    const index = this.deliveries.findIndex((row) => row.dedupeKey === delivery.dedupeKey);
    if (index < 0) this.deliveries.push(delivery);
    else this.deliveries[index] = delivery;
  }

  /**
   * Synchronous on the shared delivery list, so parallel workers cannot all
   * pass the check before any of them writes. saveDelivery on a worker waits
   * before its write is visible; this claim does not.
   */
  claimNotice(input: { ownerId: string; reminderId: string; fireAt: string; nowIso: string }): boolean {
    const dedupeKey = `reminder:${input.reminderId}:${input.fireAt}:not-delivered`;
    if (this.deliveries.some((row) => row.dedupeKey === dedupeKey)) return false;
    this.deliveries.push({
      id: dedupeKey,
      ownerId: input.ownerId,
      reminderId: input.reminderId,
      dedupeKey,
      occurrenceAt: input.fireAt,
      status: "sending",
      idempotencyKey: `fillip/${input.reminderId}/${input.fireAt}/not-delivered`,
      channel: "email",
      providerId: null,
      startedAt: input.nowIso,
      sentAt: null,
      error: null
    });
    return true;
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
    if (input.reminderId && !this.reminderIsActive(input.ownerId, input.reminderId)) return { ok: false, reason: "removed" };
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

  releaseSend(id: string, _keep = false): void {
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

  async purgeRemoved(cutoffIso: string): Promise<number> {
    const doomed = this.reminders.filter((row) => row.status === "removed" && row.removedAt && row.removedAt < cutoffIso);
    if (!doomed.length) return 0;
    const ids = new Set(doomed.map((row) => row.id));
    this.deliveries = this.deliveries.filter((row) => !row.reminderId || !ids.has(row.reminderId));
    this.reminders = this.reminders.filter((row) => !ids.has(row.id));
    return doomed.length;
  }
}

export function statusOrAll(status: string | undefined): ReminderStatus | "all" | undefined {
  if (status === "active" || status === "fired" || status === "completed" || status === "cancelled" || status === "paused" || status === "all") return status;
  return undefined;
}
