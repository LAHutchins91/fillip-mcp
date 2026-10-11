import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { appendFile, mkdir } from "node:fs/promises";
import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createFillipServer } from "./fillip-tools.js";
import { landingConnectLead } from "./connect-page.js";
import { renderLanding } from "./landing-page.js";
import { billingConfigFromEnv, checkoutParams, decideBillingAction, verifyStripeSignature, type JsonObject } from "./lib/billing.js";
import { nextMonthStart, tierCapsFromEnv, usageCapsConfigured } from "./lib/usage.js";
import { globalEmailLimitsFromEnv, nextUtcDay, readGlobalEmailSnapshot, runDueJob, type GlobalEmailSnapshot } from "./lib/deliver.js";
import { createResendSender } from "./lib/email.js";
import { publicError } from "./lib/errors.js";
import { renderCalendarFeed } from "./lib/reminders.js";
import { acceptTelegramUpdate, createTelegramSender, telegramConfigured } from "./lib/telegram.js";
import { FileFillipStore } from "./lib/file-store.js";
import { MemoryFillipStore } from "./lib/memory-store.js";
import { verifyStopToken } from "./lib/stop-token.js";
import type { ReminderStore, ServiceStore } from "./lib/store.js";
import { FILLIP_EMPTY_REPRESENTATION, SupabaseFillipStore, type Db } from "./lib/supabase-store.js";
import type { Actor } from "./lib/types.js";
import { validateMcpClaims } from "./mcp-claims.js";
import { MCP_CORS_HEADERS, ensureStreamableHttpAccept, mcpBrowserOriginAllowed } from "./mcp-clients.js";
import { installPluginAuth } from "./plugin-auth.js";
import { installPublicPages } from "./public-pages.js";
import { useStdioTransport } from "./transport.js";
import { FILLIP_VERSION } from "./version.js";

export const app = express();
export default app;
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Cache-Control": "no-store" });
  next();
});

const publicLimits = new Map<string, { count: number; end: number }>();
function allowPublic(key: string, limit: number, ms: number) {
  const now = Date.now();
  for (const [entry, value] of publicLimits) if (value.end <= now) publicLimits.delete(entry);
  const value = publicLimits.get(key);
  if (value) {
    value.count += 1;
    return value.count <= limit;
  }
  if (publicLimits.size >= 10000) return false;
  publicLimits.set(key, { count: 1, end: now + ms });
  return true;
}

function envValue(name: string) {
  return process.env[name] ?? "";
}

function appBaseUrl() {
  return (envValue("APP_BASE_URL") || "http://localhost:3000").replace(/\/$/, "");
}

function mcpResourceUrls(): string[] {
  const urls = new Set<string>();
  const add = (value: string) => {
    const trimmed = value.trim().replace(/\/+$/, "");
    if (trimmed) urls.add(`${trimmed}/mcp`);
  };
  add(appBaseUrl());
  add(envValue("FILLIP_PUBLIC_ORIGIN"));
  add(envValue("FILLIP_LEGACY_ORIGIN"));
  return [...urls];
}

function intEnv(name: string, fallback: number) {
  const value = Number(envValue(name) || fallback);
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const DATA_DIR = envValue("FILLIP_DATA_DIR") || path.join(os.tmpdir(), "fillip-data");
const loadedBase = appBaseUrl();
const loadedSupabaseUrl = envValue("SUPABASE_URL").replace(/\/+$/, "");
const loadedAnon = envValue("SUPABASE_ANON_KEY");

type AuthUser = { id: string; email?: string | null; email_confirmed_at?: string | null };

function requireEnv(name: string, value: string) {
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function contentRangeTotal(header: string | null): number {
  const match = header?.match(/\/(\d+)$/);
  if (!match) throw new Error("Supabase count missing");
  return Number(match[1]);
}

async function supabaseCount(pathname: string, serviceRole: boolean): Promise<number> {
  const base = requireEnv("SUPABASE_URL", envValue("SUPABASE_URL").replace(/\/+$/, ""));
  const key = serviceRole ? requireEnv("SUPABASE_SERVICE_ROLE_KEY", envValue("SUPABASE_SERVICE_ROLE_KEY")) : requireEnv("SUPABASE_ANON_KEY", envValue("SUPABASE_ANON_KEY"));
  const response = await fetch(`${base}${pathname}`, {
    method: "GET",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Prefer: "count=exact",
      Range: "0-0"
    },
    signal: AbortSignal.timeout(20000)
  });
  if (response.status === 416) return 0;
  if (!response.ok && response.status !== 206) {
    const text = await response.text();
    throw new Error(`Supabase ${response.status}: ${text || response.statusText}`);
  }
  const header = response.headers.get("content-range");
  if (!header || header.endsWith("/*") || header.endsWith("/0") && response.status === 204) return 0;
  return contentRangeTotal(header);
}

async function supabaseRequest<T>(pathname: string, options: RequestInit = {}, accessToken?: string, serviceRole = false): Promise<T> {
  const base = requireEnv("SUPABASE_URL", envValue("SUPABASE_URL").replace(/\/+$/, ""));
  const key = serviceRole ? requireEnv("SUPABASE_SERVICE_ROLE_KEY", envValue("SUPABASE_SERVICE_ROLE_KEY")) : requireEnv("SUPABASE_ANON_KEY", envValue("SUPABASE_ANON_KEY"));
  const headers = new Headers(options.headers);
  headers.set("apikey", key);
  headers.set("Authorization", `Bearer ${accessToken ?? key}`);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${base}${pathname}`, { ...options, headers, signal: options.signal ?? AbortSignal.timeout(20000) });
  const text = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text || response.statusText}`);
  if (!text) {
    const prefer = new Headers(options.headers).get("prefer") ?? "";
    if (prefer.includes("return=representation")) return FILLIP_EMPTY_REPRESENTATION as T;
    return null as T;
  }
  return JSON.parse(text) as T;
}

function bearer(req: Request) {
  const header = req.header("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

async function authenticatedUser(req: Request): Promise<{ user: AuthUser; token: string }> {
  const token = bearer(req);
  if (!token) throw new Error("Authentication required");
  const user = await supabaseRequest<AuthUser>("/auth/v1/user", { method: "GET" }, token);
  if (!user?.id) throw new Error("Invalid authentication token");
  return { user, token };
}

function actorFromUser(user: AuthUser): Actor {
  return { id: user.id, email: user.email ?? null, emailVerified: Boolean(user.email_confirmed_at) };
}

async function subscriptionState(userId: string, token: string): Promise<"ok" | "error"> {
  try {
    await supabaseRequest<Array<{ subscription_status: string }>>(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=subscription_status`,
      {},
      token
    );
    return "ok";
  } catch {
    return "error";
  }
}

async function stripeRequest<T>(pathname: string, params: URLSearchParams): Promise<T> {
  const secret = requireEnv("STRIPE_SECRET_KEY", envValue("STRIPE_SECRET_KEY"));
  const response = await fetch(`https://api.stripe.com/v1/${pathname}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString()
  });
  if (!response.ok) throw new Error(`Stripe ${response.status}`);
  return JSON.parse(await response.text()) as T;
}

const billingApplied = new Map<string, { subscriptionId: string | null; created: number }>();

function eventCreated(event: { created?: unknown }): number {
  return typeof event.created === "number" && Number.isFinite(event.created) ? event.created : 0;
}

async function knownBilling(userId: string): Promise<{ subscriptionId: string | null; created: number } | null> {
  const memory = billingApplied.get(userId) ?? null;
  try {
    const rows = await supabaseRequest<Array<{ stripe_subscription_id?: string | null; billing_event_created?: number | null }>>(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=stripe_subscription_id,billing_event_created`,
      { method: "GET" },
      undefined,
      true
    );
    const row = rows?.[0];
    const created = typeof row?.billing_event_created === "number" ? row.billing_event_created : 0;
    const subscriptionId = typeof row?.stripe_subscription_id === "string" ? row.stripe_subscription_id : null;
    const stored = subscriptionId || created > 0 ? { subscriptionId, created } : null;
    if (!memory) return stored;
    if (!stored || memory.created >= stored.created) return memory;
    return stored;
  } catch {
    return memory;
  }
}

function billingIsStale(prior: { subscriptionId: string | null; created: number } | null, subscriptionId: string | null, created: number): boolean {
  if (!prior) return false;
  if (created < prior.created) return true;
  if (subscriptionId && prior.subscriptionId && subscriptionId !== prior.subscriptionId && created <= prior.created) return true;
  return false;
}

async function updateBillingProfile(userId: string, patch: JsonObject) {
  await supabaseRequest("/rest/v1/profiles?on_conflict=id", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify({ id: userId, ...patch, updated_at: new Date().toISOString() })
  }, undefined, true);
}

function userDb(token: string): Db {
  return (pathname, options) => supabaseRequest(pathname, options ?? {}, token);
}

function serviceDb(): Db {
  return (pathname, options) => {
    const prefer = new Headers(options?.headers).get("prefer") ?? "";
    if (prefer.includes("count=exact")) return supabaseCount(pathname, true);
    return supabaseRequest(pathname, options ?? {}, undefined, true);
  };
}

function createUserStore(userId: string, token: string): ReminderStore {
  if (envValue("SUPABASE_URL") && token) {
    const writer = envValue("SUPABASE_SERVICE_ROLE_KEY") ? serviceDb() : null;
    return new SupabaseFillipStore(userId, userDb(token), "user", writer);
  }
  return new FileFillipStore(path.join(DATA_DIR, `${userId}.json`));
}

function createServiceStore(): ServiceStore {
  if (!envValue("SUPABASE_URL") || !envValue("SUPABASE_SERVICE_ROLE_KEY")) {
    throw new Error("Supabase service role is not configured");
  }
  return new SupabaseFillipStore(null, serviceDb(), "service");
}

app.post("/billing/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) return res.status(400).send("Missing Stripe signature");
    const event = verifyStripeSignature(req.body, signature, envValue("STRIPE_WEBHOOK_SECRET"));
    const action = decideBillingAction(event, billingConfigFromEnv());
    if (action.type === "checkout") {
      await updateBillingProfile(action.userId, {
        stripe_customer_id: action.customerId,
        stripe_subscription_id: action.subscriptionId
      });
    } else if (action.type === "subscription") {
      const created = eventCreated(event as { created?: unknown });
      const subscriptionId = action.patch.stripe_subscription_id;
      const prior = await knownBilling(action.userId);
      if (!billingIsStale(prior, subscriptionId, created)) {
        await updateBillingProfile(action.userId, { ...action.patch, billing_event_created: created });
        billingApplied.set(action.userId, { subscriptionId, created });
      }
    }
    res.json({ received: true });
  } catch {
    console.error("Stripe webhook request failed");
    res.status(400).send("Webhook could not be processed");
  }
});

app.use(express.json({ limit: "128kb" }));
installPublicPages(app, loadedBase, loadedSupabaseUrl, loadedAnon);
app.get("/.well-known/openai-apps-challenge", (_req, res) => {
  const token = envValue("OPENAI_APPS_CHALLENGE");
  if (!token) return res.status(404).type("text").send("Verification is not configured.");
  res.type("text").send(token);
});

app.post("/api/support", async (req, res) => {
  if (!allowPublic(`support:${req.ip}`, 5, 3600000)) return res.status(429).json({ error: "Too many requests. Please try again in an hour." });
  const input = z.object({ email: z.string().email().max(254), message: z.string().trim().min(10).max(4000) }).safeParse(req.body);
  if (!input.success) return res.status(400).json({ error: "Enter a valid reply email and a message of 10 to 4000 characters." });
  const id = crypto.randomUUID();
  try {
    if (envValue("SUPABASE_URL") && envValue("SUPABASE_SERVICE_ROLE_KEY")) {
      await supabaseRequest("/rest/v1/fillip_support_requests", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({ id, email: input.data.email, message: input.data.message })
      }, undefined, true);
    } else {
      await mkdir(DATA_DIR, { recursive: true });
      await appendFile(path.join(DATA_DIR, "support.jsonl"), `${JSON.stringify({ id, email: input.data.email, message: input.data.message, createdAt: new Date().toISOString() })}\n`);
    }
    res.json({ id });
  } catch {
    res.status(503).json({ error: "Support could not receive your request. Please retry later." });
  }
});

installPluginAuth(app, loadedBase, loadedSupabaseUrl, loadedAnon);

app.get("/", (_req, res) => {
  res.type("html").send(renderLanding({
    supabaseUrl: loadedSupabaseUrl,
    supabaseAnonKey: loadedAnon,
    appBaseUrl: loadedBase,
    connectLead: landingConnectLead(loadedBase)
  }));
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "fillip", version: FILLIP_VERSION });
});

async function internalStatus(req: Request, res: Response) {
  const secret = envValue("CRON_SECRET");
  if (!secret) return res.status(503).json({ error: "Status is not configured." });
  const header = bearer(req);
  if (!header || !safeEqual(header, secret)) return res.status(401).json({ error: "Status authorization failed." });
  const now = new Date();
  const limits = globalEmailLimitsFromEnv();
  if (limits.perDay <= 0 || limits.perMonth <= 0) {
    console.warn("Fillip global email guard is closed because FILLIP_GLOBAL_MAX_EMAILS_PER_DAY or FILLIP_GLOBAL_MAX_EMAILS_PER_MONTH is not set. Due reminders stay queued.");
  }
  let globalEmails: GlobalEmailSnapshot | null = null;
  if (envValue("SUPABASE_URL") && envValue("SUPABASE_SERVICE_ROLE_KEY")) {
    try {
      globalEmails = await readGlobalEmailSnapshot(createServiceStore(), now, limits);
    } catch (error) {
      console.warn("Fillip global email guard: counts are unavailable");
      console.warn(error instanceof Error ? error.message : "count failed");
    }
  }
  const daySent = globalEmails?.daySent ?? null;
  const monthSent = globalEmails?.monthSent ?? null;
  const countsMissing = Boolean(envValue("SUPABASE_URL") && envValue("SUPABASE_SERVICE_ROLE_KEY")) && !globalEmails;
  const stopped = globalEmails
    ? globalEmails.stopped
    : limits.perDay <= 0 || limits.perMonth <= 0 || countsMissing;
  const reason = globalEmails?.reason
    ?? (countsMissing ? null : limits.perMonth <= 0 ? "month" : limits.perDay <= 0 ? "day" : null);
  res.json({
    ok: true,
    service: "fillip",
    version: FILLIP_VERSION,
    supabaseConfigured: Boolean(envValue("SUPABASE_URL") && envValue("SUPABASE_ANON_KEY")),
    stripeSecretConfigured: Boolean(envValue("STRIPE_SECRET_KEY")),
    stripeProductConfigured: Boolean(envValue("STRIPE_PRODUCT_ID")),
    stripeMonthlyConfigured: Boolean(envValue("STRIPE_PRICE_MONTHLY")),
    stripeYearlyConfigured: Boolean(envValue("STRIPE_PRICE_YEARLY")),
    billingConfigured: Boolean(envValue("STRIPE_SECRET_KEY") && envValue("STRIPE_PRODUCT_ID") && envValue("STRIPE_PRICE_MONTHLY") && envValue("STRIPE_PRICE_YEARLY")),
    usageCapsConfigured: usageCapsConfigured(),
    resendConfigured: Boolean(envValue("RESEND_API_KEY")),
    senderConfigured: Boolean(envValue("FILLIP_FROM_EMAIL")),
    telegramConfigured: telegramConfigured(),
    globalEmails: {
      daySent,
      dayLimit: limits.perDay,
      monthSent,
      monthLimit: limits.perMonth,
      dayResetsAt: nextUtcDay(now).toISOString(),
      monthResetsAt: nextMonthStart(now).toISOString(),
      stopped,
      close: globalEmails?.close ?? (stopped || limits.perDay <= 0 || limits.perMonth <= 0),
      reason
    }
  });
}

app.get("/internal/status", internalStatus);

app.post("/billing/checkout", async (req, res) => {
  try {
    const { user } = await authenticatedUser(req);
    const plan = req.body?.plan === "annual" ? "annual" : "monthly";
    const price = plan === "annual" ? requireEnv("STRIPE_PRICE_YEARLY", envValue("STRIPE_PRICE_YEARLY")) : requireEnv("STRIPE_PRICE_MONTHLY", envValue("STRIPE_PRICE_MONTHLY"));
    const productId = requireEnv("STRIPE_PRODUCT_ID", envValue("STRIPE_PRODUCT_ID"));
    const profiles = await supabaseRequest<Array<{ stripe_customer_id?: string | null }>>(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id`,
      { method: "GET" },
      bearer(req)
    );
    const params = checkoutParams({
      userId: user.id,
      email: user.email,
      customerId: profiles[0]?.stripe_customer_id,
      priceId: price,
      productId,
      appBaseUrl: appBaseUrl()
    });
    const session = await stripeRequest<{ id: string; url: string }>("checkout/sessions", params);
    res.json({ id: session.id, url: session.url });
  } catch {
    res.status(400).json({ error: "Unable to create checkout. Verify sign-in and retry." });
  }
});

app.post("/billing/portal", async (req, res) => {
  try {
    const { user } = await authenticatedUser(req);
    const profiles = await supabaseRequest<Array<{ stripe_customer_id?: string | null }>>(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(user.id)}&select=stripe_customer_id`,
      { method: "GET" },
      bearer(req)
    );
    const customer = profiles[0]?.stripe_customer_id;
    if (!customer) return res.status(400).json({ error: "Billing portal is not available until a subscription exists." });
    const params = new URLSearchParams({ customer, return_url: appBaseUrl() });
    const session = await stripeRequest<{ url: string }>("billing_portal/sessions", params);
    res.json({ url: session.url });
  } catch {
    res.status(400).json({ error: "Unable to open billing management. Verify sign-in and retry." });
  }
});

app.get("/api/export", async (req, res) => {
  try {
    const { user, token } = await authenticatedUser(req);
    const store = createUserStore(user.id, token);
    const reminders = await store.listReminders(user.id, { status: "all" });
    const digest = await store.getDigest(user.id);
    res.json({ reminders, digest });
  } catch {
    res.status(401).json({ error: "Sign in to Fillip to export reminders." });
  }
});

app.delete("/api/reminders", async (req, res) => {
  let userId = "";
  let token = "";
  try {
    const auth = await authenticatedUser(req);
    userId = auth.user.id;
    token = auth.token;
  } catch {
    return res.status(401).json({ error: "Sign in to Fillip to delete reminders." });
  }
  try {
    if (envValue("SUPABASE_URL")) await createServiceStore().deleteOwnerData(userId);
    else await createUserStore(userId, token).deleteOwnerData(userId);
    res.json({ deleted: true });
  } catch {
    res.status(503).json({ error: "Fillip could not delete reminders just now." });
  }
});

async function stopMail(req: Request, res: Response) {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const secret = envValue("FILLIP_UNSUBSCRIBE_SECRET");
  const userId = secret ? verifyStopToken(token, secret) : null;
  if (!userId) return res.status(400).type("html").send("<!doctype html><title>Fillip by Ouroboros</title><p>This stop link is not valid or has expired.</p>");
  if (req.method !== "POST") {
    return res.type("html").send("<!doctype html><title>Fillip by Ouroboros</title><p>This stops every Fillip email for the whole account.</p><form method=\"post\"><button type=\"submit\">Stop these emails</button></form><p><a href=\"https://ouroborosapps.com\">Ouroboros</a></p>");
  }
  try {
    await createServiceStore().setMailOptIn(userId, false);
  } catch {
    return res.status(503).type("html").send("<!doctype html><title>Fillip by Ouroboros</title><p>Fillip could not stop mail just now. Use the link again in a minute.</p>");
  }
  res.type("html").send("<!doctype html><title>Fillip by Ouroboros</title><p>Fillip will stop emailing you. Set another reminder when you want a ping again.</p><p><a href=\"https://ouroborosapps.com\">Ouroboros</a></p>");
}

app.get("/stop", stopMail);
app.post("/stop", stopMail);

async function deliver(req: Request, res: Response) {
  const secret = envValue("CRON_SECRET");
  if (!secret) return res.status(503).json({ error: "Delivery is not configured." });
  if (!allowPublic(`deliver:${req.ip}`, 30, 60000)) return res.status(429).json({ error: "Too many delivery attempts." });
  const header = bearer(req);
  if (!header || !safeEqual(header, secret)) return res.status(401).json({ error: "Delivery authorization failed." });
  if (!envValue("RESEND_API_KEY")) return res.status(503).json({ error: "Email provider is not configured." });
  try {
    const report = await runDueJob({
      store: createServiceStore(),
      sender: createResendSender(envValue("RESEND_API_KEY")),
      now: new Date(),
      from: envValue("FILLIP_FROM_EMAIL"),
      appBaseUrl: appBaseUrl(),
      unsubscribeSecret: envValue("FILLIP_UNSUBSCRIBE_SECRET"),
      maxEmailsPerUserPerDay: intEnv("FILLIP_MAX_EMAILS_PER_USER_PER_DAY", 100),
      maxSends: intEnv("FILLIP_MAX_SENDS_PER_RUN", 40),
      minIntervalMs: intEnv("FILLIP_RESEND_MIN_INTERVAL_MS", 500),
      caps: tierCapsFromEnv(),
      global: globalEmailLimitsFromEnv(),
      telegram: envValue("TELEGRAM_BOT_TOKEN") ? { sender: createTelegramSender(envValue("TELEGRAM_BOT_TOKEN")) } : null
    });
    res.json(report);
  } catch (error) {
    console.error("Delivery job failed");
    const message = error instanceof Error ? error.message : "";
    res.status(503).json({ error: /configured/.test(message) ? message : "Delivery could not run." });
  }
}

app.get("/internal/deliver", deliver);
app.post("/internal/deliver", deliver);

app.get("/calendar/:token", async (req, res) => {
  const raw = String(req.params.token ?? "").replace(/\.ics$/i, "");
  if (raw.length < 20) return res.status(404).type("text").send("Not found");
  try {
    const body = await renderCalendarFeed(createServiceStore(), raw, new Date());
    if (!body) return res.status(404).type("text").send("Not found");
    res.set("Cache-Control", "private, no-store");
    res.type("text/calendar; charset=utf-8").send(body);
  } catch {
    res.status(503).type("text").send("Calendar feed is unavailable.");
  }
});

app.post("/telegram/webhook", async (req, res) => {
  const token = envValue("TELEGRAM_BOT_TOKEN");
  if (!token) return res.status(404).type("text").send("Not found");
  const secret = envValue("TELEGRAM_WEBHOOK_SECRET");
  const header = req.header("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !safeEqual(header, secret)) return res.status(401).type("text").send("Unauthorized");
  try {
    const store = createServiceStore();
    const result = await acceptTelegramUpdate(store, req.body ?? {}, new Date());
    if (result.replyChatId && result.replyText) {
      await createTelegramSender(token).send(result.replyChatId, result.replyText);
    }
    res.json({ ok: true });
  } catch {
    res.status(503).json({ error: "Telegram update could not be processed." });
  }
});

function guardMcpOrigin(req: Request, res: Response) {
  const origin = req.header("origin");
  if (!mcpBrowserOriginAllowed(origin, appBaseUrl())) {
    res.status(403).json({ error: "Origin is not allowed." });
    return false;
  }
  if (origin) res.set({ ...MCP_CORS_HEADERS, "Access-Control-Allow-Origin": origin, Vary: "Origin" });
  return true;
}

app.options("/mcp", (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  res.status(204).end();
});

function mcpLogIds(token: string): { userId: string | null; clientId: string | null } {
  const empty = { userId: null, clientId: null };
  const payload = token.split(".")[1];
  if (!payload) return empty;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: unknown; client_id?: unknown };
    return {
      userId: typeof claims.sub === "string" ? claims.sub : null,
      clientId: typeof claims.client_id === "string" ? claims.client_id : null
    };
  } catch {
    return empty;
  }
}

app.post("/mcp", ensureStreamableHttpAccept, async (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  const started = Date.now();
  const presented = bearer(req);
  res.on("finish", () => {
    const method = typeof req.body?.method === "string" ? req.body.method : "";
    const called = req.body?.params && typeof req.body.params === "object" ? (req.body.params as { name?: unknown }).name : undefined;
    const tool = method === "tools/call" && typeof called === "string" ? called : method;
    const ids = presented ? mcpLogIds(presented) : { userId: null, clientId: null };
    console.log(JSON.stringify({
      event: "mcp",
      userId: ids.userId,
      clientId: ids.clientId,
      tool,
      status: res.statusCode,
      durationMs: Date.now() - started
    }));
  });
  if (!allowPublic(`mcp:${req.ip}`, 300, 60000)) return res.status(429).set("Retry-After", "60").json({ error: "Too many requests. Retry in one minute." });
  let server: McpServer | undefined;
  let actor: Actor = { id: "", email: null, emailVerified: false };
  let store: ReminderStore = new MemoryFillipStore();
  // tools/list stays public so ChatGPT's app directory and Glama can read the
  // catalog and securitySchemes before a user connects. initialize and every
  // other method require a token, so Claude and Cursor start OAuth at connect
  // time instead of on the first tools/call.
  const publicMethods = new Set(["tools/list"]);
  if (!publicMethods.has(req.body?.method)) {
    try {
      const auth = await authenticatedUser(req);
      validateMcpClaims(auth.token, auth.user.id, `${envValue("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1`, mcpResourceUrls());
      actor = actorFromUser(auth.user);
      store = createUserStore(actor.id, auth.token);
    } catch {
      const metadata = `Bearer resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource/mcp"`;
      res.set("WWW-Authenticate", presented ? `${metadata}, error="invalid_token"` : metadata);
      return res.status(401).json({ error: "Authentication required." });
    }
    try {
      const state = await subscriptionState(actor.id, bearer(req));
      if (state === "error") return res.status(503).json({ error: "Could not verify your account. Please retry." });
    } catch {
      return res.status(503).json({ error: "Could not verify your subscription. Please retry." });
    }
  }
  try {
    if (actor.id && !allowPublic(`user:${actor.id}`, 60, 60000)) {
      return res.status(429).set("Retry-After", "60").json({ error: "Reminder limit reached. Retry in one minute." });
    }
    server = createFillipServer(store, actor, () => new Date(), tierCapsFromEnv());
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server?.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "Unable to process the plugin request." });
  }
});

app.get("/mcp", (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  res.set("WWW-Authenticate", `Bearer resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource/mcp"`);
  res.status(401).json({ error: "Use Streamable HTTP POST with your Fillip connection." });
});

app.use((_req, res) => {
  res.status(404).type("text").send("Not found");
});

app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  if (res.headersSent) return;
  const type = typeof error === "object" && error && "type" in error ? String((error as { type?: string }).type) : "";
  if (type === "entity.parse.failed" || type === "entity.too.large") {
    res.status(type === "entity.too.large" ? 413 : 400).json({ error: "Invalid or oversized request." });
    return;
  }
  const safe = publicError(error);
  res.status(safe.status).json({ error: safe.error });
});

const port = Number(envValue("PORT") || 3000);
if (process.env.NODE_ENV !== "test") {
  const stdio = useStdioTransport();
  app.listen(port, () => {
    const line = `Fillip listening on ${port}`;
    if (stdio) console.error(line);
    else console.log(line);
  });
  if (stdio) {
    const local = createFillipServer(new FileFillipStore(path.join(DATA_DIR, "local.json")), { id: "local", email: null, emailVerified: false }, () => new Date(), tierCapsFromEnv());
    await local.connect(new StdioServerTransport());
  }
}
