/**
 * supabase/schema.sql is re-run on hosted projects. A second apply used to
 * die on create policy because the policy already existed.
 */
import { readFileSync } from "node:fs";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const database = "fillip_schema_reapply";

function client(db: string) {
  return new pg.Client({
    host: "127.0.0.1",
    user: "fillip_qa",
    password: "fillip_qa",
    database: db
  });
}

const bootstrap = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid
language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;
`;

async function recreateDatabase() {
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

describe("schema re-run", () => {
  it("drops every policy before creating it and pins every function search_path", () => {
    const creates = [...schema.matchAll(/create policy (\w+) on (public\.\w+)/gi)];
    expect(creates.length).toBeGreaterThan(0);
    for (const match of creates) {
      const name = match[1];
      const table = match[2];
      const before = schema.slice(0, match.index).toLowerCase();
      expect(before, name).toContain(`drop policy if exists ${name} on ${table}`);
      const body = schema.slice(match.index ?? 0).split(";")[0] ?? "";
      expect(body).toMatch(/\(select auth\.uid\(\)\)/);
      expect(body).not.toMatch(/=\s*auth\.uid\(\)/);
    }
    const functions = [...schema.matchAll(/create or replace function public\.\w+\([\s\S]*?as \$\$/gi)];
    expect(functions.map((match) => match[0])).toEqual(expect.arrayContaining([
      expect.stringMatching(/fillip_enforce_open_cap/)
    ]));
    for (const match of functions) {
      expect(match[0]).toMatch(/set search_path = public/);
    }
  });

  it("applies schema.sql twice on a fresh database", async () => {
    await recreateDatabase();
    const db = client(database);
    await db.connect();
    try {
      await db.query(bootstrap);
      await db.query(schema);
      await db.query(schema);
      const policies = await db.query<{ polname: string; qual: string | null; chk: string | null }>(`
        select pol.polname,
               pg_get_expr(pol.polqual, pol.polrelid) as qual,
               pg_get_expr(pol.polwithcheck, pol.polrelid) as chk
        from pg_policy pol
        join pg_class cls on cls.oid = pol.polrelid
        join pg_namespace nsp on nsp.oid = cls.relnamespace
        where nsp.nspname = 'public'
        order by pol.polname
      `);
      expect(policies.rows.map((row) => row.polname)).toEqual([
        "deliveries_owner_delete",
        "deliveries_owner_select",
        "digest_owner",
        "profiles_select",
        "reminders_owner"
      ]);
      for (const row of policies.rows) {
        expect(row.qual ?? "", row.polname).toMatch(/select auth\.uid\(\)/i);
        if (row.chk) expect(row.chk, row.polname).toMatch(/select auth\.uid\(\)/i);
      }
      const functions = await db.query<{ proname: string; proconfig: string[] | null }>(`
        select p.proname, p.proconfig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
        order by p.proname
      `);
      expect(functions.rows.map((row) => row.proname)).toEqual(expect.arrayContaining([
        "fillip_enforce_open_cap",
        "fillip_set_mail_opt_in",
        "handle_new_fillip_user"
      ]));
      for (const row of functions.rows) {
        expect(row.proconfig ?? [], row.proname).toEqual(expect.arrayContaining(["search_path=public"]));
      }
      const triggers = await db.query<{ tgname: string }>(`
        select tgname from pg_trigger
        where not tgisinternal
          and tgname in ('on_auth_user_created_fillip', 'reminders_open_cap')
        order by tgname
      `);
      expect(triggers.rows.map((row) => row.tgname)).toEqual([
        "on_auth_user_created_fillip",
        "reminders_open_cap"
      ]);
    } finally {
      await db.end();
    }
  });
});

afterAll(async () => {
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
