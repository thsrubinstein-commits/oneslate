-- Per-user daily message counter for the health-chat coach.
-- Keeps a leaked login (or a runaway loop) from burning the free Gemini quota.
-- Only the edge function (service role) touches it. Idempotent, safe to re-run.

create table if not exists public.coach_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default (now() at time zone 'utc')::date,
  count   int  not null default 0,
  primary key (user_id, day)
);

alter table public.coach_usage enable row level security;
-- no policies: browsers can't read or write it, only the service role can.

create or replace function public.coach_bump(p_user uuid)
returns int
language sql
security definer
set search_path = public
as $$
  insert into public.coach_usage (user_id, day, count)
  values (p_user, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update set count = coach_usage.count + 1
  returning count;
$$;

revoke all on function public.coach_bump(uuid) from public, anon, authenticated;
grant execute on function public.coach_bump(uuid) to service_role;

-- old rows aren't useful, trim anything older than 30 days on each run
delete from public.coach_usage where day < (now() at time zone 'utc')::date - 30;
