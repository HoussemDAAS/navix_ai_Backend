-- 2026-08-25 — analysis_briefs stores the full market-analysis result.
-- The AI service returns content_cadence + key_takeaways in addition to the
-- three jsonb blocks; without these columns the brief insert fails.
-- Paste in the Supabase SQL editor (idempotent).

alter table public.analysis_briefs
  add column if not exists content_cadence text,
  add column if not exists key_takeaways jsonb not null default '[]'::jsonb;
