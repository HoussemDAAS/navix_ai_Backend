import { IsDateString, IsOptional } from 'class-validator';

export class ListCalendarQueryDto {
  @IsDateString()
  @IsOptional()
  from?: string;

  @IsDateString()
  @IsOptional()
  to?: string;
}
