import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export type DraftStatusInput = 'APPROVED' | 'REJECTED';

export class UpdateDraftDto {
  @IsOptional()
  @IsString()
  @IsIn(['APPROVED', 'REJECTED'])
  status?: DraftStatusInput;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  caption_text?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  video_script?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  user_feedback_notes?: string;
}
