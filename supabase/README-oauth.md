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
7. Fillip does not publish `/.well-known/oauth-authorization-server`. Supabase does, and that document is where PKCE and `authorization_response_iss_parameter_supported` belong. Supabase currently advertises both `S256` and `plain`. Claude, Cursor, ChatGPT, and Grok send `S256`. There is no dashboard setting that disables `plain`, and Supabase has approved `plain` authorizations. Fillip cannot remove `plain` from Supabase's document. Fillip rejects a missing `code_challenge`, a missing `code_challenge_method`, and any method other than `S256` on `GET /oauth/authorize`. A successful S256 request stores the proof in a short-lived HttpOnly cookie named `fillip_pkce`. The consent page denies a method or challenge that is actually present and is not exact S256. When both fields are omitted and the cookie is absent, the page still shows Connect. Supabase's authorization details do not include the PKCE fields, and clients that use Supabase's authorization endpoint never pass Fillip's `/oauth/authorize`. Authorization codes are single-use and short-lived. Calling approve after Supabase has already issued a code invalidates that code. Connect follows an existing redirect once and does not approve a second time. Fillip's protected-resource metadata does not advertise `plain` and does not set `authorization_response_iss_parameter_supported`, because that flag is an authorization-server field. Supabase does not send the `iss` parameter.
8. Authentication → Sessions: set the refresh-token reuse interval to 0. A reused refresh token then revokes the chain.
9. The access-token hook adds the Fillip `/mcp` audience only for an authorization-code grant whose latest unexpired approval string-equals `mcp_resource`, and only when no other unexpired approval for that same client and user names a different resource. A null resource on another row does not block. An expired row does not block. A trailing slash does not match. A refresh uses the stored session row only, and only when that stored value still equals the setting, even if a later approval names something else. Another client's authorization cannot cause a match. After the public URL changes, update `mcp_resource`, then disconnect clients at `/connections` and connect again.
10. The consent page shows the approval screen for every `authorization_id` it loads. It does not auto-follow a redirect. If the details already include `redirect_url`, Connect navigates there once and does not call approve again, because a second approve invalidates the single-use code. Supabase's authorize endpoint can still skip the page when a session cookie and an existing grant already exist, because clients build that URL from Supabase's metadata and Fillip cannot add `prompt=consent`. Reusing a stored refresh token is not a new authorization and does not show consent.
