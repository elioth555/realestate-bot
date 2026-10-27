-- Saved client searches and per-search listing states.
-- Apply once in the Supabase SQL editor. Additive only: no existing table is changed.
-- Access is server-side only (server actions using SUPABASE_SECRET_KEY): RLS is on with no policies,
-- and anon/authenticated get no grants, so the publishable key cannot read client details.

create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 120),
  transaction_type text not null check (transaction_type in ('rent', 'sale')),
  filters jsonb not null default '{}'::jsonb,
  sort text not null default 'newest' check (sort in ('newest', 'price-asc', 'price-desc', 'surface-desc')),
  client_name text check (char_length(client_name) <= 120),
  client_phone text check (char_length(client_phone) <= 40),
  client_email text check (char_length(client_email) <= 200),
  notes text check (char_length(notes) <= 2000),
  last_checked_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists saved_searches_created_at_idx on public.saved_searches (created_at desc);

-- No row = unseen. listing_id is the properties.id of a source listing behind the card.
create table if not exists public.saved_search_listing_states (
  saved_search_id uuid not null references public.saved_searches (id) on delete cascade,
  listing_id text not null check (char_length(listing_id) between 1 and 64),
  state text not null check (state in ('viewed', 'sent', 'rejected')),
  updated_at timestamptz not null default now(),
  primary key (saved_search_id, listing_id)
);

alter table public.saved_searches enable row level security;
alter table public.saved_search_listing_states enable row level security;

revoke all on public.saved_searches from anon, authenticated;
revoke all on public.saved_search_listing_states from anon, authenticated;
grant select, insert, update, delete on public.saved_searches to service_role;
grant select, insert, update, delete on public.saved_search_listing_states to service_role;
