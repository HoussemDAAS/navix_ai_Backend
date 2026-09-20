import { Module } from '@nestjs/common';
import { DraftsService } from './drafts.service';
import { DraftsController } from './drafts.controller';
import { JobsModule } from '../jobs/jobs.module';
import { AiModule } from '../ai/ai.module';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [JobsModule, AiModule, AnalysisModule],
  controllers: [DraftsController],
  providers: [DraftsService],
  exports: [DraftsService],
})
export class DraftsModule {}
