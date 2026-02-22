import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { CreateBrandKitDto } from './dto/create-brand-kit.dto';

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async createProject(dto: CreateProjectDto) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .insert({
        user_id: dto.user_id,
        name: dto.name,
        niche: dto.niche,
        location: dto.location ?? null,
        language: dto.language ?? 'fr-FR',
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

  async getProject(projectId: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    return data;
  }

  async saveBrandKit(projectId: string, dto: CreateBrandKitDto) {
    await this.getProject(projectId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('brand_kits')
      .upsert(
        {
          project_id: projectId,
          tone_of_voice: dto.tone_of_voice ?? null,
          target_audience: dto.target_audience ?? null,
          constraints: dto.constraints ?? [],
          preferred_cta: dto.preferred_cta ?? null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'project_id' },
      )
      .select()
      .single();

    if (error) {
      this.logger.error('Failed to save brand kit', error);
      throw new Error(error.message);
    }

    this.logger.log(`Brand kit saved for project: ${projectId}`);
    return data;
  }
}
