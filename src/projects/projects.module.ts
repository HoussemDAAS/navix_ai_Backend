import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProfileInsightsService } from './profile-insights.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { ScrapingModule } from '../scraping/scraping.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { ScraperModule } from '../scraper/scraper.module';
import { JobsModule } from '../jobs/jobs.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [SupabaseModule, ScrapingModule, EmbeddingsModule, ScraperModule, JobsModule, AiModule],
  controllers: [ProjectsController],
  providers: [ProjectsService, ProfileInsightsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
