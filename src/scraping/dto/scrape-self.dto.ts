import {
  IsArray,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

/** The platforms Navix scrapes. Adding one means an Apify actor, an input builder and a normalizer. */
export const SUPPORTED_PLATFORMS = ['instagram', 'tiktok'] as const;
export type ScrapePlatform = (typeof SUPPORTED_PLATFORMS)[number];

export class ScrapeHandlesDto {
  @IsOptional()
  @IsString()
  instagram?: string;

  @IsOptional()
  @IsString()
  tiktok?: string;
}

export class ScrapeSelfDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(2)
  @IsIn(SUPPORTED_PLATFORMS, { each: true })
  platforms: ScrapePlatform[];

  @IsObject()
  handles: ScrapeHandlesDto;
}
