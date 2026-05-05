import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('projects/:id/analysis')
@UseGuards(SupabaseAuthGuard)
export class AnalysisController {
  constructor(private readonly analysisService: AnalysisService) {}

  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  async runAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const job = await this.analysisService.runAnalysis(id, user.id);
    return {
      message: 'Market analysis started',
      data: { jobId: job.id },
    };
  }

  @Get()
  async getAnalysis(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const analysis = await this.analysisService.getAnalysis(id, user.id);
    return {
      message: analysis
        ? 'Analysis retrieved successfully'
        : 'No analysis found for this project',
      data: analysis,
    };
  }
}
