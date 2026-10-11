-- Fillip reminder tables. Run in the Supabase SQL editor for a hosted Fillip.
-- Access tokens stay OAuth bearer tokens. This file does not create API keys.

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  plan text not null default 'none',
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

create policy profiles_select on public.profiles for select to authenticated using (id = auth.uid());

create policy reminders_owner on public.reminders for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy digest_owner on public.digest_settings for all to authenticated
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.reminders to authenticated;
grant select, insert, update, delete on public.digest_settings to authenticated;

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
