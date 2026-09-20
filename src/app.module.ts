import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScraperModule } from './scraper/scraper.module';
import { SupabaseModule } from './supabase/supabase.module';
import { ProjectsModule } from './projects/projects.module';
import { ProfilesModule } from './profiles/profiles.module';
import { AuthModule } from './auth/auth.module';
import { JobsModule } from './jobs/jobs.module';
import { AiModule } from './ai/ai.module';
import { AnalysisModule } from './analysis/analysis.module';
import { ScrapingModule } from './scraping/scraping.module';
import { EmbeddingsModule } from './embeddings/embeddings.module';
import { DirectionsModule } from './directions/directions.module';
import { DraftsModule } from './drafts/drafts.module';
import { CalendarModule } from './calendar/calendar.module';
import { StudioModule } from './studio/studio.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    SupabaseModule,
    AuthModule,
    ScraperModule,
    ProjectsModule,
    ProfilesModule,
    JobsModule,
    AiModule,
    AnalysisModule,
    EmbeddingsModule,
    ScrapingModule,
    DirectionsModule,
    DraftsModule,
    CalendarModule,
    StudioModule,
  ],
})
export class AppModule {}
