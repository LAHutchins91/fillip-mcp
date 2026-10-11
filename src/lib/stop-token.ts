import crypto from "node:crypto";

const TTL_MS = 400 * 24 * 60 * 60 * 1000;

export function signStopToken(userId: string, secret: string, nowMs = Date.now()): string {
  const exp = Math.floor((nowMs + TTL_MS) / 1000);
  const payload = Buffer.from(`${userId}.${exp}`).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyStopToken(token: string, secret: string, nowMs = Date.now()): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = decoded.slice(0, dot);
  const exp = Number(decoded.slice(dot + 1));
  if (!userId || !Number.isFinite(exp) || exp * 1000 <= nowMs) return null;
  return userId;
}
