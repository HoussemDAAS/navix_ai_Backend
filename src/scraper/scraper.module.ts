import { Module } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { DiscoveryIngestService } from './discovery-ingest.service';
import { AvatarStorageService } from './avatar-storage.service';
import { ScraperController } from './scraper.controller';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { JobsModule } from '../jobs/jobs.module';
import { ApifyModule } from '../apify/apify.module';

// Discovery results are ingested in-process by ScraperService; the former
// unauthenticated /webhooks/apify/competitors fallback was removed.
@Module({
  imports: [EmbeddingsModule, JobsModule, ApifyModule],
  controllers: [ScraperController],
  providers: [ScraperService, DiscoveryIngestService, AvatarStorageService],
  exports: [ScraperService, AvatarStorageService],
})
export class ScraperModule {}
