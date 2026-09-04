import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { JobsService, JobRecord } from '../jobs/jobs.service';
import { AiService } from '../ai/ai.service';

/** What the AI service returns and what we persist in analysis_briefs */
interface BriefPayload {
  dominant_formats: unknown[];
  winning_hooks: unknown[];
  whitespace_opportunities: unknown[];
  content_cadence: string | null;
  key_takeaways: string[];
}

@Injectable()
export class AnalysisService {
  private readonly logger = new Logger(AnalysisService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly jobsService: JobsService,
    private readonly aiService: AiService,
  ) {}

  async runAnalysis(projectId: string, userId: string): Promise<JobRecord> {
    // Step 1: Validate ownership
    await this.getProjectWithOwnershipCheck(projectId, userId);

    // Step 2: Get competitors for this project
    const client = this.supabaseService.getClient();
    const { data: competitors, error: compError } = await client
      .from('competitors')
      .select('*')
      .eq('project_id', projectId)
      .eq('rejected_by_user', false);

    if (compError) {
      this.logger.error(`Failed to fetch competitors for project ${projectId}`, compError);
      throw new Error(`Failed to fetch competitors: ${compError.message}`);
    }

    if (!competitors || competitors.length === 0) {
      throw new NotFoundException('No competitors found for this project. Run competitor discovery first.');
    }

    // Step 3: Get real scraped competitor content as analysis signals
    const competitorIds = competitors.map((c: Record<string, unknown>) => c.id as string);
    const handleById = new Map<string, string>(
      competitors.map((c: Record<string, unknown>) => [
        c.id as string,
        c.handle as string,
      ]),
    );

    const { data: content, error: sigError } = await client
      .from('scraped_content')
      .select('competitor_id, platform, caption, likes_count, views_count, published_at')
      .eq('project_id', projectId)
      .eq('source_type', 'competitor')
      .in('competitor_id', competitorIds)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(150);

    if (sigError) {
      this.logger.error(`Failed to fetch scraped content for project ${projectId}`, sigError);
      throw new Error(`Failed to fetch scraped content: ${sigError.message}`);
    }

    // Shape rows into the SignalData contract the AI service expects
    const signals = ((content ?? []) as Record<string, unknown>[]).map((row) => ({
      competitor_handle: handleById.get(row.competitor_id as string) ?? 'unknown',
      platform: ((row.platform as string) ?? 'instagram').toLowerCase(),
      caption: (row.caption as string) ?? null,
      likes_count: (row.likes_count as number) ?? null,
      views_count: (row.views_count as number) ?? null,
      published_at: (row.published_at as string) ?? null,
    }));

    if (signals.length === 0) {
      this.logger.warn(
        `No scraped competitor content for project ${projectId} — analysis will rely on competitor profiles + RAG context only`,
      );
    }

    // Step 4: Get brand kit for project
    const { data: brandKit, error: bkError } = await client
      .from('brand_kits')
      .select('*')
      .eq('project_id', projectId)
      .single();

    // Brand kit is optional (PGRST116 = no rows found)
    if (bkError && bkError.code !== 'PGRST116') {
      this.logger.error(`Failed to fetch brand kit for project ${projectId}`, bkError);
      throw new Error(`Failed to fetch brand kit: ${bkError.message}`);
    }

    // Step 5: Create job record
    const jobInput = {
      project_id: projectId,
      competitors_count: competitors.length,
      signals_count: signals.length,
    };

    const job = await this.jobsService.createJob(projectId, 'market_analysis', jobInput);
    this.logger.log(`Market analysis job created: ${job.id} for project ${projectId}`);

    // Step 6: Fire and forget the AI call (async execution)
    this.executeAnalysis(job.id, projectId, competitors, signals, brandKit)
      .catch((err) => {
        this.logger.error(`Background analysis failed for job ${job.id}: ${(err as Error).message}`);
      });

    return job;
  }

  async getAnalysis(projectId: string, userId: string): Promise<Record<string, unknown> | null> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('analysis_briefs')
      .select('*')
      .eq('project_id', projectId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      this.logger.error(`Failed to fetch analysis for project ${projectId}`, error);
      throw new Error(`Failed to fetch analysis: ${error.message}`);
    }
    if (!data) return null;
    return this.completeBrief(projectId, data as Record<string, unknown>);
  }

  /**
   * Older analysis_briefs schemas lack content_cadence / key_takeaways. The
   * completed job still holds the full result, so fill the gaps from there.
   */
  async completeBrief(projectId: string, brief: Record<string, unknown>): Promise<Record<string, unknown>> {
    const missingCadence = typeof brief.content_cadence !== 'string';
    const missingTakeaways = !Array.isArray(brief.key_takeaways) || brief.key_takeaways.length === 0;
    if (!missingCadence && !missingTakeaways) return brief;

    const job = await this.jobsService.getLatestJob(projectId, 'market_analysis');
    const output = job?.status === 'completed' ? (job.output ?? {}) : {};
    return {
      ...brief,
      content_cadence:
        typeof brief.content_cadence === 'string'
          ? brief.content_cadence
          : typeof output.content_cadence === 'string'
            ? output.content_cadence
            : null,
      key_takeaways:
        Array.isArray(brief.key_takeaways) && brief.key_takeaways.length > 0
          ? brief.key_takeaways
          : Array.isArray(output.key_takeaways)
            ? output.key_takeaways
            : [],
    };
  }

  private async executeAnalysis(
    jobId: string,
    projectId: string,
    competitors: Record<string, unknown>[],
    signals: Record<string, unknown>[],
    brandKit: Record<string, unknown> | null,
  ): Promise<void> {
    const start = Date.now();

    try {
      this.logger.log(`Starting market analysis execution jobId=${jobId} project=${projectId}`);
      await this.jobsService.setActive(jobId);
      await this.jobsService.updateProgress(jobId, 10, {
        stage: 'collecting',
        message: `Reading ${signals.length} posts from ${competitors.length} competitors`,
      });

      await this.jobsService.updateProgress(jobId, 35, {
        stage: 'analyzing',
        message: 'Navix AI is studying formats, hooks and gaps',
      });
      // Call AI service — project_id is required by AnalysisRequest, and
      // brand_kit must be an object (all fields optional), never null.
      const result = await this.aiService.runMarketAnalysis({
        project_id: projectId,
        competitors,
        signals,
        brand_kit: brandKit ?? {},
      });
      const brief = this.toBrief(result);

      await this.jobsService.updateProgress(jobId, 85, { stage: 'saving', message: 'Writing your brief' });
      const saved = await this.saveBrief(projectId, brief);

      // Update project status to ANALYSIS
      const client = this.supabaseService.getClient();
      await client
        .from('projects')
        .update({ status: 'analysis' })
        .eq('id', projectId);

      await this.jobsService.setCompleted(jobId, { ...brief, brief_id: saved?.id ?? null });
      this.logger.log(`Market analysis completed jobId=${jobId} in ${Date.now() - start}ms`);
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.error(`Market analysis failed jobId=${jobId}: ${errorMessage}`);
      await this.jobsService.setFailed(jobId, errorMessage);
    }
  }

  private toBrief(result: Record<string, unknown>): BriefPayload {
    const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
    return {
      dominant_formats: list(result.dominant_formats),
      winning_hooks: list(result.winning_hooks),
      whitespace_opportunities: list(result.whitespace_opportunities),
      content_cadence: typeof result.content_cadence === 'string' ? result.content_cadence : null,
      key_takeaways: list(result.key_takeaways).filter((t): t is string => typeof t === 'string'),
    };
  }

  /**
   * Persist the brief. If the table predates the content_cadence /
   * key_takeaways columns, save what it can hold and say which migration
   * is missing instead of failing the whole analysis.
   */
  private async saveBrief(projectId: string, brief: BriefPayload): Promise<{ id: string } | null> {
    const client = this.supabaseService.getClient();
    const full = await client
      .from('analysis_briefs')
      .insert({ project_id: projectId, ...brief })
      .select('id')
      .single();
    if (!full.error) return full.data as { id: string } | null;

    if (/content_cadence|key_takeaways/.test(full.error.message)) {
      this.logger.warn(
        'analysis_briefs lacks content_cadence/key_takeaways — apply db/2026-08-25_analysis_briefs_v2.sql. Saving the brief without them.',
      );
      const base = await client
        .from('analysis_briefs')
        .insert({
          project_id: projectId,
          dominant_formats: brief.dominant_formats,
          winning_hooks: brief.winning_hooks,
          whitespace_opportunities: brief.whitespace_opportunities,
        })
        .select('id')
        .single();
      if (!base.error) return base.data as { id: string } | null;
      throw new Error(`Failed to save analysis brief: ${base.error.message}`);
    }
    throw new Error(`Failed to save analysis brief: ${full.error.message}`);
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
