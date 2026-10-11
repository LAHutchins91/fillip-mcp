import type { OwnerContact, PlanName } from "./types.js";
import type { ReminderStore } from "./store.js";

export type PlanTier = "trial" | "pro" | "annual" | "none";

export type TierCaps = {
  trialEmailsPerMonth: number;
  proEmailsPerMonth: number;
  annualEmailsPerMonth: number;
};

/**
 * Stand-in counts used only when a cap variable is unset.
 * They are not the commercial allowance. Set the env vars before hosting.
 */
export const STAND_IN_CAPS: TierCaps = {
  trialEmailsPerMonth: 30,
  proEmailsPerMonth: 60,
  annualEmailsPerMonth: 60
};

export const ALLOWANCE_REACHED = "This plan's reminder emails for the month are used up. Fillip will not send more until the allowance resets.";

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
    annualEmailsPerMonth: capValue(env.FILLIP_CAP_ANNUAL_EMAILS_PER_MONTH, STAND_IN_CAPS.annualEmailsPerMonth)
  };
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
  return "none";
}

export function emailsPerMonth(tier: PlanTier, caps: TierCaps): number {
  if (tier === "trial") return caps.trialEmailsPerMonth;
  if (tier === "pro") return caps.proEmailsPerMonth;
  if (tier === "annual") return caps.annualEmailsPerMonth;
  return 0;
}

export function sentThisMonth(contact: Pick<OwnerContact, "emailsSentInPeriod" | "emailPeriodStart"> | null, now: Date): number {
  if (!contact?.emailPeriodStart) return 0;
  if (contact.emailPeriodStart < monthStart(now).toISOString()) return 0;
  return contact.emailsSentInPeriod;
}

export function allowanceFor(contact: Pick<OwnerContact, "plan" | "subscriptionStatus" | "emailsSentInPeriod" | "emailPeriodStart"> | null, now: Date, caps: TierCaps): Allowance {
  if (!contact) return { tier: "none", used: 0, limit: 0, reached: false, message: null };
  const tier = tierFor(contact.plan, contact.subscriptionStatus);
  const limit = emailsPerMonth(tier, caps);
  const used = sentThisMonth(contact, now);
  const reached = used >= limit;
  return { tier, used, limit, reached, message: reached ? ALLOWANCE_REACHED : null };
}

export async function assertWithinAllowance(store: ReminderStore, ownerId: string, now: Date, caps: TierCaps): Promise<Allowance> {
  const allowance = allowanceFor(await store.getUsage(ownerId), now, caps);
  if (allowance.reached) throw new Error(ALLOWANCE_REACHED);
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
    ...patch
  };
}
