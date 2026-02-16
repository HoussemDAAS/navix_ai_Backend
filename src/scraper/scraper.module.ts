import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { WebhooksController } from './webhooks.controller';

@Module({
  controllers: [WebhooksController],
  providers: [ScraperService],
  exports: [ScraperService],
})
export class ScraperModule {}
