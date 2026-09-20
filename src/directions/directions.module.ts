import { Module } from '@nestjs/common';
import { DirectionsService } from './directions.service';
import { DirectionsController } from './directions.controller';
import { JobsModule } from '../jobs/jobs.module';
import { AiModule } from '../ai/ai.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [JobsModule, AiModule, AnalysisModule],
  controllers: [DirectionsController],
  providers: [DirectionsService],
  exports: [DirectionsService],
})
export class DirectionsModule {}
