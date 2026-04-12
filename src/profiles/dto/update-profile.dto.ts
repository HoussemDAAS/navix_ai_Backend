import { IsString, IsBoolean, IsInt, IsOptional, IsIn } from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  full_name?: string;

  @IsOptional()
  @IsString()
  avatar_url?: string;

  @IsOptional()
  @IsString()
  biography?: string;

  @IsOptional()
  @IsString()
  @IsIn(['ecommerce', 'agency', 'creator'])
  persona?: string;

  @IsOptional()
  @IsString()
  instagram_handle?: string;

  @IsOptional()
  @IsString()
  tiktok_handle?: string;

  @IsOptional()
  @IsString()
  youtube_handle?: string;

  @IsOptional()
  @IsInt()
  followers_count?: number;

  @IsOptional()
  @IsInt()
  following_count?: number;

  @IsOptional()
  @IsInt()
  posts_count?: number;

  @IsOptional()
  @IsBoolean()
  is_verified?: boolean;

  @IsOptional()
  @IsBoolean()
  onboarding_completed?: boolean;
}
