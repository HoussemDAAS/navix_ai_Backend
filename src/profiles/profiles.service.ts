import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async getProfile(userId: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !data) {
      this.logger.error(`Profile not found for user ${userId}`, error);
      throw new NotFoundException('Profile not found');
    }

    return data;
  }

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const client = this.supabaseService.getClient();

    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    if (dto.full_name !== undefined) payload.full_name = dto.full_name;
    if (dto.avatar_url !== undefined) payload.avatar_url = dto.avatar_url;
    if (dto.biography !== undefined) payload.biography = dto.biography;
    if (dto.persona !== undefined) payload.persona = dto.persona;
    if (dto.instagram_handle !== undefined) payload.instagram_handle = dto.instagram_handle;
    if (dto.tiktok_handle !== undefined) payload.tiktok_handle = dto.tiktok_handle;
    if (dto.youtube_handle !== undefined) payload.youtube_handle = dto.youtube_handle;
    if (dto.followers_count !== undefined) payload.followers_count = dto.followers_count;
    if (dto.following_count !== undefined) payload.following_count = dto.following_count;
    if (dto.posts_count !== undefined) payload.posts_count = dto.posts_count;
    if (dto.is_verified !== undefined) payload.is_verified = dto.is_verified;
    if (dto.onboarding_completed === true) payload.onboarding_completed = true;

    const { data, error } = await client
      .from('profiles')
      .update(payload)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      this.logger.error(`Failed to update profile for user ${userId}`, error);
      throw new Error(error.message);
    }

    this.logger.log(`Profile updated for user ${userId}`);
    return data;
  }
}
