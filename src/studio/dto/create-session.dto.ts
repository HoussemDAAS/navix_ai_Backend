import { IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  content_language?: string;
}
