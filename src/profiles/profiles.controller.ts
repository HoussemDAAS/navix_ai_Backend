import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { ProfilesService } from './profiles.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('profiles')
@UseGuards(SupabaseAuthGuard)
export class ProfilesController {
  constructor(private readonly profilesService: ProfilesService) {}

  @Get('me')
  async getProfile(@CurrentUser() user: AuthUser) {
    const profile = await this.profilesService.getProfile(user.id);
    return {
      message: 'Profile retrieved successfully',
      data: profile,
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
