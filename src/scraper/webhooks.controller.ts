import { Body, Controller, Post, Logger, HttpCode, HttpStatus } from '@nestjs/common';

@Controller('webhooks/apify')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  @Post('competitors')
  @HttpCode(HttpStatus.OK)
  async handleCompetitorResults(@Body() payload: any) {
    this.logger.log('Received webhook from Apify (Competitors Scraper)');
    
    // In a real scenario, payload usually contains event details like { eventType: 'ACTOR.RUN.SUCCEEDED', resource: { id: '...' } }
    // We would then use the runId to fetch the dataset associated with the run.
    
    this.logger.debug(JSON.stringify(payload));
    
    return { status: 'received' };
  }
}
