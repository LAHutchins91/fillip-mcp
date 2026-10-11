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
  "This plan's reminder emails",
  "Choose a timezone",
  "Digest time",
  "That date is not a real calendar day",
  "Follow-ups need a first time or a cadence"
] as const;

export function publicError(error: unknown): { status: number; error: string } {
  const message = error instanceof Error ? error.message : "";
  const safe = KNOWN.find((item) => message.includes(item));
  if (safe === "Reminder not found") return { status: 404, error: safe };
  if (safe === "Too many reminders" || safe === "This plan's reminder emails") return { status: 429, error: message };
  if (safe) return { status: 400, error: message };
  return { status: 500, error: "Fillip could not complete this request. Your reminder may not have been saved." };
}
