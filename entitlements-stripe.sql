-- ============================================================
-- Kaawn Companion — Stripe columns (run once in SQL Editor,
-- after entitlements-setup.sql)
-- ============================================================
-- Lets the webhook (supabase/functions/stripe-webhook) find the
-- entitlement row for subscription renewals and cancellations.
-- No RLS changes: clients can still only read their own row and
-- can still never write 'companion'.

alter table public.entitlements
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;

create index if not exists entitlements_stripe_customer_idx
  on public.entitlements (stripe_customer_id);
