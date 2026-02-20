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

    // We only want at most 20 competitors as per requirements
    const rawItems = items.items;
    // Explicitly type as any[] to fix TS "never" error during Array.push()
    const competitorsToSave: any[] = [];

    // Depending on the Apify actor, the data schema varies
    for (const item of rawItems as any[]) {
      if (item.username) {
        // Instagram Search Scraper returns `username`
        competitorsToSave.push({
            handle: item.username,
            platform: 'INSTAGRAM',
            full_name: item.fullName || null,
            biography: item.biography || null,
            followers_count: item.followersCount || null,
            following_count: item.followsCount || null,
            posts_count: item.postsCount || null,
            avatar_url: item.profilePicUrlHD || item.profilePicUrl || null
        });
      } else if (item.uniqueId || item.authorMeta?.name || item.author?.uniqueId) {
        // Fallback for flat lists (e.g. TikTok scraper)
        const handle = item.uniqueId || item.authorMeta?.name || item.author?.uniqueId;
        const authorMeta = item.authorMeta || item.author || {};
        const stats = item.authorStats || {};
        competitorsToSave.push({
            handle,
            platform: 'TIKTOK',
            full_name: authorMeta.nickName || item.nickname || null,
            biography: authorMeta.signature || item.signature || null,
            followers_count: authorMeta.fans || stats.followerCount || null,
            following_count: authorMeta.following || stats.followingCount || null,
            posts_count: authorMeta.video || stats.videoCount || null,
            avatar_url: authorMeta.avatar || item.avatarThumb || null
        });
      } else {
         this.logger.warn(`Could not determine platform or handle for item. Keys: ${Object.keys(item).join(', ')}`);
      }
    }

    // Strictly enforce the 20 limit per job
    const top20 = competitorsToSave.slice(0, 20);
    this.logger.log(`Extracted ${top20.length} potential competitors to save.`);

    for (const data of top20) {
      const handle = data.handle; 
      const platform = data.platform;
      
      if (handle) {
           this.logger.debug(`Found handle: ${handle} on ${platform}`);
           const client = this.supabaseService.getClient();

           try {
             const { error } = await client.from('competitors').upsert({
                handle,
                platform,
                full_name: data.full_name,
                biography: data.biography,
                followers_count: data.followers_count,
                following_count: data.following_count,
                posts_count: data.posts_count,
                avatar_url: data.avatar_url,
                confidence_score: parseFloat((Math.random() * (95 - 75) + 75).toFixed(1)), // Mock 75-95
                inclusion_reason: 'Discovered as a high-affinity related profile by Apify AI'
             }, { onConflict: 'handle, platform' });
             
             if (error) {
               this.logger.error(`Supabase Insert Error for ${handle}: ${JSON.stringify(error)}`);
             } else {
               this.logger.debug(`Successfully saved ${handle} to Supabase`);
             }
           } catch (err) {
             this.logger.error(`Exception saving ${handle} to Supabase:`, err);
           }
      }
    }
    
    return { status: 'processed', count: top20.length };
  }
}
