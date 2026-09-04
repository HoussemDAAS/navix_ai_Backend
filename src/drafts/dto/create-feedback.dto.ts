import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export type FeedbackAction = 'approved' | 'rejected' | 'edited';

export class CreateFeedbackDto {
  @IsString()
  @IsIn(['approved', 'rejected', 'edited'])
  action!: FeedbackAction;

  @IsOptional()
  @IsString()
  @MaxLength(5_000)
  notes?: string;
}
