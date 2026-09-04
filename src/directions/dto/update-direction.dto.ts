import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateDirectionDto {
  @IsBoolean()
  @IsOptional()
  selected?: boolean;
}
