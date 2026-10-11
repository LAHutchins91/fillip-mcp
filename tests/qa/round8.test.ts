/**
 * QA round 8 against 362cf99.
 * Postgres 16, schema.sql, and oauth_resource_binding.sql.
 * QA-FAIL tests assert a promised control and fail on this build.
 */
import http, { type IncomingMessage, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { app } from "../../src/server.js";
import { CODE_LOCKED, CODE_SENT, CODE_WRONG, lockoutAddressKey } from "../../src/code-auth.js";
import { validateMcpClaims } from "../../src/mcp-claims.js";
import { setReminder } from "../../src/lib/reminders.js";
import { FILLIP_EMPTY_REPRESENTATION, SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import { UNCONFIRMED_SAVE } from "../../src/lib/errors.js";
import { pkceRejection } from "../../src/plugin-auth.js";
import type { Actor, Reminder } from "../../src/lib/types.js";
import { STAND_IN_CAPS } from "../../src/lib/usage.js";

const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const caps = STAND_IN_CAPS;
const now = new Date("2026-10-11T16:00:00.000Z");
const database = "fillip_round8";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const hookSql = readFileSync(new URL("../../supabase/oauth_resource_binding.sql", import.meta.url), "utf8");
const resource = "https://fillip.example/mcp";
const hookUser = "11111111-1111-4111-8111-111111111111";
const clientA = "33333333-3333-4333-8333-333333333333";
const clientB = "44444444-4444-4444-8444-444444444444";
const KEPT_NOTE = "You're over the free plan's 10 open reminders. Upgrade to Pro for a higher allowance. The trial is 14 days, then Pro.";

function pgClient(db = database) {
  return new pg.Client({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database: db });
}

const bootstrap = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid,
  oauth_client_id uuid,
  scopes text
);
create table if not exists auth.oauth_authorizations (
  id uuid primary key,
  authorization_id text,
  client_id uuid,
  user_id uuid,
  scope text,
  status text,
  expires_at timestamptz,
  resource text,
  code_challenge_method text,
  authorization_code text,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
end
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
`;

function tokenFor(aud: unknown, sessionId: string) {
  const payload = Buffer.from(JSON.stringify({
    sub: hookUser,
    iss: "https://fillip.example/auth/v1",
    aud,
    role: "authenticated",
    exp: Math.floor(Date.now() / 1000) + 900,
    client_id: clientA,
    session_id: sessionId,
    scope: "email"
  })).toString("base64url");
  return `e30.${payload}.sig`;
}

describe("QA round 8 token hook and emailed-code window on Postgres", () => {
  const db = pgClient();

  beforeAll(async () => {
    const admin = pgClient("postgres");
    await admin.connect();
    try {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
      await admin.query(`drop database if exists ${database}`);
      await admin.query(`create database ${database}`);
    } finally {
      await admin.end();
    }
    await db.connect();
    await db.query(bootstrap);
    await db.query(schema);
    await db.query(hookSql);
    await db.query("update fillip_private.settings set value = $1 where key = 'mcp_resource'", [resource]);
  }, 60_000);

  afterAll(async () => {
    await db.end().catch(() => undefined);
    const admin = pgClient("postgres");
    await admin.connect();
    try {
      await admin.query("select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()", [database]);
      await admin.query(`drop database if exists ${database}`);
    } finally {
      await admin.end();
    }
  });

  async function grant(row: {
    id?: string;
    userId?: string;
    clientId?: string;
    scope?: string;
    method?: string | null;
    grantedResource?: string | null;
    code?: string | null;
    status?: string;
    expiresAt?: Date;
    authorizationId?: string | null;
  }) {
    const id = row.id ?? randomUUID();
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, approved_at)
       values ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10, now())`,
      [
        id,
        row.authorizationId === undefined ? id : row.authorizationId,
        row.clientId ?? clientA,
        row.userId ?? hookUser,
        row.scope ?? "email",
        row.status ?? "approved",
        row.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000),
        row.grantedResource === undefined ? resource : row.grantedResource,
        row.method === undefined ? "s256" : row.method,
        row.code === undefined ? `code-${id}` : row.code
      ]
    );
    return id;
  }

  async function audience(sessionId: string, claims: Record<string, unknown> = {}, clientId = clientA, scope = "email") {
    await db.query(
      `insert into auth.sessions (id, user_id, oauth_client_id, scopes)
       values ($1, $2, $3, $4)
       on conflict (id) do update set scopes = excluded.scopes`,
      [sessionId, hookUser, clientId, scope]
    );
    const result = await db.query<{ event: { claims?: { aud?: unknown } } }>(
      "select public.fillip_access_token_hook($1::jsonb) as event",
      [JSON.stringify({
        user_id: hookUser,
        authentication_method: "oauth_provider/authorization_code",
        claims: {
          sub: hookUser,
          client_id: clientId,
          session_id: sessionId,
          scope,
          aud: "authenticated",
          role: "authenticated",
          ...claims
        }
      })]
    );
    return result.rows[0]?.event.claims?.aud;
  }

  async function fresh(): Promise<string> {
    await db.query("delete from auth.oauth_authorizations");
    await db.query("delete from fillip_private.oauth_resources");
    return randomUUID();
  }

  function bound(aud: unknown, sessionId: string) {
    expect(() => validateMcpClaims(tokenFor(aud, sessionId), hookUser, "https://fillip.example/auth/v1", resource)).not.toThrow();
  }

  function withheld(aud: unknown, sessionId: string) {
    expect(aud).toBe("authenticated");
    expect(() => validateMcpClaims(tokenFor(aud, sessionId), hookUser, "https://fillip.example/auth/v1", resource)).toThrow(/Reconnect Fillip/);
  }

  it("QA-PASS: four agreeing S256 rows bind, and expired or unapproved rows are ignored", async () => {
    const many = await fresh();
    for (let index = 0; index < 4; index += 1) {
      await grant({ code: `agree-${index}` });
    }
    bound(await audience(many), many);

    const expiredSibling = await fresh();
    await grant({ code: "live-beside-expired" });
    await grant({
      code: "expired-evil",
      grantedResource: "https://evil.example/mcp",
      expiresAt: new Date(Date.now() - 60 * 1000)
    });
    bound(await audience(expiredSibling), expiredSibling);

    const pendingSibling = await fresh();
    await grant({ code: "live-beside-pending" });
    await grant({ code: "pending-evil", status: "pending", grantedResource: "https://evil.example/mcp" });
    await grant({ code: null, status: "approved", grantedResource: "https://evil.example/mcp", method: "plain" });
    bound(await audience(pendingSibling), pendingSibling);
  });

  it("QA-PASS: one disagreeing row withholds, whichever way it disagrees", async () => {
    const other = await fresh();
    await grant({ code: "good-other" });
    await grant({ code: "bad-resource", grantedResource: "https://other.example/mcp" });
    withheld(await audience(other), other);

    const missing = await fresh();
    await grant({ code: "good-null" });
    await grant({ code: "null-resource", grantedResource: null });
    withheld(await audience(missing), missing);

    const plain = await fresh();
    await grant({ code: "good-plain" });
    await grant({ code: "plain-method", method: "plain" });
    withheld(await audience(plain), plain);

    const alone = await fresh();
    await grant({ code: "no-resource", grantedResource: null });
    withheld(await audience(alone), alone);

    const neighbor = await fresh();
    await grant({ code: "other-client", clientId: clientB });
    withheld(await audience(neighbor), neighbor);
  });

  it("QA-PASS: an authorization id binds that row and a missing id withholds", async () => {
    const named = await fresh();
    const good = await grant({ code: "named-good", authorizationId: "auth-good" });
    await grant({ code: "named-evil", grantedResource: "https://evil.example/mcp", authorizationId: "auth-evil" });
    bound(await audience(named, { authorization_id: "auth-good" }), named);
    expect(good).toBeTruthy();

    const camel = await fresh();
    await grant({ code: "camel-good", authorizationId: "auth-camel" });
    await grant({ code: "camel-evil", grantedResource: null, method: "plain", authorizationId: "auth-camel-evil" });
    bound(await audience(camel, { authorizationId: "auth-camel" }), camel);

    const unknown = await fresh();
    await grant({ code: "present-but-not-named" });
    withheld(await audience(unknown, { authorization_id: "does-not-exist" }), unknown);
  });

  it("QA-PASS: five wrong tries stay counted through 14 minutes and roll over at 15", async () => {
    const emailHash = "c".repeat(64);
    for (let index = 0; index < 5; index += 1) {
      const result = await db.query<{ n: number }>("select public.fillip_bump_code_counter('email', $1, 'wrong') as n", [emailHash]);
      expect(result.rows[0]?.n).toBe(index + 1);
    }
    await db.query(
      "update public.fillip_code_attempts set window_started_at = now() - interval '14 minutes' where subject_kind = 'email' and subject_hash = $1",
      [emailHash]
    );
    const still = await db.query<{ n: number }>("select public.fillip_bump_code_counter('email', $1, 'wrong') as n", [emailHash]);
    expect(still.rows[0]?.n).toBe(6);
    await db.query(
      "update public.fillip_code_attempts set window_started_at = now() - interval '15 minutes' where subject_kind = 'email' and subject_hash = $1",
      [emailHash]
    );
    const rolled = await db.query<{ n: number }>("select public.fillip_bump_code_counter('email', $1, 'wrong') as n", [emailHash]);
    expect(rolled.rows[0]?.n).toBe(1);

    const sendHash = "d".repeat(64);
    await db.query("select public.fillip_bump_code_counter('email', $1, 'wrong')", [sendHash]);
    await db.query("select public.fillip_bump_code_counter('ip', $1, 'send')", [sendHash]);
    const untouched = await db.query<{ wrong_count: number }>(
      "select wrong_count from public.fillip_code_attempts where subject_kind = 'email' and subject_hash = $1",
      [sendHash]
    );
    expect(untouched.rows[0]?.wrong_count).toBe(1);
  });

  it("QA-PASS: twenty parallel bumps are a dense sequence and exactly five are within the email gate", async () => {
    const emailHash = "e".repeat(64);
    const clients = await Promise.all(Array.from({ length: 20 }, async () => {
      const client = pgClient();
      await client.connect();
      return client;
    }));
    try {
      const counts = await Promise.all(clients.map((client) => client.query<{ n: number }>(
        "select public.fillip_bump_code_counter('email', $1, 'wrong') as n",
        [emailHash]
      ).then((result) => result.rows[0]?.n)));
      expect([...counts].sort((left, right) => left - right)).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
      expect(counts.filter((count) => count <= 5)).toHaveLength(5);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
});

type DeleteKind = "return-id" | "empty-keep" | "empty-drop" | "marker-keep" | "throw-keep" | "throw-drop";
type ReadKind = "row" | "missing" | "throw" | "marker";
type Verdict = "cap" | "kept" | "unconfirmed";

function profileRow() {
  return [{ plan: "free", subscription_status: "none", unsubscribed: false, emails_sent_in_period: 0, default_channel: "email" }];
}

function overCapDouble(spec: { userDelete: DeleteKind; writerDelete: DeleteKind; reads: ReadKind[] }) {
  const stored = new Map<string, Record<string, unknown>>();
  const olderId = randomUUID();
  stored.set(olderId, {
    id: olderId,
    owner_id: actor.id,
    kind: "reminder",
    what: "older",
    context: null,
    timezone: "UTC",
    fire_at: "2026-10-12T15:00:00.000Z",
    recurrence: null,
    channel: "email",
    status: "active",
    hold_until: null,
    created_at: "2026-10-01T00:00:00.000Z",
    updated_at: "2026-10-01T00:00:00.000Z",
    completed_at: null
  });
  let inserted = "";
  let readIndex = 0;
  let writerDeletes = 0;
  const applyDelete = (kind: DeleteKind, id: string) => {
    if (kind === "throw-keep") throw new Error("delete exploded");
    if (kind === "throw-drop") {
      stored.delete(id);
      throw new Error("delete exploded");
    }
    if (kind === "return-id") {
      stored.delete(id);
      return [{ id }];
    }
    if (kind === "empty-drop") stored.delete(id);
    if (kind === "marker-keep") return FILLIP_EMPTY_REPRESENTATION;
    return [];
  };
  const handle = (role: "user" | "writer"): Db => async (pathname, options) => {
    const method = options?.method ?? "GET";
    const params = new URLSearchParams(pathname.split("?")[1] ?? "");
    if (pathname.includes("/rest/v1/profiles")) {
      if (method === "GET") return profileRow();
      return [];
    }
    if (pathname.includes("created_at=gte")) return [];
    if (pathname.includes("/rest/v1/reminders") && method === "POST") {
      const body = JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>;
      inserted = String(body.id);
      stored.set(inserted, body);
      return [body];
    }
    if (pathname.includes("/rest/v1/reminders") && method === "DELETE") {
      const id = decodeURIComponent((params.get("id") ?? "").replace(/^eq\./, ""));
      if (role === "writer") writerDeletes += 1;
      return applyDelete(role === "user" ? spec.userDelete : spec.writerDelete, id);
    }
    if (pathname.includes("status=eq.active") && pathname.includes("limit=200")) {
      return [...stored.values()].slice(0, 9).map((row) => ({ id: row.id }));
    }
    if (pathname.includes("status=eq.active")) {
      const ids = [...stored.keys()];
      while (ids.length <= 10) ids.push(`11111111-1111-4111-8111-${String(ids.length).padStart(12, "0")}`);
      return ids.map((id) => ({ id }));
    }
    if (pathname.includes("/rest/v1/reminders") && method === "GET") {
      const id = decodeURIComponent((params.get("id") ?? "").replace(/^eq\./, ""));
      if (readIndex < spec.reads.length) {
        const step = spec.reads[readIndex];
        readIndex += 1;
        if (step === "throw") throw new Error("read exploded");
        if (step === "marker") return FILLIP_EMPTY_REPRESENTATION;
        if (step === "missing") return [];
      }
      const row = stored.get(id);
      return row ? [row] : [];
    }
    return [];
  };
  return {
    user: handle("user"),
    writer: handle("writer"),
    inserted: () => inserted,
    writerDeletes: () => writerDeletes
  };
}

describe("QA round 8 over-cap delete and read combinations", () => {
  async function run(spec: { userDelete: DeleteKind; writerDelete: DeleteKind; reads: ReadKind[]; mode: "service" | "user" }) {
    const hosted = overCapDouble(spec);
    const store = spec.mode === "service"
      ? new SupabaseFillipStore(null, hosted.writer, "service")
      : new SupabaseFillipStore(actor.id, hosted.user, "user", hosted.writer);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((item) => String(item)).join(" "));
    });
    let error = "";
    let view: { status?: string; note?: string | null } | undefined;
    try {
      view = await setReminder(store, actor, {
        what: "pay the invoice",
        when: "October 12, 2026 at 3pm",
        timezone: "UTC"
      }, now, caps);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      spy.mockRestore();
    }
    const id = hosted.inserted();
    const row = id ? await store.getReminder(actor.id, id) : null;
    expect(logs.join("\n")).not.toContain("pay the invoice");
    const gone = row == null;
    if (view && gone) throw new Error(`mismatch: saved view but the row is gone (${error})`);
    if (/The free plan allows 10 open reminders|may not have been saved/.test(error) && !gone) {
      throw new Error(`mismatch: refusal while the row is still stored (${error})`);
    }
    if (view?.note?.includes("You're over the free plan") && gone) throw new Error("mismatch: kept note but the row is gone");
    let verdict: Verdict | "other" = "other";
    if (view?.status === "active" && view.note?.includes(KEPT_NOTE)) verdict = "kept";
    else if (error === UNCONFIRMED_SAVE) verdict = "unconfirmed";
    else if (/The free plan allows 10 open reminders/.test(error) && !view) verdict = "cap";
    return { verdict, error, view, row, writerDeletes: hosted.writerDeletes() };
  }

  it("QA-PASS: unknown reads say the save could not be confirmed, and no combination mismatches", async () => {
    const cases: Array<{ name: string; userDelete: DeleteKind; writerDelete: DeleteKind; reads: ReadKind[]; verdict: Verdict }> = [
      { name: "returned id, row gone", userDelete: "return-id", writerDelete: "return-id", reads: ["row"], verdict: "cap" },
      { name: "empty delete leaves the row", userDelete: "empty-keep", writerDelete: "empty-keep", reads: ["row"], verdict: "kept" },
      { name: "empty delete, row gone", userDelete: "empty-drop", writerDelete: "empty-drop", reads: ["missing"], verdict: "cap" },
      { name: "delete throws, row still reads", userDelete: "throw-keep", writerDelete: "throw-keep", reads: ["row"], verdict: "kept" },
      { name: "delete throws, row is gone", userDelete: "throw-drop", writerDelete: "throw-drop", reads: ["missing"], verdict: "cap" },
      { name: "both reads throw, row kept", userDelete: "throw-keep", writerDelete: "throw-keep", reads: ["throw", "throw"], verdict: "unconfirmed" },
      { name: "both reads throw, row dropped", userDelete: "throw-drop", writerDelete: "throw-drop", reads: ["throw", "throw"], verdict: "unconfirmed" },
      { name: "both reads are empty markers", userDelete: "marker-keep", writerDelete: "marker-keep", reads: ["marker", "marker"], verdict: "unconfirmed" },
      { name: "empty delete and both reads are empty markers", userDelete: "empty-drop", writerDelete: "empty-drop", reads: ["marker", "marker"], verdict: "unconfirmed" },
      { name: "first read throws, retry sees the row", userDelete: "throw-keep", writerDelete: "throw-keep", reads: ["throw", "row"], verdict: "kept" },
      { name: "first read throws, retry sees the row gone", userDelete: "throw-drop", writerDelete: "throw-drop", reads: ["throw", "missing"], verdict: "cap" },
      { name: "empty delete, retry sees the row", userDelete: "empty-keep", writerDelete: "empty-keep", reads: ["throw", "row"], verdict: "kept" },
      { name: "empty delete, retry sees it gone", userDelete: "empty-drop", writerDelete: "empty-drop", reads: ["throw", "missing"], verdict: "cap" }
    ];
    const failures: string[] = [];
    for (const item of cases) {
      const result = await run({ ...item, mode: "service" });
      if (result.verdict !== item.verdict) failures.push(`${item.name}: wanted ${item.verdict}, got ${result.verdict} (${result.error || result.view?.note})`);
    }
    const retry = await run({
      userDelete: "throw-keep",
      writerDelete: "return-id",
      reads: ["row"],
      mode: "user"
    });
    if (retry.verdict !== "cap" || retry.row != null) failures.push(`service retry after a present read: ${retry.verdict}`);
    const unknownFirst = await run({
      userDelete: "throw-keep",
      writerDelete: "return-id",
      reads: ["throw", "throw"],
      mode: "user"
    });
    if (unknownFirst.verdict !== "unconfirmed" || unknownFirst.row == null) {
      failures.push(`unknown read skipped a truthful retry check: ${unknownFirst.verdict}`);
    }
    if (unknownFirst.writerDeletes !== 0) failures.push(`unknown read still called the service delete (${unknownFirst.writerDeletes})`);
    expect(failures).toEqual([]);
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

describe("QA round 8 address key", () => {
  it("QA-PASS: spoofed X-Forwarded-For is ignored, and IPv6 keys on /64 including a zone id", () => {
    const header = (map: Record<string, string>) => (name: string) => map[name.toLowerCase()];
    expect(lockoutAddressKey(header({ "x-forwarded-for": "203.0.113.99, 10.0.0.1" }), "127.0.0.1")).toBe("127.0.0.1");
    expect(lockoutAddressKey(header({ "x-forwarded-for": "198.51.100.8" }), "::ffff:203.0.113.10")).toBe("203.0.113.10");
    const compressed = lockoutAddressKey(() => undefined, "2001:db8:1:2::abcd");
    expect(lockoutAddressKey(() => undefined, "2001:0db8:0001:0002:0000:0000:0000:0001")).toBe(compressed);
    expect(lockoutAddressKey(() => undefined, "2001:DB8:1:2::1%eth0")).toBe(compressed);
    expect(lockoutAddressKey(() => undefined, "2001:db8:1:3::1")).not.toBe(compressed);
    expect(lockoutAddressKey(header({ "x-real-ip": "198.51.100.9:4321" }), "127.0.0.1")).toBe("127.0.0.1");
  });
});

describe("QA round 8 emailed-code lock over HTTP", () => {
  let stub: Server;
  let fillip: Server;
  let base = "";
  const savedEnv = {
    APP_BASE_URL: process.env.APP_BASE_URL,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_ANON_KEY: process.env.SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  const attempts: Array<Record<string, string | number>> = [];
  const verifyCalls: string[] = [];

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
      if (url.startsWith("/rest/v1/rpc/fillip_clear_email_wrong") || url.startsWith("/rest/v1/rpc/fillip_reset_ip_verify")) {
        const parsed = JSON.parse(body) as { p_hash: string };
        const kind = url.includes("fillip_clear_email_wrong") ? "email" : "ip";
        const row = attempts.find((item) => item.subject_kind === kind && item.subject_hash === parsed.p_hash);
        if (row && kind === "email") row.wrong_count = 0;
        if (row && kind === "ip") row.verify_count = 0;
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
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    verifyCalls.length = 0;
    attempts.length = 0;
    delete process.env.VERCEL;
  });

  function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
    return httpCall(base, "POST", pathname, JSON.stringify(body), {
      "content-type": "application/json",
      "x-fillip-request": "1",
      ...headers
    });
  }

  it("QA-PASS: five wrong codes lock that email, and a new send cannot clear it", async () => {
    const ip = { "x-real-ip": "203.0.113.42" };
    await post("/auth/code/send", { email: "locked-r8@example.com" }, ip);
    for (let index = 0; index < 4; index += 1) {
      const wrong = await post("/auth/code/verify", { email: "locked-r8@example.com", code: "000000" }, ip);
      expect(wrong.status).toBe(400);
      expect(JSON.parse(wrong.text).message).toBe(CODE_WRONG);
    }
    const fifth = await post("/auth/code/verify", { email: "locked-r8@example.com", code: "000000" }, ip);
    expect(fifth.status).toBe(429);
    expect(JSON.parse(fifth.text).message).toBe(CODE_LOCKED);
    expect(verifyCalls).toHaveLength(5);
    const again = await post("/auth/code/send", { email: "locked-r8@example.com" }, ip);
    expect(JSON.parse(again.text).message).toBe(CODE_SENT);
    const still = await post("/auth/code/verify", { email: "locked-r8@example.com", code: "123456" }, ip);
    expect(still.status).toBe(429);
    expect(JSON.parse(still.text).message).toBe(CODE_LOCKED);
    expect(verifyCalls).toHaveLength(5);
    expect(still.text).not.toContain("issued-access");
  }, 20_000);

  it("QA-PASS: twenty parallel wrong tries let exactly five through", async () => {
    const ip = { "x-real-ip": "203.0.113.40" };
    const results = await Promise.all(Array.from({ length: 20 }, () => post(
      "/auth/code/verify",
      { email: "spray-r8@example.com", code: "000000" },
      ip
    )));
    expect(verifyCalls).toHaveLength(5);
    expect(results.filter((result) => result.status === 400)).toHaveLength(4);
    expect(results.filter((result) => result.status === 429)).toHaveLength(16);
    expect(results.every((result) => !result.text.includes("issued-access"))).toBe(true);
  });

  it("QA-PASS: the same IPv6 /64 shares a verify budget, including a zone id", async () => {
    process.env.VERCEL = "1";
    const emailAt = (index: number) => `v6-${index}@example.com`;
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: emailAt(index), code: "000000" }, {
        "x-vercel-forwarded-for": "2001:db8:aa:10::1"
      });
      expect(wrong.status).toBe(400);
    }
    const same = await post("/auth/code/verify", { email: "v6-same@example.com", code: "000000" }, {
      "x-vercel-forwarded-for": "2001:db8:aa:10:ffff::abcd"
    });
    expect(same.status).toBe(429);
    const zone = await post("/auth/code/verify", { email: "v6-zone@example.com", code: "123456" }, {
      "x-vercel-forwarded-for": "2001:db8:aa:10::9%eth0"
    });
    expect(zone.status).toBe(429);
    const other = await post("/auth/code/verify", { email: "v6-other@example.com", code: "000000" }, {
      "x-vercel-forwarded-for": "2001:db8:aa:11::1"
    });
    expect(other.status).toBe(400);
  });

  it("an allowed send leaves the IP verify count until its window expires", async () => {
    const ip = { "x-real-ip": "203.0.113.41" };
    let through = 0;
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: `grind-${index}@example.com`, code: "000000" }, ip);
      expect(wrong.status).toBe(400);
      through += 1;
    }
    const blocked = await post("/auth/code/verify", { email: "grind-blocked@example.com", code: "000000" }, ip);
    expect(blocked.status).toBe(429);
    expect(through).toBe(10);
    const owned = await post("/auth/code/send", { email: "attacker-owned@example.com" }, ip);
    expect(JSON.parse(owned.text).message).toBe(CODE_SENT);
    const afterSend = await post("/auth/code/verify", { email: "grind-after@example.com", code: "000000" }, ip);
    expect(afterSend.status).toBe(429);
    expect(verifyCalls).toHaveLength(10);

    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (attempts[index]?.subject_kind === "ip") attempts.splice(index, 1);
    }
    const sendIp = { "x-real-ip": "203.0.113.70" };
    let sends = 0;
    for (let index = 0; index < 6; index += 1) {
      const sent = await post("/auth/code/send", { email: `box-${index}@example.com` }, sendIp);
      if (sent.status === 200) sends += 1;
      else {
        expect(sent.status).toBe(429);
        break;
      }
    }
    expect(sends).toBe(5);
    expect(5 * (60 / 15)).toBe(20);
  }, 20_000);

  it("QA-FAIL: a client X-Real-IP or x-vercel-forwarded-for cannot mint a new verify budget", async () => {
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: `socket-${index}@example.com`, code: "000000" });
      expect(wrong.status).toBe(400);
    }
    const forwarded = await post("/auth/code/verify", { email: "xff-fresh@example.com", code: "000000" }, {
      "x-forwarded-for": "203.0.113.99, 10.0.0.1"
    });
    expect(forwarded.status).toBe(429);
    const holes: string[] = [];
    const real = await post("/auth/code/verify", { email: "real-fresh@example.com", code: "000000" }, {
      "X-Real-IP": "198.51.100.77"
    });
    if (real.status !== 429) holes.push(`X-Real-IP minted a new verify budget (${real.status})`);
    const vercel = await post("/auth/code/verify", { email: "vercel-fresh@example.com", code: "000000" }, {
      "x-vercel-forwarded-for": "198.51.100.88"
    });
    if (vercel.status !== 429) holes.push(`x-vercel-forwarded-for minted a new verify budget (${vercel.status})`);
    expect(holes).toEqual([]);
  });

  it("QA-PASS: tools/list stays public without a bearer and 401 invalid_token with a bad one", async () => {
    const open = await httpCall(base, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    });
    expect(open.status).toBe(200);
    const closed = await httpCall(base, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer not-a-jwt"
    });
    expect(closed.status).toBe(401);
    expect(closed.text).toContain("Authentication required.");
  });
});

const booted: ChildProcess[] = [];

function boot(overrides: Record<string, string>): Promise<{ code: number | null; output: string; listened: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: "/workspace",
      env: { ...process.env, PORT: "0", ...overrides },
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

describe("QA round 8 lockout secret at startup", () => {
  afterAll(() => {
    for (const child of booted) child.kill("SIGKILL");
  });

  it("QA-PASS: production boots when FILLIP_LOCKOUT_SECRET is set", async () => {
    const result = await boot({
      NODE_ENV: "production",
      VERCEL_ENV: "",
      FILLIP_LOCKOUT_SECRET: "round8-dedicated-secret-32-characters"
    });
    expect(result.listened).toBe(true);
  }, 30_000);

  it("QA-FAIL: production startup refuses when FILLIP_LOCKOUT_SECRET is missing", async () => {
    const production = await boot({
      NODE_ENV: "production",
      VERCEL_ENV: "",
      FILLIP_LOCKOUT_SECRET: ""
    });
    const vercel = await boot({
      NODE_ENV: "development",
      VERCEL_ENV: "production",
      FILLIP_LOCKOUT_SECRET: ""
    });
    const problems: string[] = [];
    if (production.listened) problems.push(`NODE_ENV=production listened: ${production.output.slice(0, 240)}`);
    if (vercel.listened) problems.push(`VERCEL_ENV=production listened: ${vercel.output.slice(0, 240)}`);
    if (!/FILLIP_LOCKOUT_SECRET/.test(production.output)) problems.push("production boot did not name FILLIP_LOCKOUT_SECRET");
    if (!/FILLIP_LOCKOUT_SECRET/.test(vercel.output)) problems.push("vercel production boot did not name FILLIP_LOCKOUT_SECRET");
    expect(problems).toEqual([]);
  }, 60_000);
});

describe("QA round 8 regression and copy", () => {
  it("QA-PASS: round 7 failure assertions are unchanged, plain PKCE is rejected, and copy has no prices", () => {
    const prior = readFileSync("tests/qa/round7.test.ts", "utf8");
    expect(prior).toContain('it("QA-FAIL: two live S256 codes for one reconnect still receive the audience"');
    expect(prior).toContain("validateMcpClaims(tokenFor(aud, session), hookUser, \"https://fillip.example/auth/v1\", resource)).not.toThrow()");
    expect(prior).toContain('it("QA-FAIL: a failed re-read after a delete does not claim a removed row was saved"');
    expect(prior).toContain('await outcome("both-fail")');
    expect(prior).toContain("The free plan allows 10 open reminders");
    expect(prior).toContain('it("QA-FAIL: five wrong codes stay locked after a new send and after a changed IP header"');
    expect(prior).toContain("a new code request cleared the five-wrong lock");
    expect(prior).toContain("X-Forwarded-For changed the verify lock");
    expect(prior).not.toMatch(/\bit\.skip\(|\bdescribe\.skip\(|\btest\.skip\(|\bxit\(|\bxdescribe\(/);
    expect(pkceRejection("plain", "abc")?.error).toBe("invalid_request");
    expect(pkceRejection("S256", "abc")).toBeNull();

    const readme = readFileSync("README.md", "utf8");
    const oauth = readFileSync("supabase/README-oauth.md", "utf8");
    expect(readme).toContain("A new send does not clear that lock.");
    expect(oauth).toContain("A new send does not clear that lock.");
    expect(oauth).toContain("however many rows there are");
    expect(oauth).toContain("Five wrong codes in 15 minutes");
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
