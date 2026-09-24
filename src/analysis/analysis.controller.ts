import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { AnalyticsService } from './analytics.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('projects/:id/analysis')
@UseGuards(SupabaseAuthGuard)
export class AnalysisController {
  constructor(
    private readonly analysisService: AnalysisService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /** Quantitative field data computed from scraped posts — no AI involved. */
  @Get('field')
  async getFieldAnalytics(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const data = await this.analyticsService.getFieldAnalytics(id, user.id);
    return { message: 'Field analytics computed', data };
  }

  /** The Home digest: what moved this week, best posts, the pipeline and one grounded idea. */
  @Get('digest')
  async getWeeklyDigest(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh?: string,
  ) {
    const data = await this.analyticsService.getWeeklyDigest(
      id,
      user.id,
      refresh === 'true' || refresh === '1',
    );
    return { message: 'Weekly digest computed', data };
  }

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
