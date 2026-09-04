-- =============================================================================
-- Navix Backend Migration
-- Modules: directions, drafts, calendar
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. Extend content_directions with selection flag + AI-returned hook/CTA fields
-- -----------------------------------------------------------------------------
ALTER TABLE public.content_directions
  ADD COLUMN IF NOT EXISTS hook_suggestion text,
  ADD COLUMN IF NOT EXISTS cta_suggestion  text,
  ADD COLUMN IF NOT EXISTS selected        boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_content_directions_brief_id
  ON public.content_directions (brief_id);

CREATE INDEX IF NOT EXISTS idx_content_directions_selected
  ON public.content_directions (selected) WHERE selected = true;

-- -----------------------------------------------------------------------------
-- 2. Extend drafts so we can store hook / CTA alternatives returned by the AI
-- -----------------------------------------------------------------------------
ALTER TABLE public.drafts
  ADD COLUMN IF NOT EXISTS hook_alternatives text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS cta_alternatives  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS updated_at        timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_drafts_direction_id
  ON public.drafts (direction_id);

-- Trigger to auto-bump updated_at on UPDATE
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drafts_set_updated_at ON public.drafts;
CREATE TRIGGER trg_drafts_set_updated_at
BEFORE UPDATE ON public.drafts
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 3. Calendar items table
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.calendar_items (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  draft_id     uuid REFERENCES public.drafts(id) ON DELETE SET NULL,
  title        text NOT NULL,
  scheduled_at timestamptz NOT NULL,
  platform     text NOT NULL CHECK (platform IN ('instagram','tiktok','youtube','facebook','linkedin')),
  status       text NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','published','cancelled')),
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calendar_items_project_id
  ON public.calendar_items (project_id);

CREATE INDEX IF NOT EXISTS idx_calendar_items_scheduled_at
  ON public.calendar_items (project_id, scheduled_at);

DROP TRIGGER IF EXISTS trg_calendar_items_set_updated_at ON public.calendar_items;
CREATE TRIGGER trg_calendar_items_set_updated_at
BEFORE UPDATE ON public.calendar_items
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 4. RLS for calendar_items (project-ownership pattern, same as scraped_content)
-- -----------------------------------------------------------------------------
ALTER TABLE public.calendar_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS calendar_items_select_owner ON public.calendar_items;
CREATE POLICY calendar_items_select_owner
  ON public.calendar_items
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = calendar_items.project_id
        AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS calendar_items_insert_owner ON public.calendar_items;
CREATE POLICY calendar_items_insert_owner
  ON public.calendar_items
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = calendar_items.project_id
        AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS calendar_items_update_owner ON public.calendar_items;
CREATE POLICY calendar_items_update_owner
  ON public.calendar_items
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = calendar_items.project_id
        AND p.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = calendar_items.project_id
        AND p.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS calendar_items_delete_owner ON public.calendar_items;
CREATE POLICY calendar_items_delete_owner
  ON public.calendar_items
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM public.projects p
      WHERE p.id = calendar_items.project_id
        AND p.user_id = auth.uid()
    )
  );

-- service_role bypasses RLS automatically — backend uses service-role key.
