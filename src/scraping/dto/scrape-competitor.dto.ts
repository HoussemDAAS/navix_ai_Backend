import {
  IsArray,
  IsIn,
  IsOptional,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';
import { SUPPORTED_PLATFORMS, ScrapePlatform } from './scrape-self.dto';

export class ScrapeCompetitorDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @IsIn(SUPPORTED_PLATFORMS, { each: true })
  platforms?: ScrapePlatform[];
}
