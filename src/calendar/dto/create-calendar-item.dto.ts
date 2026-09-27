import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';

export type CalendarPlatform = 'instagram' | 'tiktok';

export class CreateCalendarItemDto {
  @IsUUID()
  @IsOptional()
  draftId?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title!: string;

  @IsDateString()
  scheduledAt!: string;

  @IsString()
  @IsIn(['instagram', 'tiktok'])
  platform!: CalendarPlatform;

  @IsString()
  @IsOptional()
  @MaxLength(5_000)
  notes?: string;
}
