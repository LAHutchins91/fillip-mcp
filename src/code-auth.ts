import { createHmac } from "node:crypto";
import type { Express, Request, Response } from "express";
import { z } from "zod";

export const CODE_SENT = "If that email can sign in, a code is on its way.";
export const CODE_LOCKED = "Too many wrong codes. Request a new one.";
export const CODE_WRONG = "That code is wrong or expired.";
export const SIGNED_OUT_EVERYWHERE = "Signed out of every app and device.";

const SEND_WAIT = "Too many code emails were requested. Wait a minute, then send a new code.";
const SIGN_IN_FAILED = "Fillip could not finish sign-in. Send a new code and try again.";
const AUTH_REQUIRED = "Authentication required.";
const PAD_MS = 500;
const EMAIL_WRONG_LIMIT = 5;
const IP_SEND_LIMIT = 5;
const IP_VERIFY_LIMIT = 10;
const EMAIL_WINDOW_MS = 15 * 60 * 1000;
const IP_WINDOW_MS = 5 * 60 * 1000;

const emailBody = z.object({ email: z.string().trim().email().max(254) });
const verifyBody = emailBody.extend({ code: z.string().trim().regex(/^\d{6,10}$/) });

type AttemptKind = "email" | "ip";
type CounterField = "wrong" | "send" | "verify";

type AttemptRow = {
  subject_kind: AttemptKind;
  subject_hash: string;
  wrong_count: number;
  send_count: number;
  verify_count: number;
  window_started_at: string;
};

const memoryRows = new Map<string, AttemptRow>();
let memoryChain: Promise<unknown> = Promise.resolve();

function pepper(): string {
  const dedicated = (process.env.FILLIP_LOCKOUT_SECRET || "").trim();
  if (dedicated) return dedicated;
  return process.env.FILLIP_UNSUBSCRIBE_SECRET || process.env.CRON_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "fillip-pkce";
}

export function codeSubjectHash(kind: AttemptKind, value: string): string {
  return createHmac("sha256", pepper()).update(`${kind}:${value}`).digest("hex");
}

function supabaseBase(): string {
  return (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
}

function serviceKey(): string {
  return (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
}

function anonKey(): string {
  return (process.env.SUPABASE_ANON_KEY || "").trim();
}

function blankRow(kind: AttemptKind, hash: string, now: number): AttemptRow {
  return {
    subject_kind: kind,
    subject_hash: hash,
    wrong_count: 0,
    send_count: 0,
    verify_count: 0,
    window_started_at: new Date(now).toISOString()
  };
}

function memoryExclusive<T>(work: () => T): Promise<T> {
  const run = memoryChain.then(work, work);
  memoryChain = run.then(() => undefined, () => undefined);
  return run;
}

function memoryBump(kind: AttemptKind, hash: string, field: CounterField): Promise<number> {
  return memoryExclusive(() => {
    const now = Date.now();
    const key = `${kind}:${hash}`;
    const span = kind === "email" ? EMAIL_WINDOW_MS : IP_WINDOW_MS;
    let row = memoryRows.get(key);
    if (!row) row = blankRow(kind, hash, now);
    else {
      const started = Date.parse(row.window_started_at);
      if (!Number.isFinite(started) || now - started >= span) {
        row = { ...blankRow(kind, hash, now) };
      } else {
        row = { ...row };
      }
    }
    if (field === "wrong") row.wrong_count += 1;
    else if (field === "send") row.send_count += 1;
    else row.verify_count += 1;
    memoryRows.set(key, row);
    if (field === "wrong") return row.wrong_count;
    if (field === "send") return row.send_count;
    return row.verify_count;
  });
}

async function serviceRest<T>(pathname: string, options: RequestInit = {}): Promise<T> {
  const base = supabaseBase();
  const key = serviceKey();
  if (!base || !key) throw new Error("Sign-in store is not configured.");
  const headers = new Headers(options.headers);
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${key}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${pathname}`, { ...options, headers, signal: AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}`);
  if (!text) return null as T;
  return JSON.parse(text) as T;
}

function asCount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  throw new Error("counter");
}

async function bumpCounter(kind: AttemptKind, hash: string, field: CounterField): Promise<number> {
  if (supabaseBase() && serviceKey()) {
    const value = await serviceRest<unknown>("/rest/v1/rpc/fillip_bump_code_counter", {
      method: "POST",
      body: JSON.stringify({ p_kind: kind, p_hash: hash, p_field: field })
    });
    return asCount(value);
  }
  return memoryBump(kind, hash, field);
}

async function clearEmailWrong(hash: string): Promise<void> {
  if (supabaseBase() && serviceKey()) {
    await serviceRest("/rest/v1/rpc/fillip_clear_email_wrong", {
      method: "POST",
      body: JSON.stringify({ p_hash: hash })
    });
    return;
  }
  await memoryExclusive(() => {
    const row = memoryRows.get(`email:${hash}`);
    if (row) memoryRows.set(`email:${hash}`, { ...row, wrong_count: 0 });
  });
}

async function resetIpVerify(hash: string): Promise<void> {
  if (supabaseBase() && serviceKey()) {
    await serviceRest("/rest/v1/rpc/fillip_reset_ip_verify", {
      method: "POST",
      body: JSON.stringify({ p_hash: hash })
    });
    return;
  }
  await memoryExclusive(() => {
    const row = memoryRows.get(`ip:${hash}`);
    if (row) memoryRows.set(`ip:${hash}`, { ...row, verify_count: 0 });
  });
}

function firstHop(value: string | undefined): string {
  if (!value) return "";
  return value.split(",")[0]?.trim() ?? "";
}

function ipv6Slash64(address: string): string {
  const bare = (address.toLowerCase().split("%")[0] ?? "").trim();
  const halves = bare.split("::");
  if (halves.length > 2) return bare;
  const expand = (side: string) => (side ? side.split(":").filter((part) => part.length > 0) : []);
  const left = expand(halves[0] ?? "");
  const right = halves.length === 2 ? expand(halves[1] ?? "") : [];
  if (halves.length === 1) {
    if (left.length !== 8) return bare;
    return left.slice(0, 4).map((part) => part.padStart(4, "0")).join(":");
  }
  const missing = 8 - left.length - right.length;
  if (missing < 0) return bare;
  const hextets = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (hextets.length < 4) return bare;
  return hextets.slice(0, 4).map((part) => part.padStart(4, "0")).join(":");
}

/** Vercel sets x-vercel-forwarded-for. A client-supplied X-Forwarded-For chain is not the key. */
export function lockoutAddressKey(header: (name: string) => string | undefined, remoteAddress?: string | null): string {
  const vercel = firstHop(header("x-vercel-forwarded-for"));
  const real = firstHop(header("x-real-ip"));
  let value = vercel || real || (remoteAddress ?? "").trim() || "unknown";
  if (value.toLowerCase().startsWith("::ffff:")) value = value.slice(7);
  const v4port = value.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4port?.[1]) return v4port[1];
  if (value.includes(":")) return ipv6Slash64(value);
  return value;
}

function requestIp(req: Request): string {
  return lockoutAddressKey((name) => req.get(name), req.socket.remoteAddress);
}

function wantsJson(req: Request): boolean {
  return (req.get("content-type") || "").toLowerCase().includes("application/json") && req.get("x-fillip-request") === "1";
}

async function pad(started: number): Promise<void> {
  const wait = PAD_MS - (Date.now() - started);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

type GotrueResult = { status: number; json: Record<string, unknown> | null };

async function gotrue(pathname: string, body: unknown, apikey: string, jwt?: string): Promise<GotrueResult> {
  const base = supabaseBase();
  if (!base || !apikey) return { status: 0, json: null };
  const response = await fetch(`${base}${pathname}`, {
    method: "POST",
    headers: {
      apikey,
      Authorization: `Bearer ${jwt || apikey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!text) return { status: response.status, json: null };
  try {
    const parsed = JSON.parse(text) as unknown;
    return { status: response.status, json: parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null };
  } catch {
    return { status: response.status, json: null };
  }
}

async function userGotrue(method: string, pathname: string, jwt: string): Promise<{ status: number; json: unknown }> {
  const base = supabaseBase();
  const apikey = serviceKey() || anonKey();
  if (!base || !apikey) return { status: 0, json: null };
  const response = await fetch(`${base}${pathname}`, {
    method,
    headers: {
      apikey,
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json"
    },
    signal: AbortSignal.timeout(20000)
  });
  const text = await response.text();
  if (!text) return { status: response.status, json: null };
  try {
    return { status: response.status, json: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, json: null };
  }
}

function gotrueMessage(json: Record<string, unknown> | null): string {
  if (!json) return "";
  const value = json.msg ?? json.message ?? json.error_description ?? json.error_code ?? "";
  return typeof value === "string" ? value : "";
}

function isSendRateLimit(status: number, message: string): boolean {
  if (status === 429) return true;
  const text = message.toLowerCase();
  return text.includes("rate") || text.includes("too many") || text.includes("only request this after") || text.includes("over_request") || text.includes("security purposes");
}

async function sendCode(req: Request, res: Response): Promise<void> {
  if (!wantsJson(req)) {
    res.status(400).json({ ok: false, message: SIGN_IN_FAILED });
    return;
  }
  const parsed = emailBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, message: "Enter an email address." });
    return;
  }
  const started = Date.now();
  const email = parsed.data.email.toLowerCase();
  const ipHash = codeSubjectHash("ip", requestIp(req));
  let sendCount = 0;
  let counted = false;
  try {
    sendCount = await bumpCounter("ip", ipHash, "send");
    counted = true;
  } catch {
    counted = false;
  }
  if (counted && sendCount > IP_SEND_LIMIT) {
    await pad(started);
    res.set("Cache-Control", "no-store").status(429).json({ ok: false, message: SEND_WAIT });
    return;
  }

  const sent = await gotrue("/auth/v1/otp", { email, create_user: true }, anonKey());
  const message = gotrueMessage(sent.json);
  if (isSendRateLimit(sent.status, message)) {
    await pad(started);
    res.set("Cache-Control", "no-store").status(429).json({ ok: false, message: SEND_WAIT });
    return;
  }
  if (counted && sendCount <= IP_SEND_LIMIT) {
    try {
      await resetIpVerify(ipHash);
    } catch {
      // A failed verify-window reset still answers like every other send.
    }
  }
  await pad(started);
  res.set("Cache-Control", "no-store").status(200).json({ ok: true, message: CODE_SENT });
}

async function verifyCode(req: Request, res: Response): Promise<void> {
  if (!wantsJson(req)) {
    res.status(400).json({ ok: false, message: SIGN_IN_FAILED });
    return;
  }
  const emailParsed = emailBody.safeParse(req.body);
  if (!emailParsed.success) {
    res.status(400).json({ ok: false, message: "Enter an email address." });
    return;
  }
  const email = emailParsed.data.email.toLowerCase();
  const ipHash = codeSubjectHash("ip", requestIp(req));
  const emailHash = codeSubjectHash("email", email);
  let ipCount = 0;
  try {
    ipCount = await bumpCounter("ip", ipHash, "verify");
  } catch {
    res.status(503).json({ ok: false, message: SIGN_IN_FAILED });
    return;
  }
  if (ipCount > IP_VERIFY_LIMIT) {
    res.set("Cache-Control", "no-store").status(429).json({ ok: false, message: CODE_LOCKED });
    return;
  }
  let wrongCount = 0;
  try {
    wrongCount = await bumpCounter("email", emailHash, "wrong");
  } catch {
    res.status(503).json({ ok: false, message: SIGN_IN_FAILED });
    return;
  }
  if (wrongCount > EMAIL_WRONG_LIMIT) {
    res.set("Cache-Control", "no-store").status(429).json({ ok: false, message: CODE_LOCKED });
    return;
  }
  const parsed = verifyBody.safeParse(req.body);
  if (!parsed.success) {
    const locked = wrongCount >= EMAIL_WRONG_LIMIT;
    res.set("Cache-Control", "no-store").status(locked ? 429 : 400).json({
      ok: false,
      message: locked ? CODE_LOCKED : CODE_WRONG
    });
    return;
  }

  const checked = await gotrue("/auth/v1/verify", { email, token: parsed.data.code, type: "email" }, anonKey());
  if (checked.status >= 200 && checked.status < 300) {
    const access = typeof checked.json?.access_token === "string" ? checked.json.access_token : "";
    const refresh = typeof checked.json?.refresh_token === "string" ? checked.json.refresh_token : "";
    if (!access || !refresh) {
      res.status(502).json({ ok: false, message: SIGN_IN_FAILED });
      return;
    }
    try {
      await clearEmailWrong(emailHash);
    } catch {
      // The code is already consumed. Still hand the session to this browser.
    }
    res.set("Cache-Control", "no-store").status(200).json({ ok: true, access_token: access, refresh_token: refresh });
    return;
  }
  const locked = wrongCount >= EMAIL_WRONG_LIMIT;
  res.set("Cache-Control", "no-store").status(locked ? 429 : 400).json({
    ok: false,
    message: locked ? CODE_LOCKED : CODE_WRONG
  });
}

function bearer(req: Request): string {
  const header = req.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function grantClientId(grant: unknown): string {
  if (!grant || typeof grant !== "object") return "";
  const row = grant as { client?: { id?: unknown }; client_id?: unknown };
  if (typeof row.client?.id === "string" && row.client.id) return row.client.id;
  if (typeof row.client_id === "string") return row.client_id;
  return "";
}

async function revokeGrants(jwt: string): Promise<void> {
  const listed = await userGotrue("GET", "/auth/v1/user/oauth/grants", jwt);
  if (listed.status === 404) return;
  if (listed.status < 200 || listed.status >= 300) throw new Error("grants");
  const body = listed.json;
  const rows = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { grants?: unknown }).grants)
      ? (body as { grants: unknown[] }).grants
      : [];
  for (const grant of rows) {
    const id = grantClientId(grant);
    if (!id) continue;
    const deleted = await userGotrue("DELETE", `/auth/v1/user/oauth/grants?client_id=${encodeURIComponent(id)}`, jwt);
    if (deleted.status === 404) continue;
    if (deleted.status < 200 || deleted.status >= 300) throw new Error("revoke");
  }
}

async function signOutEverywhere(req: Request, res: Response): Promise<void> {
  if (req.method !== "POST" || !wantsJson(req)) {
    res.status(403).json({ ok: false, message: AUTH_REQUIRED });
    return;
  }
  const token = bearer(req);
  if (!token) {
    res.status(401).json({ ok: false, message: AUTH_REQUIRED });
    return;
  }
  const user = await userGotrue("GET", "/auth/v1/user", token);
  const userId = user.json && typeof user.json === "object" ? (user.json as { id?: unknown }).id : "";
  if (user.status < 200 || user.status >= 300 || typeof userId !== "string" || !userId) {
    res.status(401).json({ ok: false, message: AUTH_REQUIRED });
    return;
  }
  await revokeGrants(token);
  const loggedOut = await gotrue("/auth/v1/logout?scope=global", {}, serviceKey() || anonKey(), token);
  if (loggedOut.status < 200 || loggedOut.status >= 300) {
    res.status(502).json({ ok: false, message: "Fillip could not sign out every session. Try again." });
    return;
  }
  res.set("Cache-Control", "no-store").json({ ok: true, message: SIGNED_OUT_EVERYWHERE });
}

export function installCodeAuth(app: Express): void {
  app.post("/auth/code/send", async (req, res) => {
    try {
      await sendCode(req, res);
    } catch {
      if (!res.headersSent) res.status(500).json({ ok: false, message: SIGN_IN_FAILED });
    }
  });
  app.post("/auth/code/verify", async (req, res) => {
    try {
      await verifyCode(req, res);
    } catch {
      if (!res.headersSent) res.status(500).json({ ok: false, message: SIGN_IN_FAILED });
    }
  });
  app.post("/auth/sign-out-everywhere", async (req, res) => {
    try {
      await signOutEverywhere(req, res);
    } catch {
      if (!res.headersSent) res.status(502).json({ ok: false, message: "Fillip could not sign out every session. Try again." });
    }
  });
}
