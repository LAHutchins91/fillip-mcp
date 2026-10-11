import crypto from "node:crypto";
import type { ServiceStore } from "./store.js";

export type TelegramSender = {
  send(chatId: string, text: string): Promise<{ id: string }>;
};

export function telegramConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
}

export function newSecretToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

let cachedUsername: string | null = null;

export async function telegramUsername(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const configured = env.TELEGRAM_BOT_USERNAME?.trim().replace(/^@/, "");
  if (configured) return configured;
  if (cachedUsername) return cachedUsername;
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) throw new Error("Telegram is not offered on this Fillip.");
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getMe`, { signal: AbortSignal.timeout(20000) });
  const body = await response.json() as { ok?: boolean; result?: { username?: string } };
  const username = body.result?.username;
  if (!response.ok || !body.ok || !username) throw new Error("Telegram is not offered on this Fillip.");
  cachedUsername = username;
  return username;
}

export function telegramDeepLink(username: string, token: string): string {
  return `https://t.me/${username}?start=${encodeURIComponent(token)}`;
}

export function createTelegramSender(token: string, fetchImpl: typeof fetch = fetch): TelegramSender {
  return {
    async send(chatId: string, text: string) {
      const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(20000)
      });
      const body = await response.json() as { ok?: boolean; description?: string; result?: { message_id?: number } };
      if (response.status === 429 || /too many requests/i.test(body.description ?? "")) {
        const error = new Error("Telegram asked Fillip to back off");
        error.name = "TelegramBackoffError";
        throw error;
      }
      if (!response.ok || !body.ok || body.result?.message_id === undefined) throw new Error("Telegram did not accept the reminder");
      return { id: String(body.result.message_id) };
    }
  };
}

export function isTelegramBackoff(error: unknown): boolean {
  return error instanceof Error && error.name === "TelegramBackoffError";
}

type TelegramUpdate = {
  message?: { text?: string; chat?: { id?: number } };
};

export async function acceptTelegramUpdate(store: ServiceStore, update: TelegramUpdate, now: Date): Promise<{ replyChatId: string | null; replyText: string }> {
  const text = update.message?.text?.trim() ?? "";
  const chatId = update.message?.chat?.id;
  if (!chatId) return { replyChatId: null, replyText: "" };
  const chat = String(chatId);
  const start = text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?$/i);
  if (!start) return { replyChatId: chat, replyText: "Open Fillip and ask for a Telegram link. Then tap that link." };
  const token = start[1];
  if (!token) return { replyChatId: chat, replyText: "That start link has no Fillip token. Ask Fillip for a new Telegram link." };
  const ownerId = await store.claimTelegramLink(token, chat, now.toISOString());
  if (!ownerId) return { replyChatId: chat, replyText: "That Fillip link has expired. Ask Fillip for a new one." };
  return { replyChatId: chat, replyText: "Fillip will ping this chat. Ask Fillip to unlink Telegram when you want that to stop." };
}
