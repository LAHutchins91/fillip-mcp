import http, { type IncomingMessage, type Server } from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CODE_LOCKED, CODE_SENT, SIGNED_OUT_EVERYWHERE } from "../src/code-auth.js";
import { app } from "../src/server.js";

const saved = {
  APP_BASE_URL: process.env.APP_BASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
};

const accessToken = "user-access-token";
const refreshToken = "refresh-token-secret";
const sessionToken = "access-token-secret";
const clientId = "11111111-1111-4111-8111-111111111111";

type AttemptRow = {
  subject_kind: string;
  subject_hash: string;
  wrong_count: number;
  send_count: number;
  verify_count: number;
  window_started_at: string;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function request(base: string, method: string, pathname: string, body: string, headers: Record<string, string> = {}) {
  const url = new URL(pathname, base);
  return new Promise<{ status: number; text: string; cache: string | null }>((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...headers, "content-length": Buffer.byteLength(body) }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        text: Buffer.concat(chunks).toString("utf8"),
        cache: res.headers["cache-control"] ?? null
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("server-side emailed codes and sign-out everywhere", () => {
  let stub: Server;
  let fillip: Server;
  let fillipBase = "";
  const attempts: AttemptRow[] = [];
  const otpCalls: Array<{ email?: string; create_user?: boolean; redirect_to?: string }> = [];
  const verifyCalls: Array<{ email?: string; token?: string; type?: string }> = [];
  const logouts: string[] = [];
  const revoked: string[] = [];
  const attemptBodies: string[] = [];
  let grants: Array<{ client: { id: string; name: string } }> = [];

  beforeAll(async () => {
    stub = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      const body = await readBody(req);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && url.startsWith("/auth/v1/otp")) {
        const parsed = JSON.parse(body) as { email?: string; create_user?: boolean; redirect_to?: string };
        otpCalls.push(parsed);
        if (parsed.email === "limited@example.com") return send(429, { msg: "over_request_rate_limit" });
        if (parsed.email === "missing@example.com") return send(422, { error_code: "otp_disabled", msg: "Signups not allowed for otp" });
        return send(200, {});
      }
      if (req.method === "POST" && url.startsWith("/auth/v1/verify")) {
        const parsed = JSON.parse(body) as { email?: string; token?: string; type?: string };
        verifyCalls.push(parsed);
        if (parsed.token !== "123456") return send(400, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
        return send(200, { access_token: sessionToken, refresh_token: refreshToken, user: { id: "user-1", email: parsed.email } });
      }
      if (url.startsWith("/auth/v1/user/oauth/grants")) {
        if (req.method === "DELETE") {
          const id = new URL(url, "http://stub.local").searchParams.get("client_id") ?? "";
          revoked.push(id);
          grants = grants.filter((grant) => grant.client.id !== id);
          res.writeHead(204);
          res.end();
          return;
        }
        return send(200, grants);
      }
      if (req.method === "POST" && url.startsWith("/auth/v1/logout")) {
        logouts.push(url);
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.startsWith("/auth/v1/user")) {
        const header = req.headers.authorization ?? "";
        if (header !== `Bearer ${accessToken}`) return send(401, { message: "bad" });
        return send(200, { id: "user-1", email: "owner@example.com" });
      }
      if (url.startsWith("/rest/v1/fillip_code_attempts")) {
        const query = new URL(url, "http://stub.local");
        if (req.method === "GET") {
          const kind = (query.searchParams.get("subject_kind") ?? "").replace(/^eq\./, "");
          const hash = decodeURIComponent((query.searchParams.get("subject_hash") ?? "").replace(/^eq\./, ""));
          return send(200, attempts.filter((row) => row.subject_kind === kind && row.subject_hash === hash));
        }
        attemptBodies.push(body);
        const row = JSON.parse(body) as AttemptRow;
        const index = attempts.findIndex((item) => item.subject_kind === row.subject_kind && item.subject_hash === row.subject_hash);
        if (index >= 0) attempts[index] = row;
        else attempts.push(row);
        res.writeHead(201);
        res.end();
        return;
      }
      send(200, []);
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
    const stubAddress = stub.address();
    if (!stubAddress || typeof stubAddress === "string") throw new Error("No stub port");
    process.env.APP_BASE_URL = "https://fillip.example";
    process.env.SUPABASE_URL = `http://127.0.0.1:${stubAddress.port}`;
    process.env.SUPABASE_ANON_KEY = "anon-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
    await new Promise<void>((resolve) => {
      fillip = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fillip.address();
    if (!address || typeof address === "string") throw new Error("No app port");
    fillipBase = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    attempts.length = 0;
    otpCalls.length = 0;
    verifyCalls.length = 0;
    logouts.length = 0;
    revoked.length = 0;
    attemptBodies.length = 0;
    grants = [{ client: { id: clientId, name: "Claude" } }];
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => fillip.close((error) => (error ? reject(error) : resolve())));
  });

  function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
    return request(fillipBase, "POST", pathname, JSON.stringify(body), {
      "content-type": "application/json",
      "x-fillip-request": "1",
      ...headers
    });
  }

  it("returns the same send response whether or not the account exists", async () => {
    const firstStarted = Date.now();
    const existing = await post("/auth/code/send", { email: "owner@example.com" });
    const firstElapsed = Date.now() - firstStarted;
    const secondStarted = Date.now();
    const missing = await post("/auth/code/send", { email: "missing@example.com" });
    const secondElapsed = Date.now() - secondStarted;
    expect(existing.status).toBe(200);
    expect(missing.status).toBe(existing.status);
    expect(existing.text).toBe(JSON.stringify({ ok: true, message: CODE_SENT }));
    expect(missing.text).toBe(existing.text);
    expect(existing.text).not.toMatch(/otp_disabled|not found|registered|missing@example.com|owner@example.com/i);
    expect(otpCalls.map((call) => call.email)).toEqual(["owner@example.com", "missing@example.com"]);
    for (const call of otpCalls) {
      expect(call.create_user).toBe(true);
      expect(call.redirect_to).toBeUndefined();
      expect(JSON.stringify(call)).not.toMatch(/emailRedirectTo|redirect_to/);
    }
    expect(firstElapsed).toBeGreaterThanOrEqual(450);
    expect(secondElapsed).toBeGreaterThanOrEqual(450);
    expect(Math.abs(firstElapsed - secondElapsed)).toBeLessThan(400);
    for (const stored of attemptBodies) {
      expect(stored).not.toContain("owner@example.com");
      expect(stored).not.toContain("missing@example.com");
      expect(stored).not.toContain("127.0.0.1");
    }
  });

  it("locks an email after five wrong codes, resets on a new send, and keeps another email open", async () => {
    await post("/auth/code/send", { email: "owner@example.com" });
    for (let index = 0; index < 4; index += 1) {
      const wrong = await post("/auth/code/verify", { email: "owner@example.com", code: "000000" });
      expect(wrong.status).toBe(400);
      expect(wrong.text).toMatch(/expired/);
      expect(wrong.text).not.toContain(CODE_LOCKED);
    }
    const fifth = await post("/auth/code/verify", { email: "owner@example.com", code: "000000" });
    expect(fifth.status).toBe(429);
    expect(JSON.parse(fifth.text).message).toBe(CODE_LOCKED);
    expect(verifyCalls).toHaveLength(5);
    const blocked = await post("/auth/code/verify", { email: "owner@example.com", code: "123456" });
    expect(blocked.status).toBe(429);
    expect(JSON.parse(blocked.text).message).toBe(CODE_LOCKED);
    expect(blocked.text).not.toContain(sessionToken);
    expect(verifyCalls).toHaveLength(5);
    const other = await post("/auth/code/verify", { email: "other@example.com", code: "123456" });
    expect(other.status).toBe(200);
    expect(JSON.parse(other.text)).toEqual({ ok: true, access_token: sessionToken, refresh_token: refreshToken });
    expect(verifyCalls).toHaveLength(6);
    const again = await post("/auth/code/send", { email: "owner@example.com" });
    expect(JSON.parse(again.text).message).toBe(CODE_SENT);
    const logs: string[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) {
      console[method] = (...args: unknown[]) => {
        logs.push(args.map((item) => String(item)).join(" "));
      };
    }
    try {
      const unlocked = await post("/auth/code/verify", { email: "owner@example.com", code: "123456" });
      expect(unlocked.status).toBe(200);
      expect(unlocked.cache).toContain("no-store");
      expect(JSON.parse(unlocked.text)).toEqual({ ok: true, access_token: sessionToken, refresh_token: refreshToken });
      expect(unlocked.text).not.toContain("owner@example.com");
    } finally {
      methods.forEach((method, index) => {
        console[method] = originals[index];
      });
    }
    expect(logs.join("\n")).not.toContain(sessionToken);
    expect(logs.join("\n")).not.toContain(refreshToken);
    expect(verifyCalls.at(-1)).toEqual({ email: "owner@example.com", token: "123456", type: "email" });
    for (const stored of attemptBodies) {
      expect(stored).not.toContain("owner@example.com");
      expect(stored).not.toContain("000000");
      expect(stored).not.toContain("123456");
    }
  });

  it("throttles code sends from one IP without saying whether the email exists", async () => {
    for (let index = 0; index < 5; index += 1) {
      const sent = await post("/auth/code/send", { email: `person${index}@example.com` });
      expect(sent.status).toBe(200);
      expect(JSON.parse(sent.text).message).toBe(CODE_SENT);
    }
    expect(otpCalls).toHaveLength(5);
    const blocked = await post("/auth/code/send", { email: "person5@example.com" });
    expect(blocked.status).toBe(429);
    expect(JSON.parse(blocked.text).message).toMatch(/Wait a minute/);
    expect(blocked.text).not.toContain("person5@example.com");
    expect(otpCalls).toHaveLength(5);
  });

  it("stops verify calls from one IP after the network limit", async () => {
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: `net${index}@example.com`, code: "000000" });
      expect(wrong.status).toBe(400);
    }
    expect(verifyCalls).toHaveLength(10);
    const blocked = await post("/auth/code/verify", { email: "fresh@example.com", code: "123456" });
    expect(blocked.status).toBe(429);
    expect(JSON.parse(blocked.text).message).toBe(CODE_LOCKED);
    expect(verifyCalls).toHaveLength(10);
  });

  it("signs out every grant and every session from a CSRF-safe signed-in POST", async () => {
    const data = await request(fillipBase, "GET", "/data", "");
    const connections = await request(fillipBase, "GET", "/connections", "");
    expect(data.text).toContain("Sign out everywhere");
    expect(data.text).toContain("/auth/sign-out-everywhere");
    expect(data.text).toContain("X-Fillip-Request");
    expect(connections.text).toContain("Sign out everywhere");
    expect(connections.text).toContain("/auth/sign-out-everywhere");
    const missing = await post("/auth/sign-out-everywhere", {});
    expect(missing.status).toBe(401);
    const forged = await request(fillipBase, "POST", "/auth/sign-out-everywhere", "{}", {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`
    });
    expect(forged.status).toBe(403);
    expect(logouts).toEqual([]);
    expect(revoked).toEqual([]);
    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
    };
    try {
      const done = await post("/auth/sign-out-everywhere", {}, { authorization: `Bearer ${accessToken}` });
      expect(done.status).toBe(200);
      expect(JSON.parse(done.text)).toEqual({ ok: true, message: SIGNED_OUT_EVERYWHERE });
      expect(done.text).not.toContain(accessToken);
    } finally {
      console.log = original;
    }
    expect(logs.join("\n")).not.toContain(accessToken);
    expect(logouts).toEqual(["/auth/v1/logout?scope=global"]);
    expect(revoked).toEqual([clientId]);
    expect(grants).toEqual([]);
  });
});
