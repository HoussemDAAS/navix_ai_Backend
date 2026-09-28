import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsArray,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';

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

  /**
   * What the project IS: 'ecommerce' (a brand) or 'creator'. Agencies choose it
   * per client; single-brand accounts inherit their account type.
   */
  @IsString()
  @IsOptional()
  @IsIn(['ecommerce', 'creator', 'agency'])
  persona?: string;

  /** Uploaded logo as a data URL (stored in Supabase Storage) or an existing URL */
  @IsString()
  @IsOptional()
  logo_url?: string;

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
  @MaxLength(1000)
  niche_description?: string;

  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(15)
  keywords?: string[];

  /** Benchmark accounts as links or @handles; stored as "platform:handle" */
  @IsArray()
  @IsOptional()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  seed_accounts?: string[];
}
