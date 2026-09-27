import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

export type JobType =
  | 'competitor_discovery'
  | 'market_analysis'
  | 'direction_generation'
  | 'draft_generation'
  | 'brand_memory_update';

export type JobStatus = 'pending' | 'active' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  project_id: string;
  type: JobType;
  status: JobStatus;
  progress: number | null;
  input: Record<string, unknown> | null;
  output: Record<string, unknown> | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

// A job runs inside this process only. If the backend restarts mid-way its row would
// stay "active" forever and every screen polling it would spin: on boot anything still
// pending or active is declared interrupted, and every few minutes anything older than
// its type's budget is declared hung.
const STALE_JOB_BOOT_GRACE_MS = 60_000;
const STALE_JOB_CHECK_INTERVAL_MS = 5 * 60_000;
const STALE_JOB_MAX_AGE_MS: Record<JobType, number> = {
  competitor_discovery: 30 * 60_000,
  market_analysis: 10 * 60_000,
  direction_generation: 10 * 60_000,
  draft_generation: 10 * 60_000,
  brand_memory_update: 10 * 60_000,
};

@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(JobsService.name);
  private staleTimer: NodeJS.Timeout | null = null;

  constructor(private readonly supabaseService: SupabaseService) {}

  onModuleInit(): void {
    void this.reconcileStaleJobs(true);
    this.staleTimer = setInterval(() => {
      void this.reconcileStaleJobs(false);
    }, STALE_JOB_CHECK_INTERVAL_MS);
    this.staleTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.staleTimer) clearInterval(this.staleTimer);
  }

  /**
   * Mark jobs that can no longer be running as failed, so the UI stops waiting.
   * On boot (`afterRestart`) every pending or active job older than a minute is
   * dead by definition; afterwards only jobs past their type's budget are touched.
   */
  async reconcileStaleJobs(afterRestart: boolean): Promise<void> {
    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client
        .from('jobs')
        .select('id, type, status, started_at, created_at')
        .in('status', ['pending', 'active']);
      if (error || !data) return;
      const now = Date.now();
      for (const job of data as Array<Pick<JobRecord, 'id' | 'type' | 'status' | 'started_at' | 'created_at'>>) {
        const since = new Date(job.started_at ?? job.created_at).getTime();
        const budget = afterRestart ? STALE_JOB_BOOT_GRACE_MS : (STALE_JOB_MAX_AGE_MS[job.type] ?? 10 * 60_000);
        if (!Number.isFinite(since) || now - since < budget) continue;
        const reason = afterRestart
          ? 'Interrupted: the backend restarted while this job was running'
          : 'Interrupted: the job exceeded its time budget';
        await client
          .from('jobs')
          .update({ status: 'failed', error: reason, completed_at: new Date().toISOString() })
          .eq('id', job.id)
          .in('status', ['pending', 'active']);
        this.logger.warn(
          `Job ${job.id} (${job.type}) marked failed after ${Math.round((now - since) / 60_000)} min: ${reason}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Stale job reconciliation failed: ${(err as Error).message}`);
    }
  }

  async createJob(
    projectId: string,
    type: JobType,
    input?: Record<string, unknown>,
  ): Promise<JobRecord> {
    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('jobs')
      .insert({
        project_id: projectId,
        type,
        status: 'pending' as JobStatus,
        input: input ?? null,
      })
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to create job for project ${projectId}`, error);
      throw new Error(`Failed to create job: ${error.message}`);
    }

    this.logger.log(`Job created: ${data.id} type=${type} project=${projectId}`);
    return data as JobRecord;
  }

  async getJob(jobId: string): Promise<JobRecord> {
    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    return data as JobRecord;
  }

  async getJobsByProject(projectId: string): Promise<JobRecord[]> {
    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('jobs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch jobs for project ${projectId}`, error);
      throw new Error(`Failed to fetch jobs: ${error.message}`);
    }

    return (data ?? []) as JobRecord[];
  }

  async updateJobStatus(
    jobId: string,
    status: JobStatus,
    output?: Record<string, unknown>,
    errorMsg?: string,
  ): Promise<JobRecord> {
    const client = this.supabaseService.getClient();

    const updatePayload: Record<string, unknown> = { status };

    if (output !== undefined) {
      updatePayload.output = output;
    }
    if (errorMsg !== undefined) {
      updatePayload.error = errorMsg;
    }
    if (status === 'active') {
      updatePayload.started_at = new Date().toISOString();
    }
    if (status === 'completed' || status === 'failed') {
      updatePayload.completed_at = new Date().toISOString();
    }

    const { data, error } = await client
      .from('jobs')
      .update(updatePayload)
      .eq('id', jobId)
      .select()
      .single();

    if (error || !data) {
      this.logger.error(`Failed to update job ${jobId} to status=${status}`, error);
      throw new Error(`Failed to update job: ${error?.message ?? 'Not found'}`);
    }

    this.logger.log(`Job ${jobId} updated to status=${status}`);
    return data as JobRecord;
  }

  async setActive(jobId: string): Promise<JobRecord> {
    return this.updateJobStatus(jobId, 'active');
  }

  /**
   * Update progress (0-100) and a free-form output snapshot (stage, counters)
   * without changing the status. Errors are logged, never thrown, so that
   * progress reporting can never break the work being reported on.
   */
  async updateProgress(
    jobId: string,
    progress: number,
    output: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabaseService.getClient();
    const { error } = await client
      .from('jobs')
      .update({ progress: Math.max(0, Math.min(100, Math.round(progress))), output })
      .eq('id', jobId);
    if (error) {
      this.logger.warn(`Failed to update progress for job ${jobId}: ${error.message}`);
    }
  }

  /** Latest job of a given type for a project (or null). */
  async getLatestJob(projectId: string, type: JobType): Promise<JobRecord | null> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('jobs')
      .select('*')
      .eq('project_id', projectId)
      .eq('type', type)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      this.logger.warn(`Failed to fetch latest ${type} job for ${projectId}: ${error.message}`);
      return null;
    }
    return (data as JobRecord | null) ?? null;
  }

  async setCompleted(jobId: string, output: Record<string, unknown>): Promise<JobRecord> {
    return this.updateJobStatus(jobId, 'completed', output);
  }

  async setFailed(jobId: string, errorMsg: string): Promise<JobRecord> {
    return this.updateJobStatus(jobId, 'failed', undefined, errorMsg);
  }
}
