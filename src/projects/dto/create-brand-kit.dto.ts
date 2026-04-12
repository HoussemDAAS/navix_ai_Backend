import { IsArray, IsOptional, IsString } from 'class-validator';

export class CreateBrandKitDto {
  @IsString()
  @IsOptional()
  tone_of_voice?: string;

  @IsString()
  @IsOptional()
  formality_level?: string;

  @IsString()
  @IsOptional()
  vocab_exclude?: string;

  @IsString()
  @IsOptional()
  objective?: string;

  @IsString()
  @IsOptional()
  target_audience?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  constraints?: string[];

  @IsString()
  @IsOptional()
  preferred_cta?: string;
}
