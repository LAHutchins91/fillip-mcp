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
        "digest_owner_delete",
        "digest_owner_select",
        "profiles_select",
        "reminders_owner_delete",
        "reminders_owner_select"
      ]);
      for (const row of policies.rows) {
        expect(row.qual ?? "", row.polname).toMatch(/select auth\.uid\(\)/i);
        if (row.chk) expect(row.chk, row.polname).toMatch(/select auth\.uid\(\)/i);
      }
      const attempts = await db.query<{ rls: boolean }>(`
        select c.relrowsecurity as rls
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'fillip_code_attempts'
      `);
      expect(attempts.rows[0]?.rls).toBe(true);
      const attemptRead = await db.query<{ ok: boolean }>(
        "select has_table_privilege('authenticated', 'public.fillip_code_attempts', 'SELECT') as ok"
      );
      expect(attemptRead.rows[0]?.ok).toBe(false);
      const attemptColumns = await db.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'fillip_code_attempts'
      `);
      const attemptNames = attemptColumns.rows.map((row) => row.column_name);
      expect(attemptNames).toContain("subject_hash");
      expect(attemptNames).not.toContain("email");
      expect(attemptNames).not.toContain("code");
      const functions = await db.query<{ proname: string; proconfig: string[] | null }>(`
        select p.proname, p.proconfig
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
        order by p.proname
      `);
      expect(functions.rows.map((row) => row.proname)).toEqual(expect.arrayContaining([
        "fillip_claim_sendable",
        "fillip_enforce_open_cap",
        "fillip_purge_removed",
        "fillip_reserve_ping",
        "fillip_set_mail_opt_in",
        "handle_new_fillip_user"
      ]));
      const removedColumns = await db.query<{ column_name: string }>(`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'reminders'
          and column_name in ('removed_at', 'resume_status')
      `);
      expect(removedColumns.rows.map((row) => row.column_name).sort()).toEqual(["removed_at", "resume_status"]);
      const statusCheck = await db.query<{ def: string }>(`
        select pg_get_constraintdef(oid) as def
        from pg_constraint
        where conname = 'reminders_status_check'
      `);
      expect(statusCheck.rows[0]?.def ?? "").toContain("removed");
      const purgeIndex = await db.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname = 'public' and indexname = 'reminders_removed_purge'"
      );
      expect(purgeIndex.rows).toHaveLength(1);
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

  it("rejects an authenticated insert and update on reminders and still allows select and delete", async () => {
    const db = client(database);
    await db.connect();
    const owner = "11111111-1111-4111-8111-111111111111";
    const reminderId = "12121212-1212-4121-8121-121212121212";
    try {
      await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [owner]);
      await db.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
         values ($1, $2, 'reminder', 'Own', 'UTC', now() + interval '1 day', 'active')`,
        [reminderId, owner]
      );
      await db.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
      await db.query("set role authenticated");
      await expect(db.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
         values ('13131313-1313-4131-8131-131313131313', $1, 'reminder', 'Blocked', 'UTC', now() + interval '1 day', 'active')`,
        [owner]
      )).rejects.toThrow(/permission denied|42501/);
      await expect(db.query("update public.reminders set what = 'nope' where id = $1", [reminderId])).rejects.toThrow(/permission denied|42501/);
      const seen = await db.query("select id from public.reminders where id = $1", [reminderId]);
      expect(seen.rowCount).toBe(1);
      const removed = await db.query("delete from public.reminders where id = $1", [reminderId]);
      expect(removed.rowCount).toBe(1);
    } finally {
      await db.query("reset role").catch(() => undefined);
      await db.end();
    }
  });

  it("lets only one of two connections pass the free open cap, and reserves two pings", async () => {
    const owner = "14141414-1414-4141-8141-141414141414";
    const setup = client(database);
    await setup.connect();
    try {
      await setup.query("insert into auth.users (id) values ($1) on conflict do nothing", [owner]);
      await setup.query(
        `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
         select gen_random_uuid(), $1, 'reminder', 'n' || g, 'UTC', now() + interval '1 day', 'active'
         from generate_series(1, 9) g`,
        [owner]
      );
    } finally {
      await setup.end();
    }
    const left = client(database);
    const right = client(database);
    await left.connect();
    await right.connect();
    try {
      const insert = `insert into public.reminders (id, owner_id, kind, what, timezone, fire_at, status)
        values (gen_random_uuid(), $1, 'reminder', $2, 'UTC', now() + interval '1 day', 'active')`;
      const raced = await Promise.allSettled([
        left.query(insert, [owner, "tenth"]),
        right.query(insert, [owner, "eleventh"])
      ]);
      expect(raced.filter((result) => result.status === "rejected")).toHaveLength(1);
      const active = await left.query(
        "select count(*)::int as n from public.reminders where owner_id = $1 and status = 'active'",
        [owner]
      );
      expect(active.rows[0]?.n).toBe(10);
      const period = "2026-10-01T00:00:00.000Z";
      const [first, second] = await Promise.all([
        left.query("select public.fillip_reserve_ping($1::uuid, 30, $2::timestamptz, null::integer, null::timestamptz) as n", [owner, period]),
        right.query("select public.fillip_reserve_ping($1::uuid, 30, $2::timestamptz, null::integer, null::timestamptz) as n", [owner, period])
      ]);
      const counts = [first.rows[0]?.n, second.rows[0]?.n].map(Number).sort((a, b) => a - b);
      expect(counts).toEqual([1, 2]);
      const stored = await left.query("select emails_sent_in_period from public.profiles where id = $1", [owner]);
      expect(stored.rows[0]?.emails_sent_in_period).toBe(2);
    } finally {
      await left.end();
      await right.end();
    }
  });

  it("folds the daily cap into the same profile update as the monthly counter", async () => {
    const owner = "15151515-1515-4151-8151-151515151515";
    const db = client(database);
    await db.connect();
    try {
      await db.query("insert into auth.users (id) values ($1) on conflict do nothing", [owner]);
      const period = "2026-10-01T00:00:00.000Z";
      const day = "2026-10-11T00:00:00.000Z";
      const call = (dailyMax: number) => db.query<{ n: number | null }>(
        "select public.fillip_reserve_ping($1::uuid, 30, $2::timestamptz, $3::integer, $4::timestamptz) as n",
        [owner, period, dailyMax, day]
      );
      const first = await call(1);
      expect(first.rows[0]?.n).toBe(1);
      const second = await call(1);
      expect(second.rows[0]?.n).toBe(-1);
      const stored = await db.query<{ emails_sent_in_period: number; emails_sent_today: number }>(
        "select emails_sent_in_period, emails_sent_today from public.profiles where id = $1",
        [owner]
      );
      expect(stored.rows[0]).toEqual({ emails_sent_in_period: 1, emails_sent_today: 1 });
      const gone = await db.query<{ n: number }>(`
        select count(*)::int as n
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = 'fillip_reserve_ping'
          and pg_get_function_identity_arguments(p.oid) = 'owner uuid, max_count integer, period_start timestamp with time zone'
      `);
      expect(gone.rows[0]?.n).toBe(0);
      const still = await call(1);
      expect(still.rows[0]?.n).toBe(-1);
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
