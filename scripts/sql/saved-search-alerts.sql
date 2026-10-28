-- Sent email alerts per saved search. Additive only: no existing table or column is changed.
-- Apply once in the Supabase SQL editor. Server-side access only (SUPABASE_SECRET_KEY).
-- One row per source listing behind an emailed card; card_listing_id groups the members of one merged card,
-- so a cross-source duplicate is one alert item and stays alerted even if its representative changes.

create table if not exists public.saved_search_alerts (
  saved_search_id uuid not null references public.saved_searches (id) on delete cascade,
  listing_id text not null check (char_length(listing_id) between 1 and 64),
  card_listing_id text not null check (char_length(card_listing_id) between 1 and 64),
  channel text not null default 'email' check (channel in ('email')),
  sent_at timestamptz not null default now(),
  batch_id uuid not null,
  primary key (saved_search_id, listing_id, channel)
);

create index if not exists saved_search_alerts_batch_idx on public.saved_search_alerts (batch_id);

alter table public.saved_search_alerts enable row level security;

revoke all on public.saved_search_alerts from anon, authenticated;
grant select, insert, update, delete on public.saved_search_alerts to service_role;
