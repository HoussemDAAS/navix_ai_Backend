import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApifyClient } from 'apify-client';

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
   * Search for competitors on Instagram.
   * This triggers the 'apify/instagram-scraper' Actor.
   * @param niche The niche or keywords to search for.
   * @param location location to refine search (if supported by actor)
   * @returns object containing the runId
   */
  async searchCompetitors(niche: string, location: string) {
    this.logger.log(`Starting competitor search for niche: ${niche} in ${location}`);
    
    // Using 'apify/instagram-scraper' as the primary actor for this task.
    // Input schema assumes standard searchUrl or search terms.
    // For now, we'll simulate a search by scraping a specific hashtag or profile related to the niche.
    // Since direct "search" is tricky on IG, we might need a different actor or strategy.
    // However, adhering to the plan:
    
    const run = await this.apifyClient.actor('apify/instagram-scraper').call({
      search: `${niche} ${location}`,
      searchType: 'hashtag', // or 'user', dependent on the actor capability
      resultsLimit: 15,
    });
    return { runId: run.id };
  }

  /**
   * Get the status or results of a specific Actor run.
   * @param runId The Apify run ID.
   */
  async getActorRun(runId: string) {
    return this.apifyClient.run(runId).get();
  }
}
