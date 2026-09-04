import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class GenerateDirectionsDto {
  @IsUUID()
  @IsOptional()
  briefId?: string;

  @IsInt()
  @Min(1)
  @Max(20)
  @IsOptional()
  numDirections?: number;
}
