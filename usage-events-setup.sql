-- ============================================================
-- Kaawn usage funnel — Supabase setup (run once in SQL Editor)
-- ============================================================
-- Design: anonymous, write-only product analytics.
--   • One row per event: a random per-pageload session id (sid),
--     an event name, a timestamp. Nothing else.
--   • sid lives only in page memory — no cookie, no localStorage,
--     no device id, no cross-visit linkage, and NEVER the auth
--     user id. Events cannot be joined to practice_blobs.
--   • Clients may only INSERT. No select/update/delete policy
--     exists, so the anon key can never read anything back.
--   • The client honors Do Not Track / Global Privacy Control
--     before sending (see index.html head script).

create table if not exists public.usage_events (
  id         bigint generated always as identity primary key,
  sid        uuid        not null,  -- random per page load, memory-only
  event      text        not null check (event ~ '^[a-z0-9_]{1,32}$'),
  created_at timestamptz not null default now()
);

alter table public.usage_events enable row level security;

-- Write-only for clients: anyone may insert a well-formed event;
-- nobody on the anon key may read, change, or delete anything.
create policy "insert events" on public.usage_events
  for insert to anon, authenticated with check (true);

-- Daily counts, for the dashboard SQL editor.
create or replace view public.usage_daily
  with (security_invoker = true) as
  select created_at::date as day, event, count(*) as n
  from public.usage_events
  group by 1, 2
  order by 1 desc, 3 desc;

-- Per-visit funnel over the last 30 days (run ad hoc in SQL editor):
--   select
--     count(distinct sid) filter (where event = 'visit')             as visits,
--     count(distinct sid) filter (where event = 'begin_tapped')      as began,
--     count(distinct sid) filter (where event = 'chart_computed')    as charted,
--     count(distinct sid) filter (where event = 'natal_report')      as read_report,
--     count(distinct sid) filter (where event = 'devotion_complete') as practiced,
--     count(distinct sid) filter (where event = 'sync_enabled')      as synced
--   from public.usage_events
--   where created_at > now() - interval '30 days';
--
-- Retention hygiene: aggregate insight rarely needs raw rows older
-- than ~6 months. Prune ad hoc with:
--   delete from public.usage_events where created_at < now() - interval '180 days';
