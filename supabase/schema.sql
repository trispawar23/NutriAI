-- NutriAI restaurant nutrition database.
--
-- Run this in the Supabase SQL editor to stand up the schema the app reads
-- from. Everything is `if not exists` so it is safe to re-run, but note that
-- it will NOT alter tables that already exist. The project this was written
-- against predates the file and is missing the created_at columns and the
-- unique constraints below; the server does not depend on either.

create extension if not exists vector;

-- ---------------------------------------------------------------------------
-- Shared, crowd-sourced restaurant nutrition data
-- ---------------------------------------------------------------------------

create table if not exists restaurants (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists dishes (
  id uuid primary key default gen_random_uuid(),
  restaurant_id uuid not null references restaurants (id) on delete cascade,
  name text not null,
  is_veg boolean not null default false,
  allergens text[] not null default '{}',
  protein_g numeric not null default 0,
  carbs_g numeric not null default 0,
  -- Null when the source never stated fibre. The ranking treats an unverified
  -- fibre number as unknown rather than as zero.
  fibre_g numeric,
  fibre_verified boolean not null default false,
  -- Seeded dishes are 'verified'. Anything contributed through the app lands
  -- as 'pending' and is labelled unreviewed in the UI until promoted.
  status text not null default 'pending' check (status in ('verified', 'pending')),
  -- gemini-embedding-001 returns 3072 dimensions. pgvector's ivfflat and hnsw
  -- indexes both cap out at 2000, so similarity search is a sequential scan.
  embedding vector(3072),
  created_at timestamptz not null default now(),
  unique (restaurant_id, name)
);

create index if not exists dishes_restaurant_id_idx on dishes (restaurant_id);

-- Nearest-neighbour lookup behind the "see a better swap" button.
create or replace function match_dishes(
  query_embedding vector(3072),
  match_count int default 1,
  exclude_id uuid default null
)
returns table (
  id uuid,
  name text,
  protein_g numeric,
  carbs_g numeric,
  fibre_g numeric,
  similarity float
)
language sql
stable
as $$
  select
    d.id,
    d.name,
    d.protein_g,
    d.carbs_g,
    d.fibre_g,
    1 - (d.embedding <=> query_embedding) as similarity
  from dishes d
  where d.embedding is not null
    and (exclude_id is null or d.id <> exclude_id)
  order by d.embedding <=> query_embedding
  limit match_count;
$$;

-- ---------------------------------------------------------------------------
-- Per-device tracking. There is no auth yet, so a device id stands in for a
-- user and rows are not secret.
-- ---------------------------------------------------------------------------

create table if not exists user_goals (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  date date not null,
  calories_g integer not null,
  protein_g integer not null,
  fibre_g integer not null,
  carbs_g integer not null,
  unique (device_id, date)
);

create table if not exists logged_meals (
  id uuid primary key default gen_random_uuid(),
  device_id text not null,
  date date not null,
  name text not null,
  restaurant text,
  protein_g numeric,
  carbs_g numeric,
  fibre_g numeric,
  source text not null check (source in ('verified', 'estimated', 'self_logged')),
  created_at timestamptz not null default now()
);

create index if not exists logged_meals_device_date_idx on logged_meals (device_id, date);

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table restaurants enable row level security;
alter table dishes enable row level security;
alter table user_goals enable row level security;
alter table logged_meals enable row level security;

-- The nutrition database is public to read. Writes go through the API server
-- with the service key so extracted dishes are validated and embedded first.
drop policy if exists "restaurants are public" on restaurants;
create policy "restaurants are public" on restaurants for select using (true);

drop policy if exists "dishes are public" on dishes;
create policy "dishes are public" on dishes for select using (true);

-- Until there is auth, the client writes its own goals and meals directly.
drop policy if exists "anyone can manage goals" on user_goals;
create policy "anyone can manage goals" on user_goals for all using (true) with check (true);

drop policy if exists "anyone can manage meals" on logged_meals;
create policy "anyone can manage meals" on logged_meals for all using (true) with check (true);
