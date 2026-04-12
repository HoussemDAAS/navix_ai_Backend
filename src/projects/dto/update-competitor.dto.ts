import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateCompetitorDto {
  @IsBoolean()
  @IsOptional()
  validatedByUser?: boolean;

  @IsBoolean()
  @IsOptional()
  rejectedByUser?: boolean;
}
