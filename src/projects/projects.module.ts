import { Module } from '@nestjs/common';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { SupabaseModule } from '../supabase/supabase.module';
import { ScrapingModule } from '../scraping/scraping.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { ScraperModule } from '../scraper/scraper.module';
import { JobsModule } from '../jobs/jobs.module';

@Module({
  imports: [SupabaseModule, ScrapingModule, EmbeddingsModule, ScraperModule, JobsModule],
  controllers: [ProjectsController],
  providers: [ProjectsService],
  exports: [ProjectsService],
})
export class ProjectsModule {}
