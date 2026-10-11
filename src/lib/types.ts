export type Recurrence =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

export type ReminderStatus = "active" | "fired" | "completed" | "cancelled" | "paused";
export type ReminderKind = "reminder" | "follow_up";

export type Reminder = {
  id: string;
  ownerId: string;
  kind: ReminderKind;
  what: string;
  context: string | null;
  timezone: string;
  fireAt: string;
  recurrence: Recurrence | null;
  status: ReminderStatus;
  holdUntil: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type DeliveryStatus = "sending" | "sent" | "failed" | "skipped";

export type Delivery = {
  id: string;
  ownerId: string;
  reminderId: string | null;
  dedupeKey: string;
  occurrenceAt: string;
  status: DeliveryStatus;
  idempotencyKey: string;
  providerId: string | null;
  startedAt: string;
  sentAt: string | null;
  error: string | null;
};

export type DigestSettings = {
  ownerId: string;
  enabled: boolean;
  hour: number;
  minute: number;
  timezone: string;
  lastSentOn: string | null;
  updatedAt: string;
};

export type PlanName = "none" | "pro" | "annual";

export type OwnerContact = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  unsubscribed: boolean;
  plan: PlanName;
  subscriptionStatus: string;
  emailsSentInPeriod: number;
  emailPeriodStart: string | null;
};

/** Identity written when someone opts in. Plan and the monthly counter stay on the stored contact. */
export type OwnerIdentity = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  unsubscribed?: boolean;
  plan?: PlanName;
  subscriptionStatus?: string;
};

export type ClaimResult = {
  delivery: Delivery;
  outcome: "send" | "already-sent" | "in-progress";
};

export type Actor = {
  id: string;
  email: string | null;
  emailVerified: boolean;
};

export const MAX_ACTIVE_REMINDERS = 100;
export const MAX_CREATES_PER_HOUR = 30;
