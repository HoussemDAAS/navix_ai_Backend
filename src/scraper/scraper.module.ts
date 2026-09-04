import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { DiscoveryIngestService } from './discovery-ingest.service';
import { AvatarStorageService } from './avatar-storage.service';
import { WebhooksController } from './webhooks.controller';
import { ScraperController } from './scraper.controller';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { JobsModule } from '../jobs/jobs.module';
import { ApifyModule } from '../apify/apify.module';

@Module({
  imports: [EmbeddingsModule, JobsModule, ApifyModule],
  controllers: [WebhooksController, ScraperController],
  providers: [ScraperService, DiscoveryIngestService, AvatarStorageService],
  exports: [ScraperService, AvatarStorageService],
})
export class ScraperModule {}
