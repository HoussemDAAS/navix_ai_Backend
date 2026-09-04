import {
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export type CalendarStatus = 'planned' | 'published' | 'cancelled';

export class UpdateCalendarItemDto {
  @IsDateString()
  @IsOptional()
  scheduledAt?: string;

  @IsString()
  @IsOptional()
  @IsIn(['planned', 'published', 'cancelled'])
  status?: CalendarStatus;

  @IsString()
  @IsOptional()
  @MaxLength(5_000)
  notes?: string;
}
