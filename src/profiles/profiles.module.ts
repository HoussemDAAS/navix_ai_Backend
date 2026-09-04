import { Module } from '@nestjs/common';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';
import { ScrapingModule } from '../scraping/scraping.module';
import { ScraperModule } from '../scraper/scraper.module';

@Module({
  imports: [ScrapingModule, ScraperModule],
  controllers: [ProfilesController],
  providers: [ProfilesService],
  exports: [ProfilesService],
})
export class ProfilesModule {}
