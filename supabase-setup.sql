-- ============================================================
-- Kaawn practice sync — Supabase setup (run once in SQL Editor)
-- ============================================================
-- Design: zero-knowledge. The server stores ONE row per user holding
-- an AES-GCM ciphertext encrypted in the browser. No birth data, no
-- practice names, no plaintext dates ever reach this database.
--
-- Dashboard steps (one-time):
--   1. Create a project (choose an EU region if your users are EU).
--   2. Authentication → Sign In / Up → enable "Anonymous sign-ins".
--   3. Authentication → URL Configuration → set Site URL to your
--      deployed origin (e.g. https://kaawn.app) so magic links return.
--   4. Run this file in the SQL Editor.
--   5. Paste the project URL + anon key into KAAWN_SYNC in index.html.
--      (The anon key is public by design; row-level security below is
--      what isolates users.)

create table if not exists public.practice_blobs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  ciphertext text        not null,  -- base64 AES-GCM payload (opaque)
  iv         text        not null,  -- base64 96-bit nonce
  updated_at timestamptz not null default now()
);

alter table public.practice_blobs enable row level security;

-- Each authenticated user (anonymous or linked) sees only their row.
create policy "own blob select" on public.practice_blobs
  for select using (auth.uid() = user_id);

create policy "own blob insert" on public.practice_blobs
  for insert with check (auth.uid() = user_id);

create policy "own blob update" on public.practice_blobs
  for update using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own blob delete" on public.practice_blobs
  for delete using (auth.uid() = user_id);

-- Right-to-erasure: deleting the auth user cascades to the blob.
-- (Dashboard → Authentication → Users → delete, or the admin API.)
