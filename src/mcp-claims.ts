// Call only after Supabase /auth/v1/user has verified the token signature.
export function validateMcpClaims(token: string, userId: string, issuer: string, resource: string, now = Date.now() / 1000) {
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
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const scopes = typeof claims.scope === "string" ? claims.scope.split(" ") : [];
  if (
    claims.sub !== userId ||
    claims.iss !== issuer ||
    !audience.includes(resource) ||
    claims.role !== "authenticated" ||
    typeof claims.exp !== "number" ||
    claims.exp <= now ||
    !claims.client_id ||
    !claims.session_id ||
    !scopes.includes("email")
  ) {
    throw new Error("Reconnect Fillip");
  }
  return claims;
}
