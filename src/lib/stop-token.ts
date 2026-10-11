import crypto from "node:crypto";

/**
 * Secrets this process has signed with stay valid, so a stop link survives rotation
 * without a second argument on verify. Operators can also list retired secrets in
 * FILLIP_UNSUBSCRIBE_SECRET_PREVIOUS (comma-separated) for the next process.
 * Links are not expired: an account-wide stop link has to outlast its own timestamp.
 */
const signedSecrets = new Set<string>();

function extraSecrets(): string[] {
  const raw = [
    process.env.FILLIP_UNSUBSCRIBE_SECRET ?? "",
    process.env.FILLIP_UNSUBSCRIBE_SECRET_PREVIOUS ?? ""
  ].join(",");
  return raw.split(",").map((part) => part.trim()).filter((part) => part.length > 0);
}

function secretsFor(secret: string): string[] {
  return [...new Set([secret, ...extraSecrets(), ...signedSecrets])];
}

export function signStopToken(userId: string, secret: string, nowMs = Date.now()): string {
  signedSecrets.add(secret);
  const exp = Math.floor((nowMs + 400 * 24 * 60 * 60 * 1000) / 1000);
  const payload = Buffer.from(`${userId}.${exp}`).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyStopToken(token: string, secret: string, nowMs = Date.now()): string | null {
  void nowMs;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  if (!payload || !sig) return null;
  const left = Buffer.from(sig);
  const matched = secretsFor(secret).some((candidate) => {
    const expected = crypto.createHmac("sha256", candidate).update(payload).digest("base64url");
    const right = Buffer.from(expected);
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  });
  if (!matched) return null;
  const decoded = Buffer.from(payload, "base64url").toString("utf8");
  const dot = decoded.lastIndexOf(".");
  if (dot <= 0) return null;
  const userId = decoded.slice(0, dot);
  const exp = Number(decoded.slice(dot + 1));
  if (!userId || !Number.isFinite(exp)) return null;
  return userId;
}
