import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProfilesService } from './profiles.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { isAdminEmail } from '../auth/admin';

@Controller('profiles')
@UseGuards(SupabaseAuthGuard)
export class ProfilesController {
  constructor(
    private readonly profilesService: ProfilesService,
    private readonly config: ConfigService,
  ) {}

  @Get('me')
  async getProfile(@CurrentUser() user: AuthUser) {
    const profile = await this.profilesService.getProfile(user.id);
    return {
      message: 'Profile retrieved successfully',
      // is_admin opens the Knowledge page; it is an allowlist of emails, not a profile column
      data: { ...profile, is_admin: isAdminEmail(this.config, user.email) },
    };
  }

  @Patch('me')
  async updateProfile(
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateProfileDto,
  ) {
    const profile = await this.profilesService.updateProfile(user.id, dto);
    return {
      message: 'Profile updated successfully',
      data: profile,
    };
  }
}
