import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApifyClient, WebhookEventType } from 'apify-client';

/** Raw shape from apify/instagram-profile-scraper dataset items */
interface InstagramProfileRaw {
  username?: string;
  fullName?: string;
  biography?: string;
  followersCount?: number;
  followsCount?: number;
  postsCount?: number;
  profilePicUrl?: string;
  profilePicUrlHD?: string;
  verified?: boolean;
  isBusinessAccount?: boolean;
  relatedProfiles?: Array<{ username?: string }>;
}

/** Raw shape from clockworks/tiktok-scraper dataset items (profile mode) */
interface TiktokProfileRaw {
  authorMeta?: {
    name?: string;
    nickName?: string;
    signature?: string;
    avatar?: string;
    verified?: boolean;
    commerceUserInfo?: { commerceUser?: boolean };
  };
  authorStats?: {
    followerCount?: number;
    followingCount?: number;
    videoCount?: number;
  };
}

/** Represents one launched actor run */
export interface RunInfo {
  query: string;
  platform: string;
  strategy: string;
  runId: string;
}

/** Normalized profile data returned by scrapeProfile */
export interface ScrapedProfile {
  handle: string;
  platform: string;
  full_name: string;
  biography: string;
  followers_count: number;
  following_count: number;
  posts_count: number;
  avatar_url: string;
  is_verified: boolean;
  is_business: boolean;
  related_profiles: string[];
}

/** Options passed from the controller */
interface DiscoveryOptions {
  niche: string;
  location?: string;
  projectId?: string;
  persona?: string;
  instagramHandle?: string;
  tiktokHandle?: string;
}

/**
 * Generates smart search queries from a niche string like "Beauty & Skincare — Organic".
 * Returns 2-3 short, search-engine-friendly queries.
 */
function buildSearchQueries(niche: string, location?: string): string[] {
  // Split "Category — Sub" format
  const parts = niche.split(/\s*[—–-]\s*/);
  const category = parts[0]?.trim() || niche;
  const sub = parts[1]?.trim() || '';

  const queries: string[] = [];

  // Core query: sub + simplified category
  if (sub) {
    queries.push(`${sub} ${category}`.toLowerCase());
    queries.push(sub.toLowerCase());
  } else {
    queries.push(category.toLowerCase());
  }

  // Location-specific query (only if location is short/useful)
  if (location && queries[0]) {
    queries.push(`${queries[0]} ${location}`.toLowerCase());
  }

  // Deduplicate and limit
  return [...new Set(queries)].slice(0, 3);
}

/**
 * Generates hashtag variants from a niche for Instagram hashtag scraping.
 * e.g. "Beauty & Skincare — Organic" → ["organicskincare", "organicbeauty", "cleanbeauty"]
 */
function buildHashtags(niche: string): string[] {
  const parts = niche.split(/\s*[—–-]\s*/);
  const category = parts[0]?.trim() || niche;
  const sub = parts[1]?.trim() || '';

  const stopWords = new Set(['and', '&', 'the', 'of', 'for', 'in', 'a', 'an']);

  function toHashtag(text: string): string {
    return text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => !stopWords.has(w))
      .join('');
  }

  const tags: string[] = [];

  if (sub) {
    // "organic" + "skincare" → "organicskincare"
    const catWords = category.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w));
    tags.push(toHashtag(`${sub} ${catWords[0] || ''}`));
    tags.push(toHashtag(sub));
  }

  tags.push(toHashtag(category));

  // Filter empty and deduplicate
  return [...new Set(tags.filter((t) => t.length >= 3))].slice(0, 4);
}

/**
 * Normalizes an Instagram handle: strips @, lowercases, trims whitespace.
 */
function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);
  private readonly apifyClient: ApifyClient;

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('APIFY_TOKEN');
    if (!token) {
      this.logger.warn('APIFY_TOKEN is not set. Scraper calls will fail.');
    }
    this.apifyClient = new ApifyClient({ token });
  }

  /**
   * Multi-signal competitor discovery.
   *
   * Launches up to 4 parallel Apify actor runs:
   *  1. Instagram user search (2-3 queries)
   *  2. Instagram hashtag scraper (3-4 niche hashtags)
   *  3. Instagram profile scraper (user's own handle → relatedProfiles)
   *  4. TikTok user search (2-3 queries)
   *
   * Each run sends results via webhook to /webhooks/apify/competitors.
   */
  async discoverCompetitors(opts: DiscoveryOptions): Promise<{ runs: RunInfo[] }> {
    const { niche, location, projectId, instagramHandle, tiktokHandle } = opts;
    this.logger.log(
      `Starting multi-signal discovery — niche: "${niche}", location: "${location || 'global'}", project: ${projectId || 'none'}`,
    );

    const baseWebhookUrl = this.configService.get<string>('APIFY_WEBHOOK_URL');
    const runs: RunInfo[] = [];

    const buildWebhookUrl = (strategy: string, platform: string): string | undefined => {
      if (!baseWebhookUrl || !projectId) return undefined;
      const url = new URL(baseWebhookUrl);
      url.searchParams.set('project_id', projectId);
      url.searchParams.set('strategy', strategy);
      url.searchParams.set('platform', platform);
      url.searchParams.set('niche', niche);
      // Pass user's own handle so webhook can exclude it from results
      if (instagramHandle) url.searchParams.set('own_ig', normalizeHandle(instagramHandle));
      if (tiktokHandle) url.searchParams.set('own_tt', normalizeHandle(tiktokHandle));
      return url.toString();
    };

    const makeWebhooks = (strategy: string, platform: string) => {
      const url = buildWebhookUrl(strategy, platform);
      return url
        ? [{ eventTypes: ['ACTOR.RUN.SUCCEEDED' as WebhookEventType], requestUrl: url }]
        : undefined;
    };

    const searchQueries = buildSearchQueries(niche, location);
    const hashtags = buildHashtags(niche);

    this.logger.log(`Search queries: ${JSON.stringify(searchQueries)}`);
    this.logger.log(`Hashtags: ${JSON.stringify(hashtags)}`);

    // Launch all actors in parallel for speed
    const promises: Promise<void>[] = [];

    // ── Signal 1: Instagram User Search ──
    // Cheap (~$0.005). Search for niche-related usernames.
    promises.push(
      (async () => {
        try {
          this.logger.log(`[IG Search] Launching with queries: ${searchQueries.join(', ')}`);
          const run = await this.apifyClient.actor('apify/instagram-search-scraper').call(
            {
              search: searchQueries.join(', '),
              searchType: 'user',
              searchLimit: 10,
            },
            { webhooks: makeWebhooks('ig_search', 'INSTAGRAM') },
          );
          runs.push({ query: searchQueries.join(', '), platform: 'INSTAGRAM', strategy: 'ig_search', runId: run.id });
          this.logger.log(`[IG Search] Run started: ${run.id}`);
        } catch (err) {
          this.logger.error(`[IG Search] Failed to start: ${(err as Error).message}`);
        }
      })(),
    );

    // ── Signal 2: Instagram Hashtag Scraper ──
    // Medium cost (~$0.05-0.10). Find active creators posting with niche hashtags.
    // We scrape 8 posts per hashtag = ~32 posts, then extract unique ownerUsernames.
    if (hashtags.length > 0) {
      promises.push(
        (async () => {
          try {
            this.logger.log(`[IG Hashtag] Launching with hashtags: ${hashtags.join(', ')}`);
            const run = await this.apifyClient.actor('apify/instagram-hashtag-scraper').call(
              {
                hashtags,
                resultsType: 'posts',
                resultsLimit: 8,
              },
              { webhooks: makeWebhooks('ig_hashtag', 'INSTAGRAM') },
            );
            runs.push({ query: hashtags.join(', '), platform: 'INSTAGRAM', strategy: 'ig_hashtag', runId: run.id });
            this.logger.log(`[IG Hashtag] Run started: ${run.id}`);
          } catch (err) {
            this.logger.error(`[IG Hashtag] Failed to start: ${(err as Error).message}`);
          }
        })(),
      );
    }

    // ── Signal 3: Instagram Profile Scraper (user's own handle) ──
    // Cheap (~$0.003). Scrape user's profile to get Instagram's "relatedProfiles".
    // These are Instagram's own recommendations = highest quality signal.
    if (instagramHandle) {
      const handle = normalizeHandle(instagramHandle);
      promises.push(
        (async () => {
          try {
            this.logger.log(`[IG Related] Scraping profile for related accounts: @${handle}`);
            const run = await this.apifyClient.actor('apify/instagram-profile-scraper').call(
              {
                usernames: [handle],
              },
              { webhooks: makeWebhooks('ig_related', 'INSTAGRAM') },
            );
            runs.push({ query: `@${handle}`, platform: 'INSTAGRAM', strategy: 'ig_related', runId: run.id });
            this.logger.log(`[IG Related] Run started: ${run.id}`);
          } catch (err) {
            this.logger.error(`[IG Related] Failed to start: ${(err as Error).message}`);
          }
        })(),
      );
    }

    // ── Signal 4: TikTok User Search ──
    // Medium cost (~$0.03-0.05). Find TikTok creators in the niche.
    promises.push(
      (async () => {
        try {
          const ttQueries = searchQueries.slice(0, 2); // limit to 2 queries for cost
          this.logger.log(`[TT Search] Launching with queries: ${ttQueries.join(', ')}`);
          const run = await this.apifyClient.actor('clockworks/tiktok-scraper').call(
            {
              searchQueries: ttQueries,
              searchSection: '/user' as const,
              maxProfilesPerQuery: 10,
              resultsPerPage: 1, // we only want profile metadata, not videos
            },
            { webhooks: makeWebhooks('tt_search', 'TIKTOK') },
          );
          runs.push({ query: ttQueries.join(', '), platform: 'TIKTOK', strategy: 'tt_search', runId: run.id });
          this.logger.log(`[TT Search] Run started: ${run.id}`);
        } catch (err) {
          this.logger.error(`[TT Search] Failed to start: ${(err as Error).message}`);
        }
      })(),
    );

    await Promise.all(promises);

    this.logger.log(`Discovery launched ${runs.length} actor runs for project ${projectId}`);
    return { runs };
  }

  /** Fetch the status of a specific Actor run. */
  async getActorRun(runId: string) {
    return this.apifyClient.run(runId).get();
  }

  /** Fetch items from a dataset. */
  async getDatasetItems(datasetId: string) {
    return this.apifyClient.dataset(datasetId).listItems();
  }

  /**
   * Scrape a single social media profile and return normalized data.
   * Blocks until the Apify actor finishes (typically 3-10 seconds).
   */
  async scrapeProfile(handle: string, platform: string): Promise<ScrapedProfile> {
    const cleanHandle = normalizeHandle(handle);
    this.logger.log(`Scraping ${platform} profile: @${cleanHandle}`);

    switch (platform) {
      case 'instagram':
        return this.scrapeInstagramProfile(cleanHandle);
      case 'tiktok':
        return this.scrapeTiktokProfile(cleanHandle);
      default:
        throw new BadRequestException(`Platform "${platform}" is not yet supported for profile scraping`);
    }
  }

  private async scrapeInstagramProfile(handle: string): Promise<ScrapedProfile> {
    const run = await this.apifyClient.actor('apify/instagram-profile-scraper').call({
      usernames: [handle],
    });

    if (!run.defaultDatasetId) {
      throw new BadRequestException('Instagram profile scraper returned no dataset');
    }

    const { items } = await this.apifyClient.dataset(run.defaultDatasetId).listItems();

    if (!items.length) {
      throw new BadRequestException(`No profile data found for Instagram handle @${handle}`);
    }

    const raw = items[0] as unknown as InstagramProfileRaw;

    const relatedProfiles = (raw.relatedProfiles || [])
      .map((rp) => rp.username)
      .filter((u): u is string => !!u);

    this.logger.log(
      `Instagram profile @${handle} scraped — ${raw.followersCount ?? 0} followers, ${relatedProfiles.length} related profiles`,
    );

    return {
      handle,
      platform: 'instagram',
      full_name: raw.fullName || '',
      biography: raw.biography || '',
      followers_count: raw.followersCount ?? 0,
      following_count: raw.followsCount ?? 0,
      posts_count: raw.postsCount ?? 0,
      avatar_url: raw.profilePicUrlHD || raw.profilePicUrl || '',
      is_verified: raw.verified ?? false,
      is_business: raw.isBusinessAccount ?? false,
      related_profiles: relatedProfiles,
    };
  }

  private async scrapeTiktokProfile(handle: string): Promise<ScrapedProfile> {
    const run = await this.apifyClient.actor('clockworks/tiktok-scraper').call({
      profiles: [handle],
      resultsPerPage: 1,
    });

    if (!run.defaultDatasetId) {
      throw new BadRequestException('TikTok scraper returned no dataset');
    }

    const { items } = await this.apifyClient.dataset(run.defaultDatasetId).listItems();

    if (!items.length) {
      throw new BadRequestException(`No profile data found for TikTok handle @${handle}`);
    }

    const raw = items[0] as unknown as TiktokProfileRaw;
    const meta = raw.authorMeta;
    const stats = raw.authorStats;

    this.logger.log(
      `TikTok profile @${handle} scraped — ${stats?.followerCount ?? 0} followers`,
    );

    return {
      handle,
      platform: 'tiktok',
      full_name: meta?.nickName || meta?.name || '',
      biography: meta?.signature || '',
      followers_count: stats?.followerCount ?? 0,
      following_count: stats?.followingCount ?? 0,
      posts_count: stats?.videoCount ?? 0,
      avatar_url: meta?.avatar || '',
      is_verified: meta?.verified ?? false,
      is_business: meta?.commerceUserInfo?.commerceUser ?? false,
      related_profiles: [],
    };
  }
}
