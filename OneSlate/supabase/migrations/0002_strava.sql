-- OneSlate — Strava running sync + structured run storage
-- Run this in Supabase → SQL Editor → New query → Run.
-- Idempotent: safe to re-run. Follows the same RLS model as 0001_sleep.sql —
-- the signed-in owner can READ their own rows; all WRITES come from the edge
-- functions / sync job using the service-role key, which bypasses RLS.

-- ─────────────────────────────────────────────────────────────────────────────
-- runs — one row per activity. Predates versioned migrations, so create-if-missing
-- with the base columns the app already reads, then additively add the rich fields.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.runs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  provider      text not null default 'manual',   -- 'strava' | 'manual'
  name          text,
  type          text,                              -- easy | workout | long | race
  started_at    timestamptz not null,
  distance_km   double precision,
  moving_sec    integer,
  avg_pace_sec_km integer,
  created_at    timestamptz not null default now()
);

-- Rich per-run fields synced from Strava /activities/{id} + /streams.
alter table public.runs add column if not exists strava_id        bigint;
alter table public.runs add column if not exists elapsed_sec      integer;
alter table public.runs add column if not exists avg_hr           integer;
alter table public.runs add column if not exists max_hr           integer;
alter table public.runs add column if not exists avg_cadence      integer;         -- spm (already doubled if run)
alter table public.runs add column if not exists elev_gain_m      double precision;
alter table public.runs add column if not exists max_pace_sec_km  integer;
alter table public.runs add column if not exists perceived_effort integer;         -- Strava perceived_exertion (1-10) or suffer_score
alter table public.runs add column if not exists splits           jsonb;           -- [{km|mi, pace_sec_km, hr, elev_m}]
alter table public.runs add column if not exists stream           jsonb;           -- downsampled ~120pt [{t,pace,hr,elev,cad}]
alter table public.runs add column if not exists raw              jsonb;           -- trimmed Strava summary for debugging
alter table public.runs add column if not exists synced_at        timestamptz;

-- One row per Strava activity per user; lets the sync upsert by (user_id, strava_id).
-- A plain UNIQUE constraint (not a partial index) so PostgREST's ON CONFLICT
-- inference matches. NULLs are distinct in Postgres, so manual runs (strava_id null)
-- are unconstrained and can coexist freely.
do $$ begin
  alter table public.runs add constraint runs_user_strava_id_key unique (user_id, strava_id);
exception when duplicate_table then null; when duplicate_object then null; end $$;
create index if not exists runs_user_started_idx
  on public.runs (user_id, started_at desc);

alter table public.runs enable row level security;

drop policy if exists "own runs read"   on public.runs;
drop policy if exists "own runs insert" on public.runs;
drop policy if exists "own runs delete" on public.runs;
-- Owner can read their runs, and insert/delete their OWN manual runs from the browser.
-- Strava rows are written by the sync function (service-role, bypasses RLS).
create policy "own runs read"   on public.runs for select using (auth.uid() = user_id);
create policy "own runs insert" on public.runs for insert with check (auth.uid() = user_id);
create policy "own runs delete" on public.runs for delete using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- running_settings — weekly goal + mode (app reads it in fetchRunning()).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.running_settings (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  weekly_goal_km  double precision,
  mode            text,
  goal_time_sec   integer,
  goal_distance_km double precision,
  updated_at      timestamptz not null default now()
);
alter table public.running_settings enable row level security;
drop policy if exists "own running_settings rw" on public.running_settings;
create policy "own running_settings rw" on public.running_settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- strava_connections — the browser-readable connection status (NO tokens here).
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.strava_connections (
  user_id         uuid primary key references auth.users(id) on delete cascade,
  athlete_id      bigint,
  athlete_name    text,
  status          text not null default 'active',   -- 'active' | 'reauth_needed'
  scope           text,
  last_synced_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
alter table public.strava_connections enable row level security;
-- Read-only from the browser; writes come from the edge functions (service role).
drop policy if exists "own strava_connection read" on public.strava_connections;
create policy "own strava_connection read" on public.strava_connections
  for select using (auth.uid() = user_id);

-- ─────────────────────────────────────────────────────────────────────────────
-- strava_tokens — access/refresh tokens. SERVICE-ROLE ONLY. No RLS policy at all,
-- so with RLS enabled the anon/authenticated browser role can NEVER read a row.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.strava_tokens (
  user_id       uuid primary key references auth.users(id) on delete cascade,
  access_token  text not null,
  refresh_token text not null,
  expires_at    timestamptz not null,             -- when access_token expires
  scope         text,
  updated_at    timestamptz not null default now()
);
alter table public.strava_tokens enable row level security;
-- Intentionally NO policies → only the service-role key (which bypasses RLS) can touch it.

-- ─────────────────────────────────────────────────────────────────────────────
-- strava_sync_state — incremental watermark + rate-limit accounting
-- (mirrors garmin_sync_state). Browser reads it for the "last error / last synced"
-- signal; the sync function updates it.
-- ─────────────────────────────────────────────────────────────────────────────
create table if not exists public.strava_sync_state (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  last_activity_start timestamptz,                 -- watermark: newest activity start already synced
  requests_15min      integer not null default 0,
  window_15min_start  timestamptz,
  requests_day        integer not null default 0,
  day_start           timestamptz,
  last_synced_at      timestamptz,
  last_error          text,
  updated_at          timestamptz not null default now()
);
alter table public.strava_sync_state enable row level security;
drop policy if exists "own strava_sync_state read" on public.strava_sync_state;
create policy "own strava_sync_state read" on public.strava_sync_state
  for select using (auth.uid() = user_id);

-- Live-update the dashboard the moment a sync writes new runs / status.
do $$ begin
  alter publication supabase_realtime add table public.runs;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.strava_connections;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.strava_sync_state;
exception when duplicate_object then null; end $$;
