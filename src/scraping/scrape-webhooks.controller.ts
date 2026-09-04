import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { ApifyService } from './apify.service';

interface ApifyWebhookPayload {
  eventType?: string;
  eventData?: { actorRunId?: string };
  resource?: {
    id?: string;
    actId?: string;
    defaultDatasetId?: string;
    status?: string;
  };
}

@Controller('webhooks/apify')
export class ScrapeWebhooksController {
  private readonly logger = new Logger(ScrapeWebhooksController.name);

  constructor(
    private readonly scrapingService: ScrapingService,
    private readonly apifyService: ApifyService,
  ) {}

  @Post('scrape')
  @HttpCode(HttpStatus.OK)
  async handleScrape(
    @Body() payload: ApifyWebhookPayload,
    @Query('scrape_job_id') scrapeJobId: string | undefined,
    @Headers('x-apify-signature') signature: string | undefined,
  ): Promise<{ status: string; message?: string }> {
    if (!scrapeJobId) {
      this.logger.warn(
        'Scrape webhook received without scrape_job_id query param',
      );
      return { status: 'ignored', message: 'missing scrape_job_id' };
    }

    // Verify HMAC signature — if APIFY_WEBHOOK_SECRET is set
    if (!this.apifyService.verifySignature(scrapeJobId, signature ?? '')) {
      this.logger.warn(
        `Scrape webhook signature mismatch for scrape_job=${scrapeJobId}`,
      );
      return { status: 'rejected', message: 'invalid signature' };
    }

    const eventType = payload.eventType ?? 'unknown';
    const runId = payload.resource?.id ?? payload.eventData?.actorRunId;

    this.logger.log(
      `Scrape webhook received scrape_job=${scrapeJobId} event=${eventType} runId=${runId}`,
    );

    if (!runId) {
      this.logger.warn('No runId in webhook payload');
      return { status: 'ignored', message: 'missing runId' };
    }

    // For non-success events, the service will mark the job failed after it checks the
    // run's real status via Apify API (we never trust the payload alone).
    try {
      await this.scrapingService.processCompletedRun(scrapeJobId, runId);
      return { status: 'processed' };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `Failed to process scrape webhook scrape_job=${scrapeJobId}: ${message}`,
      );
      return { status: 'error', message };
    }
  }
}
