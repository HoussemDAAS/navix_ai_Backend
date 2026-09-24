import { Module } from '@nestjs/common';
import { StudioController } from './studio.controller';
import { StudioService } from './studio.service';
import { AnalysisModule } from '../analysis/analysis.module';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { ScraperModule } from '../scraper/scraper.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [AnalysisModule, EmbeddingsModule, ScraperModule, AiModule],
  controllers: [StudioController],
  providers: [StudioService],
  exports: [StudioService],
})
export class StudioModule {}
