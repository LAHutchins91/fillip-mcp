import { newId, type ReminderStore } from "./store.js";
import { applyRepeat, describeRecurrence, nextFire, parseClock, recurrenceFromCadence, resolveWhen, type RepeatChoice, type ResolvedWhen } from "./time.js";
import { MAX_ACTIVE_REMINDERS, MAX_CREATES_PER_HOUR, type Actor, type DigestSettings, type Reminder, type ReminderStatus } from "./types.js";
import { assertWithinAllowance, STAND_IN_CAPS, type TierCaps } from "./usage.js";
import { assertTimeZone, formatWhen, localDateKey, zonedParts } from "./zone.js";

export type ReminderView = {
  id: string;
  what: string;
  context: string | null;
  kind: Reminder["kind"];
  status: ReminderStatus;
  timezone: string;
  fireAt: string;
  localTime: string;
  repeats: string;
  overdue: boolean;
  corrected: boolean;
  note: string | null;
};

function view(reminder: Reminder, now: Date, extra?: { corrected?: boolean; note?: string | null }): ReminderView {
  return {
    id: reminder.id,
    what: reminder.what,
    context: reminder.context,
    kind: reminder.kind,
    status: reminder.status,
    timezone: reminder.timezone,
    fireAt: reminder.fireAt,
    localTime: formatWhen(new Date(reminder.fireAt), reminder.timezone),
    repeats: describeRecurrence(reminder.recurrence),
    overdue: reminder.status === "active" && reminder.fireAt <= now.toISOString(),
    corrected: extra?.corrected ?? false,
    note: extra?.note ?? null
  };
}

async function gate(store: ReminderStore, actor: Actor, now: Date) {
  if (!actor.id || !actor.email || !actor.emailVerified) {
    throw new Error("A verified account email is required before Fillip can ping you.");
  }
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (await store.countCreatedSince(actor.id, since) >= MAX_CREATES_PER_HOUR) {
    throw new Error("Too many reminders. Wait before setting another.");
  }
  if (await store.countActive(actor.id) >= MAX_ACTIVE_REMINDERS) {
    throw new Error("Too many reminders are still open. Complete or cancel one first.");
  }
  await store.rememberOwner({ id: actor.id, email: actor.email, emailVerified: true, unsubscribed: false });
  await store.setMailOptIn(actor.id, true);
}

function stamp(actor: Actor, what: string, context: string | null, timezone: string, resolved: ResolvedWhen, kind: Reminder["kind"], now: Date): Reminder {
  return {
    id: newId(),
    ownerId: actor.id,
    kind,
    what,
    context,
    timezone,
    fireAt: resolved.fireAt.toISOString(),
    recurrence: resolved.recurrence,
    status: "active",
    holdUntil: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    completedAt: null
  };
}

export async function setReminder(store: ReminderStore, actor: Actor, input: {
  what: string;
  when: string;
  timezone: string;
  repeat?: RepeatChoice;
  context?: string | null;
}, now: Date, caps: TierCaps = STAND_IN_CAPS): Promise<ReminderView> {
  await gate(store, actor, now);
  await assertWithinAllowance(store, actor.id, now, caps);
  const resolved = applyRepeat(resolveWhen(input.when, input.timezone, now), input.repeat, input.timezone);
  const reminder = await store.createReminder(stamp(actor, input.what, input.context ?? null, input.timezone, resolved, "reminder", now));
  const note = [resolved.note, "Fillip will email the verified address on this account."].filter(Boolean).join(" ");
  return view(reminder, now, { corrected: resolved.corrected, note });
}

export async function listReminders(store: ReminderStore, ownerId: string, input: {
  status?: ReminderStatus | "all";
  range?: "upcoming" | "today" | "week" | "past" | "any";
  timezone?: string;
}, now: Date): Promise<ReminderView[]> {
  const rows = await store.listReminders(ownerId, { status: input.status ?? "active" });
  const weekEnd = now.getTime() + 7 * 86_400_000;
  const filtered = rows.filter((row) => {
    const fire = new Date(row.fireAt).getTime();
    if (input.range === "past") return fire < now.getTime() || row.status === "fired" || row.status === "completed";
    if (input.range === "today") return localDateKey(new Date(row.fireAt), input.timezone || row.timezone) === localDateKey(now, input.timezone || row.timezone);
    if (input.range === "week") return fire >= now.getTime() - 86_400_000 && fire <= weekEnd;
    return true;
  });
  return filtered.map((row) => view(row, now));
}

export async function snoozeOrReschedule(store: ReminderStore, ownerId: string, id: string, until: string, timezone: string | undefined, now: Date): Promise<ReminderView> {
  const reminder = await store.getReminder(ownerId, id);
  if (!reminder) throw new Error("Reminder not found");
  if (reminder.status === "cancelled" || reminder.status === "completed") {
    throw new Error(`That reminder is already ${reminder.status}.`);
  }
  const zone = timezone || reminder.timezone;
  await store.setMailOptIn(ownerId, true);
  const resolved = resolveWhen(until, zone, now);
  const saved = await store.saveReminder({
    ...reminder,
    timezone: zone,
    fireAt: resolved.fireAt.toISOString(),
    status: "active",
    holdUntil: null,
    updatedAt: now.toISOString()
  });
  const note = [resolved.note, `Moved to ${formatWhen(resolved.fireAt, zone)}.`].filter(Boolean).join(" ");
  return view(saved, now, { corrected: resolved.corrected, note });
}

export async function completeOrCancel(store: ReminderStore, ownerId: string, id: string, action: "complete" | "cancel", now: Date): Promise<ReminderView> {
  const reminder = await store.getReminder(ownerId, id);
  if (!reminder) throw new Error("Reminder not found");
  const status: ReminderStatus = action === "complete" ? "completed" : "cancelled";
  const saved = await store.saveReminder({
    ...reminder,
    status,
    holdUntil: null,
    completedAt: action === "complete" ? now.toISOString() : reminder.completedAt,
    updatedAt: now.toISOString()
  });
  const note = action === "complete"
    ? "Marked done. Fillip will stop nudging you about this."
    : "Cancelled. Fillip will not email you about this.";
  return view(saved, now, { note });
}

export async function followUp(store: ReminderStore, actor: Actor, input: {
  topic: string;
  after?: string;
  cadence?: string;
  timezone: string;
  context?: string | null;
}, now: Date, caps: TierCaps = STAND_IN_CAPS): Promise<ReminderView> {
  await gate(store, actor, now);
  await assertWithinAllowance(store, actor.id, now, caps);
  if (!input.after && !input.cadence) throw new Error("Follow-ups need a first time or a cadence, such as next Tuesday at 2pm.");
  let first: ResolvedWhen;
  if (input.after) {
    first = resolveWhen(input.after, input.timezone, now);
    if (input.cadence) first = { ...first, recurrence: recurrenceFromCadence(input.cadence, input.timezone, now) };
  } else {
    const recurrence = recurrenceFromCadence(input.cadence ?? "", input.timezone, now);
    first = { fireAt: nextFire(recurrence, input.timezone, now), recurrence, corrected: false, note: null };
  }
  if (!first.recurrence) {
    const parts = zonedParts(first.fireAt, input.timezone);
    first = {
      ...first,
      recurrence: { kind: "weekly", weekday: parts.weekday, hour: parts.hour, minute: parts.minute }
    };
  }
  const reminder = await store.createReminder(stamp(actor, input.topic, input.context ?? null, input.timezone, first, "follow_up", now));
  const note = [first.note, `Fillip will keep emailing you ${describeRecurrence(reminder.recurrence)} until you mark it done.`].filter(Boolean).join(" ");
  return view(reminder, now, { corrected: first.corrected, note });
}

export async function saveDigestSettings(store: ReminderStore, actor: Actor, input: {
  enabled: boolean;
  time?: string;
  timezone?: string;
}, now: Date, caps: TierCaps = STAND_IN_CAPS): Promise<DigestSettings & { note: string }> {
  if (input.enabled) {
    if (!actor.email || !actor.emailVerified) throw new Error("A verified account email is required before Fillip can ping you.");
    await store.rememberOwner({ id: actor.id, email: actor.email, emailVerified: true, unsubscribed: false });
    await store.setMailOptIn(actor.id, true);
    await assertWithinAllowance(store, actor.id, now, caps);
  }
  const existing = await store.getDigest(actor.id);
  let hour = existing?.hour ?? 8;
  let minute = existing?.minute ?? 0;
  let timezone = input.timezone || existing?.timezone || "UTC";
  if (input.time) {
    const clock = parseClock(input.time);
    if (!clock) throw new Error("Digest time needs a clock time such as 8am.");
    hour = clock.hour;
    minute = clock.minute;
  } else if (input.enabled && !existing) {
    throw new Error("Digest time needs a clock time such as 8am.");
  }
  timezone = assertTimeZone(input.timezone || timezone);
  const settings: DigestSettings = {
    ownerId: actor.id,
    enabled: input.enabled,
    hour,
    minute,
    timezone,
    lastSentOn: existing?.lastSentOn ?? null,
    updatedAt: now.toISOString()
  };
  await store.saveDigest(settings);
  const note = input.enabled
    ? "Fillip will email you one daily summary. It goes only to the verified address on this account."
    : "Daily summary is off. Individual reminders still email you until you stop them.";
  return { ...settings, note };
}
