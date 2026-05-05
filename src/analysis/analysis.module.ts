import { Module } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { AnalysisController } from './analysis.controller';
import { JobsModule } from '../jobs/jobs.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [JobsModule, AiModule],
  controllers: [AnalysisController],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
