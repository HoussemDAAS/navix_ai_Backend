import { Module } from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { ScrapingController } from './scraping.controller';
import { ScrapeWebhooksController } from './scrape-webhooks.controller';
import { ApifyService } from './apify.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { ApifyModule } from '../apify/apify.module';
import { ScraperModule } from '../scraper/scraper.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [EmbeddingsModule, ApifyModule, ScraperModule, AnalysisModule, AiModule],
  controllers: [ScrapingController, ScrapeWebhooksController],
  providers: [ScrapingService, ApifyService],
  exports: [ScrapingService, ApifyService],
})
export class ScrapingModule {}
