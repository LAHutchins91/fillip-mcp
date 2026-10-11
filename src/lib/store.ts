import { randomUUID } from "node:crypto";
import type { ClaimResult, Delivery, DigestSettings, OwnerContact, OwnerIdentity, Reminder, ReminderStatus } from "./types.js";

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
}

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
    nowIso: string;
    staleBeforeIso: string;
  }): Promise<ClaimResult>;
  saveDelivery(delivery: Delivery): Promise<void>;
  countSentSince(ownerId: string, sinceIso: string): Promise<number>;
  countAllSentSince(sinceIso: string): Promise<number>;
  getProviderBackoffUntil(): Promise<string | null>;
  setProviderBackoffUntil(untilIso: string): Promise<void>;
  saveUsage(ownerId: string, usage: { emailsSentInPeriod: number; emailPeriodStart: string }): Promise<void>;
}

export function newId(): string {
  return randomUUID();
}
