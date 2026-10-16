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

function event(sessionId: string, clientId: string, scope = "email") {
  return {
    user_id: user,
    authentication_method: "oauth_provider/authorization_code",
    claims: {
      sub: user,
      client_id: clientId,
      session_id: sessionId,
      scope,
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

  async function audience(sessionId: string, clientId: string, scope = "email"): Promise<unknown> {
    await db.query(
      `insert into auth.sessions (id, user_id, oauth_client_id, scopes)
       values ($1, $2, $3, $4)
       on conflict (id) do update set oauth_client_id = excluded.oauth_client_id, scopes = excluded.scopes`,
      [sessionId, user, clientId, scope]
    );
    const result = await db.query<{ event: { claims?: { aud?: unknown } } }>(
      "select public.fillip_access_token_hook($1::jsonb) as event",
      [JSON.stringify(event(sessionId, clientId, scope))]
    );
    return result.rows[0]?.event.claims?.aud;
  }

  async function setLatest(clientId: string, id: string, resource: string | null, method: string | null = "s256", scope = "email") {
    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientId]);
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, created_at, approved_at)
       values ($1::uuid, $1::text, $2::uuid, $3::uuid, $4, 'approved', now() + interval '1 hour', $5, $6, $7, now(), now())`,
      [id, clientId, user, scope, resource, method, `code-${id}`]
    );
  }

  it("lets the auth admin read only the grant columns the hook uses", async () => {
    const granted = await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema = 'auth' and table_name = 'oauth_authorizations' and grantee = 'supabase_auth_admin' and privilege_type = 'SELECT'
        order by column_name`
    );
    expect(granted.rows.map((row) => row.column_name)).toEqual([
      "authorization_code",
      "authorization_id",
      "client_id",
      "code_challenge_method",
      "expires_at",
      "id",
      "resource",
      "scope",
      "status",
      "user_id"
    ]);
    const sessions = await db.query<{ column_name: string }>(
      `select column_name from information_schema.column_privileges
        where table_schema = 'auth' and table_name = 'sessions' and grantee = 'supabase_auth_admin' and privilege_type = 'SELECT'
        order by column_name`
    );
    expect(sessions.rows.map((row) => row.column_name)).toEqual(["id", "oauth_client_id", "scopes", "user_id"]);
    const extra = await db.query(
      `select 1 from information_schema.role_table_grants
        where table_schema = 'auth' and table_name = 'oauth_authorizations'
          and grantee in ('anon', 'authenticated', 'public') and privilege_type in ('SELECT', 'INSERT', 'UPDATE', 'DELETE')`
    );
    expect(extra.rowCount).toBe(0);
  });

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

  it("binds the issued S256 grant when a pending evil authorization is waiting for the same user and client", async () => {
    const session = "66666666-6666-4666-8666-666666666661";
    const expired = "66666666-6666-4666-8666-666666666662";
    const otherScope = "66666666-6666-4666-8666-666666666663";
    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query("delete from fillip_private.oauth_resources where session_id = $1", [session]);
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, created_at, approved_at)
       values
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', 'evil-pending', $1, $2, 'email', 'pending', now() + interval '1 hour', 'https://evil.example/mcp', 's256', null, now(), null),
         ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', 'real-grant', $1, $2, 'email', 'approved', now() + interval '1 hour', $3, 's256', 'code-real', now(), now())`,
      [clientA, user, expected]
    );
    expect(await audience(session, clientA)).toEqual(["authenticated", expected]);

    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query("delete from fillip_private.oauth_resources where session_id = $1", [expired]);
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, created_at, approved_at)
       values
         ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'evil-expired', $1, $2, 'email', 'approved', now() - interval '1 minute', 'https://evil.example/mcp', 's256', 'code-expired', now() - interval '2 minutes', now() - interval '2 minutes'),
         ('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'real-after-expiry', $1, $2, 'email', 'approved', now() + interval '1 hour', $3, 's256', 'code-live', now(), now())`,
      [clientA, user, expected]
    );
    expect(await audience(expired, clientA)).toEqual(["authenticated", expected]);

    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query("delete from fillip_private.oauth_resources where session_id = $1", [otherScope]);
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, created_at, approved_at)
       values
         ('dddddddd-dddd-4ddd-8ddd-ddddddddddd1', 'evil-other-scope', $1, $2, 'openid', 'approved', now() + interval '1 hour', 'https://evil.example/mcp', 's256', 'code-other', now() - interval '1 minute', now() - interval '1 minute'),
         ('dddddddd-dddd-4ddd-8ddd-ddddddddddd2', 'real-email-scope', $1, $2, 'email', 'approved', now() + interval '1 hour', $3, 'S256', 'code-email', now(), now())`,
      [clientA, user, expected]
    );
    expect(await audience(otherScope, clientA, "email")).toEqual(["authenticated", expected]);
  });

  it("withholds the Fillip audience when the issued grant used plain or missing PKCE, or when two issued grants share a scope", async () => {
    const plain = "77777777-7777-4777-8777-777777777771";
    const missing = "77777777-7777-4777-8777-777777777772";
    const clash = "77777777-7777-4777-8777-777777777773";
    await setLatest(clientA, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1", expected, "plain");
    expect(await audience(plain, clientA)).toBe("authenticated");

    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query("delete from fillip_private.oauth_resources where session_id = $1", [missing]);
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, created_at, approved_at)
       values ($1::uuid, $1::text, $2::uuid, $3::uuid, 'email', 'approved', now() + interval '1 hour', $4, null, 'code-missing', now(), now())`,
      ["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2", clientA, user, expected]
    );
    expect(await audience(missing, clientA)).toBe("authenticated");

    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query("delete from fillip_private.oauth_resources where session_id = $1", [clash]);
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, created_at, approved_at)
       values
         ('ffffffff-ffff-4fff-8fff-fffffffffff1', 'clash-evil', $1, $2, 'email', 'approved', now() + interval '1 hour', 'https://evil.example/mcp', 's256', 'code-clash-evil', now() - interval '1 minute', now() - interval '1 minute'),
         ('ffffffff-ffff-4fff-8fff-fffffffffff2', 'clash-real', $1, $2, 'email', 'approved', now() + interval '1 hour', $3, 's256', 'code-clash-real', now(), now())`,
      [clientA, user, expected]
    );
    expect(await audience(clash, clientA)).toBe("authenticated");
  });

  it("matches the authorization id in the claims and withholds a different id", async () => {
    const goodSession = "88888888-8888-4888-8888-888888888881";
    const badSession = "88888888-8888-4888-8888-888888888882";
    await db.query("delete from auth.oauth_authorizations where client_id = $1", [clientA]);
    await db.query("delete from fillip_private.oauth_resources where session_id in ($1, $2)", [goodSession, badSession]);
    await db.query(
      `insert into auth.oauth_authorizations
         (id, authorization_id, client_id, user_id, scope, status, expires_at, resource, code_challenge_method, authorization_code, created_at, approved_at)
       values
         ('99999999-9999-4999-8999-999999999991', 'named-evil', $1, $2, 'email', 'approved', now() + interval '1 hour', 'https://evil.example/mcp', 's256', 'code-named-evil', now() - interval '1 minute', now() - interval '1 minute'),
         ('99999999-9999-4999-8999-999999999992', 'named-real', $1, $2, 'email', 'approved', now() + interval '1 hour', $3, 's256', 'code-named-real', now(), now())`,
      [clientA, user, expected]
    );
    const base = event(goodSession, clientA);
    await db.query(
      `insert into auth.sessions (id, user_id, oauth_client_id, scopes)
       values ($1, $2, $3, 'email')
       on conflict (id) do update set oauth_client_id = excluded.oauth_client_id`,
      [goodSession, user, clientA]
    );
    const good = await db.query<{ event: { claims?: { aud?: unknown } } }>(
      "select public.fillip_access_token_hook($1::jsonb) as event",
      [JSON.stringify({ ...base, claims: { ...base.claims, authorization_id: "named-real" } })]
    );
    expect(good.rows[0]?.event.claims?.aud).toEqual(["authenticated", expected]);

    await db.query(
      `insert into auth.sessions (id, user_id, oauth_client_id, scopes)
       values ($1, $2, $3, 'email')
       on conflict (id) do update set oauth_client_id = excluded.oauth_client_id`,
      [badSession, user, clientA]
    );
    const bad = await db.query<{ event: { claims?: { aud?: unknown } } }>(
      "select public.fillip_access_token_hook($1::jsonb) as event",
      [JSON.stringify({
        ...event(badSession, clientA),
        claims: { ...event(badSession, clientA).claims, authorization_id: "does-not-exist" }
      })]
    );
    expect(bad.rows[0]?.event.claims?.aud).toBe("authenticated");
  });
});
