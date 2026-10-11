-- Bind OAuth tokens to this MCP resource while preserving the authenticated audience for RLS.
-- Same hook shape as Desk. The resource URL is a setting, not a hardcoded host.
-- After applying: Authentication → Auth Hooks → Customize Access Token Claims → public.fillip_access_token_hook
-- Then set the resource to the public APP_BASE_URL || '/mcp' and reconnect clients.
--
-- The custom access token hook payload (Supabase Auth v0hooks.CustomAccessTokenInput) carries
-- user_id, authentication_method, and claims. The current payload does not carry
-- code_challenge_method or authorization_id. If claims include authorization_id or
-- authorizationId, that row is the only match. Otherwise the grant is every unexpired
-- approved issued row for that user, client, and scope. Claims that identify the set are
-- session_id, client_id, sub, and scope.
-- On an authorization_code exchange, IssueRefreshToken writes auth.sessions.oauth_client_id and
-- auth.sessions.scopes from that authorization before this hook runs. The authorization row is
-- still present: FindOAuthServerAuthorizationByCode requires status = approved, and Approve sets
-- authorization_code. Pending rows have a null authorization_code. code_challenge_method is the
-- auth.code_challenge_method enum, stored lowercase ('s256' or 'plain'). There is no session_id
-- column on auth.oauth_authorizations.

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
  grant_scope text;
  auth_id text;
  matched integer := 0;
  agreed boolean := false;
  s256 boolean := false;
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

  -- Refresh uses only the stored session row, and only when it still equals
  -- mcp_resource. That row is written only for an S256 grant, so a later
  -- approval cannot add the audience and a plain grant cannot gain it on refresh.
  -- A new authorization code is bound from every unexpired, approved, issued
  -- grant for this user, client, and scope. Each of those rows must string-equal
  -- mcp_resource and use code_challenge_method s256. Any number of such rows
  -- still receives the audience. One different or null resource, or one method
  -- other than s256, withholds it. A pending row is not an issued grant.
  -- Trailing slashes are not trimmed. Another client does not count. When the
  -- claims carry an authorization id, that row is the only one matched.
  if resource is not null then
    if resource <> expected then
      resource := null;
    end if;
  elsif coalesce(event->>'authentication_method', '') = 'oauth_provider/authorization_code' and sid is not null then
    grant_scope := nullif(btrim(coalesce(claims->>'scope', '')), '');
    if grant_scope is null then
      select nullif(btrim(coalesce(s.scopes, '')), '') into grant_scope
        from auth.sessions s
       where s.id = sid
         and s.user_id = (claims->>'sub')::uuid
         and (s.oauth_client_id is null or s.oauth_client_id::text = cid);
    end if;

    auth_id := nullif(btrim(coalesce(claims->>'authorization_id', claims->>'authorizationId', '')), '');

    if grant_scope is not null then
      select count(*)::integer,
             bool_and(a.resource is not null and a.resource = expected),
             bool_and(lower(coalesce(a.code_challenge_method::text, '')) = 's256'),
             min(a.resource)
        into matched, agreed, s256, resource
        from auth.oauth_authorizations a
       where a.client_id::text = cid
         and a.user_id = (claims->>'sub')::uuid
         and a.status::text = 'approved'
         and a.authorization_code is not null
         and a.expires_at > now()
         and a.scope = grant_scope
         and (
           auth_id is null
           or a.authorization_id = auth_id
           or a.id::text = auth_id
         );
    end if;

    if matched >= 1 and agreed and s256 and resource = expected then
      insert into fillip_private.oauth_resources (session_id, resource)
      values (sid, resource)
      on conflict do nothing;
    else
      resource := null;
    end if;
  else
    resource := null;
  end if;

  if resource is not null and resource = expected then
    claims := jsonb_set(claims, '{aud}', jsonb_build_array('authenticated', expected));
  end if;

  return jsonb_set(event, '{claims}', claims);
end
$fn$;

revoke all on function public.fillip_access_token_hook(jsonb) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    revoke all on function public.fillip_access_token_hook(jsonb) from service_role;
  end if;
end
$$;
grant execute on function public.fillip_access_token_hook(jsonb) to supabase_auth_admin;

-- The hook runs as security invoker. It needs to read the issued grant and the
-- session row that points at it, and nothing else on those tables.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'auth'
          and table_name = 'oauth_authorizations'
          and column_name = 'code_challenge_method'
     )
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'auth'
          and table_name = 'oauth_authorizations'
          and column_name = 'authorization_id'
     ) then
    grant select (
      id,
      authorization_id,
      client_id,
      user_id,
      scope,
      status,
      authorization_code,
      resource,
      code_challenge_method,
      expires_at
    ) on table auth.oauth_authorizations to supabase_auth_admin;
  end if;
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin')
     and exists (
       select 1 from information_schema.columns
        where table_schema = 'auth'
          and table_name = 'sessions'
          and column_name = 'scopes'
     ) then
    grant select (id, user_id, oauth_client_id, scopes)
      on table auth.sessions to supabase_auth_admin;
  end if;
end
$$;
