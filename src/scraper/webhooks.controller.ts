import { Body, Controller, Post, Logger, HttpCode, HttpStatus, Inject } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { SupabaseService } from '../supabase/supabase.service';

@Controller('webhooks/apify')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly supabaseService: SupabaseService,
  ) {}

  @Post('competitors')
  @HttpCode(HttpStatus.OK)
  async handleCompetitorResults(@Body() payload: any) {
    this.logger.log('Received webhook from Apify (Competitors Scraper)');
    
    // 1. Validate Payload (Apify sends eventType)
    const { eventType, resource } = payload;
    if (eventType !== 'ACTOR.RUN.SUCCEEDED') {
        this.logger.warn(`Ignored event: ${eventType}`);
        return { status: 'ignored' };
    }

    const runId = resource?.defaultDatasetId; // Usually dataset ID is what we want, or run ID to fetch dataset
    if (!runId) {
        this.logger.error('No dataset ID found in payload');
        return;
    }

    this.logger.log(`Processing dataset: ${runId}`);

    // 2. Fetch Data from Apify
    const items = await this.scraperService.getDatasetItems(resource.defaultDatasetId);
    this.logger.log(`Fetched ${items.items.length} items from dataset`);

    // 3. Save to Supabase
    const client = this.supabaseService.getClient();
    
    // We need a project_id to associate these competitors with.
    // OPTION A: Pass project_id in the Apify Input/Webhook payload (Best Practice)
    // OPTION B: Hardcode for now (MVP)
    // Let's assume the run Input had a 'projectId' field, or we look it up.
    // For this step, we'll iterate and log, or verify if we have a way to link.
    // TODO: Update ScraperService to pass projectId in run input -> payload metadata.
    
    // Simulating mapping for now:
    for (const item of items.items) {
        // Map Apify item to Competitor model
        // This depends on the specific Actor output schema
        const handle = item.username || item.ownerUsername; 
        const platform = 'INSTAGRAM';
        
        if (handle) {
             this.logger.debug(`Found handle: ${handle}`);
             // Database insert logic would go here
             // await client.from('competitors').insert({ handle, platform, ... });
        }
    }
    
    return { status: 'processed', count: items.items.length };
  }
}
