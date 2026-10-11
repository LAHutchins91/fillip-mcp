-- Fillip reminder tables. Run in the Supabase SQL editor for a hosted Fillip.
-- Safe to re-run on a project that already has these objects: policies are
-- dropped first, and tables, columns, indexes, functions, triggers, and grants
-- are written so a second run does not fail.
-- Access tokens stay OAuth bearer tokens. This file does not create API keys.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'free',
  subscription_status text not null default 'none',
  stripe_customer_id text,
  stripe_subscription_id text,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  unsubscribed boolean not null default false,
  timezone text not null default 'UTC',
  emails_sent_in_period integer not null default 0,
  email_period_start timestamptz,
  updated_at timestamptz not null default now()
);

alter table public.profiles add column if not exists emails_sent_in_period integer not null default 0;
alter table public.profiles add column if not exists email_period_start timestamptz;
alter table public.profiles add column if not exists billing_event_created bigint not null default 0;

create table if not exists public.reminders (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('reminder', 'follow_up')),
  what text not null,
  context text,
  timezone text not null,
  fire_at timestamptz not null,
  recurrence jsonb,
  status text not null check (status in ('active', 'fired', 'completed', 'cancelled', 'paused')),
  hold_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create table if not exists public.deliveries (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  reminder_id uuid references public.reminders (id) on delete cascade,
  dedupe_key text not null unique,
  occurrence_at timestamptz not null,
  status text not null check (status in ('sending', 'sent', 'failed', 'skipped')),
  idempotency_key text not null,
  provider_id text,
  started_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);

create table if not exists public.digest_settings (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  enabled boolean not null default false,
  hour integer not null check (hour >= 0 and hour <= 23),
  minute integer not null check (minute >= 0 and minute <= 59),
  timezone text not null,
  last_sent_on date,
  updated_at timestamptz not null default now()
);

create table if not exists public.fillip_support_requests (
  id uuid primary key,
  email text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists reminders_due on public.reminders (fire_at) where status = 'active';
create index if not exists deliveries_owner_sent on public.deliveries (owner_id, sent_at);

alter table public.profiles enable row level security;
alter table public.reminders enable row level security;
alter table public.deliveries enable row level security;
alter table public.digest_settings enable row level security;
alter table public.fillip_support_requests enable row level security;

-- (select auth.uid()) is evaluated once per statement. A bare auth.uid() is
-- re-checked on every row.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists reminders_owner on public.reminders;
drop policy if exists reminders_owner_select on public.reminders;
create policy reminders_owner_select on public.reminders
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists reminders_owner_delete on public.reminders;
create policy reminders_owner_delete on public.reminders
  for delete to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists digest_owner on public.digest_settings;
drop policy if exists digest_owner_select on public.digest_settings;
create policy digest_owner_select on public.digest_settings
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists digest_owner_delete on public.digest_settings;
create policy digest_owner_delete on public.digest_settings
  for delete to authenticated
  using (owner_id = (select auth.uid()));

-- Authenticated sessions read and delete their own rows. Inserts and updates
-- go through the service role so date, length, recurrence, and plan holds
-- cannot be skipped with the anon key and a user token.
revoke all on table public.profiles from public, anon, authenticated;
grant select on public.profiles to authenticated;
revoke all on table public.reminders from public, anon, authenticated;
grant select, delete on public.reminders to authenticated;
revoke all on table public.digest_settings from public, anon, authenticated;
grant select, delete on public.digest_settings to authenticated;
revoke all on table public.fillip_support_requests from public, anon, authenticated;

-- Deliveries are written by the service role. Owners may delete only their own
-- rows. PostgreSQL requires SELECT as well as DELETE: without a SELECT grant
-- the delete raises 42501, and without a SELECT policy the delete matches
-- nothing because the rows are not visible. The app deletes with the service
-- role, which does not depend on these policies.
drop policy if exists deliveries_owner_select on public.deliveries;
create policy deliveries_owner_select on public.deliveries
  for select to authenticated
  using (owner_id = (select auth.uid()));

drop policy if exists deliveries_owner_delete on public.deliveries;
create policy deliveries_owner_delete on public.deliveries
  for delete to authenticated
  using (owner_id = (select auth.uid()));

revoke insert, update on table public.deliveries from public, anon, authenticated;
grant select on public.deliveries to authenticated;
grant delete on public.deliveries to authenticated;

-- Opt-in flips only the mail flag. It cannot change plan or Stripe ids.
create or replace function public.fillip_set_mail_opt_in(enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to Fillip';
  end if;
  insert into public.profiles (id, unsubscribed)
  values (auth.uid(), not enabled)
  on conflict (id) do update set unsubscribed = not enabled, updated_at = now();
end;
$$;

revoke all on function public.fillip_set_mail_opt_in(boolean) from public, anon;
grant execute on function public.fillip_set_mail_opt_in(boolean) to authenticated;

create or replace function public.handle_new_fillip_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_fillip on auth.users;
create trigger on_auth_user_created_fillip
  after insert on auth.users
  for each row execute function public.handle_new_fillip_user();

-- One row for the shared provider backoff. Service role only. No user can read it.
create table if not exists public.fillip_runtime (
  id integer primary key check (id = 1),
  provider_backoff_until timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.fillip_runtime (id) values (1) on conflict (id) do nothing;

alter table public.fillip_runtime enable row level security;
revoke all on table public.fillip_runtime from public, anon, authenticated;

alter table public.profiles add column if not exists default_channel text not null default 'email';
alter table public.profiles add column if not exists telegram_chat_id text;
alter table public.profiles add column if not exists telegram_link_token text;
alter table public.profiles add column if not exists telegram_link_expires timestamptz;
alter table public.profiles add column if not exists calendar_token text;
alter table public.profiles alter column plan set default 'free';
update public.profiles set plan = 'free' where plan = 'none';

alter table public.reminders add column if not exists channel text not null default 'email';
alter table public.deliveries add column if not exists channel text not null default 'email';

create unique index if not exists profiles_calendar_token on public.profiles (calendar_token) where calendar_token is not null;
create unique index if not exists profiles_telegram_link on public.profiles (telegram_link_token) where telegram_link_token is not null;

-- These flips cannot change plan or Stripe ids.
create or replace function public.fillip_set_default_channel(channel text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to Fillip';
  end if;
  if channel not in ('email', 'telegram', 'both') then
    raise exception 'Choose email, Telegram, or both';
  end if;
  insert into public.profiles (id, default_channel)
  values (auth.uid(), channel)
  on conflict (id) do update set default_channel = excluded.default_channel, updated_at = now();
end;
$$;

create or replace function public.fillip_set_telegram_link(token text, expires timestamptz)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to Fillip';
  end if;
  insert into public.profiles (id, telegram_link_token, telegram_link_expires)
  values (auth.uid(), token, expires)
  on conflict (id) do update
    set telegram_link_token = excluded.telegram_link_token,
        telegram_link_expires = excluded.telegram_link_expires,
        updated_at = now();
end;
$$;

create or replace function public.fillip_clear_telegram()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to Fillip';
  end if;
  update public.profiles
  set telegram_chat_id = null,
      telegram_link_token = null,
      telegram_link_expires = null,
      default_channel = 'email',
      updated_at = now()
  where id = auth.uid();
end;
$$;

create or replace function public.fillip_set_calendar_token(token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to Fillip';
  end if;
  if exists (
    select 1 from public.profiles
    where calendar_token = token and id <> auth.uid()
  ) then
    raise exception 'Fillip could not save that calendar link';
  end if;
  insert into public.profiles (id, calendar_token)
  values (auth.uid(), token)
  on conflict (id) do update set calendar_token = excluded.calendar_token, updated_at = now();
end;
$$;

revoke all on function public.fillip_set_default_channel(text) from public, anon;
revoke all on function public.fillip_set_telegram_link(text, timestamptz) from public, anon;
revoke all on function public.fillip_clear_telegram() from public, anon;
revoke all on function public.fillip_set_calendar_token(text) from public, anon;
grant execute on function public.fillip_set_default_channel(text) to authenticated;
grant execute on function public.fillip_set_telegram_link(text, timestamptz) to authenticated;
grant execute on function public.fillip_clear_telegram() to authenticated;
grant execute on function public.fillip_set_calendar_token(text) to authenticated;

-- One conditional update for the monthly ping counter. A number is the new
-- count. Null means the cap already held. Service role only.
create or replace function public.fillip_reserve_ping(owner uuid, max_count integer, period_start timestamptz)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  next_count integer;
begin
  update public.profiles
  set emails_sent_in_period = case
        when email_period_start is null or email_period_start < period_start then 1
        else emails_sent_in_period + 1
      end,
      email_period_start = case
        when email_period_start is null or email_period_start < period_start then period_start
        else email_period_start
      end,
      updated_at = now()
  where id = owner
    and (
      email_period_start is null
      or email_period_start < period_start
      or emails_sent_in_period < max_count
    )
  returning emails_sent_in_period into next_count;
  return next_count;
end;
$$;

revoke all on function public.fillip_reserve_ping(uuid, integer, timestamptz) from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fillip_reserve_ping(uuid, integer, timestamptz) to service_role;
  end if;
end
$$;

-- Parallel creates must not pass the free open cap. The advisory lock and the
-- profile row lock are per owner, so two transactions cannot both count 9 and insert.
create or replace function public.fillip_enforce_open_cap()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  open_count integer;
  plan text;
  sub_status text;
  cap integer;
begin
  if new.status is distinct from 'active' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext(new.owner_id::text));
  select p.plan, p.subscription_status into plan, sub_status
  from public.profiles p
  where p.id = new.owner_id
  for update;
  if sub_status = 'trialing' or (sub_status = 'active' and plan in ('pro', 'annual')) then
    cap := 100;
  else
    cap := 10;
  end if;
  select count(*) into open_count
  from public.reminders r
  where r.owner_id = new.owner_id and r.status = 'active';
  if open_count >= cap then
    if cap = 10 then
      raise exception 'The free plan allows 10 open reminders.';
    end if;
    raise exception 'Too many reminders are still open. Complete or cancel one first.';
  end if;
  return new;
end;
$$;

drop trigger if exists reminders_open_cap on public.reminders;
create trigger reminders_open_cap
  before insert on public.reminders
  for each row execute function public.fillip_enforce_open_cap();
