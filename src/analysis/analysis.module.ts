import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { AnalyticsService } from './analytics.service';
import { AnalysisController } from './analysis.controller';
import { JobsModule } from '../jobs/jobs.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [JobsModule, AiModule],
  controllers: [AnalysisController],
  providers: [AnalysisService, AnalyticsService],
  exports: [AnalysisService, AnalyticsService],
})
export class AnalysisModule {}
