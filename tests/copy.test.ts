import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useStdioTransport } from "../src/transport.js";

async function files(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") return [];
    if (entry.isDirectory()) return files(full);
    return [full];
  }));
  return nested.flat();
}

describe("public copy", () => {
  it("chooses stdio only when stdin is not a terminal", () => {
    expect(useStdioTransport({ isTTY: true })).toBe(false);
    expect(useStdioTransport({ isTTY: false })).toBe(true);
    expect(useStdioTransport({})).toBe(true);
  });

  it("does not print a dollar amount", async () => {
    const roots = ["README.md", "Dockerfile", "glama.json", "server.json", ".env.example", "package.json", "src", "supabase", "vercel.json"];
    const paths = (await Promise.all(roots.map(async (root) => {
      const full = path.join(process.cwd(), root);
      const info = await stat(full);
      return info.isDirectory() ? files(full) : [full];
    }))).flat();
    const offenders: string[] = [];
    for (const file of paths) {
      const text = await readFile(file, "utf8");
      if (/\$\s*\d/.test(text) || /\bUSD\b/.test(text) || /\bdollars?\b/i.test(text)) offenders.push(path.relative(process.cwd(), file));
    }
    expect(offenders).toEqual([]);
  });

  it("names Fillip by Ouroboros and lists every environment variable", async () => {
    const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
    const example = await readFile(path.join(process.cwd(), ".env.example"), "utf8");
    expect(readme).toContain("Fillip by Ouroboros");
    expect(readme).toContain("Fillip, reminders that fire.");
    expect(readme).toContain("https://ouroborosapps.com");
    expect(readme).toContain("Remind me to follow up on this next Tuesday at 2pm, and actually ping me.");
    const keys = example.split("\n").map((line) => line.split("=")[0]?.trim()).filter((key) => key && !key.startsWith("#"));
    const missing = keys.filter((key) => !readme.includes(key ?? ""));
    expect(missing).toEqual([]);
  });
});
