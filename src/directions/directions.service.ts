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
import { AiService, DirectionGenerationResponse } from '../ai/ai.service';
import { UpdateDirectionDto } from './dto/update-direction.dto';

export interface DirectionRow {
  id: string;
  brief_id: string;
  title_pillar: string;
  angle: string;
  format: string;
  hook_suggestion: string | null;
  cta_suggestion: string | null;
  rationale: string | null;
  selected: boolean;
  created_at: string;
}

interface AnalysisBriefRow {
  id: string;
  project_id: string;
  [key: string]: unknown;
}

@Injectable()
export class DirectionsService {
  private readonly logger = new Logger(DirectionsService.name);
  private readonly defaultNumDirections = 5;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly jobsService: JobsService,
    private readonly aiService: AiService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  async generateDirections(
    projectId: string,
    userId: string,
    options: { briefId?: string; numDirections?: number },
  ): Promise<JobRecord> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    const client = this.supabaseService.getClient();

    // Step 1: resolve the brief (provided, or latest for this project)
    const brief = await this.withJobFallback(projectId, await this.resolveBrief(projectId, options.briefId));

    // Step 2: fetch brand_kit (optional)
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

    const numDirections = options.numDirections ?? this.defaultNumDirections;

    // Step 3: create job record
    const job = await this.jobsService.createJob(
      projectId,
      'direction_generation',
      {
        project_id: projectId,
        brief_id: brief.id,
        num_directions: numDirections,
      },
    );

    this.logger.log(
      `Direction generation job created: ${job.id} project=${projectId} brief=${brief.id}`,
    );

    // Step 4: fire-and-forget execution
    this.executeGeneration(
      job.id,
      projectId,
      brief,
      (brandKit as Record<string, unknown> | null) ?? null,
      numDirections,
    ).catch((err) => {
      this.logger.error(
        `Background direction generation failed for job ${job.id}: ${(err as Error).message}`,
      );
    });

    return job;
  }

  async getDirections(
    projectId: string,
    userId: string,
  ): Promise<DirectionRow[]> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    const client = this.supabaseService.getClient();

    // Resolve latest brief
    const { data: brief, error: briefError } = await client
      .from('analysis_briefs')
      .select('id')
      .eq('project_id', projectId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (briefError) {
      this.logger.error(
        `Failed to fetch latest brief for project ${projectId}: ${briefError.message}`,
      );
      throw new Error(`Failed to fetch latest brief: ${briefError.message}`);
    }

    if (!brief) {
      return [];
    }

    const { data, error } = await client
      .from('content_directions')
      .select('*')
      .eq('brief_id', (brief as { id: string }).id)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(
        `Failed to fetch directions for brief ${(brief as { id: string }).id}: ${error.message}`,
      );
      throw new Error(`Failed to fetch directions: ${error.message}`);
    }

    return (data ?? []) as DirectionRow[];
  }

  async updateDirection(
    projectId: string,
    directionId: string,
    userId: string,
    dto: UpdateDirectionDto,
  ): Promise<DirectionRow> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    if (dto.selected === undefined) {
      throw new BadRequestException('No fields to update');
    }

    const client = this.supabaseService.getClient();

    // Ensure the direction belongs to a brief in this project
    const { data: existing, error: existErr } = await client
      .from('content_directions')
      .select('id, brief_id, analysis_briefs!inner(project_id)')
      .eq('id', directionId)
      .single();

    if (existErr || !existing) {
      throw new NotFoundException(`Direction ${directionId} not found`);
    }

    const briefProjectId = (
      existing as unknown as {
        analysis_briefs: { project_id: string } | { project_id: string }[];
      }
    ).analysis_briefs;
    const ownerProjectId = Array.isArray(briefProjectId)
      ? briefProjectId[0]?.project_id
      : briefProjectId?.project_id;

    if (ownerProjectId !== projectId) {
      throw new ForbiddenException('Direction does not belong to this project');
    }

    const { data, error } = await client
      .from('content_directions')
      .update({ selected: dto.selected })
      .eq('id', directionId)
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(
        `Failed to update direction ${directionId}: ${error?.message ?? 'unknown'}`,
      );
      throw new Error(
        `Failed to update direction: ${error?.message ?? 'unknown'}`,
      );
    }

    return data as DirectionRow;
  }

  /**
   * The AI direction generator needs content_cadence + key_takeaways. Briefs
   * saved before the analysis_briefs v2 migration lack those columns; the
   * completed market_analysis job still holds the full result.
   */
  private async withJobFallback(projectId: string, brief: AnalysisBriefRow): Promise<AnalysisBriefRow> {
    const hasCadence = typeof brief.content_cadence === 'string';
    const hasTakeaways = Array.isArray(brief.key_takeaways) && brief.key_takeaways.length > 0;
    if (hasCadence && hasTakeaways) return brief;
    const job = await this.jobsService.getLatestJob(projectId, 'market_analysis');
    const output = job?.status === 'completed' ? (job.output ?? {}) : {};
    return {
      ...brief,
      content_cadence: hasCadence ? brief.content_cadence : (output.content_cadence ?? ''),
      key_takeaways: hasTakeaways ? brief.key_takeaways : (output.key_takeaways ?? []),
    };
  }

  private async resolveBrief(
    projectId: string,
    briefId?: string,
  ): Promise<AnalysisBriefRow> {
    const client = this.supabaseService.getClient();

    if (briefId) {
      const { data, error } = await client
        .from('analysis_briefs')
        .select('*')
        .eq('id', briefId)
        .single();

      if (error || !data) {
        throw new NotFoundException(`Analysis brief ${briefId} not found`);
      }
      const row = data as AnalysisBriefRow;
      if (row.project_id !== projectId) {
        throw new ForbiddenException('Brief does not belong to this project');
      }
      return row;
    }

    const { data, error } = await client
      .from('analysis_briefs')
      .select('*')
      .eq('project_id', projectId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.error(
        `Failed to fetch latest brief for project ${projectId}: ${error.message}`,
      );
      throw new Error(`Failed to fetch latest brief: ${error.message}`);
    }

    if (!data) {
      throw new NotFoundException(
        'No analysis brief found for this project. Run market analysis first.',
      );
    }

    return data as AnalysisBriefRow;
  }

  private async executeGeneration(
    jobId: string,
    projectId: string,
    brief: AnalysisBriefRow,
    brandKit: Record<string, unknown> | null,
    numDirections: number,
  ): Promise<void> {
    const start = Date.now();

    try {
      this.logger.log(
        `Starting direction generation jobId=${jobId} project=${projectId} brief=${brief.id}`,
      );
      await this.jobsService.setActive(jobId);

      const grounding = await this.analyticsService.groundingFor(projectId);
      const result: DirectionGenerationResponse =
        await this.aiService.generateDirections({
          project_id: projectId,
          brief_id: brief.id,
          brand_kit: brandKit ?? {},
          analysis: brief as unknown as Record<string, unknown>,
          num_directions: numDirections,
          ...grounding,
        });

      const incoming = Array.isArray(result?.directions)
        ? result.directions
        : [];

      if (incoming.length === 0) {
        throw new Error('AI service returned no directions');
      }

      const rows = incoming.map((d) => ({
        brief_id: brief.id,
        title_pillar: d.title_pillar,
        angle: d.angle,
        format: d.format,
        hook_suggestion: d.hook_suggestion ?? null,
        cta_suggestion: d.cta_suggestion ?? null,
        rationale: d.rationale ?? null,
        selected: false,
      }));

      const client = this.supabaseService.getClient();
      const { data: inserted, error: insertError } = await client
        .from('content_directions')
        .insert(rows)
        .select('*');

      if (insertError) {
        throw new Error(
          `Failed to persist content_directions: ${insertError.message}`,
        );
      }

      await client
        .from('projects')
        .update({ status: 'co_creation' })
        .eq('id', projectId);

      await this.jobsService.setCompleted(jobId, {
        directions_count: inserted?.length ?? 0,
        brief_id: brief.id,
      });

      this.logger.log(
        `Direction generation completed jobId=${jobId} count=${inserted?.length ?? 0} in ${Date.now() - start}ms`,
      );
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.error(
        `Direction generation failed jobId=${jobId}: ${errorMessage}`,
      );
      await this.jobsService.setFailed(jobId, errorMessage);
    }
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
