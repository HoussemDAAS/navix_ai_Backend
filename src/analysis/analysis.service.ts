import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { JobsService, JobRecord } from '../jobs/jobs.service';
import { AiService } from '../ai/ai.service';

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

    // Step 3: Get signals for those competitors
    const competitorIds = competitors.map((c: Record<string, unknown>) => c.id as string);
    const { data: signals, error: sigError } = await client
      .from('signals')
      .select('*')
      .in('competitor_id', competitorIds);

    if (sigError) {
      this.logger.error(`Failed to fetch signals for project ${projectId}`, sigError);
      throw new Error(`Failed to fetch signals: ${sigError.message}`);
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
      signals_count: signals?.length ?? 0,
    };

    const job = await this.jobsService.createJob(projectId, 'market_analysis', jobInput);
    this.logger.log(`Market analysis job created: ${job.id} for project ${projectId}`);

    // Step 6: Fire and forget the AI call (async execution)
    this.executeAnalysis(job.id, projectId, competitors, signals ?? [], brandKit)
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
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    // PGRST116 means no rows found
    if (error && error.code !== 'PGRST116') {
      this.logger.error(`Failed to fetch analysis for project ${projectId}`, error);
      throw new Error(`Failed to fetch analysis: ${error.message}`);
    }

    return (data as Record<string, unknown>) ?? null;
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

      // Call AI service
      const result = await this.aiService.runMarketAnalysis({
        competitors,
        signals,
        brand_kit: brandKit,
      });

      // Save result to analysis_briefs table
      const client = this.supabaseService.getClient();
      const { error: saveError } = await client
        .from('analysis_briefs')
        .insert({
          project_id: projectId,
          ...result,
        });

      if (saveError) {
        throw new Error(`Failed to save analysis brief: ${saveError.message}`);
      }

      // Update project status to ANALYSIS
      await client
        .from('projects')
        .update({ status: 'analysis' })
        .eq('id', projectId);

      await this.jobsService.setCompleted(jobId, result);
      this.logger.log(`Market analysis completed jobId=${jobId} in ${Date.now() - start}ms`);
    } catch (err) {
      const errorMessage = (err as Error).message;
      this.logger.error(`Market analysis failed jobId=${jobId}: ${errorMessage}`);
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
