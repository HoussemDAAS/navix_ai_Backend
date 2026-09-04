import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsArray,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';

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
  @MaxLength(200)
  entity_name?: string;

  @IsString()
  @IsOptional()
  instagram_handle?: string;

  @IsString()
  @IsOptional()
  tiktok_handle?: string;

  @IsString()
  @IsOptional()
  youtube_handle?: string;

  @IsString()
  @IsOptional()
  facebook_handle?: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  niche_description?: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(15)
  keywords?: string[];

  @IsString()
  @IsOptional()
  @MaxLength(500)
  target_market?: string;

  /** Benchmark accounts as "platform:handle" (or links / @handles, parsed server-side) */
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  seed_accounts?: string[];
}
