# Fillip OAuth resource binding

ChatGPT and other hosts expect the access token `aud` to include this server's MCP resource (`APP_BASE_URL/mcp`). The hook in `oauth_resource_binding.sql` does that. It follows the same shape as Desk, and reads the resource from `fillip_private.settings` so the host is not hardcoded.

## Apply once

1. Run `schema.sql` in the Supabase SQL editor.
2. Run `oauth_resource_binding.sql`.
3. Set the resource to the public origin plus `/mcp`:

```sql
update fillip_private.settings
set value = 'https://YOUR_HOST/mcp'
where key = 'mcp_resource';
```

4. Supabase Dashboard → Authentication → Auth Hooks → Customize Access Token Claims → `public.fillip_access_token_hook`.
5. Authentication → URL configuration: add `APP_BASE_URL` and `APP_BASE_URL/oauth/consent` as redirect URLs.
6. Sign-in is an emailed one-time code. Authentication → Providers → Email stays on. Authentication → Emails → Magic Link must include `{{ .Token }}` so the message shows the code. Enable custom SMTP with Resend (`smtp.resend.com`, port 465, username `resend`, password your Resend API key, from-address on the verified domain). That avoids Supabase's built-in email rate limit. Set `FILLIP_AUTH_GOOGLE_ENABLED=true` only after the Google provider is enabled. Until then the consent page does not show Google. Password sign-in remains behind "Use a password instead".
7. Fillip does not publish `/.well-known/oauth-authorization-server`. Supabase does, and that document is where PKCE and `authorization_response_iss_parameter_supported` belong. Supabase currently advertises both `S256` and `plain`. Claude, Cursor, ChatGPT, and Grok send `S256`. There is no dashboard setting that disables `plain`, and Supabase has approved `plain` authorizations. Fillip cannot remove `plain` from Supabase's document. Fillip rejects a missing `code_challenge`, a missing `code_challenge_method`, and any method other than `S256` on `GET /oauth/authorize` and again on the consent page. The consent page calls deny and redirects with `error=invalid_request`. If `getAuthorizationDetails` does not include the PKCE fields, every consent is denied until those fields are present. Authorization codes are single-use and short-lived. Fillip's protected-resource metadata does not advertise `plain` and does not set `authorization_response_iss_parameter_supported`, because that flag is an authorization-server field. Supabase does not send the `iss` parameter.
8. Authentication → Sessions: set the refresh-token reuse interval to 0. A reused refresh token then revokes the chain.
9. The access-token hook adds the Fillip `/mcp` audience only when the requested resource string-equals `mcp_resource`. A trailing slash does not match. A refresh uses the session row when that stored value still equals the setting. Another client's authorization cannot cause a match. After the public URL changes, update `mcp_resource`, then disconnect clients at `/connections` and connect again.
10. The consent page shows the approval screen for every `authorization_id` it loads. It does not auto-follow a redirect. Supabase's authorize endpoint can still skip the page when a session cookie and an existing grant already exist, because clients build that URL from Supabase's metadata and Fillip cannot add `prompt=consent`. Reusing a stored refresh token is not a new authorization and does not show consent.
