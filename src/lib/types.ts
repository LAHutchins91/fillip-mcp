export type RecurrenceEnd = {
  /** Exclusive instant. The next occurrence at or after this is not scheduled. */
  until: string | null;
  count: number | null;
  completed: number;
};

export type Recurrence =
  | { kind: "daily"; hour: number; minute: number; ends?: RecurrenceEnd }
  | { kind: "weekdays"; hour: number; minute: number; ends?: RecurrenceEnd }
  | { kind: "weekly"; weekday: number; hour: number; minute: number; ends?: RecurrenceEnd }
  | { kind: "every_n_days"; interval: number; hour: number; minute: number; anchor: string; ends?: RecurrenceEnd }
  | { kind: "every_n_weeks"; interval: number; weekday: number; hour: number; minute: number; anchor: string; ends?: RecurrenceEnd }
  | { kind: "monthly_date"; day: number; hour: number; minute: number; ends?: RecurrenceEnd }
  | { kind: "monthly_nth"; nth: number; weekday: number; hour: number; minute: number; ends?: RecurrenceEnd };

export type DeliveryChannel = "email" | "telegram" | "both";

export type ReminderStatus = "active" | "fired" | "completed" | "cancelled" | "paused" | "removed";
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
  channel: DeliveryChannel;
  status: ReminderStatus;
  holdUntil: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  /** Set while status is removed. Restore is refused after 30 days, and the cron then deletes the row. */
  removedAt?: string | null;
  /** active or paused, remembered so restore returns the same reminder to that state. */
  resumeStatus?: "active" | "paused" | null;
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
  channel: "email" | "telegram";
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

export type PlanName = "none" | "free" | "pro" | "annual";

export type OwnerContact = {
  id: string;
  email: string | null;
  emailVerified: boolean;
  unsubscribed: boolean;
  plan: PlanName;
  subscriptionStatus: string;
  emailsSentInPeriod: number;
  emailPeriodStart: string | null;
  defaultChannel: DeliveryChannel;
  telegramChatId: string | null;
  telegramLinkToken: string | null;
  telegramLinkExpires: string | null;
  calendarToken: string | null;
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
  outcome: "send" | "already-sent" | "in-progress" | "withheld";
};

export type Actor = {
  id: string;
  email: string | null;
  emailVerified: boolean;
};

export const MAX_ACTIVE_REMINDERS = 100;
export const MAX_CREATES_PER_HOUR = 30;
