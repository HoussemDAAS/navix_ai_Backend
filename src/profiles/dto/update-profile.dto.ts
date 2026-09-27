import {
  IsString,
  IsBoolean,
  IsInt,
  IsOptional,
  IsIn,
  IsArray,
  IsUrl,
  ArrayMaxSize,
  MaxLength,
} from 'class-validator';

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  full_name?: string;

  @IsOptional()
  @IsString()
  avatar_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
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

  /** Full profile links pasted during onboarding; parsed server-side into handles */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(6)
  social_links?: string[];

  @IsOptional()
  @IsBoolean()
  has_social_presence?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  niche_description?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(15)
  keywords?: string[];

  /** Benchmark accounts (links or @handles); stored as "platform:handle" */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(5)
  seed_accounts?: string[];

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

  // ── New entity fields ──
  @IsOptional()
  @IsString()
  @MaxLength(200)
  entity_name?: string;

  @IsOptional()
  @IsString()
  entity_logo_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  website_url?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  niche?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  target_market?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  product_category?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  product_subcategory?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  languages?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(100)
  timezone?: string;

  @IsOptional()
  @IsString()
  @IsIn([
    'account_type',
    'identity',
    'socials',
    'scraping',
    'competitors',
    'brand_kit',
    'completed',
  ])
  onboarding_step?: string;
}
