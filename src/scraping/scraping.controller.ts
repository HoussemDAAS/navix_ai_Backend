import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { ScrapeSelfDto } from './dto/scrape-self.dto';
import { ScrapeCompetitorDto } from './dto/scrape-competitor.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller()
@UseGuards(SupabaseAuthGuard)
export class ScrapingController {
  private readonly logger = new Logger(ScrapingController.name);

  constructor(private readonly scrapingService: ScrapingService) {}

  @Post('projects/:id/scrape/self')
  @HttpCode(HttpStatus.ACCEPTED)
  async scrapeSelf(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ScrapeSelfDto,
  ) {
    this.logger.log(
      `Self-scrape request project=${projectId} user=${user.id} platforms=${dto.platforms.join(',')}`,
    );
    const scrapeJobIds = await this.scrapingService.scrapeSelf(
      projectId,
      user.id,
      dto,
    );
    return {
      message: 'Self-scrape jobs enqueued',
      data: { scrapeJobIds },
    };
  }

  @Post('projects/:id/scrape/competitor/:competitorId')
  @HttpCode(HttpStatus.ACCEPTED)
  async scrapeCompetitor(
    @Param('id', ParseUUIDPipe) projectId: string,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: ScrapeCompetitorDto,
  ) {
    this.logger.log(
      `Competitor scrape request project=${projectId} competitor=${competitorId} user=${user.id}`,
    );
    const scrapeJobIds = await this.scrapingService.scrapeCompetitor(
      projectId,
      competitorId,
      user.id,
      dto,
    );
    return {
      message: 'Competitor scrape jobs enqueued',
      data: { scrapeJobIds },
    };
  }

  @Get('projects/:id/scrape/status')
  async listProjectScrapeJobs(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const jobs = await this.scrapingService.getProjectScrapeJobs(
      projectId,
      user.id,
    );
    return {
      message: 'Scrape jobs retrieved',
      data: jobs,
    };
  }

  @Get('scrape-jobs/:id')
  async getScrapeJob(
    @Param('id', ParseUUIDPipe) scrapeJobId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const job = await this.scrapingService.getScrapeJob(scrapeJobId, user.id);
    return {
      message: 'Scrape job retrieved',
      data: job,
    };
  }
}
