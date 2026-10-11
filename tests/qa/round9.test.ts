/**
 * QA round 9 against 02e7373.
 * Postgres 16 is exercised by the existing suite. These cases cover the three fixes.
 * QA-FAIL tests assert a promised control and fail on this build.
 */
import http, { type IncomingMessage, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CODE_LOCKED, CODE_SENT, codeSubjectHash, lockoutAddressKey, lockoutSecretProblem } from "../../src/code-auth.js";
import { app } from "../../src/server.js";
import { pkceRejection } from "../../src/plugin-auth.js";

const saved = {
  VERCEL: process.env.VERCEL,
  NODE_ENV: process.env.NODE_ENV,
  VERCEL_ENV: process.env.VERCEL_ENV,
  FILLIP_LOCKOUT_SECRET: process.env.FILLIP_LOCKOUT_SECRET,
  FILLIP_UNSUBSCRIBE_SECRET: process.env.FILLIP_UNSUBSCRIBE_SECRET,
  CRON_SECRET: process.env.CRON_SECRET,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
};

function restoreEnv() {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function header(map: Record<string, string>) {
  return (name: string) => map[name.toLowerCase()];
}

describe("QA round 9 address key and lockout secret", () => {
  afterAll(() => restoreEnv());

  it("QA-PASS: VERCEL uses only x-vercel-forwarded-for, and every other mode uses the socket", () => {
    const previous = process.env.VERCEL;
    try {
      process.env.VERCEL = "1";
      const platform = header({
        "x-vercel-forwarded-for": "198.51.100.8:443, 203.0.113.50",
        "x-real-ip": "198.51.100.9",
        "x-forwarded-for": "203.0.113.99"
      });
      expect(lockoutAddressKey(platform, "127.0.0.1")).toBe("198.51.100.8");
      expect(lockoutAddressKey(header({
        "x-vercel-forwarded-for": "198.51.100.8, 203.0.113.77",
        "x-real-ip": "203.0.113.1",
        "x-forwarded-for": "198.51.100.50"
      }), "10.0.0.4")).toBe("198.51.100.8");
      expect(lockoutAddressKey(header({
        "x-real-ip": "198.51.100.77",
        "x-forwarded-for": "203.0.113.10"
      }), "127.0.0.1")).toBe("127.0.0.1");
      const v6 = lockoutAddressKey(header({
        "x-vercel-forwarded-for": "2001:db8:9:8::abcd",
        "x-real-ip": "203.0.113.10"
      }), "127.0.0.1");
      expect(lockoutAddressKey(header({
        "x-vercel-forwarded-for": "2001:db8:9:8:ffff::1%eth0"
      }), "10.1.1.1")).toBe(v6);
      expect(lockoutAddressKey(header({
        "x-vercel-forwarded-for": "::ffff:203.0.113.10",
        "x-forwarded-for": "198.51.100.1"
      }), "127.0.0.1")).toBe("203.0.113.10");

      for (const off of [undefined, ""]) {
        if (off === undefined) delete process.env.VERCEL;
        else process.env.VERCEL = off;
        expect(lockoutAddressKey(header({
          "x-vercel-forwarded-for": "198.51.100.8",
          "x-real-ip": "198.51.100.9",
          "x-forwarded-for": "203.0.113.99, 10.0.0.1"
        }), "127.0.0.1")).toBe("127.0.0.1");
        expect(lockoutAddressKey(() => undefined, "2001:db8:1:2::1")).toBe(
          lockoutAddressKey(header({ "x-vercel-forwarded-for": "2001:db8:1:3::1" }), "2001:db8:1:2:ffff::9")
        );
      }
    } finally {
      if (previous === undefined) delete process.env.VERCEL;
      else process.env.VERCEL = previous;
    }
  });

  it("QA-PASS: production rejects a missing or short lockout secret and does not fall back", () => {
    const source = readFileSync("src/code-auth.ts", "utf8");
    expect(source).not.toContain("fillip-pkce");
    expect(source).not.toMatch(/header\(["']x-real-ip["']\)/);
    expect(source).not.toMatch(/header\(["']x-forwarded-for["']\)/);
    expect(source).not.toContain("resetIpVerify");
    expect(source).not.toContain("fillip_reset_ip_verify");
    expect(source).not.toMatch(/FILLIP_UNSUBSCRIBE_SECRET \|\|/);
    expect(source).not.toMatch(/CRON_SECRET \|\|/);
    expect(source).not.toMatch(/SUPABASE_ANON_KEY \|\| process\.env/);

    process.env.FILLIP_UNSUBSCRIBE_SECRET = "unsubscribe-secret-not-a-lockout-key";
    process.env.CRON_SECRET = "cron-secret-not-a-lockout-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-not-a-lockout-key";
    process.env.SUPABASE_ANON_KEY = "anon-key-not-a-lockout-key";

    const cases: Array<{ node: string; vercelEnv: string; secret: string; ok: boolean }> = [
      { node: "production", vercelEnv: "", secret: "", ok: false },
      { node: "production", vercelEnv: "", secret: "x".repeat(31), ok: false },
      { node: "production", vercelEnv: "", secret: `${" ".repeat(4)}${"x".repeat(31)}`, ok: false },
      { node: "production", vercelEnv: "", secret: " ".repeat(40), ok: false },
      { node: "development", vercelEnv: "production", secret: "", ok: false },
      { node: "development", vercelEnv: "production", secret: "y".repeat(31), ok: false },
      { node: "production", vercelEnv: "production", secret: "z".repeat(32), ok: true },
      { node: "production", vercelEnv: "", secret: `  ${"z".repeat(32)}\n`, ok: true },
      { node: "development", vercelEnv: "preview", secret: "", ok: true },
      { node: "test", vercelEnv: "", secret: "", ok: true }
    ];
    try {
      for (const item of cases) {
        process.env.NODE_ENV = item.node;
        process.env.VERCEL_ENV = item.vercelEnv;
        process.env.FILLIP_LOCKOUT_SECRET = item.secret;
        const problem = lockoutSecretProblem();
        if (item.ok) {
          expect(problem, JSON.stringify(item)).toBeNull();
        } else {
          expect(problem, JSON.stringify(item)).toMatch(/FILLIP_LOCKOUT_SECRET/);
          if (item.secret.trim()) expect(problem ?? "").not.toContain(item.secret.trim());
          expect(() => codeSubjectHash("ip", "203.0.113.10")).toThrow(/FILLIP_LOCKOUT_SECRET/);
        }
      }
      process.env.NODE_ENV = "production";
      process.env.VERCEL_ENV = "";
      process.env.FILLIP_LOCKOUT_SECRET = "";
      try {
        codeSubjectHash("email", "owner@example.com");
        throw new Error("hash used a fallback");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toMatch(/FILLIP_LOCKOUT_SECRET/);
        expect(message).not.toContain("anon-key-not-a-lockout-key");
        expect(message).not.toContain("unsubscribe-secret-not-a-lockout-key");
      }
    } finally {
      restoreEnv();
    }
  });
});

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function httpCall(base: string, method: string, pathname: string, body: string, headers: Record<string, string> = {}) {
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

describe("QA round 9 emailed-code address and send over HTTP", () => {
  let stub: Server;
  let fillip: Server;
  let base = "";
  const attempts: Array<Record<string, string | number>> = [];
  const verifyCalls: string[] = [];
  const resetCalls: string[] = [];
  const httpEnv = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    VERCEL: process.env.VERCEL
  };

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
        verifyCalls.push(parsed.token ?? "");
        if (parsed.token !== "123456") return send(400, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
        return send(200, { access_token: "issued-access", refresh_token: "issued-refresh" });
      }
      if (url.startsWith("/rest/v1/rpc/fillip_bump_code_counter")) {
        const parsed = JSON.parse(body) as { p_kind: string; p_hash: string; p_field: "wrong" | "send" | "verify" };
        let row = attempts.find((item) => item.subject_kind === parsed.p_kind && item.subject_hash === parsed.p_hash);
        if (!row) {
          row = { subject_kind: parsed.p_kind, subject_hash: parsed.p_hash, wrong_count: 0, send_count: 0, verify_count: 0 };
          attempts.push(row);
        }
        const field = parsed.p_field === "wrong" ? "wrong_count" : parsed.p_field === "send" ? "send_count" : "verify_count";
        row[field] = Number(row[field] ?? 0) + 1;
        return send(200, row[field]);
      }
      if (url.startsWith("/rest/v1/rpc/fillip_reset_ip_verify")) {
        resetCalls.push(body);
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.startsWith("/rest/v1/rpc/fillip_clear_email_wrong")) {
        const parsed = JSON.parse(body) as { p_hash: string };
        const row = attempts.find((item) => item.subject_kind === "email" && item.subject_hash === parsed.p_hash);
        if (row) row.wrong_count = 0;
        res.writeHead(204);
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
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => fillip.close((error) => (error ? reject(error) : resolve())));
    await new Promise<void>((resolve, reject) => stub.close((error) => (error ? reject(error) : resolve())));
    for (const [key, value] of Object.entries(httpEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    attempts.length = 0;
    verifyCalls.length = 0;
    resetCalls.length = 0;
    delete process.env.VERCEL;
  });

  function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
    return httpCall(base, "POST", pathname, JSON.stringify(body), {
      "content-type": "application/json",
      "x-fillip-request": "1",
      ...headers
    });
  }

  it("QA-PASS: with VERCEL set, only the platform header keys the IP, and a send leaves the verify cap", async () => {
    process.env.VERCEL = "1";
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: `v-${index}@example.com`, code: "000000" }, {
        "x-vercel-forwarded-for": "198.51.100.8, 10.0.0.1",
        "x-real-ip": `203.0.113.${index}`,
        "x-forwarded-for": `198.51.100.${index}`
      });
      expect(wrong.status).toBe(400);
    }
    const same = await post("/auth/code/verify", { email: "v-same@example.com", code: "000000" }, {
      "x-vercel-forwarded-for": "198.51.100.8, 203.0.113.200",
      "X-Real-IP": "198.51.100.77",
      "x-forwarded-for": "203.0.113.99"
    });
    expect(same.status).toBe(429);
    expect(JSON.parse(same.text).message).toBe(CODE_LOCKED);
    const otherHop = await post("/auth/code/verify", { email: "v-hop@example.com", code: "000000" }, {
      "x-vercel-forwarded-for": "203.0.113.50, 198.51.100.8",
      "x-real-ip": "198.51.100.8"
    });
    expect(otherHop.status).toBe(400);
    const calls = verifyCalls.length;
    const sent = await post("/auth/code/send", { email: "attacker-owned@example.com" }, {
      "x-vercel-forwarded-for": "198.51.100.8"
    });
    expect(JSON.parse(sent.text).message).toBe(CODE_SENT);
    expect(resetCalls).toEqual([]);
    const after = await post("/auth/code/verify", { email: "v-after@example.com", code: "123456" }, {
      "x-vercel-forwarded-for": "198.51.100.8",
      "x-real-ip": "203.0.113.10",
      "x-forwarded-for": "198.51.100.9"
    });
    expect(after.status).toBe(429);
    expect(after.text).not.toContain("issued-access");
    expect(verifyCalls).toHaveLength(calls);
  }, 20_000);

  it("QA-PASS: without VERCEL the socket is the key and a send does not clear it", async () => {
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: `s-${index}@example.com`, code: "000000" }, {
        "x-forwarded-for": `203.0.113.${index}`,
        "x-real-ip": "198.51.100.20",
        "x-vercel-forwarded-for": "198.51.100.30"
      });
      expect(wrong.status).toBe(400);
    }
    const headers = [
      { "x-forwarded-for": "203.0.113.99, 10.0.0.1" },
      { "X-Real-IP": "198.51.100.77" },
      { "x-vercel-forwarded-for": "198.51.100.88" }
    ];
    for (const extra of headers) {
      const blocked = await post("/auth/code/verify", { email: `s-block-${Object.keys(extra)[0]}@example.com`, code: "000000" }, extra);
      expect(blocked.status).toBe(429);
    }
    const calls = verifyCalls.length;
    const sent = await post("/auth/code/send", { email: "attacker-owned@example.com" });
    expect(JSON.parse(sent.text).message).toBe(CODE_SENT);
    expect(resetCalls).toEqual([]);
    const after = await post("/auth/code/verify", { email: "s-after@example.com", code: "123456" }, {
      "x-real-ip": "203.0.113.10",
      "x-forwarded-for": "198.51.100.9",
      "x-vercel-forwarded-for": "198.51.100.8"
    });
    expect(after.status).toBe(429);
    expect(verifyCalls).toHaveLength(calls);
  }, 20_000);

  it("QA-PASS: with VERCEL set and no platform header, X-Real-IP and XFF still share the socket", async () => {
    process.env.VERCEL = "1";
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: `m-${index}@example.com`, code: "000000" }, {
        "x-real-ip": `203.0.113.${index}`,
        "x-forwarded-for": `198.51.100.${index}`
      });
      expect(wrong.status).toBe(400);
    }
    const blocked = await post("/auth/code/verify", { email: "m-block@example.com", code: "123456" }, {
      "X-Real-IP": "198.51.100.77",
      "x-forwarded-for": "203.0.113.99"
    });
    expect(blocked.status).toBe(429);
    expect(blocked.text).not.toContain("issued-access");
  });
});

const booted: ChildProcess[] = [];

function boot(overrides: Record<string, string>): Promise<{ code: number | null; output: string; listened: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: "/workspace",
      env: {
        ...process.env,
        PORT: "0",
        FILLIP_UNSUBSCRIBE_SECRET: "unsubscribe-secret-not-a-lockout-key",
        CRON_SECRET: "cron-secret-not-a-lockout-key",
        SUPABASE_ANON_KEY: "anon-key-not-a-lockout-key",
        SUPABASE_SERVICE_ROLE_KEY: "service-role-not-a-lockout-key",
        ...overrides
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    booted.push(child);
    let output = "";
    let listened = false;
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, listened });
    };
    const take = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Fillip listening")) {
        listened = true;
        child.kill("SIGTERM");
      }
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    child.on("exit", (code) => finish(code));
    child.on("error", (error) => {
      output += String(error);
      finish(1);
    });
  });
}

describe("QA round 9 production startup", () => {
  afterAll(() => {
    for (const child of booted) child.kill("SIGKILL");
  });

  it("QA-PASS: production startup refuses a missing or short secret and boots at 32 characters", async () => {
    const refused = [
      { NODE_ENV: "production", VERCEL_ENV: "", FILLIP_LOCKOUT_SECRET: "" },
      { NODE_ENV: "production", VERCEL_ENV: "", FILLIP_LOCKOUT_SECRET: "x".repeat(31) },
      { NODE_ENV: "development", VERCEL_ENV: "production", FILLIP_LOCKOUT_SECRET: "" },
      { NODE_ENV: "development", VERCEL_ENV: "production", FILLIP_LOCKOUT_SECRET: "y".repeat(31) }
    ];
    for (const env of refused) {
      const result = await boot(env);
      expect(result.listened, JSON.stringify(env)).toBe(false);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.output).toMatch(/FILLIP_LOCKOUT_SECRET/);
      expect(result.output).not.toContain("anon-key-not-a-lockout-key");
      if (env.FILLIP_LOCKOUT_SECRET) expect(result.output).not.toContain(env.FILLIP_LOCKOUT_SECRET);
    }
    const ready = await boot({
      NODE_ENV: "production",
      VERCEL_ENV: "production",
      FILLIP_LOCKOUT_SECRET: "z".repeat(32)
    });
    expect(ready.listened).toBe(true);
  }, 60_000);
});

describe("QA round 9 regression", () => {
  it("QA-PASS: prior failure assertions remain, plain PKCE is rejected, and copy has no prices", () => {
    const round7 = readFileSync("tests/qa/round7.test.ts", "utf8");
    const round8 = readFileSync("tests/qa/round8.test.ts", "utf8");
    expect(round7).toContain('it("QA-FAIL: two live S256 codes for one reconnect still receive the audience"');
    expect(round7).toContain('it("QA-FAIL: a failed re-read after a delete does not claim a removed row was saved"');
    expect(round7).toContain('it("QA-FAIL: five wrong codes stay locked after a new send and after a changed IP header"');
    expect(round7).toContain("a new code request cleared the five-wrong lock");
    expect(round8).toContain('it("QA-FAIL: a client X-Real-IP or x-vercel-forwarded-for cannot mint a new verify budget"');
    expect(round8).toContain('it("QA-FAIL: production startup refuses when FILLIP_LOCKOUT_SECRET is missing"');
    expect(round8).toContain("an allowed send leaves the IP verify count until its window expires");
    expect(round7).not.toMatch(/\bit\.skip\(|\bdescribe\.skip\(|\btest\.skip\(/);
    expect(round8).not.toMatch(/\bit\.skip\(|\bdescribe\.skip\(|\btest\.skip\(/);
    expect(pkceRejection("plain", "abc")?.error).toBe("invalid_request");
    expect(pkceRejection("S256", "abc")).toBeNull();
    const roots = ["README.md", "src", "public", "glama.json", "server.json", "supabase/README-oauth.md"];
    const offenders: string[] = [];
    const walk = (target: string) => {
      const info = statSync(target, { throwIfNoEntry: false });
      if (!info) return;
      if (!info.isDirectory()) {
        if (!/\.(md|ts|json|html)$/.test(target)) return;
        const text = readFileSync(target, "utf8");
        if (/\$\s*\d/.test(text) || /\bUSD\b/.test(text) || /\bdollars?\b/i.test(text)) offenders.push(`${target} price`);
        if (/\bSMS\b|Slack notification|push notification|WhatsApp|iMessage/i.test(text)) offenders.push(`${target} channel`);
        return;
      }
      for (const entry of readdirSync(target)) {
        if (entry === "node_modules" || entry === "dist") continue;
        walk(path.join(target, entry));
      }
    };
    for (const root of roots) walk(root);
    expect(offenders).toEqual([]);
  });
});
