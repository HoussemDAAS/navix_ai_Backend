import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

export const SUPPORTED_PLATFORMS = [
  'instagram',
  'tiktok',
  'youtube',
  'facebook',
] as const;
export type ScrapePlatform = (typeof SUPPORTED_PLATFORMS)[number];

export class ScrapeHandlesDto {
  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  tiktok?: string;

  @IsOptional()
  @IsString()
  youtube?: string;

  @IsOptional()
  @IsString()
  facebook?: string;
}

export class ScrapeSelfDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(SUPPORTED_PLATFORMS, { each: true })
  platforms: ScrapePlatform[];

  @IsObject()
  handles: ScrapeHandlesDto;
}
