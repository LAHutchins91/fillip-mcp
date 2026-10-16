function canonical(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

// Call only after Supabase /auth/v1/user has verified the token signature.
export function validateMcpClaims(token: string, userId: string, issuer: string, resource: string | readonly string[], now = Date.now() / 1000) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid connection");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
    sub?: string;
    iss?: string;
    aud?: string | string[];
    role?: string;
    exp?: number;
    client_id?: string;
    session_id?: string;
    scope?: string;
  };
  const resources = (Array.isArray(resource) ? resource : [resource]).map((item) => canonical(String(item)));
  const audience = (Array.isArray(claims.aud) ? claims.aud : [claims.aud]).map((item) => canonical(String(item ?? "")));
  const scopes = typeof claims.scope === "string" ? claims.scope.split(/\s+/).filter(Boolean) : [];
  // A present scope must include email. An omitted scope is accepted when the
  // token is still an OAuth client token: Supabase sometimes leaves scope off
  // the refreshed JWT after the hook has already bound the resource.
  const scopeOk = scopes.includes("email") || scopes.length === 0;
  const issued = typeof claims.iss === "string" ? canonical(claims.iss) : "";
  if (
    claims.sub !== userId ||
    issued !== canonical(issuer) ||
    !resources.some((item) => audience.includes(item)) ||
    claims.role !== "authenticated" ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    !claims.client_id ||
    !claims.session_id ||
    !scopeOk
  ) {
    throw new Error("Reconnect Fillip");
  }
  return claims;
}
