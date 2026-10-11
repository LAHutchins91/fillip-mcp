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
begin
  if cid is null or cid = '' then
    return event;
  end if;

  select s.value into expected from fillip_private.settings s where s.key = 'mcp_resource';
  if expected is null or expected = '' then
    return event;
  end if;

  begin
    sid := (claims->>'session_id')::uuid;
  exception when others then
    sid := null;
  end;

  if sid is not null then
    select r.resource into resource from fillip_private.oauth_resources r where r.session_id = sid;
  end if;

  -- A stored session covers refresh. The audience is added only when that
  -- stored value still equals mcp_resource exactly. A missing session row
  -- uses the latest approved authorization for this client and user, and
  -- only when its resource string-equals mcp_resource. Another client's
  -- authorization does not count. Trailing slashes are not trimmed.
  if resource is null and sid is not null then
    select a.resource into resource
      from auth.oauth_authorizations a
     where a.client_id = cid::uuid
       and a.user_id = (claims->>'sub')::uuid
       and a.status::text = 'approved'
       and a.expires_at > now()
     order by a.created_at desc
     limit 1;
    if resource is not null and resource = expected then
      insert into fillip_private.oauth_resources (session_id, resource)
      values (sid, resource)
      on conflict do nothing;
    else
      resource := null;
    end if;
  end if;

  if resource is not null and resource = expected then
    claims := jsonb_set(claims, '{aud}', jsonb_build_array('authenticated', expected));
  end if;

  return jsonb_set(event, '{claims}', claims);
end
$fn$;

revoke all on function public.fillip_access_token_hook(jsonb) from public, anon, authenticated;
grant execute on function public.fillip_access_token_hook(jsonb) to supabase_auth_admin;
