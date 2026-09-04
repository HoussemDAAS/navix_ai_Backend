-- Fix: match_embeddings failed with `column reference "id" is ambiguous`,
-- which silently broke ALL RAG retrieval (rag.py catches the error and
-- returns empty context, so agents ran ungrounded).
--
-- Run this in the Supabase SQL editor (project ituecleocjmzyowwnqrm).
--
-- Drops every existing overload (whatever its signature), then recreates the
-- function with fully qualified columns. The return shape intentionally has no
-- `id` column — rag.py only reads chunk_text / similarity / source_type.

do $$
declare
  fn record;
begin
  for fn in
    select oid::regprocedure as sig
    from pg_proc
    where proname = 'match_embeddings'
      and pronamespace = 'public'::regnamespace
  loop
    execute 'drop function ' || fn.sig;
  end loop;
end $$;

create function public.match_embeddings(
  query_embedding vector(1536),
  match_project_id uuid,
  match_count int default 8,
  match_threshold double precision default 0.4,
  filter_source_types text[] default null
)
returns table (
  chunk_text text,
  source_type text,
  metadata jsonb,
  similarity double precision
)
language sql
stable
as $$
  select
    e.chunk_text,
    e.source_type,
    e.metadata,
    1 - (e.embedding <=> query_embedding) as similarity
  from public.embeddings e
  where e.project_id = match_project_id
    and (filter_source_types is null or e.source_type = any (filter_source_types))
    and 1 - (e.embedding <=> query_embedding) >= match_threshold
  order by e.embedding <=> query_embedding asc
  limit greatest(match_count, 1)
$$;
