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
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { result?: { tools?: Array<{ name: string; description?: string; inputSchema?: { properties?: Record<string, unknown> } }> } };
    const tools = body.result?.tools ?? [];
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(["set_reminder", "list_reminders", "snooze_or_reschedule", "complete_or_cancel", "follow_up", "digest_settings"]);
    const text = JSON.stringify(tools);
    expect(text).not.toMatch(/\$\d/);
    expect(text).toMatch(/verified/);
    const setReminder = tools.find((tool) => tool.name === "set_reminder");
    const properties = Object.keys(setReminder?.inputSchema?.properties ?? {});
    expect(properties).toEqual(expect.arrayContaining(["what", "when", "timezone"]));
    expect(properties).not.toEqual(expect.arrayContaining(["email", "to", "recipient"]));
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
    expect(response.headers.get("www-authenticate")).toContain("oauth-protected-resource");
    const body = await response.json() as { error?: string };
    expect(body.error).toMatch(/Sign in to Fillip/);
  });

  it("serves connect, health, and OAuth metadata", async () => {
    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json() as { service: string };
    expect(healthBody.service).toBe("fillip");

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

  it("rejects a browser origin that is not an assistant", async () => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} })
    });
    expect(response.status).toBe(403);
  });
});
