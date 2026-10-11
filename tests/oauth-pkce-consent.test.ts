/**
 * Authorize records S256 in a cookie the consent page can read.
 * Supabase details often omit PKCE, and an empty pair must not deny consent.
 * A code Supabase already returned is single-use: Connect follows redirect_url
 * once and does not call approveAuthorization again.
 */
import http, { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/server.js";

const userId = "22222222-2222-4222-8222-222222222222";
const saved = {
  APP_BASE_URL: process.env.APP_BASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  FILLIP_UNSUBSCRIBE_SECRET: process.env.FILLIP_UNSUBSCRIBE_SECRET
};

function jwt(claims: Record<string, unknown>) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${header}.${body}.sig`;
}

function request(base: string, method: string, pathname: string, headers: Record<string, string> = {}, body = "") {
  const url = new URL(pathname, base);
  return new Promise<{ status: number; text: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
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
        headers: res.headers
      }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

describe("PKCE proof through the first authenticated MCP call", () => {
  let stub: Server;
  let fillip: Server;
  let stubBase = "";
  let fillipBase = "";
  let accessToken = "";

  beforeAll(async () => {
    stub = http.createServer((_req, res) => {
      const url = _req.url ?? "";
      if (url.startsWith("/auth/v1/user")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: userId, email: "owner@example.com", email_confirmed_at: "2026-10-01T00:00:00.000Z" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", () => resolve()));
    const stubAddress = stub.address();
    if (!stubAddress || typeof stubAddress === "string") throw new Error("No stub port");
    stubBase = `http://127.0.0.1:${stubAddress.port}`;
    process.env.APP_BASE_URL = "https://fillip.example";
    process.env.SUPABASE_URL = stubBase;
    process.env.SUPABASE_ANON_KEY = "anon-test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-test";
    process.env.FILLIP_UNSUBSCRIBE_SECRET = "pkce-secret";
    const exp = Math.floor(Date.now() / 1000) + 3600;
    accessToken = jwt({
      sub: userId,
      iss: `${stubBase}/auth/v1`,
      aud: ["authenticated", "https://fillip.example/mcp"],
      role: "authenticated",
      exp,
      client_id: "11111111-1111-4111-8111-111111111111",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      scope: "email"
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

  it("records S256, shows consent when details omit PKCE, and accepts the issued token", async () => {
    const authorize = await request(
      fillipBase,
      "GET",
      `/oauth/authorize?redirect_uri=${encodeURIComponent("https://client.example/cb")}&code_challenge_method=S256&code_challenge=abc&state=xyz`
    );
    expect(authorize.status).toBeGreaterThanOrEqual(300);
    expect(authorize.status).toBeLessThan(400);
    expect(authorize.headers.location).toContain(`${stubBase}/auth/v1/oauth/authorize`);
    const setCookie = String(authorize.headers["set-cookie"] ?? "");
    expect(setCookie).toContain("fillip_pkce=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Path=/oauth");
    expect(setCookie).not.toContain("Secure");
    const cookie = setCookie.split(";")[0] ?? "";
    const proof = await request(fillipBase, "GET", "/oauth/pkce-proof", { cookie });
    expect(proof.status).toBe(200);
    expect(JSON.parse(proof.text)).toEqual({ method: "S256", challenge: "abc" });

    const consent = await request(fillipBase, "GET", "/oauth/consent?authorization_id=auth-1");
    const html = consent.text;
    const shown = html.indexOf("el('consent').hidden=false");
    const redirect = html.indexOf("details.data.redirect_url");
    expect(shown).toBeGreaterThan(-1);
    expect(redirect).toBeGreaterThan(shown);
    expect(html).toContain("(method||challenge)?rejectPkce(method,challenge):null");
    expect(html).toContain("if(approved&&details.data.redirect_url){location.assign(details.data.redirect_url);return}");
    expect(html).not.toContain("if(details.data.redirect_url){location.assign(details.data.redirect_url);return}");

    const initialize = await request(fillipBase, "POST", "/mcp", {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`
    }, JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "claude", version: "1" } }
    }));
    expect(initialize.status).toBe(200);
  });
});
