import { Module } from '@nestjs/common';
import { ApifyGateService } from './apify-gate.service';

@Module({
  providers: [ApifyGateService],
  exports: [ApifyGateService],
})
export class ApifyModule {}
