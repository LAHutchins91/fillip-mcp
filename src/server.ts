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
import { FileFillipStore } from "./lib/file-store.js";
import { MemoryFillipStore } from "./lib/memory-store.js";
import { verifyStopToken } from "./lib/stop-token.js";
import type { ReminderStore, ServiceStore } from "./lib/store.js";
import { SupabaseFillipStore, type Db } from "./lib/supabase-store.js";
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
  if (!response.ok && response.status !== 206) {
    const text = await response.text();
    throw new Error(`Supabase ${response.status}: ${text || response.statusText}`);
  }
  return contentRangeTotal(response.headers.get("content-range"));
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
  return (text ? JSON.parse(text) : null) as T;
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

async function subscriptionState(userId: string, token: string): Promise<"ok" | "inactive" | "error"> {
  try {
    const profiles = await supabaseRequest<Array<{ subscription_status: string }>>(
      `/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=subscription_status`,
      {},
      token
    );
    if (!profiles[0] || !["active", "trialing"].includes(profiles[0].subscription_status)) return "inactive";
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
  if (envValue("SUPABASE_URL") && token) return new SupabaseFillipStore(userId, userDb(token), "user");
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
      await updateBillingProfile(action.userId, action.patch);
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

app.get("/health", async (_req, res) => {
  const now = new Date();
  const limits = globalEmailLimitsFromEnv();
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
});

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
  try {
    const { user, token } = await authenticatedUser(req);
    const store = createUserStore(user.id, token);
    await store.deleteOwnerData(user.id);
    res.json({ deleted: true });
  } catch {
    res.status(401).json({ error: "Sign in to Fillip to delete reminders." });
  }
});

async function stopMail(req: Request, res: Response) {
  const token = typeof req.query.token === "string" ? req.query.token : "";
  const secret = envValue("FILLIP_UNSUBSCRIBE_SECRET");
  const userId = secret ? verifyStopToken(token, secret) : null;
  if (!userId) return res.status(400).type("html").send("<!doctype html><title>Fillip by Ouroboros</title><p>This stop link is not valid or has expired.</p>");
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
      maxEmailsPerUserPerDay: intEnv("FILLIP_MAX_EMAILS_PER_USER_PER_DAY", 20),
      maxSends: intEnv("FILLIP_MAX_SENDS_PER_RUN", 40),
      minIntervalMs: intEnv("FILLIP_RESEND_MIN_INTERVAL_MS", 500),
      caps: tierCapsFromEnv(),
      global: globalEmailLimitsFromEnv()
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

app.post("/mcp", ensureStreamableHttpAccept, async (req, res) => {
  if (!guardMcpOrigin(req, res)) return;
  if (!allowPublic(`mcp:${req.ip}`, 300, 60000)) return res.status(429).set("Retry-After", "60").json({ error: "Too many requests. Retry in one minute." });
  let server: McpServer | undefined;
  let actor: Actor = { id: "", email: null, emailVerified: false };
  let store: ReminderStore = new MemoryFillipStore();
  const publicMethods = new Set(["initialize", "notifications/initialized", "tools/list", "ping"]);
  if (!publicMethods.has(req.body?.method)) {
    try {
      const auth = await authenticatedUser(req);
      validateMcpClaims(auth.token, auth.user.id, `${envValue("SUPABASE_URL").replace(/\/+$/, "")}/auth/v1`, `${appBaseUrl()}/mcp`);
      actor = actorFromUser(auth.user);
      store = createUserStore(actor.id, auth.token);
    } catch {
      res.set("WWW-Authenticate", `Bearer resource_metadata="${appBaseUrl()}/.well-known/oauth-protected-resource/mcp"`);
      return res.status(401).json({ error: "Sign in to Fillip to set a reminder." });
    }
    try {
      const state = await subscriptionState(actor.id, bearer(req));
      if (state === "error") return res.status(503).json({ error: "Could not verify your subscription. Please retry." });
      if (state !== "ok") return res.status(403).json({ error: "This Fillip account does not currently include reminders. The trial is 14 days, then Pro.", access_information: `${appBaseUrl()}/access` });
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
