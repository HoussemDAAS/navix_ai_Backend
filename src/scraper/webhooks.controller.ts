import {
  Body,
  Controller,
  Post,
  Logger,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { DiscoveryIngestService } from './discovery-ingest.service';

/**
 * Optional path: Apify webhooks only fire when APIFY_WEBHOOK_URL points to a
 * publicly reachable URL (e.g. ngrok). Discovery results are also ingested
 * directly in-process by ScraperService, so this controller is a redundant
 * safety net — ingestion is idempotent either way.
 */
@Controller('webhooks/apify')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly discoveryIngestService: DiscoveryIngestService,
  ) {}

  @Post('competitors')
  @HttpCode(HttpStatus.OK)
  async handleCompetitorResults(
    @Body() payload: Record<string, unknown>,
    @Query('project_id') projectId?: string,
    @Query('strategy') strategy?: string,
    @Query('platform') platform?: string,
    @Query('niche') niche?: string,
    @Query('own_ig') ownIg?: string,
    @Query('own_tt') ownTt?: string,
  ) {
    const method = strategy || 'unknown';
    this.logger.log(
      `Webhook received — strategy: ${method}, platform: ${platform || '?'}, project: ${projectId || 'none'}`,
    );

    // 1. Validate event
    const { eventType, resource } = payload as {
      eventType: string;
      resource: { defaultDatasetId?: string };
    };

    if (eventType !== 'ACTOR.RUN.SUCCEEDED') {
      this.logger.warn(`Ignored event: ${eventType}`);
      return { status: 'ignored' };
    }

    const datasetId = resource?.defaultDatasetId;
    if (!datasetId) {
      this.logger.error('No dataset ID in payload');
      return { status: 'error', message: 'No dataset ID' };
    }

    if (!projectId) {
      this.logger.warn('Webhook missing project_id — nothing to ingest into');
      return { status: 'ignored' };
    }

    // 2. Fetch dataset items
    const items = await this.scraperService.getDatasetItems(datasetId);
    this.logger.log(
      `Fetched ${items.items.length} items from dataset (strategy: ${method})`,
    );

    // 3. Delegate to the shared ingestion pipeline
    const count = await this.discoveryIngestService.ingestRunItems(
      method,
      items.items as Record<string, unknown>[],
      {
        projectId,
        niche: niche || '',
        ownIg,
        ownTt,
      },
    );

    return { status: 'processed', count };
  }
}
