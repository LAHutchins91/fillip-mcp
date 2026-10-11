/**
 * Account deletion must remove every reminder-owned row, including deliveries.
 * A user-token DELETE on deliveries used to match nothing: RLS is on and,
 * before the owner delete policy, no policy let the row through. PostgREST
 * still returned success. This stand-in applies the policies in schema.sql.
 */
import { readFileSync } from "node:fs";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../src/server.js";
import { SupabaseFillipStore, type Db } from "../src/lib/supabase-store.js";

const schema = readFileSync(new URL("../supabase/schema.sql", import.meta.url), "utf8");
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const userToken = "user-token-a";
const serviceKey = "service-role-test";

type TableName = "profiles" | "reminders" | "deliveries" | "digest_settings";
type Row = Record<string, string | null>;

function ownerDeleteColumn(sql: string, table: string): "owner_id" | "id" | null {
  const match = sql.match(new RegExp(
    `create policy \\w+ on public\\.${table}\\s+for (?:all|delete) to authenticated[\\s\\S]*?using \\((owner_id|id) = auth\\.uid\\(\\)\\)`,
    "i"
  ));
  return match ? match[1] as "owner_id" | "id" : null;
}

function authUsersTables(sql: string): string[] {
  return [...sql.matchAll(/create table if not exists (public\.\w+) \(([\s\S]*?)\n\);/g)]
    .filter(([, , body]) => body.includes("references auth.users"))
    .map(([, name]) => name)
    .sort();
}

function seed(): Record<TableName, Row[]> {
  return {
    profiles: [
      { id: userA, plan: "pro", stripe_customer_id: "cus_a" },
      { id: userB, plan: "free", stripe_customer_id: "cus_b" }
    ],
    reminders: [
      { id: "reminder-a", owner_id: userA, what: "Call Ada" },
      { id: "reminder-b", owner_id: userB, what: "Call Bo" }
    ],
    deliveries: [
      { id: "delivery-linked", owner_id: userA, reminder_id: "reminder-a" },
      { id: "delivery-digest", owner_id: userA, reminder_id: null },
      { id: "delivery-b", owner_id: userB, reminder_id: "reminder-b" }
    ],
    digest_settings: [
      { owner_id: userA, enabled: "true" },
      { owner_id: userB, enabled: "false" }
    ]
  };
}

function eq(url: string, key: string): string | null {
  const match = url.match(new RegExp(`[?&]${key}=eq\\.([^&]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

describe("account deletion", () => {
  const tables = seed();
  let server: Server;
  let base: string;
  const savedEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  function roleOf(init?: RequestInit): "service" | "user" | "other" {
    const headers = new Headers(init?.headers);
    const auth = headers.get("authorization") ?? "";
    if (auth === `Bearer ${serviceKey}`) return "service";
    if (auth === `Bearer ${userToken}`) return "user";
    return "other";
  }

  function applyDelete(table: TableName, column: string, value: string, role: "service" | "user") {
    const policyColumn = ownerDeleteColumn(schema, table);
    tables[table] = tables[table].filter((row) => {
      if (row[column] !== value) return true;
      if (role === "service") return false;
      return !(policyColumn && row[policyColumn] === userA);
    });
  }

  beforeAll(async () => {
    process.env.SUPABASE_URL = "https://delete.supabase.co";
    process.env.SUPABASE_ANON_KEY = "anon-delete";
    process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
    process.env.APP_BASE_URL = "https://fillip.example";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith(base)) return originalFetch(input, init);
      const method = init?.method ?? "GET";
      const role = roleOf(init);
      if (url.includes("/auth/v1/user")) {
        if (role !== "user") return new Response("{}", { status: 401 });
        return new Response(JSON.stringify({ id: userA, email: "a@example.com", email_confirmed_at: "2026-01-01T00:00:00.000Z" }), { status: 200 });
      }
      const table = url.match(/\/rest\/v1\/(profiles|reminders|deliveries|digest_settings)/)?.[1] as TableName | undefined;
      if (table && method === "DELETE" && (role === "service" || role === "user")) {
        const column = eq(url, "owner_id") ? "owner_id" : "id";
        const value = eq(url, column);
        if (!value) return new Response("missing filter", { status: 400 });
        applyDelete(table, column, value, role);
        return new Response(null, { status: 204 });
      }
      return new Response("[]", { status: 200 });
    }) as typeof fetch;
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("names every table that belongs to a user, and only deliveries needed a delete policy", () => {
    expect(authUsersTables(schema)).toEqual([
      "public.deliveries",
      "public.digest_settings",
      "public.profiles",
      "public.reminders"
    ]);
    expect(ownerDeleteColumn(schema, "reminders")).toBe("owner_id");
    expect(ownerDeleteColumn(schema, "digest_settings")).toBe("owner_id");
    expect(ownerDeleteColumn(schema, "deliveries")).toBe("owner_id");
    expect(schema).toMatch(/grant delete on public\.deliveries to authenticated/);
    // The profile is the billing row. There is no user delete policy, and reminder deletion leaves it.
    expect(ownerDeleteColumn(schema, "profiles")).toBeNull();
    const support = schema.match(/create table if not exists public\.fillip_support_requests \(([\s\S]*?)\n\);/);
    expect(support?.[1] ?? "").not.toMatch(/owner_id/);
  });

  it("refuses a user-token store delete so a missing policy cannot succeed as a no-op", async () => {
    const calls: string[] = [];
    const db: Db = async (pathname, options) => {
      calls.push(`${options?.method ?? "GET"} ${pathname}`);
      return [];
    };
    const store = new SupabaseFillipStore(userA, db, "user");
    await expect(store.deleteOwnerData(userA)).rejects.toThrow(/service role/);
    expect(calls).toEqual([]);
  });

  it("removes every reminder, delivery, and digest row for that user and leaves everyone else", async () => {
    const response = await fetch(`${base}/api/reminders`, { method: "DELETE", headers: { authorization: `Bearer ${userToken}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: true });

    expect(tables.reminders.filter((row) => row.owner_id === userA)).toEqual([]);
    expect(tables.deliveries.filter((row) => row.owner_id === userA)).toEqual([]);
    expect(tables.digest_settings.filter((row) => row.owner_id === userA)).toEqual([]);
    expect(tables.profiles.filter((row) => row.id === userA)).toEqual([{ id: userA, plan: "pro", stripe_customer_id: "cus_a" }]);

    expect(tables.reminders.filter((row) => row.owner_id === userB)).toHaveLength(1);
    expect(tables.deliveries.filter((row) => row.owner_id === userB)).toHaveLength(1);
    expect(tables.digest_settings.filter((row) => row.owner_id === userB)).toHaveLength(1);
    expect(tables.profiles.filter((row) => row.id === userB)).toHaveLength(1);
  });
});
