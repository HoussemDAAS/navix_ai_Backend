import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class DiscoverCompetitorsDto {
  @IsString({ message: 'Niche must be a string.' })
  @IsNotEmpty({ message: 'Niche is required.' })
  niche: string;

  @IsString({ message: 'Location must be a string.' })
  @IsOptional()
  location?: string;
}
