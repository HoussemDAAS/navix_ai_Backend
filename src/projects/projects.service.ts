import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { CreateBrandKitDto } from './dto/create-brand-kit.dto';
import { UpdateCompetitorDto } from './dto/update-competitor.dto';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async findAllByUser(userId: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch projects for user ${userId}`, error);
      throw new Error(error.message);
    }

    return data;
  }

  async createProject(dto: CreateProjectDto, userId: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .insert({
        user_id: userId,
        name: dto.name,
        niche: dto.niche,
        location: dto.location ?? null,
        persona: dto.persona ?? null,
        website: dto.website ?? null,
        instagram_handle: dto.instagram_handle ?? null,
        tiktok_handle: dto.tiktok_handle ?? null,
        youtube_handle: dto.youtube_handle ?? null,
      })
      .select()
      .single();

    if (error) {
      this.logger.error('Failed to create project', error);
      throw new Error(error.message);
    }

    this.logger.log(`Project created: ${data.id}`);
    return data;
  }

  async getProject(projectId: string, userId: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if (data.user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }

    return data;
  }

  async getBrandKit(projectId: string, userId: string) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('brand_kits')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.error(
        `Failed to fetch brand kit for project ${projectId}`,
        error,
      );
      throw new Error(error.message);
    }

    return data ?? null;
  }

  async saveBrandKit(
    projectId: string,
    dto: CreateBrandKitDto,
    userId: string,
  ) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();
    const payload: Record<string, unknown> = {
      project_id: projectId,
      updated_at: new Date().toISOString(),
    };

    if (dto.tone_of_voice !== undefined) payload.tone_of_voice = dto.tone_of_voice;
    if (dto.formality_level !== undefined) payload.formality_level = dto.formality_level;
    if (dto.vocab_exclude !== undefined) payload.vocab_exclude = dto.vocab_exclude;
    if (dto.objective !== undefined) payload.objective = dto.objective;
    if (dto.target_audience !== undefined) payload.target_audience = dto.target_audience;
    if (dto.constraints !== undefined) payload.constraints = dto.constraints;
    if (dto.preferred_cta !== undefined) payload.preferred_cta = dto.preferred_cta;

    const { data, error } = await client
      .from('brand_kits')
      .upsert(payload, { onConflict: 'project_id' })
      .select()
      .single();

    if (error) {
      this.logger.error('Failed to save brand kit', error);
      throw new Error(error.message);
    }

    this.logger.log(`Brand kit saved for project: ${projectId}`);
    return data;
  }

  async getCompetitors(projectId: string, userId: string) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('competitors')
      .select('*')
      .eq('project_id', projectId)
      .order('confidence_score', { ascending: false });

    if (error) {
      this.logger.error(
        `Failed to fetch competitors for project ${projectId}`,
        error,
      );
      throw new Error(error.message);
    }

    return data;
  }

  async updateCompetitor(
    projectId: string,
    competitorId: string,
    dto: UpdateCompetitorDto,
    userId: string,
  ) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();

    // Verify the competitor belongs to this project
    const { data: existing, error: fetchError } = await client
      .from('competitors')
      .select('id, project_id')
      .eq('id', competitorId)
      .eq('project_id', projectId)
      .single();

    if (fetchError || !existing) {
      throw new NotFoundException(
        `Competitor ${competitorId} not found in project ${projectId}`,
      );
    }

    const updatePayload: Record<string, boolean> = {};
    if (dto.validatedByUser !== undefined) {
      updatePayload.validated_by_user = dto.validatedByUser;
    }
    if (dto.rejectedByUser !== undefined) {
      updatePayload.rejected_by_user = dto.rejectedByUser;
    }

    const { data, error } = await client
      .from('competitors')
      .update(updatePayload)
      .eq('id', competitorId)
      .select()
      .single();

    if (error) {
      this.logger.error(
        `Failed to update competitor ${competitorId}`,
        error,
      );
      throw new Error(error.message);
    }

    this.logger.log(`Competitor ${competitorId} updated in project ${projectId}`);
    return data;
  }
}
