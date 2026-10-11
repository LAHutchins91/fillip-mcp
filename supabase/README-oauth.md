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
5. Authentication → URL configuration: add `APP_BASE_URL` and `APP_BASE_URL/oauth/consent` as redirect URLs. Enable the Google provider if you want one-click Google sign-in.
6. After the public URL changes, update `mcp_resource`, then disconnect clients at `/connections` and connect again.
