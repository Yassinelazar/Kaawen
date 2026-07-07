-- ============================================================
-- Kaawn Companion — entitlements (run once in SQL Editor)
-- ============================================================
-- One row per auth user. Three states the client derives from it:
--   trial      now() < trial_started_at + 7 days  (and plan = 'none')
--   companion  plan = 'companion' and (plan_expires_at is null or future)
--   none       otherwise
--
-- Trust model:
--   • The client may INSERT its own row exactly once, and only with
--     plan = 'none' — that insert IS the trial start. No update or
--     delete policy exists for clients, so a trial can never be
--     restarted and a plan can never be self-granted.
--   • 'companion' is written only by the payment provider's webhook
--     using the service role (bypasses RLS).
--   • The taste day is client-side only (localStorage) by design —
--     someone clearing storage to re-taste was never a customer.

create table if not exists public.entitlements (
  user_id          uuid primary key references auth.users (id) on delete cascade,
  trial_started_at timestamptz not null default now(),
  plan             text not null default 'none' check (plan in ('none', 'companion')),
  plan_expires_at  timestamptz
);

alter table public.entitlements enable row level security;

create policy "own entitlement select" on public.entitlements
  for select using (auth.uid() = user_id);

create policy "own entitlement insert" on public.entitlements
  for insert with check (auth.uid() = user_id and plan = 'none');

-- No update/delete policies: plan changes arrive only via service role.
