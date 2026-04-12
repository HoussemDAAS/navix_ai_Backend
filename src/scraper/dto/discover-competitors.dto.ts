import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class DiscoverCompetitorsDto {
  @IsString({ message: 'Niche must be a string.' })
  @IsNotEmpty({ message: 'Niche is required.' })
  niche: string;

  @IsString({ message: 'Location must be a string.' })
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  project_id?: string;

  @IsString()
  @IsOptional()
  persona?: string;

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
