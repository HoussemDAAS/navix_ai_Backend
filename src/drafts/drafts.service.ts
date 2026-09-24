import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { JobsService, JobRecord } from '../jobs/jobs.service';
import { AnalyticsService } from '../analysis/analytics.service';
import {
  AiService,
  DraftGenerationDirectionPayload,
  DraftGenerationResponse,
} from '../ai/ai.service';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { CreateFeedbackDto, FeedbackAction } from './dto/create-feedback.dto';

export type DraftStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface DraftRow {
  id: string;
  direction_id: string | null;
  caption_text: string;
  video_script: string | null;
  user_feedback_notes: string | null;
  status: DraftStatus;
  hook_alternatives: string[];
  cta_alternatives: string[];
  created_at: string;
  updated_at?: string;
}

export interface FeedbackRow {
  id: string;
  draft_id: string;
  action: FeedbackAction;
  notes: string | null;
  created_at: string;
}

interface DirectionRow {
  id: string;
  brief_id: string;
  title_pillar: string;
  angle: string;
  format: string;
  rationale: string | null;
  hook_suggestion: string | null;
  cta_suggestion: string | null;
}

const FEEDBACK_THRESHOLD_FOR_BRAND_MEMORY = 3;

@Injectable()
export class DraftsService {
  private readonly logger = new Logger(DraftsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly jobsService: JobsService,
    private readonly aiService: AiService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async generateDrafts(
    projectId: string,
    userId: string,
    directionIds: string[],
  ): Promise<JobRecord> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    const client = this.supabaseService.getClient();

    // Load directions + their brief, ensure they belong to this project
    const { data: directions, error: dirError } = await client
      .from('content_directions')
      .select(
        'id, brief_id, title_pillar, angle, format, rationale, hook_suggestion, cta_suggestion, analysis_briefs!inner(project_id)',
      )
      .in('id', directionIds);

    if (dirError) {
      this.logger.error(
        `Failed to fetch directions for project ${projectId}: ${dirError.message}`,
      );
      throw new Error(`Failed to fetch directions: ${dirError.message}`);
    }

    if (!directions || directions.length === 0) {
      throw new NotFoundException('No directions found for the provided IDs');
    }

    if (directions.length !== directionIds.length) {
      throw new BadRequestException('One or more direction IDs are invalid');
    }

    for (const d of directions as unknown as Array<{
      analysis_briefs: { project_id: string } | { project_id: string }[];
    }>) {
      const ab = d.analysis_briefs;
      const ownerProjectId = Array.isArray(ab)
        ? ab[0]?.project_id
        : ab?.project_id;
      if (ownerProjectId !== projectId) {
        throw new ForbiddenException(
          'One or more directions do not belong to this project',
        );
      }
    }

    // Load brand_kit (optional)
    const { data: brandKit, error: bkError } = await client
      .from('brand_kits')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (bkError && bkError.code !== 'PGRST116') {
      this.logger.error(
        `Failed to fetch brand kit for project ${projectId}: ${bkError.message}`,
      );
      throw new Error(`Failed to fetch brand kit: ${bkError.message}`);
    }

    const directionsList = directions as unknown as DirectionRow[];

    const job = await this.jobsService.createJob(
      projectId,
      'draft_generation',
      {
        project_id: projectId,
        direction_ids: directionIds,
      },
    );

    this.logger.log(
      `Draft generation job created: ${job.id} project=${projectId} directions=${directionIds.length}`,
    );

    this.executeGeneration(
      job.id,
      projectId,
      directionsList,
      (brandKit as Record<string, unknown> | null) ?? null,
    ).catch((err) => {
      this.logger.error(
        `Background draft generation failed for job ${job.id}: ${(err as Error).message}`,
      );
    });

    return job;
  }

  async getDrafts(projectId: string, userId: string): Promise<DraftRow[]> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('drafts')
      .select(
        '*, content_directions!inner(id, title_pillar, angle, format, brief_id, analysis_briefs!inner(project_id))',
      )
      .eq('content_directions.analysis_briefs.project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(
        `Failed to fetch drafts for project ${projectId}: ${error.message}`,
      );
      throw new Error(`Failed to fetch drafts: ${error.message}`);
    }

    return (data ?? []).map((row) => {
      const r = row as Record<string, unknown>;
      // Keep the direction's identity for the Library; drop the ownership join
      const joined = r.content_directions as
        | { id: string; title_pillar: string; angle: string | null; format: string | null }
        | null
        | undefined;
      if (joined) {
        r.direction = {
          id: joined.id,
          title_pillar: joined.title_pillar,
          angle: joined.angle,
          format: joined.format,
        };
      }
      delete r.content_directions;
      return r as unknown as DraftRow;
    });
  }

  async updateDraft(
    projectId: string,
    draftId: string,
    userId: string,
    dto: UpdateDraftDto,
  ): Promise<DraftRow> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    const draft = await this.getDraftWithProjectCheck(draftId, projectId);

    if (
      dto.status === undefined &&
      dto.caption_text === undefined &&
      dto.video_script === undefined &&
      dto.user_feedback_notes === undefined
    ) {
      throw new BadRequestException('No fields to update');
    }

    if (dto.status !== undefined) {
      if (draft.status !== 'PENDING') {
        throw new BadRequestException(
          `Cannot transition draft from ${draft.status} to ${dto.status}. Only PENDING drafts can be approved or rejected.`,
        );
      }
    }

    const update: Record<string, unknown> = {};
    if (dto.status !== undefined) update.status = dto.status;
    if (dto.caption_text !== undefined) update.caption_text = dto.caption_text;
    if (dto.video_script !== undefined) update.video_script = dto.video_script;
    if (dto.user_feedback_notes !== undefined) {
      update.user_feedback_notes = dto.user_feedback_notes;
    }

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('drafts')
      .update(update)
      .eq('id', draftId)
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(
        `Failed to update draft ${draftId}: ${error?.message ?? 'unknown'}`,
      );
      throw new Error(`Failed to update draft: ${error?.message ?? 'unknown'}`);
    }

    return data as DraftRow;
  }

  async addFeedback(
    projectId: string,
    draftId: string,
    userId: string,
    dto: CreateFeedbackDto,
  ): Promise<FeedbackRow> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    await this.getDraftWithProjectCheck(draftId, projectId);

    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('feedback')
      .insert({
        draft_id: draftId,
        action: dto.action,
        notes: dto.notes ?? null,
      })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(
        `Failed to insert feedback for draft ${draftId}: ${error?.message ?? 'unknown'}`,
      );
      throw new Error(
        `Failed to insert feedback: ${error?.message ?? 'unknown'}`,
      );
    }

    const feedback = data as FeedbackRow;

    // Check accumulated feedback for project — auto-trigger brand memory update
    void this.maybeTriggerBrandMemoryUpdate(projectId).catch((err) => {
      this.logger.error(
        `Failed checking brand memory trigger for project ${projectId}: ${(err as Error).message}`,
      );
    });

    return feedback;
  }

  private async maybeTriggerBrandMemoryUpdate(
    projectId: string,
  ): Promise<void> {
    const client = this.supabaseService.getClient();

    // Count feedback rows for this project (joined through drafts -> directions -> briefs)
    const { data: feedbackRows, error: fbError } = await client
      .from('feedback')
      .select(
        'id, action, notes, draft_id, drafts!inner(caption_text, content_directions!inner(brief_id, analysis_briefs!inner(project_id)))',
      )
      .eq('drafts.content_directions.analysis_briefs.project_id', projectId);

    if (fbError) {
      this.logger.error(
        `Failed to count feedback for project ${projectId}: ${fbError.message}`,
      );
      return;
    }

    const total = feedbackRows?.length ?? 0;
    if (total < FEEDBACK_THRESHOLD_FOR_BRAND_MEMORY) {
      this.logger.debug(
        `Feedback count=${total} below threshold=${FEEDBACK_THRESHOLD_FOR_BRAND_MEMORY} for project ${projectId}`,
      );
      return;
    }

    // Avoid double-firing: skip if a brand_memory_update job is currently pending/active
    const { data: activeJobs, error: jobErr } = await client
      .from('jobs')
      .select('id, status')
      .eq('project_id', projectId)
      .eq('type', 'brand_memory_update')
      .in('status', ['pending', 'active']);

    if (jobErr) {
      this.logger.error(
        `Failed checking active brand_memory jobs for project ${projectId}: ${jobErr.message}`,
      );
      return;
    }

    if (activeJobs && activeJobs.length > 0) {
      this.logger.log(
        `Brand memory update already in-flight for project ${projectId}, skipping`,
      );
      return;
    }

    const { data: brandKit, error: bkError } = await client
      .from('brand_kits')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (bkError && bkError.code !== 'PGRST116') {
      this.logger.error(
        `Failed to fetch brand kit for project ${projectId}: ${bkError.message}`,
      );
      return;
    }

    if (!brandKit) {
      this.logger.log(
        `No brand kit found for project ${projectId} — skipping brand memory update`,
      );
      return;
    }

    const feedbackPayload = (feedbackRows ?? []).map((row) => {
      const r = row as unknown as {
        action: FeedbackAction;
        notes: string | null;
        draft_id: string;
        drafts: { caption_text: string } | { caption_text: string }[];
      };
      const draft = Array.isArray(r.drafts) ? r.drafts[0] : r.drafts;
      return {
        draft_id: r.draft_id,
        caption_text: draft?.caption_text ?? '',
        action: r.action,
        notes: r.notes,
      };
    });

    const job = await this.jobsService.createJob(
      projectId,
      'brand_memory_update',
      {
        project_id: projectId,
        feedback_count: feedbackPayload.length,
      },
    );

    this.logger.log(
      `Brand memory update job auto-triggered: ${job.id} for project ${projectId} feedbackCount=${feedbackPayload.length}`,
    );

    void this.executeBrandMemoryUpdate(
      job.id,
      projectId,
      feedbackPayload,
      brandKit as Record<string, unknown>,
    ).catch((err) => {
      this.logger.error(
        `Background brand memory update failed jobId=${job.id}: ${(err as Error).message}`,
      );
    });
  }

  private async executeBrandMemoryUpdate(
    jobId: string,
    projectId: string,
    feedback: Array<{
      draft_id: string;
      caption_text: string;
      action: FeedbackAction;
      notes: string | null;
    }>,
    currentBrandKit: Record<string, unknown>,
  ): Promise<void> {
    const start = Date.now();
    try {
      this.logger.log(
        `Starting brand memory update jobId=${jobId} project=${projectId}`,
      );
      await this.jobsService.setActive(jobId);

      const result = await this.aiService.updateBrandMemory({
        project_id: projectId,
        feedback,
        current_brand_kit: currentBrandKit,
      });

      const updates: Record<string, unknown> = {
        ...(result.updated_preferences ?? {}),
      };
      if (Array.isArray(result.learned_patterns)) {
        updates.learned_patterns = result.learned_patterns;
      }

      if (Object.keys(updates).length > 0) {
        const client = this.supabaseService.getClient();
        const { error: updateErr } = await client
          .from('brand_kits')
          .update(updates)
          .eq('project_id', projectId);

        if (updateErr) {
          throw new Error(
            `Failed to persist brand memory: ${updateErr.message}`,
          );
        }
      }

      await this.jobsService.setCompleted(jobId, {
        applied_keys: Object.keys(updates),
      });
      this.logger.log(
        `Brand memory update completed jobId=${jobId} in ${Date.now() - start}ms`,
      );
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.error(
        `Brand memory update failed jobId=${jobId}: ${errorMessage}`,
      );
      await this.jobsService.setFailed(jobId, errorMessage);
    }
  }

  private async executeGeneration(
    jobId: string,
    projectId: string,
    directions: DirectionRow[],
    brandKit: Record<string, unknown> | null,
  ): Promise<void> {
    const start = Date.now();

    try {
      this.logger.log(
        `Starting draft generation jobId=${jobId} project=${projectId} directions=${directions.length}`,
      );
      await this.jobsService.setActive(jobId);

      const payload: DraftGenerationDirectionPayload[] = directions.map(
        (d) => ({
          id: d.id,
          title_pillar: d.title_pillar,
          angle: d.angle,
          format: d.format,
          // The AI DirectionData schema requires rationale — never omit it
          rationale: d.rationale ?? '',
          hook_suggestion: d.hook_suggestion,
          cta_suggestion: d.cta_suggestion,
        }),
      );

      const grounding = await this.analyticsService.groundingFor(projectId);
      const result: DraftGenerationResponse =
        await this.aiService.generateDrafts({
          project_id: projectId,
          directions: payload,
          brand_kit: brandKit ?? {},
          ...grounding,
        });

      const incoming = Array.isArray(result?.drafts) ? result.drafts : [];

      if (incoming.length === 0) {
        throw new Error('AI service returned no drafts');
      }

      // Map each draft back to a direction by title_pillar fallback (best-effort)
      const rows = incoming.map((d, idx) => {
        const fallback = directions[Math.min(idx, directions.length - 1)];
        const matched = directions.find(
          (dir) => dir.title_pillar === d.direction_title,
        );
        const directionId = (matched ?? fallback).id;
        return {
          direction_id: directionId,
          caption_text: d.caption_text,
          video_script: d.video_script ?? null,
          hook_alternatives: Array.isArray(d.hook_alternatives)
            ? d.hook_alternatives
            : [],
          cta_alternatives: Array.isArray(d.cta_alternatives)
            ? d.cta_alternatives
            : [],
          status: 'PENDING' as DraftStatus,
        };
      });

      const client = this.supabaseService.getClient();
      const { data: inserted, error: insertError } = await client
        .from('drafts')
        .insert(rows)
        .select('*');

      if (insertError) {
        throw new Error(`Failed to persist drafts: ${insertError.message}`);
      }

      await this.jobsService.setCompleted(jobId, {
        drafts_count: inserted?.length ?? 0,
      });

      this.logger.log(
        `Draft generation completed jobId=${jobId} count=${inserted?.length ?? 0} in ${Date.now() - start}ms`,
      );
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.error(
        `Draft generation failed jobId=${jobId}: ${errorMessage}`,
      );
      await this.jobsService.setFailed(jobId, errorMessage);
    }
  }

  private async getDraftWithProjectCheck(
    draftId: string,
    projectId: string,
  ): Promise<DraftRow> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('drafts')
      .select(
        '*, content_directions!inner(brief_id, analysis_briefs!inner(project_id))',
      )
      .eq('id', draftId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Draft ${draftId} not found`);
    }

    const row = data as unknown as DraftRow & {
      content_directions: {
        analysis_briefs: { project_id: string } | { project_id: string }[];
      };
    };

    const ab = row.content_directions?.analysis_briefs;
    const ownerProjectId = Array.isArray(ab)
      ? ab[0]?.project_id
      : ab?.project_id;

    if (ownerProjectId !== projectId) {
      throw new ForbiddenException('Draft does not belong to this project');
    }

    const { content_directions: _omit, ...clean } = row;
    void _omit;
    return clean as DraftRow;
  }

  private async getProjectWithOwnershipCheck(
    projectId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if ((data as Record<string, unknown>).user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }

    return data as Record<string, unknown>;
  }
}
