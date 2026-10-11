import { calendarFeed } from "./ics.js";
import { OpenCapError, newId, type OpenCap, type ReminderStore, type ServiceStore } from "./store.js";
import { newSecretToken, telegramDeepLink, telegramUsername } from "./telegram.js";
import { applyRepeat, attachEndDate, describeRecurrence, nextFire, parseClock, recurrenceFromCadence, resolveWhen, WhenError, type RepeatChoice, type ResolvedWhen } from "./time.js";
import { MAX_ACTIVE_REMINDERS, MAX_CREATES_PER_HOUR, type Actor, type DeliveryChannel, type DigestSettings, type Reminder, type ReminderStatus } from "./types.js";
import { allowanceFor, assertWithinAllowance, freeOpenMessage, freeOpenReminders, STAND_IN_CAPS, tierFor, type Allowance, type TierCaps } from "./usage.js";
import { assertTimeZone, formatShortWhen, formatWhen, localDateKey, zonedParts } from "./zone.js";

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
  channel: DeliveryChannel;
  state: ReminderStatus | "delayed";
  delayed: boolean;
  delay: string | null;
  overdue: boolean;
  corrected: boolean;
  note: string | null;
};

export function formatDelay(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.max(1, Math.round(hours / 24));
  return `${days} ${days === 1 ? "day" : "days"}`;
}

export function delayLength(reminder: Pick<Reminder, "fireAt" | "holdUntil" | "status">, now: Date): string | null {
  if (reminder.status !== "active" || !reminder.holdUntil) return null;
  const late = now.getTime() - new Date(reminder.fireAt).getTime();
  if (late < 60_000) return null;
  return formatDelay(late);
}

function wouldNextSend(reminder: Reminder, now: Date): string | null {
  if (reminder.status !== "paused") return null;
  let when = new Date(reminder.fireAt);
  if (when.getTime() <= now.getTime() && reminder.recurrence) {
    const upcoming = nextFire(reminder.recurrence, reminder.timezone, now);
    if (upcoming) when = upcoming;
  }
  return `paused (would next send ${formatShortWhen(when, reminder.timezone)})`;
}

function view(reminder: Reminder, now: Date, extra?: { corrected?: boolean; note?: string | null }): ReminderView {
  const delay = delayLength(reminder, now);
  const delayed = delay !== null;
  const note = [extra?.note, wouldNextSend(reminder, now)].filter(Boolean).join(" ") || null;
  return {
    id: reminder.id,
    what: reminder.what,
    context: reminder.context,
    kind: reminder.kind,
    status: reminder.status,
    timezone: reminder.timezone,
    fireAt: reminder.fireAt,
    localTime: formatWhen(new Date(reminder.fireAt), reminder.timezone),
    repeats: describeRecurrence(reminder.recurrence, reminder.timezone),
    channel: reminder.channel ?? "email",
    state: delayed ? "delayed" : reminder.status,
    delayed,
    delay,
    overdue: reminder.status === "active" && reminder.fireAt <= now.toISOString(),
    corrected: extra?.corrected ?? false,
    note
  };
}

function refuseSilentShift(resolved: { note: string | null; fireAt: Date }, accept: boolean | undefined, timeZone: string): void {
  if (accept || !resolved.note || !/does not exist/i.test(resolved.note)) return;
  throw new WhenError(
    `${resolved.note} Fillip did not save that time. Pass accept_shifted_time true to keep ${formatShortWhen(resolved.fireAt, timeZone)}, or give a clock that exists that day.`
  );
}

async function gate(store: ReminderStore, actor: Actor, now: Date, caps: TierCaps) {
  if (!actor.id || !actor.email || !actor.emailVerified) {
    throw new Error("A verified account email is required before Fillip can ping you.");
  }
  const since = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  if (await store.countCreatedSince(actor.id, since) >= MAX_CREATES_PER_HOUR) {
    throw new Error("Too many reminders. Wait before setting another.");
  }
  await store.rememberOwner({ id: actor.id, email: actor.email, emailVerified: true, unsubscribed: false });
  await store.setMailOptIn(actor.id, true);
  const usage = await store.getUsage(actor.id);
  const tier = tierFor(usage?.plan, usage?.subscriptionStatus);
  const openCap = tier === "free" ? freeOpenReminders(caps) : MAX_ACTIVE_REMINDERS;
  if (await store.countActive(actor.id) >= openCap) {
    throw new Error(tier === "free" ? freeOpenMessage(openCap) : "Too many reminders are still open. Complete or cancel one first.");
  }
}

function channelNote(channel: DeliveryChannel): string {
  if (channel === "telegram") return "Fillip will ping your linked Telegram chat.";
  if (channel === "both") return "Fillip will email the verified address on this account and ping your linked Telegram chat.";
  return "Fillip will email the verified address on this account.";
}

function followNote(channel: DeliveryChannel, recurrence: Reminder["recurrence"], timeZone: string): string {
  const repeats = describeRecurrence(recurrence, timeZone);
  const ended = Boolean(recurrence?.ends && (recurrence.ends.until || recurrence.ends.count));
  const stop = ended
    ? "It stops at that limit even if it is not marked done."
    : "It keeps going until you mark it done.";
  if (channel === "telegram") return `Fillip will keep pinging your Telegram chat ${repeats}. ${stop}`;
  if (channel === "both") return `Fillip will keep emailing you and pinging Telegram ${repeats}. ${stop}`;
  return `Fillip will keep emailing you ${repeats}. ${stop}`;
}

function chosenChannel(input: DeliveryChannel | undefined, fallback: DeliveryChannel | undefined, telegramEnabled: boolean): DeliveryChannel {
  const channel = input ?? fallback ?? "email";
  if (!telegramEnabled && channel !== "email") throw new Error("Telegram is not offered on this Fillip.");
  return channel;
}

function stamp(actor: Actor, what: string, context: string | null, timezone: string, resolved: ResolvedWhen, kind: Reminder["kind"], channel: DeliveryChannel, now: Date): Reminder {
  return {
    id: newId(),
    ownerId: actor.id,
    kind,
    what,
    context,
    timezone,
    fireAt: resolved.fireAt.toISOString(),
    recurrence: resolved.recurrence,
    channel,
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
  until?: string;
  context?: string | null;
  channel?: DeliveryChannel;
  acceptShiftedTime?: boolean;
}, now: Date, caps: TierCaps = STAND_IN_CAPS, telegramEnabled = false): Promise<ReminderView> {
  await gate(store, actor, now, caps);
  await assertWithinAllowance(store, actor.id, now, caps);
  const usage = await store.getUsage(actor.id);
  const channel = chosenChannel(input.channel, usage?.defaultChannel, telegramEnabled);
  let resolved = applyRepeat(resolveWhen(input.when, input.timezone, now), input.repeat, input.timezone);
  if (input.until?.trim()) resolved = attachEndDate(resolved, input.until, input.timezone, now);
  refuseSilentShift(resolved, input.acceptShiftedTime, input.timezone);
  const draft = stamp(actor, input.what, input.context ?? null, input.timezone, resolved, "reminder", channel, now);
  const note = [resolved.note, channelNote(channel)].filter(Boolean).join(" ");
  return createOrRefuse(store, draft, openCapFor(usage, caps), now, { corrected: resolved.corrected, note });
}

function holdExplanation(reminder: Reminder, allowance: Allowance): string | null {
  if (reminder.status !== "active" || !reminder.holdUntil) return null;
  if (allowance.reached && allowance.message) return allowance.message;
  return "This reminder is queued and held by the email guard, so the email will be delayed.";
}

export async function listReminders(store: ReminderStore, ownerId: string, input: {
  status?: ReminderStatus | "all";
  includeDone?: boolean;
  range?: "upcoming" | "today" | "week" | "past" | "any";
  timezone?: string;
}, now: Date, caps: TierCaps = STAND_IN_CAPS): Promise<ReminderView[]> {
  const rows = await store.listReminders(ownerId, { status: input.status ?? "all" });
  const visible = input.status || input.includeDone
    ? rows
    : rows.filter((row) => row.status !== "completed" && row.status !== "cancelled");
  const usage = await store.getUsage(ownerId);
  const weekEnd = now.getTime() + 7 * 86_400_000;
  const filtered = visible.filter((row) => {
    const fire = new Date(row.fireAt).getTime();
    if (input.range === "past") return fire < now.getTime() || row.status === "fired" || row.status === "completed";
    if (input.range === "today") return localDateKey(new Date(row.fireAt), input.timezone || row.timezone) === localDateKey(now, input.timezone || row.timezone);
    if (input.range === "week") return fire >= now.getTime() - 86_400_000 && fire <= weekEnd;
    return true;
  });
  return filtered.map((row) => {
    const allowance = allowanceFor(usage, now, caps, input.timezone || row.timezone);
    return view(row, now, { note: holdExplanation(row, allowance) });
  });
}

export type ReminderMove = "reschedule" | "pause" | "resume";

function nextOpenFire(reminder: Reminder, zone: string, now: Date): Date {
  const current = new Date(reminder.fireAt);
  if (current.getTime() > now.getTime()) return current;
  if (reminder.recurrence) {
    const upcoming = nextFire(reminder.recurrence, zone, now);
    if (!upcoming) throw new Error("That repeating reminder has already ended.");
    return upcoming;
  }
  throw new Error("That one-time reminder is already in the past. Name a new time to move it.");
}

function withoutEnds(recurrence: NonNullable<Reminder["recurrence"]>): NonNullable<Reminder["recurrence"]> {
  const next = { ...recurrence };
  delete next.ends;
  return next;
}

function applyScheduleEdit(reminder: Reminder, zone: string, now: Date, repeat: string | undefined, end: string | undefined, moved: ResolvedWhen | null): { recurrence: Reminder["recurrence"]; fireAt: string; notes: string[]; corrected: boolean } {
  let recurrence = reminder.recurrence;
  let fireAt = reminder.fireAt;
  const notes: string[] = [];
  let corrected = false;
  if (moved) {
    fireAt = moved.fireAt.toISOString();
    if (moved.recurrence) recurrence = moved.recurrence;
    if (moved.note) notes.push(moved.note);
    corrected = moved.corrected;
  }
  if (repeat?.trim()) {
    const word = repeat.trim().toLowerCase();
    if (word === "once" || word === "none" || word === "off") {
      recurrence = null;
      notes.push("Repeat removed. This reminder happens once.");
    } else if (word === "daily" || word === "weekdays" || word === "weekly") {
      const parts = zonedParts(new Date(fireAt), zone);
      const ends = recurrence?.ends;
      recurrence = word === "daily"
        ? { kind: "daily", hour: parts.hour, minute: parts.minute, ...(ends ? { ends } : {}) }
        : word === "weekdays"
          ? { kind: "weekdays", hour: parts.hour, minute: parts.minute, ...(ends ? { ends } : {}) }
          : { kind: "weekly", weekday: parts.weekday, hour: parts.hour, minute: parts.minute, ...(ends ? { ends } : {}) };
      notes.push(`Repeat is now ${describeRecurrence(recurrence, zone)}.`);
    } else {
      const parsed = resolveWhen(repeat, zone, now);
      if (!parsed.recurrence) throw new Error("Fillip could not read that repeat. Try daily, weekdays, every 2 weeks, first Monday of every month, or once to remove it.");
      recurrence = parsed.recurrence;
      if (!recurrence.ends && reminder.recurrence?.ends && !end?.trim()) {
        recurrence = { ...recurrence, ends: reminder.recurrence.ends };
      }
      if (!moved) fireAt = parsed.fireAt.toISOString();
      if (parsed.note) notes.push(parsed.note);
      corrected = corrected || parsed.corrected;
      notes.push(`Repeat is now ${describeRecurrence(recurrence, zone)}.`);
    }
  }
  if (end?.trim()) {
    const word = end.trim().toLowerCase();
    if (word === "none" || word === "never" || word === "off") {
      if (recurrence) recurrence = withoutEnds(recurrence);
      notes.push("End date removed.");
    } else {
      if (!recurrence) throw new Error("An end date needs a repeating reminder. Set a repeat, such as daily or every 2 weeks.");
      const attached = attachEndDate({ fireAt: new Date(fireAt), recurrence, corrected: false, note: null }, end, zone, now);
      recurrence = attached.recurrence;
      notes.push(`It now repeats ${describeRecurrence(recurrence, zone)}.`);
    }
  }
  return { recurrence, fireAt, notes, corrected };
}

export async function snoozeOrReschedule(store: ReminderStore, ownerId: string, id: string, until: string | undefined, timezone: string | undefined, now: Date, action: ReminderMove = "reschedule", schedule?: { repeat?: string; end?: string }, acceptShiftedTime = false): Promise<ReminderView> {
  const reminder = await store.getReminder(ownerId, id);
  if (!reminder) throw new Error("Reminder not found");
  if (reminder.status === "cancelled" || reminder.status === "completed") {
    throw new Error(`That reminder is already ${reminder.status}.`);
  }
  const zone = timezone || reminder.timezone;
  const repeat = schedule?.repeat?.trim();
  const end = schedule?.end?.trim();
  const moving = action === "reschedule" && Boolean(until?.trim());
  if (action === "reschedule" && !moving && !repeat && !end) throw new Error("Name a time to move this reminder, or a repeat or end date to change.");
  if (moving || repeat || end) await store.setMailOptIn(ownerId, true);
  const moved = moving ? resolveWhen(until ?? "", zone, now) : null;
  const edited = moving || repeat || end
    ? applyScheduleEdit(reminder, zone, now, repeat, end, moved)
    : { recurrence: reminder.recurrence, fireAt: reminder.fireAt, notes: [] as string[], corrected: false };
  let draft: Reminder = {
    ...reminder,
    timezone: zone,
    fireAt: edited.fireAt,
    recurrence: edited.recurrence,
    updatedAt: now.toISOString()
  };
  const notes = [...edited.notes];
  if (!acceptShiftedTime && notes.some((note) => /does not exist/i.test(note))) {
    const shifted = moved?.fireAt ?? new Date(edited.fireAt);
    refuseSilentShift({ note: notes.find((note) => /does not exist/i.test(note)) ?? "", fireAt: shifted }, false, zone);
  }
  if (action === "pause") {
    draft = { ...draft, status: "paused", holdUntil: null };
    notes.push("Paused. Fillip will not send this until you resume it.");
  } else if (action === "resume") {
    const fireAt = nextOpenFire(draft, zone, now);
    draft = { ...draft, fireAt: fireAt.toISOString(), status: "active", holdUntil: null };
    notes.push(`Resumed. Next ping is ${formatWhen(fireAt, zone)}.`);
  } else if (reminder.status === "paused") {
    draft = { ...draft, status: "paused" };
  } else {
    draft = { ...draft, status: "active", holdUntil: null };
    if (moving && moved) notes.push(`Moved to ${formatWhen(moved.fireAt, zone)}.`);
  }
  const saved = await store.saveReminder(draft);
  return view(saved, now, { corrected: edited.corrected, note: notes.filter(Boolean).join(" ") || null });
}

export type DeleteResult = { id: string; what: string; status: "deleted"; note: string };

export async function completeOrCancel(store: ReminderStore, ownerId: string, id: string, action: "complete" | "cancel" | "delete", now: Date): Promise<ReminderView | DeleteResult> {
  const reminder = await store.getReminder(ownerId, id);
  if (!reminder) throw new Error("Reminder not found");
  if (action === "delete") {
    await store.deleteReminder(ownerId, id);
    return { id: reminder.id, what: reminder.what, status: "deleted", note: "Deleted. The reminder and its delivery history are gone." };
  }
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
  until?: string;
  timezone: string;
  context?: string | null;
  channel?: DeliveryChannel;
  acceptShiftedTime?: boolean;
}, now: Date, caps: TierCaps = STAND_IN_CAPS, telegramEnabled = false): Promise<ReminderView> {
  await gate(store, actor, now, caps);
  await assertWithinAllowance(store, actor.id, now, caps);
  if (!input.after && !input.cadence) throw new Error("Follow-ups need a first time or a cadence, such as next Tuesday at 2pm.");
  const usage = await store.getUsage(actor.id);
  const channel = chosenChannel(input.channel, usage?.defaultChannel, telegramEnabled);
  let first: ResolvedWhen;
  if (input.after) {
    first = resolveWhen(input.after, input.timezone, now);
    if (input.cadence) first = { ...first, recurrence: recurrenceFromCadence(input.cadence, input.timezone, now) };
  } else {
    const recurrence = recurrenceFromCadence(input.cadence ?? "", input.timezone, now);
    const fireAt = nextFire(recurrence, input.timezone, now);
    if (!fireAt) throw new Error("That repeating reminder has already ended.");
    first = { fireAt, recurrence, corrected: false, note: null };
  }
  if (!first.recurrence) {
    const parts = zonedParts(first.fireAt, input.timezone);
    first = {
      ...first,
      recurrence: { kind: "weekly", weekday: parts.weekday, hour: parts.hour, minute: parts.minute }
    };
  }
  if (input.until?.trim()) first = attachEndDate(first, input.until, input.timezone, now);
  refuseSilentShift(first, input.acceptShiftedTime, input.timezone);
  const draft = stamp(actor, input.topic, input.context ?? null, input.timezone, first, "follow_up", channel, now);
  const note = [first.note, followNote(channel, draft.recurrence, input.timezone)].filter(Boolean).join(" ");
  return createOrRefuse(store, draft, openCapFor(usage, caps), now, { corrected: first.corrected, note });
}

function openCapFor(usage: { plan?: string | null; subscriptionStatus?: string | null } | null, caps: TierCaps): OpenCap {
  const tier = tierFor(usage?.plan, usage?.subscriptionStatus);
  const cap = tier === "free" ? freeOpenReminders(caps) : MAX_ACTIVE_REMINDERS;
  return {
    cap,
    message: tier === "free" ? freeOpenMessage(cap) : "Too many reminders are still open. Complete or cancel one first."
  };
}

async function createOrRefuse(
  store: ReminderStore,
  reminder: Reminder,
  open: OpenCap,
  now: Date,
  extra: { corrected?: boolean; note?: string | null }
): Promise<ReminderView> {
  try {
    const saved = await store.createReminder(reminder, open);
    return view(saved, now, extra);
  } catch (error) {
    if (error instanceof OpenCapError && (await store.countActive(reminder.ownerId)) >= open.cap) {
      return view(reminder, now, { corrected: extra.corrected ?? false, note: error.message });
    }
    throw error;
  }
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

const LINK_MS = 30 * 60 * 1000;

export async function calendarLink(store: ReminderStore, actor: Actor, action: "get" | "rotate", appBaseUrl: string): Promise<{ url: string; rotated: boolean; note: string }> {
  if (!actor.id) throw new Error("A verified account email is required before Fillip can ping you.");
  await store.rememberOwner({ id: actor.id, email: actor.email, emailVerified: actor.emailVerified, unsubscribed: false });
  const existing = await store.getUsage(actor.id);
  let token = existing?.calendarToken ?? null;
  let rotated = false;
  if (action === "rotate" || !token) {
    token = newSecretToken();
    await store.setCalendarToken(actor.id, token);
    rotated = action === "rotate";
  }
  const url = `${appBaseUrl.replace(/\/$/, "")}/calendar/${token}.ics`;
  return {
    url,
    rotated,
    note: rotated
      ? "The previous calendar link no longer works. Subscribe to this one in Google, Apple, or Outlook."
      : "Subscribe to this private link in Google, Apple, or Outlook. It lists your active Fillip reminders. Rotate it if the link leaks."
  };
}

export async function renderCalendarFeed(store: ServiceStore, token: string, now: Date): Promise<string | null> {
  const ownerId = await store.ownerIdForCalendarToken(token);
  if (!ownerId) return null;
  const reminders = await store.listReminders(ownerId, { status: "active" });
  return calendarFeed(reminders, now);
}

export async function deliverySettings(store: ReminderStore, actor: Actor, input: {
  action: "status" | "link_telegram" | "unlink_telegram" | "set_default";
  channel?: DeliveryChannel;
}, now: Date, env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<Record<string, unknown>> {
  if (!actor.id || !actor.email || !actor.emailVerified) throw new Error("A verified account email is required before Fillip can ping you.");
  await store.rememberOwner({ id: actor.id, email: actor.email, emailVerified: true, unsubscribed: false });
  if (input.action === "unlink_telegram") {
    await store.unlinkTelegram(actor.id);
    return { linked: false, defaultChannel: "email", note: "Telegram is unlinked. Fillip will not ping that chat." };
  }
  if (input.action === "set_default") {
    if (!input.channel) throw new Error("Choose email, Telegram, or both.");
    if (input.channel !== "email" && !env.TELEGRAM_BOT_TOKEN?.trim()) throw new Error("Telegram is not offered on this Fillip.");
    const usage = await store.getUsage(actor.id);
    if (input.channel !== "email" && !usage?.telegramChatId) throw new Error("Telegram is not linked. Ask Fillip for a link first.");
    await store.setDefaultChannel(actor.id, input.channel);
    return { defaultChannel: input.channel, note: `Fillip will use ${input.channel} unless a reminder says otherwise.` };
  }
  if (input.action === "link_telegram") {
    if (!env.TELEGRAM_BOT_TOKEN?.trim()) throw new Error("Telegram is not offered on this Fillip.");
    const token = newSecretToken();
    const expires = new Date(now.getTime() + LINK_MS).toISOString();
    await store.beginTelegramLink(actor.id, token, expires);
    const username = await telegramUsername(env, fetchImpl);
    return {
      url: telegramDeepLink(username, token),
      expires,
      note: "Open this link, then press Start in Telegram. It expires in 30 minutes. Fillip pings only this chat after you do."
    };
  }
  const usage = await store.getUsage(actor.id);
  return {
    defaultChannel: usage?.defaultChannel ?? "email",
    telegramLinked: Boolean(usage?.telegramChatId),
    note: usage?.telegramChatId ? "Telegram is linked." : "Telegram is not linked."
  };
}
