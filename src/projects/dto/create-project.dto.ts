import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  niche: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  language?: string;

  @IsString()
  @IsOptional()
  persona?: string;

  @IsString()
  @IsOptional()
  website?: string;

  @IsString()
  @IsOptional()
  instagram_handle?: string;

  @IsString()
  @IsOptional()
  tiktok_handle?: string;

  @IsString()
  @IsOptional()
  youtube_handle?: string;
}
