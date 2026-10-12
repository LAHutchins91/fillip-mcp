/**
 * QA round 7 against e24b51b.
 * Cap and token-hook cases use Postgres 16 with schema.sql and oauth_resource_binding.sql.
 * QA-FAIL tests assert the behavior a user was promised and fail on this build.
 */
import http, { type IncomingMessage, type Server } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { app } from "../../src/server.js";
import { CODE_LOCKED, CODE_SENT } from "../../src/code-auth.js";
import { validateMcpClaims } from "../../src/mcp-claims.js";
import { setReminder, snoozeOrReschedule } from "../../src/lib/reminders.js";
import { MemoryFillipStore } from "../../src/lib/memory-store.js";
import { SupabaseFillipStore, type Db } from "../../src/lib/supabase-store.js";
import { pkceRejection } from "../../src/plugin-auth.js";
import type { Actor, Reminder } from "../../src/lib/types.js";
import { blankContact, STAND_IN_CAPS, upgradePrompt } from "../../src/lib/usage.js";

const actor: Actor = { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.com", emailVerified: true };
const caps = STAND_IN_CAPS;
const now = new Date("2026-10-11T16:00:00.000Z");
const database = "fillip_round7";
const schema = readFileSync(new URL("../../supabase/schema.sql", import.meta.url), "utf8");
const hookSql = readFileSync(new URL("../../supabase/oauth_resource_binding.sql", import.meta.url), "utf8");
const resource = "https://fillip.example/mcp";
const hookUser = "11111111-1111-4111-8111-111111111111";
const otherUser = "12121212-1212-4212-8212-121212121212";
const clientA = "33333333-3333-4333-8333-333333333333";
const clientB = "44444444-4444-4444-8444-444444444444";

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

function reminder(patch: Partial<Reminder> = {}): Reminder {
  return {
    id: randomUUID(),
    ownerId: actor.id,
    kind: "reminder",
    what: "pay the invoice",
    context: null,
    timezone: "UTC",
    fireAt: "2026-10-12T15:00:00.000Z",
    recurrence: null,
    channel: "email",
    status: "active",
    holdUntil: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    completedAt: null,
    ...patch
  };
}

function freeUser(store: MemoryFillipStore) {
  store.contacts.set(actor.id, blankContact(actor.id, {
    email: actor.email,
    emailVerified: true,
    plan: "free",
    subscriptionStatus: "none",
    unsubscribed: false
  }));
}

type CapMode = "return-id" | "keep" | "vanish" | "both-fail";

function overCap(mode: CapMode) {
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
  const deleted: string[] = [];
  const prefers: string[] = [];
  let failedRead = false;
  const db: Db = async (pathname, options) => {
    const method = options?.method ?? "GET";
    const params = new URLSearchParams(pathname.split("?")[1] ?? "");
    if (pathname.includes("/rest/v1/profiles") && method === "GET") {
      return [{ plan: "free", subscription_status: "none", unsubscribed: false, emails_sent_in_period: 0, default_channel: "email" }];
    }
    if (pathname.includes("/rest/v1/profiles") || pathname.includes("created_at=gte")) return [];
    if (pathname.includes("/rest/v1/reminders") && method === "POST") {
      const body = JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>;
      stored.set(String(body.id), body);
      return [body];
    }
    if (pathname.includes("/rest/v1/reminders") && method === "DELETE") {
      const id = decodeURIComponent((params.get("id") ?? "").replace(/^eq\./, ""));
      const prefer = new Headers(options?.headers).get("prefer") ?? "";
      prefers.push(prefer);
      deleted.push(id);
      if (mode === "keep") return [];
      stored.delete(id);
      if (mode === "both-fail") throw new Error("delete exploded");
      if (mode === "return-id") return [{ id }];
      return [];
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
      if (mode === "both-fail" && !failedRead) {
        failedRead = true;
        throw new Error("read exploded");
      }
      const row = stored.get(id);
      return row ? [row] : [];
    }
    return [];
  };
  return { db, deleted, prefers, olderId, stored };
}

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
  return new Promise<{ status: number; text: string; www?: string }>((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method,
      headers: { ...headers, "content-length": Buffer.byteLength(body) }
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const www = res.headers["www-authenticate"];
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
          www: typeof www === "string" ? www : undefined
        });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

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

describe("QA round 7 token hook and the open cap on Postgres", () => {
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

  async function audience(sessionId: string, clientId: string, userId = hookUser, scope = "email") {
    await db.query(
      `insert into auth.sessions (id, user_id, oauth_client_id, scopes)
       values ($1, $2, $3, $4)
       on conflict (id) do update set user_id = excluded.user_id, oauth_client_id = excluded.oauth_client_id, scopes = excluded.scopes`,
      [sessionId, userId, clientId, scope]
    );
    const result = await db.query<{ event: { claims?: { aud?: unknown } } }>(
      "select public.fillip_access_token_hook($1::jsonb) as event",
      [JSON.stringify({
        user_id: userId,
        authentication_method: "oauth_provider/authorization_code",
        claims: { sub: userId, client_id: clientId, session_id: sessionId, scope, aud: "authenticated", role: "authenticated" }
      })]
    );
    return result.rows[0]?.event.claims?.aud;
  }

  async function grant(id: string, userId: string, clientId: string, scope: string, method: string | null, grantedResource: string | null, code: string) {
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, approved_at)
       values ($1::uuid, $1::text, $2::uuid, $3::uuid, $4, 'approved', now() + interval '1 hour', $5, $6, $7, now())`,
      [id, clientId, userId, scope, grantedResource, method, code]
    );
  }

  it("QA-PASS: one S256 grant is bound, a null resource is not, and another user does not collide", async () => {
    const single = randomUUID();
    const bare = randomUUID();
    const neighbor = randomUUID();
    await grant("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", hookUser, clientA, "email", "s256", resource, "code-one");
    expect(await audience(single, clientA)).toEqual(["authenticated", resource]);
    expect(() => validateMcpClaims(tokenFor(["authenticated", resource], single), hookUser, "https://fillip.example/auth/v1", resource)).not.toThrow();

    await db.query("delete from auth.oauth_authorizations where client_id = $1 and user_id = $2", [clientA, hookUser]);
    await grant("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", hookUser, clientA, "email", "s256", null, "code-bare");
    expect(await audience(bare, clientA)).toBe("authenticated");
    expect(() => validateMcpClaims(tokenFor("authenticated", bare), hookUser, "https://fillip.example/auth/v1", resource)).toThrow(/Reconnect Fillip/);

    await grant("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", otherUser, clientA, "email", "s256", resource, "code-other-user");
    expect(await audience(neighbor, clientA, otherUser)).toEqual(["authenticated", resource]);
    await db.query("delete from auth.oauth_authorizations");
  });

  it("QA-FAIL: two live S256 codes for one reconnect still receive the audience", async () => {
    const session = randomUUID();
    await db.query("delete from auth.oauth_authorizations");
    await db.query("delete from fillip_private.oauth_resources where session_id = $1", [session]);
    await grant("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1", hookUser, clientA, "email", "s256", resource, "code-tab-1");
    await grant("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", hookUser, clientA, "email", "s256", resource, "code-tab-2");
    const aud = await audience(session, clientA);
    expect(() => validateMcpClaims(tokenFor(aud, session), hookUser, "https://fillip.example/auth/v1", resource)).not.toThrow();
  });

  it("QA-PASS: twelve real inserts at nine open leave exactly ten", async () => {
    const owner = randomUUID();
    await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [owner]);
    await db.query("insert into public.profiles (id, plan, subscription_status) values ($1, 'free', 'none') on conflict do nothing", [owner]);
    const older: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const id = randomUUID();
      older.push(id);
      await db.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
         values ($1, $2, 'reminder', $3, 'UTC', now() + interval '2 days', 'active')`,
        [id, owner, `older-${index}`]
      );
    }
    const clients = await Promise.all(Array.from({ length: 12 }, async () => {
      const client = pgClient();
      await client.connect();
      return client;
    }));
    try {
      const results = await Promise.all(clients.map(async (client, index) => {
        try {
          const id = randomUUID();
          await client.query(
            `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
             values ($1, $2, 'reminder', $3, 'UTC', now() + interval '3 days', 'active')`,
            [id, owner, `new-${index}`]
          );
          return { ok: true as const };
        } catch (error) {
          return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
        }
      }));
      expect(results.filter((row) => row.ok)).toHaveLength(1);
      expect(results.filter((row) => !row.ok).every((row) => /The free plan allows 10 open reminders/.test(row.message))).toBe(true);
      const active = await db.query("select id from public.reminders where owner_id = $1 and status = 'active'", [owner]);
      expect(active.rows).toHaveLength(10);
      expect(older.every((id) => active.rows.some((row) => row.id === id))).toBe(true);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });

  it("counts 15 simultaneous wrong tries once each and lets through at most five", async () => {
    const emailHash = "a".repeat(64);
    const ipHash = "b".repeat(64);
    const clients = await Promise.all(Array.from({ length: 15 }, async () => {
      const client = pgClient();
      await client.connect();
      return client;
    }));
    try {
      const emailCounts = await Promise.all(clients.map((client) => client.query<{ n: number }>(
        "select public.fillip_bump_code_counter('email', $1, 'wrong') as n",
        [emailHash]
      ).then((result) => result.rows[0]?.n)));
      expect([...emailCounts].sort((left, right) => left - right)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
      expect(emailCounts.filter((count) => count <= 5)).toHaveLength(5);
      const storedEmail = await db.query<{ wrong_count: number }>(
        "select wrong_count from public.fillip_code_attempts where subject_kind = 'email' and subject_hash = $1",
        [emailHash]
      );
      expect(storedEmail.rows[0]?.wrong_count).toBe(15);

      const ipCounts = await Promise.all(clients.map((client) => client.query<{ n: number }>(
        "select public.fillip_bump_code_counter('ip', $1, 'verify') as n",
        [ipHash]
      ).then((result) => result.rows[0]?.n)));
      expect([...ipCounts].sort((left, right) => left - right)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
      const storedIp = await db.query<{ verify_count: number }>(
        "select verify_count from public.fillip_code_attempts where subject_kind = 'ip' and subject_hash = $1",
        [ipHash]
      );
      expect(storedIp.rows[0]?.verify_count).toBe(15);
    } finally {
      await Promise.all(clients.map((client) => client.end()));
    }
  });
});

describe("QA round 7 over-cap read-back", () => {
  async function outcome(mode: CapMode) {
    const hosted = overCap(mode);
    const store = new SupabaseFillipStore(null, hosted.db, "service");
    let thrown = false;
    let view: Awaited<ReturnType<typeof setReminder>> | undefined;
    try {
      view = await setReminder(store, actor, { what: "still due", when: "tomorrow at 9am", timezone: "UTC" }, now, caps);
    } catch (error) {
      thrown = true;
      expect(String(error)).toMatch(/The free plan allows 10 open reminders/);
    }
    const ownId = hosted.deleted[0] ?? "";
    const kept = await store.getReminder(actor.id, ownId);
    expect(hosted.prefers.every((prefer) => prefer.includes("return=representation"))).toBe(true);
    expect(hosted.deleted).toEqual([ownId]);
    expect(hosted.deleted).not.toContain(hosted.olderId);
    if (thrown) {
      expect(view).toBeUndefined();
      expect(kept).toBeNull();
    } else {
      expect(view?.status).toBe("active");
      expect(view?.id).toBe(ownId);
      expect(view?.note).toContain(`You're over the free plan's 10 open reminders. ${upgradePrompt()}`);
      expect(view?.note ?? "").not.toMatch(/may not have been saved/);
      expect(kept?.status).toBe("active");
    }
    expect((await store.getReminder(actor.id, hosted.olderId))?.status).toBe("active");
    return { thrown, kept };
  }

  it("QA-PASS: a DELETE that returns the id is an error, and a vanished row is an error", async () => {
    expect((await outcome("return-id")).thrown).toBe(true);
    expect((await outcome("vanish")).thrown).toBe(true);
  });

  it("QA-PASS: a DELETE that leaves the row returns it with the over-cap note", async () => {
    const result = await outcome("keep");
    expect(result.thrown).toBe(false);
    expect(result.kept?.status).toBe("active");
  });

  it("QA-FAIL: a failed re-read after a delete does not claim a removed row was saved", async () => {
    await outcome("both-fail");
  });
});

describe("QA round 7 edits, refusals, catalog, and sign-in", () => {
  it("QA-PASS: a repeat edit stays on the same id and a rejected create writes nothing", async () => {
    const store = new MemoryFillipStore();
    freeUser(store);
    const created = await setReminder(store, actor, {
      what: "series",
      when: "every weekday at 9am",
      timezone: "UTC"
    }, now, caps);
    const revised = await snoozeOrReschedule(store, actor.id, created.id, undefined, "UTC", now, "reschedule", { repeat: "weekly", what: "series revised" });
    expect(revised.id).toBe(created.id);
    expect(store.reminders).toHaveLength(1);
    expect(store.reminders[0]?.status).toBe("active");
    expect(store.reminders.some((row) => row.what.includes("older copy") || row.status === "cancelled")).toBe(false);

    const posts: string[] = [];
    const db: Db = async (pathname, options) => {
      if ((options?.method ?? "GET") === "POST" && pathname.includes("/rest/v1/reminders")) posts.push(String(options?.body ?? ""));
      if (pathname.includes("/rest/v1/profiles")) {
        return [{ plan: "free", subscription_status: "none", unsubscribed: false, emails_sent_in_period: 0, default_channel: "email" }];
      }
      return [];
    };
    const hosted = new SupabaseFillipStore(null, db, "service");
    await expect(setReminder(hosted, actor, { what: "gap", when: "March 14, 2027 at 2:30am", timezone: "America/New_York" }, now, caps)).rejects.toThrow(/does not exist/);
    await expect(setReminder(hosted, actor, { what: "past", when: "yesterday at 3pm", timezone: "UTC" }, now, caps)).rejects.toThrow(/past/);
    await expect(setReminder(hosted, actor, { what: "junk", when: "not a real time", timezone: "UTC" }, now, caps)).rejects.toThrow(/could not read that time/);
    expect(posts).toEqual([]);
    expect(store.reminders.filter((row) => row.status === "cancelled")).toHaveLength(0);
  });

  it("QA-PASS: plain PKCE is still rejected on Fillip's authorize check", () => {
    expect(pkceRejection("plain", "abc")?.error).toBe("invalid_request");
    expect(pkceRejection("S256", "abc")).toBeNull();
  });
});

describe("QA round 7 HTTP catalog, lockout, and sign-out", () => {
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
  const revoked: string[] = [];
  const logouts: Array<{ url: string; authorization: string }> = [];
  const grants = new Map<string, Array<{ client: { id: string } }>>([
    ["token-a", [{ client: { id: "client-a" } }]],
    ["token-b", [{ client: { id: "client-b" } }]]
  ]);

  beforeAll(async () => {
    stub = http.createServer(async (req, res) => {
      const url = req.url ?? "";
      const body = await readBody(req);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const bearer = String(req.headers.authorization ?? "");
      if (req.method === "POST" && url.startsWith("/auth/v1/otp")) {
        const parsed = JSON.parse(body) as { email?: string };
        if (parsed.email === "missing@example.com") return send(422, { error_code: "otp_disabled", msg: "Signups not allowed for otp" });
        return send(200, {});
      }
      if (req.method === "POST" && url.startsWith("/auth/v1/verify")) {
        const parsed = JSON.parse(body) as { token?: string };
        verifyCalls.push(parsed.token ?? "");
        if (parsed.token !== "123456") return send(400, { error_code: "otp_expired", msg: "Token has expired or is invalid" });
        return send(200, { access_token: "issued-access", refresh_token: "issued-refresh" });
      }
      if (url.startsWith("/auth/v1/user/oauth/grants")) {
        const token = bearer.replace(/^Bearer /, "");
        const rows = grants.get(token) ?? [];
        if (req.method === "DELETE") {
          const id = new URL(url, "http://stub.local").searchParams.get("client_id") ?? "";
          revoked.push(`${token}:${id}`);
          grants.set(token, rows.filter((row) => row.client.id !== id));
          res.writeHead(204);
          res.end();
          return;
        }
        return send(200, rows);
      }
      if (req.method === "POST" && url.startsWith("/auth/v1/logout")) {
        logouts.push({ url, authorization: bearer });
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.startsWith("/auth/v1/user")) {
        if (bearer === "Bearer token-a") return send(200, { id: "user-a", email: "a@example.com" });
        if (bearer === "Bearer token-b") return send(200, { id: "user-b", email: "b@example.com" });
        return send(401, { message: "bad" });
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

  function post(pathname: string, body: unknown, headers: Record<string, string> = {}) {
    return httpCall(base, "POST", pathname, JSON.stringify(body), {
      "content-type": "application/json",
      "x-fillip-request": "1",
      ...headers
    });
  }

  it("QA-PASS: tools/list is public without a bearer and 401 invalid_token with a bad one", async () => {
    const open = await httpCall(base, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    });
    expect(open.status).toBe(200);
    const tools = (JSON.parse(open.text) as { result?: { tools?: Array<{ name: string; title?: string; description?: string; annotations?: { destructiveHint?: boolean } }> } }).result?.tools ?? [];
    const deleting = tools.find((tool) => tool.name === "remove_reminder");
    expect(deleting?.title).toBe("Remove reminder");
    expect(deleting?.description).toBe("Stops a reminder and removes it from the user's list. It can be restored for 30 days.");
    expect(deleting?.annotations?.destructiveHint).toBe(false);
    expect(JSON.stringify(deleting)).not.toMatch(/permanently|erases|cannot be undone|destroy|wipe/i);
    const closed = await httpCall(base, "POST", "/mcp", JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: "Bearer not-a-jwt"
    });
    expect(closed.status).toBe(401);
    expect(closed.www ?? "").toContain('error="invalid_token"');
    expect(closed.text).toContain("Authentication required.");
  });

  it("QA-PASS: existing and unknown emails get the same send response", async () => {
    const known = await post("/auth/code/send", { email: "owner@example.com" });
    const unknown = await post("/auth/code/send", { email: "missing@example.com" });
    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(known.text).toBe(JSON.stringify({ ok: true, message: CODE_SENT }));
    expect(unknown.text).toBe(known.text);
    expect(unknown.text).not.toMatch(/otp_disabled|missing@example.com|not found/i);
  }, 15_000);

  it("QA-FAIL: five wrong codes stay locked after a new send and after a changed IP header", async () => {
    const holes: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      const wrong = await post("/auth/code/verify", { email: `net${index}@example.com`, code: "000000" }, { "x-forwarded-for": "203.0.113.10" });
      expect(wrong.status).toBe(400);
    }
    const shifted = await post("/auth/code/verify", { email: "fresh@example.com", code: "123456" }, { "x-forwarded-for": "203.0.113.99" });
    if (shifted.status !== 429) holes.push(`X-Forwarded-For changed the verify lock to ${shifted.status}`);

    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (attempts[index]?.subject_kind === "ip") attempts.splice(index, 1);
    }

    const lockedIp = { "x-forwarded-for": "198.51.100.20" };
    await post("/auth/code/send", { email: "locked@example.com" }, lockedIp);
    for (let index = 0; index < 5; index += 1) {
      const wrong = await post("/auth/code/verify", { email: "locked@example.com", code: "000000" }, lockedIp);
      expect(wrong.status).toBe(index === 4 ? 429 : 400);
    }
    const otherIp = await post("/auth/code/verify", { email: "locked@example.com", code: "123456" }, { "x-forwarded-for": "198.51.100.21" });
    if (otherIp.status !== 429 || !otherIp.text.includes(CODE_LOCKED)) holes.push(`a new IP header cleared the five-wrong lock (${otherIp.status})`);
    const again = await post("/auth/code/send", { email: "locked@example.com" }, lockedIp);
    expect(JSON.parse(again.text).message).toBe(CODE_SENT);
    const unlocked = await post("/auth/code/verify", { email: "locked@example.com", code: "123456" }, lockedIp);
    if (unlocked.status !== 429) holes.push(`a new code request cleared the five-wrong lock (${unlocked.status})`);
    expect(holes).toEqual([]);
  }, 20_000);

  it("QA-PASS: sign out everywhere revokes only that user's grants, consent, and sessions", async () => {
    const done = await post("/auth/sign-out-everywhere", {}, { authorization: "Bearer token-a" });
    expect(done.status).toBe(200);
    expect(done.text).toContain("Signed out of every app and device.");
    expect(revoked).toEqual(["token-a:client-a"]);
    expect(grants.get("token-b")).toEqual([{ client: { id: "client-b" } }]);
    expect(logouts).toEqual([{ url: "/auth/v1/logout?scope=global", authorization: "Bearer token-a" }]);
  });

  it("QA-PASS: README residuals match the hook, the code route, and the catalog, and copy has no prices", () => {
    const readme = readFileSync("README.md", "utf8");
    const oauth = readFileSync("supabase/README-oauth.md", "utf8");
    expect(readme).toContain('error="invalid_token"');
    expect(readme).toContain("If that email can sign in, a code is on its way.");
    expect(readme).toContain("otp_disabled");
    expect(readme).toContain("create_user=false");
    expect(readme).toContain("refresh_token_already_used");
    expect(readme).toContain("Sign out everywhere");
    expect(readme).toContain("code_challenge_method");
    expect(oauth).toContain("A new send does not clear that lock.");
    expect(oauth).toContain("however many rows there are");
    expect(oauth).toContain("an issued grant with no resource does not receive the audience");
    expect(oauth).toContain("POST /auth/v1/logout?scope=global");
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
