import http, { type Server } from "node:http";
import vm from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { otpFailure } from "../src/plugin-auth.js";
import { app } from "../src/server.js";

const userId = "22222222-2222-4222-8222-222222222222";
const saved = {
  APP_BASE_URL: process.env.APP_BASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
};

function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.sig`;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function request(base: string, method: string, pathname: string, body: string, headers: Record<string, string> = {}) {
  const url = new URL(pathname, base);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...headers, "content-length": Buffer.byteLength(body) }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("emailed code through to the first tool call", () => {
  let stub: Server;
  let fillip: Server;
  let stubBase = "";
  let fillipBase = "";
  let accessToken = "";
  const reminders: unknown[] = [];

  beforeAll(async () => {
    stub = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      const body = await readBody(req);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && url.startsWith("/auth/v1/otp")) return send(200, {});
      if (req.method === "POST" && url.startsWith("/auth/v1/verify")) {
        const parsed = JSON.parse(body) as { token?: string };
        if (parsed.token !== "123456") return send(400, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
        return send(200, { access_token: accessToken, user: { id: userId, email: "owner@example.com" } });
      }
      if (url.startsWith("/auth/v1/user")) {
        return send(200, { id: userId, email: "owner@example.com", email_confirmed_at: "2026-10-01T00:00:00.000Z" });
      }
      if (req.method === "POST" && url.startsWith("/rest/v1/reminders")) {
        const row = JSON.parse(body) as unknown;
        reminders.push(row);
        return send(200, [row]);
      }
      if (req.method === "GET" && url.startsWith("/rest/v1/reminders")) return send(200, reminders);
      if (url.startsWith("/rest/v1/profiles")) {
        return send(200, [{ id: userId, plan: "free", subscription_status: "none", emails_sent_in_period: 0, unsubscribed: false }]);
      }
      send(200, []);
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
    const stubAddress = stub.address();
    if (!stubAddress || typeof stubAddress === "string") throw new Error("No stub port");
    stubBase = `http://127.0.0.1:${stubAddress.port}`;
    process.env.APP_BASE_URL = "https://fillip.example";
    process.env.SUPABASE_URL = stubBase;
    process.env.SUPABASE_ANON_KEY = "anon-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    accessToken = jwt({
      sub: userId,
      iss: `${stubBase}/auth/v1`,
      aud: ["authenticated", "https://fillip.example/mcp"],
      role: "authenticated",
      exp,
      client_id: "11111111-1111-4111-8111-111111111111",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      scope: "email offline_access"
    });
    await new Promise<void>((resolve) => {
      fillip = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = fillip.address();
    if (!address || typeof address === "string") throw new Error("No app port");
    fillipBase = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => fillip.close((error) => (error ? reject(error) : resolve())));
  });

  it("maps a wrong, expired, or rate-limited code to a plain sentence", () => {
    expect(otpFailure("Token has expired or is invalid")).toMatch(/expired/);
    expect(otpFailure("otp_expired")).toMatch(/expired/);
    expect(otpFailure("Invalid login credentials")).toMatch(/not right/);
    expect(otpFailure("For security purposes, you can only request this after 60 seconds")).toMatch(/Wait a minute/);
    expect(otpFailure("over_request_rate_limit")).toMatch(/Wait a minute/);
  });

  it("accepts a freshly issued code token and a refreshed token on the first tools/call", async () => {
    const started = await request(stubBase, "POST", "/auth/v1/otp", JSON.stringify({ email: "owner@example.com" }));
    expect(started.status).toBe(200);
    const wrong = await request(stubBase, "POST", "/auth/v1/verify", JSON.stringify({ email: "owner@example.com", token: "000000", type: "email" }));
    expect(wrong.status).toBe(400);
    expect(otpFailure(JSON.parse(wrong.text).msg as string)).toMatch(/expired/);
    const verified = await request(stubBase, "POST", "/auth/v1/verify", JSON.stringify({ email: "owner@example.com", token: "123456", type: "email" }));
    expect(verified.status).toBe(200);
    const fresh = JSON.parse(verified.text).access_token as string;
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${fresh}`
    };
    const initialize = await request(fillipBase, "POST", "/mcp", JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude", version: "1" } }
    }), headers);
    expect(initialize.status).toBe(200);
    const call = await request(fillipBase, "POST", "/mcp", JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "set_reminder", arguments: { what: "Ship the notes", when: "tomorrow 9am", timezone: "UTC" } }
    }), headers);
    expect(call.status).toBe(200);
    expect(call.text).toContain("Ship the notes");
    expect(call.text).not.toMatch(/Reconnect|Sign in to Fillip/);

    const refreshed = jwt({
      sub: userId,
      iss: `${stubBase}/auth/v1`,
      aud: ["authenticated", "https://fillip.example/mcp"],
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 7200,
      client_id: "11111111-1111-4111-8111-111111111111",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      scope: "email offline_access"
    });
    const again = await request(fillipBase, "POST", "/mcp", JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "list_reminders", arguments: {} }
    }), { ...headers, authorization: `Bearer ${refreshed}` });
    expect(again.status).toBe(200);
    expect(again.text).toContain("Ship the notes");
    expect(again.text).not.toMatch(/Reconnect|Sign in to Fillip/);
  });

  it("sends a code with signInWithOtp and verifies it with type email", async () => {
    const consent = await request(fillipBase, "GET", "/oauth/consent", "");
    expect(consent.status).toBe(200);
    expect(consent.text).toContain('id="loginCode"');
    expect(consent.text).not.toContain("emailRedirectTo");
    const started = consent.text.lastIndexOf("<script>");
    const ended = consent.text.lastIndexOf("</script>");
    const source = consent.text.slice(started + "<script>".length, ended);
    const otpCalls: unknown[] = [];
    const verifyCalls: unknown[] = [];
    const elements = new Map<string, {
      hidden: boolean;
      textContent: string;
      value: string;
      disabled: boolean;
      onsubmit: ((event: { preventDefault: () => void }) => Promise<void>) | null;
      onclick: (() => void) | null;
      querySelector: () => { disabled: boolean };
    }>();
    const element = (id: string) => {
      let node = elements.get(id);
      if (!node) {
        node = {
          hidden: true,
          textContent: "",
          value: "",
          disabled: false,
          onsubmit: null,
          onclick: null,
          querySelector: () => ({ disabled: false })
        };
        elements.set(id, node);
      }
      return node;
    };
    const sandbox = {
      Error,
      Promise,
      JSON,
      window: {
        supabase: {
          createClient() {
            return {
              auth: {
                async getSession() {
                  return { data: { session: null }, error: null };
                },
                async signInWithOtp(args: unknown) {
                  otpCalls.push(args);
                  return { error: null };
                },
                async verifyOtp(args: unknown) {
                  verifyCalls.push(args);
                  return { error: null };
                },
                async signInWithPassword() {
                  return { error: null };
                }
              }
            };
          }
        }
      },
      document: {
        getElementById: (id: string) => id === "signin" ? null : element(id),
        createElement: () => element("created")
      },
      location: {
        search: "",
        pathname: "/oauth/consent",
        origin: "https://fillip.example",
        assign() {
          return undefined;
        },
        reload() {
          return undefined;
        }
      },
      URLSearchParams,
      Date,
      setTimeout,
      fetch: async () => ({ json: async () => ({}) }),
      sessionStorage: {
        setItem() {
          return undefined;
        },
        getItem() {
          return null;
        }
      }
    };
    await vm.runInContext(source, vm.createContext(sandbox));
    const email = element("loginEmail");
    const code = element("loginCode");
    email.value = "owner@example.com";
    const emailForm = element("emailForm");
    expect(emailForm.hidden).toBe(false);
    await emailForm.onsubmit?.({ preventDefault() { return undefined; } });
    expect(otpCalls).toEqual([{ email: "owner@example.com", options: { shouldCreateUser: true } }]);
    expect(JSON.stringify(otpCalls[0])).not.toContain("emailRedirectTo");
    expect(element("codeForm").hidden).toBe(false);
    expect(element("status").textContent).toBe("If that email can sign in, a code is on its way.");
    expect(element("error").textContent).toBe("");
    code.value = "123456";
    await element("codeForm").onsubmit?.({ preventDefault() { return undefined; } });
    expect(verifyCalls).toEqual([{ email: "owner@example.com", token: "123456", type: "email" }]);
  });

  it("uses the same code-sent reply when the account is new and when Supabase reports otp_disabled", async () => {
    const consent = await request(fillipBase, "GET", "/oauth/consent", "");
    const started = consent.text.lastIndexOf("<script>");
    const ended = consent.text.lastIndexOf("</script>");
    const source = consent.text.slice(started + "<script>".length, ended);
    const replies: string[] = [];
    const elapsed: number[] = [];
    for (const outcome of ["ok", "otp_disabled"] as const) {
      const elements = new Map<string, { hidden: boolean; textContent: string; value: string; disabled: boolean; onsubmit: ((event: { preventDefault: () => void }) => Promise<void>) | null; querySelector: () => { disabled: boolean } }>();
      const element = (id: string) => {
        let node = elements.get(id);
        if (!node) {
          node = { hidden: true, textContent: "", value: "", disabled: false, onsubmit: null, querySelector: () => ({ disabled: false }) };
          elements.set(id, node);
        }
        return node;
      };
      const sandbox = {
        Error,
        Promise,
        JSON,
        Date,
        setTimeout,
        window: {
          supabase: {
            createClient() {
              return {
                auth: {
                  async getSession() {
                    return { data: { session: null }, error: null };
                  },
                  async signInWithOtp() {
                    if (outcome === "otp_disabled") return { error: { message: "otp_disabled" } };
                    return { error: null };
                  },
                  async verifyOtp() {
                    return { error: null };
                  },
                  async signInWithPassword() {
                    return { error: null };
                  }
                }
              };
            }
          }
        },
        document: { getElementById: (id: string) => element(id), createElement: () => element("created") },
        location: { search: "", pathname: "/oauth/consent", origin: "https://fillip.example", assign() { return undefined; }, reload() { return undefined; } },
        URLSearchParams,
        fetch: async () => ({ json: async () => ({}) }),
        sessionStorage: { setItem() { return undefined; }, getItem() { return null; } }
      };
      await vm.runInContext(source, vm.createContext(sandbox));
      element("loginEmail").value = outcome === "ok" ? "new@example.com" : "owner@example.com";
      const before = Date.now();
      await element("emailForm").onsubmit?.({ preventDefault() { return undefined; } });
      elapsed.push(Date.now() - before);
      replies.push(`${element("status").textContent}|${element("error").textContent}|${element("codeForm").hidden}`);
    }
    expect(replies[0]).toBe("If that email can sign in, a code is on its way.||false");
    expect(replies[1]).toBe(replies[0]);
    expect(elapsed[0]).toBeGreaterThanOrEqual(450);
    expect(elapsed[1]).toBeGreaterThanOrEqual(450);
    expect(Math.abs(elapsed[0] - elapsed[1])).toBeLessThan(400);
  });
});
