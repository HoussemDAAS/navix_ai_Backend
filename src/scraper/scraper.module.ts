import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { WebhooksController } from './webhooks.controller';
import { ScraperController } from './scraper.controller';

@Module({
  controllers: [WebhooksController, ScraperController],
  providers: [ScraperService],
  exports: [ScraperService],
})
export class ScraperModule {}
