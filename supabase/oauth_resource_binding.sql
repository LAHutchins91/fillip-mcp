-- Bind OAuth tokens to this MCP resource while preserving the authenticated audience for RLS.
-- Same hook shape as Desk. The resource URL is a setting, not a hardcoded host.
-- After applying: Authentication → Auth Hooks → Customize Access Token Claims → public.fillip_access_token_hook
-- Then set the resource to the public APP_BASE_URL || '/mcp' and reconnect clients.

create schema if not exists fillip_private;
revoke all on schema fillip_private from public, anon, authenticated;
grant usage on schema fillip_private to supabase_auth_admin;

create table if not exists fillip_private.oauth_resources (
  session_id uuid primary key references auth.sessions (id) on delete cascade,
  resource text not null
);
grant select, insert on fillip_private.oauth_resources to supabase_auth_admin;

create table if not exists fillip_private.settings (
  key text primary key,
  value text not null
);
grant select on fillip_private.settings to supabase_auth_admin;

insert into fillip_private.settings (key, value)
values ('mcp_resource', 'http://localhost:3000/mcp')
on conflict (key) do nothing;

create or replace function public.fillip_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn$
declare
  claims jsonb := event->'claims';
  cid text := claims->>'client_id';
  sid uuid;
  resource text;
  expected text;
  matching boolean;
begin
  if cid is null or cid = '' then
    return event;
  end if;

  select s.value into expected from fillip_private.settings s where s.key = 'mcp_resource';
  if expected is null or expected = '' then
    return event;
  end if;

  sid := (claims->>'session_id')::uuid;
  select r.resource into resource from fillip_private.oauth_resources r where r.session_id = sid;

  -- Bind on the approved authorization for this resource, including a refresh
  -- whose session row was never stored. Another client's authorization must
  -- not make bool_and fail the match. Trailing slashes are ignored.
  if resource is null then
    select exists (
      select 1
        from auth.oauth_authorizations a
       where a.client_id = cid::uuid
         and a.user_id = (claims->>'sub')::uuid
         and a.status::text = 'approved'
         and a.expires_at > now()
         and rtrim(a.resource, '/') = rtrim(expected, '/')
    ) into matching;
    if matching and sid is not null then
      resource := expected;
      insert into fillip_private.oauth_resources (session_id, resource)
      values (sid, resource)
      on conflict do nothing;
    end if;
  end if;

  if resource is not null then
    claims := jsonb_set(claims, '{aud}', jsonb_build_array('authenticated', resource));
  end if;

  return jsonb_set(event, '{claims}', claims);
end
$fn$;

revoke all on function public.fillip_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.fillip_access_token_hook(jsonb) to supabase_auth_admin;
