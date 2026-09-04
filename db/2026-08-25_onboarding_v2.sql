-- Onboarding v2: social profile links (any platform) or "I'm new" path with a
-- richer niche description, plus seed accounts for discovery.
-- Run in the Supabase SQL editor (project ituecleocjmzyowwnqrm) or via MCP.

alter table public.profiles
  add column if not exists facebook_handle      text,
  add column if not exists has_social_presence  boolean not null default true,
  add column if not exists niche_description    text,
  add column if not exists keywords             text[]  not null default '{}',
  add column if not exists seed_accounts        text[]  not null default '{}';

alter table public.projects
  add column if not exists facebook_handle      text,
  add column if not exists niche_description    text,
  add column if not exists keywords             text[]  not null default '{}',
  add column if not exists seed_accounts        text[]  not null default '{}';

-- Avatars persisted at discovery time (Instagram/TikTok CDN URLs expire).
insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

-- Allow public reads of the avatars bucket.
do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'avatars_public_read'
  ) then
    create policy avatars_public_read on storage.objects
      for select using (bucket_id = 'avatars');
  end if;
end $$;
