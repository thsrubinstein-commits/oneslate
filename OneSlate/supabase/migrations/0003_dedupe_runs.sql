-- 0003_dedupe_runs.sql
-- One-time cleanup: the `runs` table accumulated duplicate rows for the same
-- Strava activity (e.g. an earlier import left strava_id-null twins next to the
-- newly-synced rows, and NULLs are distinct under the unique constraint so both
-- survived). This removes the duplicates and re-asserts the uniqueness guarantee.
-- Safe to run more than once.

-- 1) Collapse rows that represent the same activity for a user (same start time
--    and distance), keeping the most complete/most-recent one: prefer a row that
--    HAS a strava_id, then the newest synced_at.
with ranked as (
  select ctid,
         row_number() over (
           partition by user_id, started_at, distance_km
           order by (strava_id is not null) desc,
                    synced_at desc nulls last,
                    ctid desc
         ) as rn
  from public.runs
)
delete from public.runs r
using ranked
where r.ctid = ranked.ctid
  and ranked.rn > 1;

-- 2) Re-assert the unique constraint (no-op if it already exists). Now that the
--    duplicates are gone this will succeed even if it previously failed to apply.
do $$ begin
  alter table public.runs
    add constraint runs_user_strava_id_key unique (user_id, strava_id);
exception
  when duplicate_object then null;
  when duplicate_table  then null;
end $$;
