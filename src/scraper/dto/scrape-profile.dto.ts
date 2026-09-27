import { IsString, IsNotEmpty, IsIn } from 'class-validator';

export class ScrapeProfileDto {
  @IsString()
  @IsNotEmpty()
  handle: string;

  @IsString()
  @IsIn(['instagram', 'tiktok'])
  platform: string;
}
