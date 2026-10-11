function configuredOrigin(name: string): string {
  return (process.env[name] ?? "").replace(/\/$/, "");
}

/** Public connect copy prefers FILLIP_PUBLIC_ORIGIN when the request base is the legacy host. */
export function canonicalPublicOrigin(appBaseUrl: string): string {
  const base = appBaseUrl.replace(/\/$/, "");
  const legacy = configuredOrigin("FILLIP_LEGACY_ORIGIN");
  const pub = configuredOrigin("FILLIP_PUBLIC_ORIGIN");
  if (pub && legacy && base === legacy) return pub;
  return base;
}

/** Earlier MCP URL, mentioned only when a legacy origin is configured. */
export function legacyMcpUrl(appBaseUrl: string): string | null {
  const base = appBaseUrl.replace(/\/$/, "");
  const legacy = configuredOrigin("FILLIP_LEGACY_ORIGIN");
  const pub = configuredOrigin("FILLIP_PUBLIC_ORIGIN");
  if (!legacy) return null;
  if (base === legacy || (pub && base === pub)) return `${legacy}/mcp`;
  return null;
}
