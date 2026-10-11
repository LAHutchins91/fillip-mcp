import { UPGRADE_PROMPT } from "./usage.js";

const KNOWN = [
  "Say when to ping you",
  "That time is in the past",
  "That time today has already passed",
  "That year",
  "That date has already passed",
  "Fillip could not read that time",
  "Fillip can repeat",
  "Add a time",
  "A verified account email",
  "Reminder not found",
  "That reminder is already",
  "Too many reminders",
  "The free plan",
  "This plan's reminder pings",
  "Telegram is not offered",
  "Telegram is not linked",
  "Choose email, Telegram, or both",
  "An end date needs",
  "That repeating reminder has already ended",
  "That one-time reminder is already in the past",
  "Name a time to move this reminder",
  "Choose a timezone",
  "Digest time",
  "That date is not a real calendar day",
  "Follow-ups need a first time or a cadence"
] as const;

/** The trigger raises P0001 with the cap sentence buried in a PostgREST body. Callers should see that sentence, not the wrapper. */
export function openCapMessage(error: unknown): string | null {
  const message = error instanceof Error ? error.message : "";
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  let sentence = "";
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(message.slice(start, end + 1)) as { message?: unknown };
      if (typeof parsed.message === "string") sentence = parsed.message;
    } catch {
      sentence = "";
    }
  }
  if (!sentence && (message.startsWith("The free plan") || message.startsWith("Too many reminders"))) sentence = message;
  if (sentence.startsWith("The free plan")) {
    return sentence.includes(UPGRADE_PROMPT) ? sentence : `${sentence} ${UPGRADE_PROMPT}`;
  }
  if (sentence.startsWith("Too many reminders")) return sentence;
  return null;
}

export function publicError(error: unknown): { status: number; error: string } {
  const cap = openCapMessage(error);
  if (cap) return { status: 429, error: cap };
  const message = error instanceof Error ? error.message : "";
  const safe = KNOWN.find((item) => message.includes(item));
  if (safe === "Reminder not found") return { status: 404, error: safe };
  if (safe === "Too many reminders" || safe === "The free plan" || safe === "This plan's reminder pings") return { status: 429, error: message };
  if (safe) return { status: 400, error: message };
  return { status: 500, error: "Fillip could not complete this request. Your reminder may not have been saved." };
}
