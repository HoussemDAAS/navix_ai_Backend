import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  UseGuards,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JobsService } from './jobs.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('jobs')
@UseGuards(SupabaseAuthGuard)
export class JobsController {
  private readonly logger = new Logger(JobsController.name);

  constructor(
    private readonly jobsService: JobsService,
    private readonly supabaseService: SupabaseService,
  ) {}

  @Get(':id/status')
  async getJobStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const job = await this.jobsService.getJob(id);

    // Validate user owns the project this job belongs to
    const client = this.supabaseService.getClient();
    const { data: project, error } = await client
      .from('projects')
      .select('user_id')
      .eq('id', job.project_id)
      .single();

    if (error || !project) {
      this.logger.warn(`Job ${id} references non-existent project ${job.project_id}`);
      throw new ForbiddenException('Access denied');
    }

    if (project.user_id !== user.id) {
      throw new ForbiddenException('You do not have access to this job');
    }

    return {
      message: 'Job status retrieved successfully',
      data: {
        id: job.id,
        type: job.type,
        status: job.status,
        progress: job.progress,
        output: job.status === 'completed' ? job.output : undefined,
        error: job.status === 'failed' ? job.error : undefined,
        started_at: job.started_at,
        completed_at: job.completed_at,
        created_at: job.created_at,
      },
    };
  }
}
