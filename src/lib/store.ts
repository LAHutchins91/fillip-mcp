import { randomUUID } from "node:crypto";
import type { ClaimResult, Delivery, DeliveryChannel, DigestSettings, OwnerContact, OwnerIdentity, Reminder, ReminderStatus } from "./types.js";

export type ListQuery = { status?: ReminderStatus | "all" };

export interface ReminderStore {
  listReminders(ownerId: string, query: ListQuery): Promise<Reminder[]>;
  getReminder(ownerId: string, id: string): Promise<Reminder | null>;
  createReminder(reminder: Reminder): Promise<Reminder>;
  saveReminder(reminder: Reminder): Promise<Reminder>;
  countCreatedSince(ownerId: string, sinceIso: string): Promise<number>;
  countActive(ownerId: string): Promise<number>;
  rememberOwner(contact: OwnerIdentity): Promise<void>;
  setMailOptIn(ownerId: string, enabled: boolean): Promise<void>;
  getDigest(ownerId: string): Promise<DigestSettings | null>;
  saveDigest(settings: DigestSettings): Promise<void>;
  deleteOwnerData(ownerId: string): Promise<void>;
  getUsage(ownerId: string): Promise<OwnerContact | null>;
  setDefaultChannel(ownerId: string, channel: DeliveryChannel): Promise<void>;
  beginTelegramLink(ownerId: string, token: string, expiresIso: string): Promise<void>;
  unlinkTelegram(ownerId: string): Promise<void>;
  setCalendarToken(ownerId: string, token: string): Promise<void>;
}

export type SendReserve = {
  ownerId: string;
  now: Date;
  timeZone: string;
  sinceIso: string;
  monthlyLimit: number;
  dailyLimit: number;
  globalDayStartIso: string;
  globalMonthStartIso: string;
  globalDayLimit: number;
  globalMonthLimit: number;
  countGlobal: boolean;
};

export type SendReserveResult =
  | { ok: true; id: string }
  | { ok: false; reason: "month" | "day" | "global-day" | "global-month" };

export interface ServiceStore extends ReminderStore {
  getContact(ownerId: string): Promise<OwnerContact | null>;
  listDue(nowIso: string, limit: number): Promise<Reminder[]>;
  listEnabledDigests(): Promise<DigestSettings[]>;
  claimDelivery(input: {
    ownerId: string;
    reminderId: string | null;
    dedupeKey: string;
    occurrenceAt: string;
    idempotencyKey: string;
    channel: "email" | "telegram";
    nowIso: string;
    staleBeforeIso: string;
  }): Promise<ClaimResult>;
  ownerIdForCalendarToken(token: string): Promise<string | null>;
  claimTelegramLink(token: string, chatId: string, nowIso: string): Promise<string | null>;
  saveDelivery(delivery: Delivery): Promise<void>;
  countSentSince(ownerId: string, sinceIso: string): Promise<number>;
  countAllSentSince(sinceIso: string): Promise<number>;
  getProviderBackoffUntil(): Promise<string | null>;
  setProviderBackoffUntil(untilIso: string): Promise<void>;
  saveUsage(ownerId: string, usage: { emailsSentInPeriod: number; emailPeriodStart: string }): Promise<void>;
  /** Synchronous cap hold. Two callers in one process cannot both pass the same remaining slot. */
  reserveSend(input: SendReserve): SendReserveResult;
  releaseSend(id: string): void;
  /** One in-flight provider call per idempotency key. False when another caller already holds it or it was sent. */
  beginSend(idempotencyKey: string): boolean;
  finishSend(idempotencyKey: string): void;
}

export function newId(): string {
  return randomUUID();
}
