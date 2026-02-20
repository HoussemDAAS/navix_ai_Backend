import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApifyClient, WebhookEventType } from 'apify-client';

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly apifyClient: ApifyClient;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('APIFY_TOKEN');
    // Initialize without token if missing, but log a warning.
    // In production, token is required for most operations.
    if (!token) {
      this.logger.warn('APIFY_TOKEN is not set. Scraper calls may fail.');
    }
    this.apifyClient = new ApifyClient({
      token: token,
    });
  }

  /**
   * Discover competitors based on niche and location.
   * Routes to specific Apify actors for IG and TikTok search.
   * @param niche The niche or keyword
   * @param location Optional location
   */
  async discoverCompetitors(niche: string, location?: string) {
    const query = `${niche} ${location || ''}`.trim();
    this.logger.log(`Starting competitor discovery for query: "${query}"`);
    
    const runIds: { query: string; platform: string; runId: string }[] = [];
    
    // We fetch the webhook URL from environment. For local testing, this is the Ngrok URL.
    const webhookUrl = this.configService.get<string>('APIFY_WEBHOOK_URL');
    const webhooks = webhookUrl ? [{
        eventTypes: ['ACTOR.RUN.SUCCEEDED' as WebhookEventType],
        requestUrl: webhookUrl,
    }] : undefined;

    // Trigger Instagram Search
    this.logger.log(`Triggering Instagram discovery for: ${query}`);
    const igRun = await this.apifyClient.actor('apify/instagram-search-scraper').call({
      search: query,
      searchType: 'user',
      searchLimit: 15,
    }, { webhooks });
    runIds.push({ query, platform: 'INSTAGRAM', runId: igRun.id });

    // Trigger TikTok Search (using clockworks/tiktok-scraper)
    this.logger.log(`Triggering TikTok discovery for: ${query}`);
    const ttRun = await this.apifyClient.actor('clockworks/tiktok-scraper').call({
      searchQueries: [query],
      searchSection: '/user',
      resultsPerPage: 15,
    }, { webhooks });
    runIds.push({ query, platform: 'TIKTOK', runId: ttRun.id });

    return { runs: runIds };
  }

  /**
   * Get the status or results of a specific Actor run.
   * @param runId The Apify run ID.
   */
  async getActorRun(runId: string) {
    return this.apifyClient.run(runId).get();
  }

  /**
   * Fetch items from a dataset.
   * @param datasetId The dataset ID (usually run.defaultDatasetId).
   */
  async getDatasetItems(datasetId: string) {
    return this.apifyClient.dataset(datasetId).listItems();
  }
}
