import type { OwnerContact, PlanName } from "./types.js";
import type { ReminderStore } from "./store.js";

export type PlanTier = "trial" | "pro" | "annual" | "free";

export type TierCaps = {
  trialEmailsPerMonth: number;
  proEmailsPerMonth: number;
  annualEmailsPerMonth: number;
  freeEmailsPerMonth?: number;
  freeOpenReminders?: number;
};

/**
 * Stand-in counts used only when a cap variable is unset.
 * They are not the commercial allowance. Set the env vars before hosting.
 */
export const FREE_EMAILS_PER_MONTH = 30;
export const FREE_OPEN_REMINDERS = 10;

export const STAND_IN_CAPS: TierCaps = {
  trialEmailsPerMonth: 30,
  proEmailsPerMonth: 60,
  annualEmailsPerMonth: 60,
  freeEmailsPerMonth: FREE_EMAILS_PER_MONTH,
  freeOpenReminders: FREE_OPEN_REMINDERS
};

export const ALLOWANCE_REACHED = "This plan's reminder emails for the month are used up. Fillip will not send more until the allowance resets.";
export const UPGRADE_PROMPT = "Upgrade to Pro for a higher allowance. The trial is 14 days, then Pro.";

export type Allowance = {
  tier: PlanTier;
  used: number;
  limit: number;
  reached: boolean;
  message: string | null;
};

function capValue(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

export function tierCapsFromEnv(env: NodeJS.ProcessEnv = process.env): TierCaps {
  return {
    trialEmailsPerMonth: capValue(env.FILLIP_CAP_TRIAL_EMAILS_PER_MONTH, STAND_IN_CAPS.trialEmailsPerMonth),
    proEmailsPerMonth: capValue(env.FILLIP_CAP_PRO_EMAILS_PER_MONTH, STAND_IN_CAPS.proEmailsPerMonth),
    annualEmailsPerMonth: capValue(env.FILLIP_CAP_ANNUAL_EMAILS_PER_MONTH, STAND_IN_CAPS.annualEmailsPerMonth),
    freeEmailsPerMonth: capValue(env.FILLIP_CAP_FREE_EMAILS_PER_MONTH, FREE_EMAILS_PER_MONTH),
    freeOpenReminders: capValue(env.FILLIP_CAP_FREE_OPEN_REMINDERS, FREE_OPEN_REMINDERS)
  };
}

export function freeEmailsPerMonth(caps: TierCaps): number {
  return caps.freeEmailsPerMonth ?? FREE_EMAILS_PER_MONTH;
}

export function freeOpenReminders(caps: TierCaps): number {
  return caps.freeOpenReminders ?? FREE_OPEN_REMINDERS;
}

export function allowanceReachedMessage(tier: PlanTier): string {
  if (tier === "free" || tier === "trial") return `${ALLOWANCE_REACHED} ${UPGRADE_PROMPT}`;
  return ALLOWANCE_REACHED;
}

export function freeOpenMessage(limit: number): string {
  return `The free plan allows ${limit} open reminders. ${UPGRADE_PROMPT}`;
}

export function usageCapsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return ["FILLIP_CAP_TRIAL_EMAILS_PER_MONTH", "FILLIP_CAP_PRO_EMAILS_PER_MONTH", "FILLIP_CAP_ANNUAL_EMAILS_PER_MONTH"]
    .every((name) => {
      const raw = env[name];
      if (!raw || raw.trim() === "") return false;
      const value = Number(raw);
      return Number.isFinite(value) && value >= 0;
    });
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextMonthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export function tierFor(plan: PlanName | string | null | undefined, status: string | null | undefined): PlanTier {
  if (status === "trialing") return "trial";
  if (status === "active" && plan === "annual") return "annual";
  if (status === "active" && plan === "pro") return "pro";
  return "free";
}

export function emailsPerMonth(tier: PlanTier, caps: TierCaps): number {
  if (tier === "trial") return caps.trialEmailsPerMonth;
  if (tier === "pro") return caps.proEmailsPerMonth;
  if (tier === "annual") return caps.annualEmailsPerMonth;
  return freeEmailsPerMonth(caps);
}

export function sentThisMonth(contact: Pick<OwnerContact, "emailsSentInPeriod" | "emailPeriodStart"> | null, now: Date): number {
  if (!contact?.emailPeriodStart) return 0;
  if (contact.emailPeriodStart < monthStart(now).toISOString()) return 0;
  return contact.emailsSentInPeriod;
}

export function allowanceFor(contact: Pick<OwnerContact, "plan" | "subscriptionStatus" | "emailsSentInPeriod" | "emailPeriodStart"> | null, now: Date, caps: TierCaps): Allowance {
  const tier = contact ? tierFor(contact.plan, contact.subscriptionStatus) : "free";
  const limit = emailsPerMonth(tier, caps);
  const used = sentThisMonth(contact, now);
  const reached = used >= limit;
  return { tier, used, limit, reached, message: reached ? allowanceReachedMessage(tier) : null };
}

export async function assertWithinAllowance(store: ReminderStore, ownerId: string, now: Date, caps: TierCaps): Promise<Allowance> {
  const allowance = allowanceFor(await store.getUsage(ownerId), now, caps);
  if (allowance.reached) throw new Error(allowance.message ?? ALLOWANCE_REACHED);
  return allowance;
}

export function blankContact(id: string, patch: Partial<OwnerContact> = {}): OwnerContact {
  return {
    id,
    email: null,
    emailVerified: false,
    unsubscribed: false,
    plan: "pro",
    subscriptionStatus: "active",
    emailsSentInPeriod: 0,
    emailPeriodStart: null,
    defaultChannel: "email",
    telegramChatId: null,
    telegramLinkToken: null,
    telegramLinkExpires: null,
    calendarToken: null,
    ...patch
  };
}
