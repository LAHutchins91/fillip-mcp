/**
 * The access-token hook adds the Fillip resource only when the requested
 * resource string-equals mcp_resource. Local Postgres has no Supabase OAuth
 * tables, so this stands them in and calls the function.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const hook = readFileSync(new URL("../supabase/oauth_resource_binding.sql", import.meta.url), "utf8");
const database = "fillip_oauth_hook";
const expected = "https://fillip.example/mcp";
const user = "11111111-1111-4111-8111-111111111111";
const clientA = "33333333-3333-4333-8333-333333333333";
const clientB = "44444444-4444-4444-8444-444444444444";

function client(db: string) {
  return new pg.Client({ host: "127.0.0.1", user: "fillip_qa", password: "fillip_qa", database: db });
}

const bootstrap = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create table if not exists auth.sessions (
  id uuid primary key,
  user_id uuid
);
create table if not exists auth.oauth_authorizations (
  id uuid primary key,
  client_id uuid,
  user_id uuid,
  status text,
  expires_at timestamptz,
  resource text,
  created_at timestamptz not null default now(),
  approved_at timestamptz
);
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin nologin;
  end if;
end
$$;
`;

async function recreate() {
  const admin = client("postgres");
  await admin.connect();
  try {
    await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [database]
    );
    await admin.query(`drop database if exists ${database}`);
    await admin.query(`create database ${database}`);
  } finally {
    await admin.end();
  }
}

function event(sessionId: string, clientId: string) {
  return {
    user_id: user,
    authentication_method: "oauth_provider/authorization_code",
    claims: {
      sub: user,
      client_id: clientId,
      session_id: sessionId,
      aud: "authenticated",
      role: "authenticated"
    }
  };
}

describe("OAuth resource audience", () => {
  const db = client(database);

  beforeAll(async () => {
    await recreate();
    await db.connect();
    await db.query(bootstrap);
    await db.query(hook);
    await db.query("update fillip_private.settings set value = $1 where key = 'mcp_resource'", [expected]);
  });

  afterAll(async () => {
    await db.end().catch(() => undefined);
    const admin = client("postgres");
    await admin.connect();
    try {
      await admin.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [database]
      );
      await admin.query(`drop database if exists ${database}`);
    } finally {
      await admin.end();
    }
  });

  async function audience(sessionId: string, clientId: string): Promise<unknown> {
    await db.query("insert into auth.sessions (id, user_id) values ($1, $2) on conflict do nothing", [sessionId, user]);
    const result = await db.query<{ event: { claims?: { aud?: unknown } } }>(
      "select public.fillip_access_token_hook($1::jsonb) as event",
      [JSON.stringify(event(sessionId, clientId))]
    );
    return result.rows[0]?.event.claims?.aud;
  }

  async function setLatest(clientId: string, id: string, resource: string | null) {
    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientId]);
    await db.query(
      `insert into auth.oauth_authorizations (id, client_id, user_id, status, expires_at, resource, created_at, approved_at)
       values ($1, $2, $3, 'approved', now() + interval '1 hour', $4, now(), now())`,
      [id, clientId, user, resource]
    );
  }

  it("adds the Fillip audience only for an exact resource, including refresh, and not for another client", async () => {
    const omitted = "55555555-5555-4555-8555-555555555551";
    const evil = "55555555-5555-4555-8555-555555555552";
    const slash = "55555555-5555-4555-8555-555555555553";
    const exact = "55555555-5555-4555-8555-555555555554";
    const refresh = "55555555-5555-4555-8555-555555555555";
    const crossed = "55555555-5555-4555-8555-555555555556";

    await setLatest(clientA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", null);
    expect(await audience(omitted, clientA)).toBe("authenticated");

    await setLatest(clientA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2", "https://evil.example/mcp");
    expect(await audience(evil, clientA)).toBe("authenticated");

    await setLatest(clientA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3", `${expected}/`);
    expect(await audience(slash, clientA)).toBe("authenticated");

    await setLatest(clientA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa4", expected);
    expect(await audience(exact, clientA)).toEqual(["authenticated", expected]);

    await db.query("insert into auth.sessions (id, user_id) values ($1, $2) on conflict do nothing", [refresh, user]);
    await db.query(
      "insert into fillip_private.oauth_resources (session_id, resource) values ($1, $2)",
      [refresh, expected]
    );
    await setLatest(clientA, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa6", "https://evil.example/mcp");
    expect(await audience(refresh, clientA)).toEqual(["authenticated", expected]);

    await setLatest(clientB, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa5", expected);
    expect(await audience(crossed, clientA)).toBe("authenticated");
  });

  it("does not bind a code when another unexpired authorization names a different resource", async () => {
    const session = "66666666-6666-4666-8666-666666666661";
    const expired = "66666666-6666-4666-8666-666666666662";
    const blank = "66666666-6666-4666-8666-666666666663";
    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query(
      `insert into auth.oauth_authorizations (id, client_id, user_id, status, expires_at, resource, created_at, approved_at)
       values
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', $1, $2, 'approved', now() + interval '1 hour', 'https://evil.example/mcp', now() - interval '2 minutes', now() - interval '2 minutes'),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', $1, $2, 'approved', now() + interval '1 hour', $3, now(), now())`,
      [clientA, user, expected]
    );
    expect(await audience(session, clientA)).toBe("authenticated");

    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query(
      `insert into auth.oauth_authorizations (id, client_id, user_id, status, expires_at, resource, created_at, approved_at)
       values
         ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', $1, $2, 'approved', now() - interval '1 minute', 'https://evil.example/mcp', now() - interval '2 minutes', now() - interval '2 minutes'),
         ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', $1, $2, 'approved', now() + interval '1 hour', $3, now(), now())`,
      [clientA, user, expected]
    );
    expect(await audience(expired, clientA)).toEqual(["authenticated", expected]);

    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query("delete from fillip_private.oauth_resources where session_id = $1", [blank]);
    await db.query(
      `insert into auth.oauth_authorizations (id, client_id, user_id, status, expires_at, resource, created_at, approved_at)
       values
         ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', $1, $2, 'approved', now() + interval '1 hour', null, now() - interval '1 minute', now() - interval '1 minute'),
         ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', $1, $2, 'approved', now() + interval '1 hour', $3, now(), now())`,
      [clientA, user, expected]
    );
    expect(await audience(blank, clientA)).toEqual(["authenticated", expected]);
  });
});
