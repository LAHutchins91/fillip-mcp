/**
 * Independent QA for delivery idempotency, stop links, Stripe, and OAuth.
 * Tests named QA-FAIL assert the behavior a user was promised.
 * They fail on this build. Tests named QA-PASS are observed successes.
 */
import crypto from "node:crypto";
import http, { type Server } from "node:http";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFillipServer } from "../../src/fillip-tools.js";
import { decideBillingAction, verifyStripeSignature, type StripeEvent } from "../../src/lib/billing.js";
import { runDueJob } from "../../src/lib/deliver.js";
import type { MailSender, OutboundEmail } from "../../src/lib/email.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { completeOrCancel, listReminders, setReminder } from "../../src/lib/reminders.js";
import { signStopToken, verifyStopToken } from "../../src/lib/stop-token.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import type { Actor } from "../../src/lib/types.js";
import type { TierCaps } from "../../src/lib/usage.js";
import { validateMcpClaims } from "../../src/mcp-claims.js";
import { app } from "../../src/server.js";

const caps: TierCaps = { trialEmailsPerMonth: 100, proEmailsPerMonth: 1000, annualEmailsPerMonth: 1000 };
const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const other: Actor = { id: "33333333-3333-4333-8333-333333333333", email: "other@example.com", emailVerified: true };
const secret = "unsubscribe-secret";
const from = "Fillip <reminders@example.com>";

class CountingSender implements MailSender {
  sent: OutboundEmail[] = [];
  throwAfterRecord = false;
  async send(message: OutboundEmail) {
    this.sent.push(structuredClone(message));
    if (this.throwAfterRecord) {
      this.throwAfterRecord = false;
      throw new Error("timeout after accept");
    }
    return { id: `email_${this.sent.length}` };
  }
}

class ResendLikeSender implements MailSender {
  inbox: OutboundEmail[] = [];
  calls = 0;
  failNextAfterStore = false;
  async send(message: OutboundEmail) {
    this.calls += 1;
    const prior = this.inbox.find((row) => row.idempotencyKey === message.idempotencyKey);
    if (prior) return { id: "same-email" };
    this.inbox.push(message);
    if (this.failNextAfterStore) {
      this.failNextAfterStore = false;
      throw new Error("timeout after accept");
    }
    return { id: `email_${this.inbox.length}` };
  }
}

function job(store: MemoryFillipStore, sender: MailSender, now: Date) {
  return runDueJob({
    store,
    sender,
    now,
    from,
    appBaseUrl: "https://fillip.example",
    unsubscribeSecret: secret,
    maxEmailsPerUserPerDay: 100,
    maxSends: 20,
    minIntervalMs: 0,
    caps,
    sleep: async () => {}
  });
}

async function seedDue(store: MemoryFillipStore, what = "Call Ada") {
  return setReminder(store, actor, { what, when: "in 1 hour", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"), caps);
}

const due = new Date("2026-10-11T16:00:00.000Z");

function delayingDb(seed: Record<string, unknown>[] = []) {
  const deliveries = seed.map((row) => ({ ...row }));
  let gate: Promise<void> = Promise.resolve();
  const arm = () => {
    let release: () => void = () => {};
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const prev = gate;
    gate = wait;
    return { prev, release };
  };
  const db: Db = async (pathname, options) => {
    const method = options?.method ?? "GET";
    if (pathname.startsWith("/rest/v1/deliveries") && method === "POST") {
      const row = JSON.parse(String(options?.body)) as Record<string, unknown>;
      const hold = arm();
      await hold.prev;
      const duplicate = deliveries.some((item) => item.dedupe_key === row.dedupe_key);
      hold.release();
      if (duplicate) throw new Error("duplicate key value violates unique constraint 23505");
      deliveries.push(row);
      return [row];
    }
    if (pathname.startsWith("/rest/v1/deliveries") && method === "GET") {
      const key = decodeURIComponent((pathname.match(/dedupe_key=eq\.([^&]+)/) ?? [])[1] ?? "");
      return deliveries.filter((item) => item.dedupe_key === key);
    }
    if (pathname.startsWith("/rest/v1/deliveries") && method === "PATCH") {
      const key = decodeURIComponent((pathname.match(/dedupe_key=eq\.([^&]+)/) ?? [])[1] ?? "");
      const patch = JSON.parse(String(options?.body)) as Record<string, unknown>;
      const hold = arm();
      await hold.prev;
      const matches = deliveries.filter((item) => item.dedupe_key === key && item.status !== "sent");
      for (const row of matches) Object.assign(row, patch);
      hold.release();
      return matches.map((row) => ({ ...row }));
    }
    return [];
  };
  return { db, deliveries };
}

describe("QA duplicate sends", () => {
  it("QA-PASS: a second cron run after a successful send does not send again", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    await seedDue(store);
    const first = await job(store, sender, due);
    const second = await job(store, sender, due);
    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(sender.sent).toHaveLength(1);
  });

  it("QA-PASS: two workers claiming the same new occurrence produce one send", async () => {
    const { db } = delayingDb();
    const store = new SupabaseFillipStore(null, db, "service");
    const input = {
      ownerId: actor.id,
      reminderId: "reminder-1",
      dedupeKey: "reminder:reminder-1:2026-10-11T13:00:00.000Z",
      occurrenceAt: "2026-10-11T13:00:00.000Z",
      idempotencyKey: "fillip/reminder-1/2026-10-11T13:00:00.000Z",
      nowIso: due.toISOString(),
      staleBeforeIso: new Date(due.getTime() - 120_000).toISOString()
    };
    const [first, second] = await Promise.all([store.claimDelivery(input), store.claimDelivery(input)]);
    expect([first.outcome, second.outcome].filter((outcome) => outcome === "send")).toHaveLength(1);
  });

  it("QA-PASS: a timeout after accept retries with the same idempotency key and a deduping provider stores one email", async () => {
    const store = new MemoryFillipStore();
    const sender = new ResendLikeSender();
    sender.failNextAfterStore = true;
    await seedDue(store);
    const failed = await job(store, sender, due);
    const retried = await job(store, sender, due);
    expect(failed.failed).toBe(1);
    expect(retried.sent).toBe(1);
    expect(sender.inbox).toHaveLength(1);
    expect(sender.calls).toBeGreaterThan(1);
    expect(new Set(sender.inbox.map((message) => message.idempotencyKey)).size).toBe(1);
    expect(sender.inbox[0]?.idempotencyKey).toMatch(/^fillip\//);
  });

  it("QA-FAIL: reclaiming a failed delivery is an atomic claim", async () => {
    const { db } = delayingDb([{
      id: "existing",
      owner_id: actor.id,
      reminder_id: "reminder-1",
      dedupe_key: "reminder:reminder-1:2026-10-11T13:00:00.000Z",
      occurrence_at: "2026-10-11T13:00:00.000Z",
      status: "failed",
      idempotency_key: "fillip/reminder-1/2026-10-11T13:00:00.000Z",
      provider_id: null,
      started_at: "2026-10-11T13:00:00.000Z",
      sent_at: null,
      error: "send failed"
    }]);
    const store = new SupabaseFillipStore(null, db, "service");
    const input = {
      ownerId: actor.id,
      reminderId: "reminder-1",
      dedupeKey: "reminder:reminder-1:2026-10-11T13:00:00.000Z",
      occurrenceAt: "2026-10-11T13:00:00.000Z",
      idempotencyKey: "fillip/reminder-1/2026-10-11T13:00:00.000Z",
      nowIso: due.toISOString(),
      staleBeforeIso: new Date(due.getTime() - 120_000).toISOString()
    };
    const [first, second] = await Promise.all([store.claimDelivery(input), store.claimDelivery(input)]);
    expect([first.outcome, second.outcome].filter((outcome) => outcome === "send")).toHaveLength(1);
  });

  it("QA-FAIL: a crash after the provider accepts does not submit that occurrence again", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    await seedDue(store);
    const saveUsage = store.saveUsage.bind(store);
    store.saveUsage = async () => {
      throw new Error("crashed after send");
    };
    await job(store, sender, due);
    store.saveUsage = saveUsage;
    await job(store, sender, due);
    expect(store.deliveries[0]?.status).toBe("sent");
    expect(sender.sent).toHaveLength(1);
  });

  it("QA-FAIL: one malformed recipient does not abort the rest of the sweep", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    await seedDue(store, "bad owner");
    const bad = store.contacts.get(actor.id);
    if (!bad) throw new Error("missing contact");
    bad.email = "owner@example.com, other@example.net";
    await setReminder(store, other, { what: "good owner", when: "in 1 hour", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"), caps);
    const report = await job(store, sender, due);
    expect(report.sent + report.failed + report.skipped + report.deferred).toBeGreaterThan(0);
    expect(sender.sent.map((message) => message.to)).toContain("other@example.com");
  });
});

describe("QA stop link and copy", () => {
  const now = Date.parse("2026-10-11T16:00:00.000Z");

  it("QA-PASS: the stop token is unguessable, account-scoped, and safe to check twice", () => {
    const token = signStopToken(actor.id, secret, now);
    expect(verifyStopToken(token, secret, now)).toBe(actor.id);
    expect(verifyStopToken(token, secret, now + 60_000)).toBe(actor.id);
    expect(verifyStopToken(token, secret, now + 30 * 24 * 60 * 60 * 1000)).toBe(actor.id);
    const forged = `${Buffer.from(`${other.id}.9999999999`).toString("base64url")}.${token.split(".")[1]}`;
    expect(verifyStopToken(forged, secret, now)).toBeNull();
    const flipped = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expect(verifyStopToken(flipped, secret, now)).toBeNull();
    let accepted = 0;
    for (let i = 0; i < 200; i += 1) {
      const guess = `${crypto.randomBytes(24).toString("base64url")}.${crypto.randomBytes(32).toString("base64url")}`;
      if (verifyStopToken(guess, secret, now)) accepted += 1;
    }
    expect(accepted).toBe(0);
    expect(token.length).toBeGreaterThan(80);
  });

  it("QA-PASS: one stop link turns off every reminder for that account only", async () => {
    const store = new MemoryFillipStore();
    await seedDue(store, "first");
    await setReminder(store, actor, { what: "second", when: "in 2 hours", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"), caps);
    await setReminder(store, other, { what: "theirs", when: "in 2 hours", timezone: "UTC" }, new Date("2026-10-11T12:00:00.000Z"), caps);
    await store.setMailOptIn(actor.id, false);
    const sender = new CountingSender();
    await job(store, sender, due);
    expect(sender.sent.map((message) => message.to)).toEqual(["other@example.com"]);
    const mine = await listReminders(store, actor.id, { status: "all" }, due);
    expect(mine).toHaveLength(2);
  });

  it("QA-FAIL: the email says the link stops every reminder, not just this one", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    await seedDue(store, "one follow-up");
    await job(store, sender, due);
    const text = sender.sent[0]?.text ?? "";
    expect(text).toMatch(/all reminders|every reminder|every Fillip email|whole account/i);
  });

  it("QA-FAIL: a stop link stays valid after the signing secret is rotated", () => {
    const token = signStopToken(actor.id, "old-unsubscribe-secret", now);
    expect(verifyStopToken(token, "new-unsubscribe-secret", now)).toBe(actor.id);
  });

  it("QA-FAIL: a stop link stays valid after its own expiry", () => {
    const token = signStopToken(actor.id, secret, now);
    const afterTtl = now + 401 * 24 * 60 * 60 * 1000;
    expect(verifyStopToken(token, secret, afterTtl)).toBe(actor.id);
  });

  it("QA-PASS: reminder HTML is escaped and the recipient stays the account address", async () => {
    const store = new MemoryFillipStore();
    const sender = new CountingSender();
    await setReminder(store, actor, {
      what: `<img src=x onerror="alert(1)">`,
      when: "in 1 hour",
      timezone: "UTC",
      context: `</p><script>alert(1)</script>`
    }, new Date("2026-10-11T12:00:00.000Z"), caps);
    await job(store, sender, due);
    const message = sender.sent[0];
    expect(message?.to).toBe("owner@example.com");
    expect(message?.html).not.toContain("<script>");
    expect(message?.html).not.toContain("<img");
    expect(message?.html).toContain("&lt;script&gt;");
    expect(message?.text).not.toContain("other@example.net");
  });
});

const billingConfig = {
  appBaseUrl: "https://fillip.example",
  productId: "prod_fillip",
  monthlyPriceId: "price_fillip_month",
  yearlyPriceId: "price_fillip_year"
};

function subscription(input: { product?: string; price?: string; status?: string; id?: string; app?: string; userId?: string } = {}, type = "customer.subscription.updated"): StripeEvent {
  const product = input.product ?? billingConfig.productId;
  return {
    type,
    data: {
      object: {
        id: input.id ?? "sub_fillip",
        customer: "cus_1",
        status: input.status ?? "active",
        current_period_end: 1_800_000_000,
        cancel_at_period_end: false,
        metadata: { supabase_user_id: input.userId ?? "user-1", app: input.app ?? "fillip", product },
        items: { data: [{ price: { id: input.price ?? billingConfig.monthlyPriceId, product } }] }
      }
    }
  };
}

describe("QA Stripe and HTTP behavior", () => {
  let server: Server;
  let base: string;
  const webhookSecret = "whsec_qa";
  const savedEnv = { ...process.env };
  let fetches: Array<{ url: string; method: string; body: string }> = [];
  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = webhookSecret;
    process.env.STRIPE_PRODUCT_ID = billingConfig.productId;
    process.env.STRIPE_PRICE_MONTHLY = billingConfig.monthlyPriceId;
    process.env.STRIPE_PRICE_YEARLY = billingConfig.yearlyPriceId;
    process.env.APP_BASE_URL = billingConfig.appBaseUrl;
    process.env.SUPABASE_URL = "https://qa.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-qa";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-qa";
    process.env.FILLIP_UNSUBSCRIBE_SECRET = secret;
    process.env.CRON_SECRET = "cron-qa";
    process.env.RESEND_API_KEY = "re_qa";
    process.env.FILLIP_FROM_EMAIL = from;
    delete process.env.FILLIP_MAX_EMAILS_PER_USER_PER_DAY;
    delete process.env.FILLIP_CAP_TRIAL_EMAILS_PER_MONTH;
    delete process.env.FILLIP_CAP_PRO_EMAILS_PER_MONTH;
    delete process.env.FILLIP_CAP_ANNUAL_EMAILS_PER_MONTH;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : "";
      fetches.push({ url, method, body });
      if (url.includes("api.resend.com")) return new Response(JSON.stringify({ id: "re_qa" }), { status: 200 });
      if (url.includes("/auth/v1/user")) {
        const token = (init?.headers instanceof Headers ? init.headers.get("authorization") : "") ?? "";
        const claims = claimsOf(token.replace("Bearer ", ""));
        return new Response(JSON.stringify({ id: claims.sub, email: "owner@example.com", email_confirmed_at: "2026-01-01T00:00:00.000Z" }), { status: 200 });
      }
      if (url.includes("/rest/v1/profiles") && method === "GET") {
        return new Response(JSON.stringify([{ subscription_status: "active", plan: "pro", unsubscribed: false, emails_sent_in_period: profileUsage.emails, email_period_start: profileUsage.period }]), { status: 200 });
      }
      if (url.includes("/rest/v1/profiles")) return new Response("", { status: 201 });
      if (url.includes("/auth/v1/admin/users/")) {
        return new Response(JSON.stringify({ id: actor.id, email: "owner@example.com", email_confirmed_at: "2026-01-01T00:00:00.000Z" }), { status: 200 });
      }
      if (url.includes("/rest/v1/reminders") && method === "GET") return new Response(JSON.stringify(dueRows), { status: 200 });
      if (url.includes("/rest/v1/deliveries") && method === "GET") return new Response(JSON.stringify(sentRows), { status: 200 });
      if (url.includes("/rest/v1/reminders") && method === "PATCH") return new Response(JSON.stringify([{ id: "rem-1" }]), { status: 200 });
      if (url.includes("/rest/v1/deliveries") && method === "POST") return new Response(JSON.stringify([{ id: "del-1", status: "sending" }]), { status: 201 });
      if (url.includes("/rest/v1/digest_settings")) return new Response("[]", { status: 200 });
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  function sign(body: string, timestamp = Math.floor(Date.now() / 1000)) {
    const digest = crypto.createHmac("sha256", webhookSecret).update(`${timestamp}.${body}`).digest("hex");
    return `t=${timestamp},v1=${digest}`;
  }

  function post(pathname: string, body: string, headers: Record<string, string>) {
    const payload = Buffer.from(body);
    const url = new URL(pathname, base);
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: { "content-length": payload.length, ...headers }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end(payload);
    });
  }

  function authorizedGet(pathname: string) {
    return get(pathname, { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` });
  }

  function get(pathname: string, headers: Record<string, string> = {}) {
    const url = new URL(pathname, base);
    return new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = http.request({ hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`, method: "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  it("QA-PASS: a bad signature, an unknown event, and another product do not change Fillip access", async () => {
    const continuity = JSON.stringify(subscription({ product: "prod_continuity", price: "price_continuity", app: "continuity", id: "sub_continuity" }, "customer.subscription.deleted"));
    const desk = JSON.stringify({
      type: "checkout.session.completed",
      data: { object: { success_url: "https://desk.example/?checkout=success", client_reference_id: "user-1", metadata: { app: "desk", product: "prod_desk" } } }
    });
    const unknown = JSON.stringify({ type: "charge.refunded", data: { object: { metadata: { app: "fillip", product: billingConfig.productId } } } });
    fetches = [];
    for (const body of [continuity, desk, unknown]) {
      const response = await post("/billing/webhook", body, { "content-type": "application/json", "stripe-signature": sign(body) });
      expect(response.status).toBe(200);
      expect(decideBillingAction(JSON.parse(body) as StripeEvent, billingConfig).type).toBe("ignore");
    }
    expect(fetches.filter((call) => call.url.includes("/rest/v1/profiles") && call.method === "POST")).toHaveLength(0);
    const bad = await post("/billing/webhook", continuity, { "content-type": "application/json", "stripe-signature": sign(`${continuity} `) });
    expect(bad.status).toBe(400);
    expect(() => verifyStripeSignature(Buffer.from(continuity), sign(continuity, Math.floor(Date.now() / 1000) - 600), webhookSecret)).toThrow(/Expired/);
    const logs: unknown[] = [];
    const errorSpy = console.error;
    console.error = (...args: unknown[]) => { logs.push(args); };
    try {
      await post("/billing/webhook", continuity, { "content-type": "application/json", "stripe-signature": "t=1,v1=nope" });
    } finally {
      console.error = errorSpy;
    }
    expect(JSON.stringify(logs)).not.toContain(webhookSecret);
    expect(JSON.stringify(logs)).not.toContain("prod_continuity");
  });

  it("QA-PASS: replaying the same Fillip subscription event writes the same plan twice", async () => {
    const body = JSON.stringify(subscription({ status: "active", id: "sub_live" }));
    fetches = [];
    const first = await post("/billing/webhook", body, { "content-type": "application/json", "stripe-signature": sign(body) });
    const second = await post("/billing/webhook", body, { "content-type": "application/json", "stripe-signature": sign(body) });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const writes = fetches.filter((call) => call.method === "POST" && call.url.includes("/rest/v1/profiles")).map((call) => JSON.parse(call.body) as { plan?: string });
    expect(writes.map((row) => row.plan)).toEqual(["pro", "pro"]);
  });

  it("QA-FAIL: an older cancellation does not revoke a newer Fillip subscription", async () => {
    const active = JSON.stringify({ ...subscription({ status: "active", id: "sub_new" }), created: 2_000 });
    const older = JSON.stringify({ ...subscription({ status: "canceled", id: "sub_old" }, "customer.subscription.deleted"), created: 1_000 });
    fetches = [];
    expect((await post("/billing/webhook", active, { "content-type": "application/json", "stripe-signature": sign(active) })).status).toBe(200);
    expect((await post("/billing/webhook", older, { "content-type": "application/json", "stripe-signature": sign(older) })).status).toBe(200);
    const writes = fetches.filter((call) => call.method === "POST" && call.url.includes("/rest/v1/profiles")).map((call) => JSON.parse(call.body) as { plan?: string; stripe_subscription_id?: string });
    expect(writes.at(-1)?.plan).toBe("pro");
    expect(writes.at(-1)?.stripe_subscription_id).toBe("sub_new");
  });

  it("QA-FAIL: clicking the stop link with GET does not unsubscribe", async () => {
    const token = signStopToken(actor.id, secret);
    fetches = [];
    const response = await get(`/stop?token=${encodeURIComponent(token)}`);
    const writes = fetches.filter((call) => call.method === "POST" && call.url.includes("/rest/v1/profiles"));
    expect(response.status).toBeLessThan(500);
    expect(writes, "a GET from a mail scanner must not change mail settings").toHaveLength(0);
  });

  it("QA-PASS: the stop link works without a session and a second POST is safe", async () => {
    const token = signStopToken(actor.id, secret);
    fetches = [];
    const first = await post(`/stop?token=${encodeURIComponent(token)}`, "", {});
    const second = await post(`/stop?token=${encodeURIComponent(token)}`, "", {});
    const missing = await get("/stop");
    expect(first.status).toBe(200);
    expect(first.text).toMatch(/stop emailing you/i);
    expect(second.status).toBe(200);
    expect(missing.status).toBe(400);
    const writes = fetches.filter((call) => call.method === "POST" && call.url.includes("/rest/v1/profiles")).map((call) => JSON.parse(call.body) as { id?: string; unsubscribed?: boolean });
    expect(writes.every((row) => row.id === actor.id && row.unsubscribed === true)).toBe(true);
    expect(writes.length).toBeGreaterThanOrEqual(2);
  });

  it("QA-PASS: tools/list works, anonymous calls are rejected, and audience and expiry are checked", async () => {
    const listed = await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    });
    expect(listed.status).toBe(200);
    expect(listed.text).toContain("set_reminder");
    const anonymous = await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_reminders", arguments: {} } }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    });
    expect(anonymous.status).toBe(401);

    const issuer = "https://qa.supabase.co/auth/v1";
    const resource = "https://fillip.example/mcp";
    const baseClaims = {
      sub: actor.id,
      iss: issuer,
      aud: ["authenticated", resource],
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 120,
      client_id: "chatgpt",
      session_id: "session-1",
      scope: "email"
    };
    expect(() => validateMcpClaims(jwt({ ...baseClaims, aud: ["authenticated"] }), actor.id, issuer, resource)).toThrow(/Reconnect/);
    expect(() => validateMcpClaims(jwt({ ...baseClaims, exp: Math.floor(Date.now() / 1000) - 10 }), actor.id, issuer, resource)).toThrow(/Reconnect/);
    expect(() => validateMcpClaims(jwt(baseClaims), other.id, issuer, resource)).toThrow(/Reconnect/);
    const accepted = await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_reminders", arguments: {} } }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt(baseClaims)}`
    });
    expect(accepted.status).toBe(200);
    const wrongAudience = await post("/mcp", JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_reminders", arguments: {} } }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${jwt({ ...baseClaims, aud: ["authenticated"] })}`
    });
    expect(wrongAudience.status).toBe(401);
    const metadata = await get("/.well-known/oauth-protected-resource/mcp");
    expect(metadata.status).toBe(200);
    expect(metadata.text).toContain("/auth/v1");
    const authorizationServer = await get("/.well-known/oauth-authorization-server");
    expect([404, 401]).toContain(authorizationServer.status);
  });

  it("QA-FAIL: the shipped server defaults are 1,000 reminder emails a month and 100 a day", async () => {
    dueRows = [reminderRow()];
    sentRows = Array.from({ length: 20 }, (_, index) => ({ id: `sent-${index}` }));
    profileUsage = { emails: 0, period: "2026-10-01T00:00:00.000Z" };
    fetches = [];
    const daily = await authorizedGet("/internal/deliver");
    expect(daily.status).toBe(200);
    const claimedDaily = fetches.some((call) => call.method === "POST" && call.url.includes("/rest/v1/deliveries"));

    dueRows = [reminderRow()];
    sentRows = [];
    profileUsage = { emails: 60, period: new Date().toISOString() };
    fetches = [];
    const monthly = await authorizedGet("/internal/deliver");
    expect(monthly.status).toBe(200);
    const claimedMonthly = fetches.some((call) => call.method === "POST" && call.url.includes("/rest/v1/deliveries"));
    expect({ dayAllows21st: claimedDaily, monthAllows61st: claimedMonthly }).toEqual({ dayAllows21st: true, monthAllows61st: true });
  });

  it("QA-PASS: user-facing pages and tool text do not print a price", async () => {
    const pages = ["/", "/connect", "/terms", "/privacy", "/access", "/support", "/data"];
    for (const page of pages) {
      const response = await get(page);
      expect(response.status, page).toBe(200);
      expect(response.text, page).not.toMatch(/\$\s*\d/);
      expect(response.text, page).not.toMatch(/\bUSD\b|\bdollars?\b/i);
    }
    const roots = ["README.md", "src", "server.json", "glama.json"];
    const offenders: string[] = [];
    for (const root of roots) {
      for (const file of await walk(path.join(process.cwd(), root))) {
        const text = await readFile(file, "utf8");
        if (/\$\s*\d/.test(text) || /\bUSD\b/.test(text) || /\bdollars?\b/i.test(text)) offenders.push(path.relative(process.cwd(), file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

let dueRows: unknown[] = [];
let sentRows: unknown[] = [];
let profileUsage = { emails: 0, period: "2026-10-01T00:00:00.000Z" };

function reminderRow() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    owner_id: actor.id,
    kind: "reminder",
    what: "ship the notes",
    context: null,
    timezone: "UTC",
    fire_at: "2026-01-01T00:00:00.000Z",
    recurrence: null,
    status: "active",
    hold_until: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null
  };
}

function claimsOf(token: string): { sub?: string } {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: string };
  } catch {
    return {};
  }
}

function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.sig`;
}

async function walk(target: string): Promise<string[]> {
  const info = await stat(target);
  if (!info.isDirectory()) return [target];
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    if (entry.name === "node_modules" || entry.name === "dist") return [];
    return walk(path.join(target, entry.name));
  }));
  return nested.flat();
}

describe("QA account isolation", () => {
  it("QA-PASS: user A cannot list, reschedule, or cancel user B's reminders", async () => {
    const store = new MemoryFillipStore();
    const now = new Date("2026-10-11T16:00:00.000Z");
    const created = await setReminder(store, actor, { what: "private", when: "tomorrow 9am", timezone: "UTC" }, now, caps);
    expect(await listReminders(store, other.id, { status: "all" }, now)).toHaveLength(0);
    await expect(completeOrCancel(store, other.id, created.id, "cancel", now)).rejects.toThrow(/not found/);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "qa", version: "0.0.0" });
    const server = createFillipServer(store, other, () => now, caps);
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const listed = await client.callTool({ name: "list_reminders", arguments: { status: "all" } });
    const text = JSON.stringify(listed);
    expect(text).not.toContain("private");
    expect(text).not.toContain(created.id);
    await client.close();
    await server.close();
    const userStore = new SupabaseFillipStore(other.id, async () => [], "user");
    await expect(userStore.getReminder(actor.id, created.id)).rejects.toThrow(/not found/);
  });
});
