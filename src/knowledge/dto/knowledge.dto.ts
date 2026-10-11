import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export const KNOWLEDGE_TYPES = ['framework', 'hook', 'cta', 'script', 'caption', 'rule', 'article'] as const;
export const KNOWLEDGE_LANGUAGES = ['derja', 'fr', 'en', 'mixed', 'other'] as const;
export const KNOWLEDGE_SCRIPTS = ['arabic', 'latin', 'mixed', 'na'] as const;
export const KNOWLEDGE_FORMATS = ['reel', 'carousel', 'image', 'story', 'caption', 'any'] as const;
export const KNOWLEDGE_GOALS = ['sell', 'educate', 'entertain', 'announce', 'engage', 'any'] as const;
export const KNOWLEDGE_FUNNELS = ['tof', 'mof', 'bof', 'any'] as const;
export const KNOWLEDGE_STATUSES = ['active', 'pending', 'rejected'] as const;
export const SPLIT_MODES = ['line', 'blank', 'marker', 'none'] as const;

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

/** Items created from the admin page or an import; each element is validated by the service. */
export class CreateKnowledgeItemsDto {
  @IsArray()
  @ArrayMaxSize(5000)
  items!: unknown[];

  @IsOptional()
  @IsBoolean()
  auto_tag?: boolean;
}

export class ImportTextDto {
  @IsString()
  @MinLength(1)
  @MaxLength(5_000_000)
  text!: string;

  @IsString()
  @IsIn(KNOWLEDGE_TYPES as unknown as string[])
  type!: string;

  @IsOptional()
  @IsIn(SPLIT_MODES as unknown as string[])
  split?: string;

  @IsOptional()
  @IsBoolean()
  auto_tag?: boolean;

  /** Tags applied to every item of the import (language, script, field, format, goal, funnel, note) */
  @IsOptional()
  @IsObject()
  defaults?: Record<string, string>;
}

export class ArticleDto {
  @IsUrl({ require_protocol: true })
  @MaxLength(2000)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  field?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_LANGUAGES as unknown as string[])
  language?: string;
}

export class SearchKnowledgeDto {
  @IsString()
  @MinLength(2)
  @MaxLength(2000)
  query!: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_TYPES as unknown as string[])
  type?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_LANGUAGES as unknown as string[])
  language?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_SCRIPTS as unknown as string[])
  script?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_FORMATS as unknown as string[])
  format?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_GOALS as unknown as string[])
  goal?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  field?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  k?: number;
}

export class UpdateKnowledgeItemDto {
  @IsOptional()
  @IsIn(KNOWLEDGE_TYPES as unknown as string[])
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(300_000)
  content?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_LANGUAGES as unknown as string[])
  language?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_SCRIPTS as unknown as string[])
  script?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  field?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_FORMATS as unknown as string[])
  format?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_GOALS as unknown as string[])
  goal?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_FUNNELS as unknown as string[])
  funnel?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  group_label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsIn(KNOWLEDGE_STATUSES as unknown as string[])
  status?: string;
}
