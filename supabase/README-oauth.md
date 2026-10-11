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
7. Fillip does not publish `/.well-known/oauth-authorization-server`. Supabase does, and that document is where PKCE and `authorization_response_iss_parameter_supported` belong. Supabase currently advertises both `S256` and `plain`. Claude, Cursor, ChatGPT, and Grok send `S256`. Fillip cannot remove `plain` from Supabase's document. If the dashboard gains an S256-only switch, turn it on. Authorization codes are single-use and short-lived. Fillip's protected-resource metadata does not advertise `plain` and does not set `authorization_response_iss_parameter_supported`, because that flag is an authorization-server field.
8. The access-token hook binds `aud` to `mcp_resource` when the approved authorization's resource matches, including a refresh whose session row was missing. Another client's authorization does not block the match. After the public URL changes, update `mcp_resource`, then disconnect clients at `/connections` and connect again.
