import http, { type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/server.js";

let server: Server;
let base: string;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

function postMcp(accept: string | undefined, body: unknown) {
  const payload = JSON.stringify(body);
  const url = new URL(base);
  return new Promise<{ status: number; text: string; wwwAuthenticate?: string }>((resolve, reject) => {
    const requestHeaders: http.OutgoingHttpHeaders = {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload)
    };
    if (accept !== undefined) requestHeaders.accept = accept;
    const req = http.request(
      { hostname: url.hostname, port: url.port, path: "/mcp", method: "POST", headers: requestHeaders },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const wwwAuthenticate = res.headers["www-authenticate"];
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString("utf8"),
            wwwAuthenticate: typeof wwwAuthenticate === "string" ? wwwAuthenticate : undefined
          });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

describe("streamable HTTP", () => {
  it("returns Fillip tools from tools/list without a pasted token", async () => {
    const previous = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { tools?: Array<{ name: string; title?: string; description?: string; annotations?: { destructiveHint?: boolean }; inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }> } };
    const tools = body.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["set_reminder", "list_reminders", "snooze_or_reschedule", "complete_or_cancel", "remove_reminder", "restore_reminder", "follow_up", "digest_settings", "calendar_feed"]);
    expect(names).not.toContain("delivery_settings");
    const text = JSON.stringify(tools);
    expect(text).not.toMatch(/\$\d/);
    expect(text).toMatch(/verified/);
    const setReminder = tools.find((tool) => tool.name === "set_reminder");
    const properties = Object.keys(setReminder?.inputSchema?.properties ?? {});
    expect(properties).toEqual(expect.arrayContaining(["what", "when", "timezone"]));
    expect(properties).not.toEqual(expect.arrayContaining(["email", "to", "recipient"]));
    expect(properties).not.toContain("channel");
    const deleting = tools.find((tool) => tool.name === "remove_reminder") as { title?: string; description?: string; annotations?: { destructiveHint?: boolean; idempotentHint?: boolean } } | undefined;
    expect(deleting?.title).toBe("Remove reminder");
    expect(deleting?.description).toBe("Stops a reminder and removes it from the user's list. It can be restored for 30 days.");
    expect(deleting?.annotations?.destructiveHint).toBe(false);
    expect(deleting?.annotations?.idempotentHint).toBe(true);
    expect(deleting?.inputSchema?.required ?? []).not.toContain("confirm");
    expect(JSON.stringify(tools)).not.toMatch(/permanently|erases|cannot be undone/i);
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  });

  it("rejects a tool call that is not an OAuth sign-in", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_reminders", arguments: {} }
      })
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain("oauth-protected-resource");
    expect(challenge).not.toContain("invalid_token");
    const body = await response.json() as { error?: string };
    expect(body.error).toBe("Authentication required.");
  });

  it("marks a presented bad token as invalid_token and logs the MCP request without the token", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      const response = await fetch(`${base}/mcp`, {
        method: "POST",
        headers: { ...headers, authorization: "Bearer not-a-jwt" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "list_reminders", arguments: {} }
        })
      });
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
      const body = await response.json() as { error?: string };
      expect(body.error).toBe("Authentication required.");
    } finally {
      console.log = original;
    }
    const logged = lines.map((line) => {
      try {
        return JSON.parse(line) as { event?: string; tool?: string; status?: number; userId?: string | null };
      } catch {
        return null;
      }
    }).find((row) => row?.event === "mcp" && row.tool === "list_reminders");
    expect(logged?.status).toBe(401);
    expect(logged?.userId ?? null).toBeNull();
    expect(lines.join("\n")).not.toContain("not-a-jwt");
  });

  it("returns 401 invalid_token for tools/list when a bearer is present but invalid", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, authorization: "Bearer not-a-jwt" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    const body = await response.json() as { error?: string };
    expect(body.error).toBe("Authentication required.");
  });

  it("asks for sign-in on initialize and keeps tools/list public", async () => {
    const initialize = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "qa", version: "0" } } })
    });
    expect(initialize.status).toBe(401);
    expect(initialize.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(initialize.headers.get("www-authenticate")).toContain("oauth-protected-resource/mcp");
    const listed = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
    });
    expect(listed.status).toBe(200);
  });

  it("offers an emailed code first and hides Google unless the flag is set", async () => {
    delete process.env.FILLIP_AUTH_GOOGLE_ENABLED;
    const hidden = await fetch(`${base}/oauth/consent`);
    const hiddenHtml = await hidden.text();
    expect(hidden.status).toBe(200);
    expect(hiddenHtml).toContain("Email me a code");
    expect(hiddenHtml).toContain('id="loginCode"');
    expect(hiddenHtml).toContain('autocomplete="one-time-code"');
    expect(hiddenHtml).toContain("/auth/code/send");
    expect(hiddenHtml).toContain("/auth/code/verify");
    expect(hiddenHtml).toContain("setSession");
    expect(hiddenHtml).not.toContain("signInWithOtp");
    expect(hiddenHtml).not.toContain("verifyOtp");
    expect(hiddenHtml).not.toContain("emailRedirectTo");
    expect(hiddenHtml).toContain("Sign out everywhere");
    expect(hiddenHtml).toContain("Use a password instead");
    expect(hiddenHtml).not.toContain("Continue with Google");
    expect(hiddenHtml).toContain("That code has expired");
    expect(hiddenHtml).toContain("Too many code emails");
    process.env.FILLIP_AUTH_GOOGLE_ENABLED = "true";
    const shown = await fetch(`${base}/oauth/consent`);
    expect(await shown.text()).toContain("Continue with Google");
    delete process.env.FILLIP_AUTH_GOOGLE_ENABLED;
  });

  it("rejects a missing or non-S256 PKCE challenge and follows an existing redirect before reading the client", async () => {
    const plain = await fetch(`${base}/oauth/authorize?redirect_uri=${encodeURIComponent("https://client.example/cb")}&code_challenge_method=plain&code_challenge=abc&state=xyz`, { redirect: "manual" });
    expect(plain.status).toBeGreaterThanOrEqual(300);
    expect(plain.status).toBeLessThan(400);
    const plainLocation = plain.headers.get("location") ?? "";
    expect(plainLocation).toContain("error=invalid_request");
    expect(plainLocation).toContain("client.example");
    const missing = await fetch(`${base}/oauth/authorize?redirect_uri=${encodeURIComponent("https://client.example/cb")}&state=xyz`, { redirect: "manual" });
    expect(missing.headers.get("location") ?? "").toContain("error=invalid_request");
    const bare = await fetch(`${base}/oauth/authorize?code_challenge_method=plain`);
    expect(bare.status).toBe(400);
    const previousSupabase = process.env.SUPABASE_URL;
    process.env.SUPABASE_URL = "https://qa.supabase.co";
    const forward = await fetch(`${base}/oauth/authorize?redirect_uri=${encodeURIComponent("https://client.example/cb")}&code_challenge_method=S256&code_challenge=abc&state=xyz`, { redirect: "manual" });
    if (previousSupabase === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = previousSupabase;
    const forwardLocation = forward.headers.get("location") ?? "";
    expect(forwardLocation).toContain("https://qa.supabase.co/auth/v1/oauth/authorize");
    expect(forwardLocation).toContain("code_challenge_method=S256");
    expect(forwardLocation).not.toContain("error=invalid_request");
    const consent = await fetch(`${base}/oauth/consent?authorization_id=auth-1`);
    const html = await consent.text();
    expect(html).toContain("denyAuthorization");
    expect(html).toContain("code_challenge_method");
    expect(html).toContain("S256");
    const assign = html.indexOf("if(details.data&&details.data.redirect_url){location.assign(details.data.redirect_url);return}");
    const proof = html.indexOf("/oauth/pkce-proof");
    const clientName = html.indexOf("details.data.client||{}");
    expect(assign).toBeGreaterThan(0);
    expect(assign).toBeLessThan(proof);
    expect(proof).toBeLessThan(clientName);
    expect(html).toContain("el('consent').hidden=false");
    expect(html).not.toContain("details.data.client.name||");
  });

  it("serves connect, health, and OAuth metadata", async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { ok: boolean; service: string; version: string; globalEmails?: unknown };
    expect(healthBody).toMatchObject({ ok: true, service: "fillip" });
    expect(healthBody.version).toBeTruthy();
    expect(healthBody.globalEmails).toBeUndefined();
    expect(JSON.stringify(healthBody)).not.toMatch(/telegram|stripe|resend|globalEmails/i);

    const locked = await fetch(`${base}/internal/status`);
    expect([401, 503]).toContain(locked.status);
    const previousSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "status-test";
    const status = await fetch(`${base}/internal/status`, { headers: { authorization: "Bearer status-test" } });
    const statusBody = await status.json() as {
      globalEmails: {
        daySent: number | null;
        monthSent: number | null;
        dayLimit: number;
        monthLimit: number;
        stopped: boolean;
        close: boolean;
        reason: string | null;
        dayResetsAt: string;
        monthResetsAt: string;
      };
    };
    expect(status.status).toBe(200);
    expect(statusBody.globalEmails).toMatchObject({
      daySent: null,
      monthSent: null,
      dayLimit: 0,
      monthLimit: 0,
      stopped: true,
      close: true,
      reason: "month"
    });
    expect(statusBody.globalEmails.dayResetsAt).toMatch(/T00:00:00.000Z$/);
    expect(statusBody.globalEmails.monthResetsAt).toMatch(/T00:00:00.000Z$/);
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;

    const connect = await fetch(`${base}/connect`);
    const html = await connect.text();
    expect(connect.status).toBe(200);
    for (const name of ["ChatGPT", "Claude", "Gemini", "Grok", "Cursor"]) expect(html).toContain(name);
    expect(html).toContain("Fillip by Ouroboros");
    expect(html).not.toMatch(/\$\d/);

    const metadata = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    const oauth = await metadata.json() as { resource: string; resource_name: string; bearer_methods_supported: string[]; authorization_servers: string[] };
    expect(oauth.resource).toMatch(/\/mcp$/);
    expect(oauth.resource_name).toBe("Fillip by Ouroboros");
    expect(oauth.bearer_methods_supported).toEqual(["header"]);
    expect(oauth.authorization_servers[0]).toMatch(/\/auth\/v1$/);
    expect(JSON.stringify(oauth)).not.toContain("code_challenge_methods_supported");
    expect(JSON.stringify(oauth)).not.toContain("authorization_response_iss_parameter_supported");

    const home = await fetch(`${base}/`);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("Fillip, reminders that fire.");
    expect(homeHtml).toContain("The trial is 14 days, then Pro");
    expect(homeHtml).toContain("https://ouroborosapps.com");
    expect(homeHtml).not.toMatch(/\$\d/);
  });

  it.each([
    ["application/json"],
    ["*/*"],
    ["text/event-stream"],
    [undefined]
  ] as const)("lists tools when Accept is %s", async (accept) => {
    const response = await postMcp(accept, { jsonrpc: "2.0", id: 11, method: "tools/list", params: {} });
    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as { result?: { tools?: Array<{ name: string }> }; error?: { message?: string } };
    expect(body.error?.message ?? "").not.toMatch(/Not Acceptable/);
    expect(body.result?.tools?.map((tool) => tool.name)).toContain("set_reminder");
  });

  it("hides the Telegram webhook until a bot token is set", async () => {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    delete process.env.TELEGRAM_BOT_TOKEN;
    try {
      const hidden = await fetch(`${base}/telegram/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      });
      expect(hidden.status).toBe(404);
      process.env.TELEGRAM_BOT_TOKEN = "123456:test";
      process.env.TELEGRAM_WEBHOOK_SECRET = "hook-secret";
      const denied = await fetch(`${base}/telegram/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "nope" },
        body: "{}"
      });
      expect(denied.status).toBe(401);
      const calendar = await fetch(`${base}/calendar/short.ics`);
      expect(calendar.status).toBe(404);
    } finally {
      if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = token;
      if (secret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET;
      else process.env.TELEGRAM_WEBHOOK_SECRET = secret;
    }
  });

  it("rejects a browser origin that is not an assistant", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(403);
  });
});
