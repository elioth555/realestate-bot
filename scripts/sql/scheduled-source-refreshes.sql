-- Daily claim for the scheduled source refresh (/api/cron/source-refresh). Additive only: no existing table changes.
-- One row per (Israel calendar date, source); the primary key makes a second claim on the same day fail,
-- so a retried or duplicated cron delivery never starts a second set of Apify runs.
-- Apply once in the Supabase SQL editor. Server-side access only (SUPABASE_SECRET_KEY).

create table if not exists public.scheduled_source_refreshes (
  refresh_date date not null,
  source text not null check (source in ('yad2', 'madlan', 'facebook')),
  status text not null default 'claimed' check (status in ('claimed', 'started', 'partial', 'failed')),
  planned_runs integer not null default 0 check (planned_runs >= 0),
  started_runs integer not null default 0 check (started_runs >= 0),
  run_ids text[] not null default '{}',
  error text check (error is null or char_length(error) <= 2000),
  claimed_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (refresh_date, source)
);

alter table public.scheduled_source_refreshes enable row level security;

revoke all on public.scheduled_source_refreshes from anon, authenticated;
grant select, insert, update, delete on public.scheduled_source_refreshes to service_role;
