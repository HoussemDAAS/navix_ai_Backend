import { Module } from '@nestjs/common';
import { StudioController } from './studio.controller';
import { StudioService } from './studio.service';
import { AnalysisModule } from '../analysis/analysis.module';

@Module({
  imports: [AnalysisModule],
  controllers: [StudioController],
  providers: [StudioService],
  exports: [StudioService],
})
export class StudioModule {}
