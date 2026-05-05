import {
  Injectable,
  Logger,
  NotFoundException,
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

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

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

  async setCompleted(jobId: string, output: Record<string, unknown>): Promise<JobRecord> {
    return this.updateJobStatus(jobId, 'completed', output);
  }

  async setFailed(jobId: string, errorMsg: string): Promise<JobRecord> {
    return this.updateJobStatus(jobId, 'failed', undefined, errorMsg);
  }
}
