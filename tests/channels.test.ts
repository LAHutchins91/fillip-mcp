import { describe, expect, it } from "vitest";
import { calendarFeed } from "../src/lib/ics.js";
import { MemoryFillipStore } from "../src/lib/memory-store.js";
import { calendarLink, deliverySettings, renderCalendarFeed, setReminder } from "../src/lib/reminders.js";
import { acceptTelegramUpdate, telegramDeepLink } from "../src/lib/telegram.js";
import type { Actor } from "../src/lib/types.js";

const now = new Date("2026-10-11T18:00:00.000Z");
const actor: Actor = { id: "44444444-4444-4444-8444-444444444444", email: "owner@example.com", emailVerified: true };

describe("private calendar feed", () => {
  it("returns a stable link, rotates it, and lists only active reminders", async () => {
    const store = new MemoryFillipStore();
    const active = await setReminder(store, actor, { what: "Still open", when: "tomorrow 9am", timezone: "America/New_York" }, now);
    const done = await setReminder(store, actor, { what: "Already done", when: "tomorrow 10am", timezone: "America/New_York" }, now);
    const finished = await store.getReminder(actor.id, done.id);
    if (!finished) throw new Error("missing reminder");
    await store.saveReminder({ ...finished, status: "completed" });

    const first = await calendarLink(store, actor, "get", "https://fillip.example");
    const again = await calendarLink(store, actor, "get", "https://fillip.example");
    expect(again.url).toBe(first.url);
    expect(first.url).toMatch(/^https:\/\/fillip\.example\/calendar\/.+\.ics$/);
    const token = first.url.split("/calendar/")[1]?.replace(/\.ics$/, "") ?? "";
    const body = await renderCalendarFeed(store, token, now);
    expect(body).toMatch(/Still open/);
    expect(body).not.toMatch(/Already done/);
    expect(body).toMatch(/TZID=America\/New_York/);
    expect(body).toMatch(/DTEND;TZID=America\/New_York:/);
    expect(body).toMatch(/BEGIN:VALARM/);
    expect(body).toMatch(/TRIGGER:PT0S/);

    const rotated = await calendarLink(store, actor, "rotate", "https://fillip.example/");
    expect(rotated.rotated).toBe(true);
    expect(rotated.url).not.toBe(first.url);
    expect(await renderCalendarFeed(store, token, now)).toBeNull();
    const nextToken = rotated.url.split("/calendar/")[1]?.replace(/\.ics$/, "") ?? "";
    const nextBody = await renderCalendarFeed(store, nextToken, now);
    expect(nextBody).toMatch(/Still open/);
    expect(calendarFeed([], now)).toMatch(/BEGIN:VCALENDAR/);
    expect(active.id).toBeTruthy();
  });
});

describe("Telegram linking", () => {
  it("hides linking when the bot token is unset and claims a start token when it is set", async () => {
    const store = new MemoryFillipStore();
    await expect(deliverySettings(store, actor, { action: "link_telegram" }, now, {})).rejects.toThrow(/Telegram is not offered/);
    await expect(setReminder(store, actor, {
      what: "Chat only",
      when: "tomorrow 9am",
      timezone: "UTC",
      channel: "telegram"
    }, now, undefined, false)).rejects.toThrow(/Telegram is not offered/);

    const linked = await deliverySettings(store, actor, { action: "link_telegram" }, now, {
      TELEGRAM_BOT_TOKEN: "123456:test",
      TELEGRAM_BOT_USERNAME: "FillipBot"
    });
    expect(linked.url).toBe(telegramDeepLink("FillipBot", String(linked.url).split("start=")[1] ?? ""));
    const token = decodeURIComponent(String(linked.url).split("start=")[1] ?? "");
    const expired = await acceptTelegramUpdate(store, { message: { text: `/start ${token}`, chat: { id: 99 } } }, new Date(now.getTime() + 31 * 60 * 1000));
    expect(expired.replyText).toMatch(/expired/);
    expect(store.contacts.get(actor.id)?.telegramChatId).toBeNull();

    await deliverySettings(store, actor, { action: "link_telegram" }, now, {
      TELEGRAM_BOT_TOKEN: "123456:test",
      TELEGRAM_BOT_USERNAME: "FillipBot"
    });
    const fresh = store.contacts.get(actor.id)?.telegramLinkToken;
    const claimed = await acceptTelegramUpdate(store, { message: { text: `/start ${fresh}`, chat: { id: 77 } } }, now);
    expect(claimed.replyText).toMatch(/this chat/);
    expect(store.contacts.get(actor.id)?.telegramChatId).toBe("77");

    await deliverySettings(store, actor, { action: "set_default", channel: "both" }, now, { TELEGRAM_BOT_TOKEN: "123456:test" });
    expect(store.contacts.get(actor.id)?.defaultChannel).toBe("both");
    const unlinked = await deliverySettings(store, actor, { action: "unlink_telegram" }, now, { TELEGRAM_BOT_TOKEN: "123456:test" });
    expect(unlinked).toMatchObject({ linked: false, defaultChannel: "email" });
    expect(store.contacts.get(actor.id)?.telegramChatId).toBeNull();
    await expect(deliverySettings(store, actor, { action: "set_default", channel: "telegram" }, now, { TELEGRAM_BOT_TOKEN: "123456:test" }))
      .rejects.toThrow(/Telegram is not linked/);
  });
});
