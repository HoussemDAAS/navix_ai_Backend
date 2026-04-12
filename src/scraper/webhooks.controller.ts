import { Body, Controller, Post, Logger, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { SupabaseService } from '../supabase/supabase.service';

/* ────────────────────────────────────────────────────────────
 * Types
 * ──────────────────────────────────────────────────────────── */

interface NormalizedCompetitor {
  handle: string;
  platform: 'INSTAGRAM' | 'TIKTOK';
  full_name: string | null;
  biography: string | null;
  followers_count: number | null;
  following_count: number | null;
  posts_count: number | null;
  avatar_url: string | null;
  is_business: boolean;
  discovery_method: string;
}

/* ────────────────────────────────────────────────────────────
 * Confidence scoring
 *
 * Produces 40-98 based on real signals, not Math.random().
 * ──────────────────────────────────────────────────────────── */

function scoreConfidence(
  c: NormalizedCompetitor,
  nicheKeywords: string[],
): number {
  let score = 45; // base — "we found this account"

  // Bio relevance: does their bio mention niche keywords?
  if (c.biography) {
    const bioLower = c.biography.toLowerCase();
    const matches = nicheKeywords.filter((kw) => bioLower.includes(kw));
    score += Math.min(matches.length * 6, 18); // up to +18
  }

  // Follower sweet spot: 1K-500K is the competitive range
  if (c.followers_count) {
    if (c.followers_count >= 1_000 && c.followers_count <= 500_000) {
      score += 12; // ideal competitor size
    } else if (c.followers_count > 500_000 && c.followers_count <= 2_000_000) {
      score += 6; // large but still relevant
    } else if (c.followers_count >= 500 && c.followers_count < 1_000) {
      score += 4; // small but could be emerging
    }
    // < 500 or > 2M gets no bonus
  }

  // Active poster (has meaningful content)
  if (c.posts_count && c.posts_count > 20) {
    score += 5;
  }

  // Business account = more likely a real competitor
  if (c.is_business) {
    score += 5;
  }

  // Discovery method quality bonus
  if (c.discovery_method === 'ig_related') {
    score += 10; // Instagram's own recommendation = gold
  } else if (c.discovery_method === 'ig_hashtag') {
    score += 6; // active in niche hashtags = strong signal
  }

  return Math.min(score, 98);
}

/**
 * Generate a human-readable inclusion reason based on discovery method + data.
 */
function buildInclusionReason(c: NormalizedCompetitor, niche: string): string {
  switch (c.discovery_method) {
    case 'ig_related':
      return 'Instagram recommends this account as similar to yours.';
    case 'ig_hashtag':
      return `Actively posting content with ${niche.split(/\s*[—–-]\s*/)[0] || niche} hashtags.`;
    case 'ig_search':
      return `Profile matches your niche keywords on Instagram.`;
    case 'tt_search':
      return `Creating content in your niche on TikTok.`;
    default:
      return `Discovered as a relevant account in your niche.`;
  }
}

/**
 * Extract niche keywords for bio matching.
 * "Beauty & Skincare — Organic" → ["beauty", "skincare", "organic"]
 */
function extractNicheKeywords(niche: string): string[] {
  const stopWords = new Set(['and', '&', 'the', 'of', 'for', 'in', 'a', 'an', 'to']);
  return niche
    .toLowerCase()
    .split(/[\s—–\-&,]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stopWords.has(w));
}

/* ────────────────────────────────────────────────────────────
 * Controller
 * ──────────────────────────────────────────────────────────── */

@Controller('webhooks/apify')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    private readonly scraperService: ScraperService,
    private readonly supabaseService: SupabaseService,
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

    // 2. Fetch dataset items
    const items = await this.scraperService.getDatasetItems(datasetId);
    this.logger.log(`Fetched ${items.items.length} items from dataset (strategy: ${method})`);

    // 3. Parse into normalized competitors based on strategy
    const competitors = this.parseByStrategy(method, items.items as Record<string, unknown>[]);
    this.logger.log(`Parsed ${competitors.length} unique competitors from strategy: ${method}`);

    if (competitors.length === 0) {
      return { status: 'processed', count: 0 };
    }

    // 4. Filter out user's own handles
    const ownHandles = new Set<string>();
    if (ownIg) ownHandles.add(ownIg.toLowerCase());
    if (ownTt) ownHandles.add(ownTt.toLowerCase());

    const filtered = competitors.filter(
      (c) => !ownHandles.has(c.handle.toLowerCase()),
    );

    // 5. Score and build inclusion reasons
    const nicheKeywords = extractNicheKeywords(niche || '');
    const nicheLabel = niche || '';

    // 6. Batch UPSERT into Supabase (deduplicates on project_id + handle + platform)
    const client = this.supabaseService.getClient();
    const rows = filtered.slice(0, 25).map((c) => ({
      project_id: projectId || null,
      handle: c.handle,
      platform: c.platform,
      full_name: c.full_name,
      biography: c.biography,
      followers_count: c.followers_count,
      following_count: c.following_count,
      posts_count: c.posts_count,
      avatar_url: c.avatar_url,
      discovery_method: c.discovery_method,
      confidence_score: parseFloat(scoreConfidence(c, nicheKeywords).toFixed(1)),
      inclusion_reason: buildInclusionReason(c, nicheLabel),
    }));

    if (rows.length > 0) {
      const { error } = await client
        .from('competitors')
        .upsert(rows, {
          onConflict: 'project_id,handle,platform',
          ignoreDuplicates: false, // update existing with better data
        });

      if (error) {
        this.logger.error(`Supabase batch upsert error: ${JSON.stringify(error)}`);
      } else {
        this.logger.log(`Upserted ${rows.length} competitors for project ${projectId}`);
      }
    }

    return { status: 'processed', count: rows.length };
  }

  /* ──────────────────────────────────────────────────────────
   * Strategy-specific parsers
   * ────────────────────────────────────────────────────────── */

  private parseByStrategy(
    strategy: string,
    items: Record<string, unknown>[],
  ): NormalizedCompetitor[] {
    switch (strategy) {
      case 'ig_search':
        return this.parseIgSearch(items);
      case 'ig_hashtag':
        return this.parseIgHashtag(items);
      case 'ig_related':
        return this.parseIgRelated(items);
      case 'tt_search':
        return this.parseTtSearch(items);
      default:
        // Fallback: try to auto-detect
        return this.parseAutoDetect(items);
    }
  }

  /** Instagram Search Scraper → direct user results */
  private parseIgSearch(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    return items
      .filter((item) => typeof item.username === 'string')
      .map((item) => ({
        handle: (item.username as string).toLowerCase(),
        platform: 'INSTAGRAM' as const,
        full_name: (item.fullName as string) || null,
        biography: (item.biography as string) || null,
        followers_count: (item.followersCount as number) || null,
        following_count: (item.followsCount as number) || null,
        posts_count: (item.postsCount as number) || null,
        avatar_url: (item.profilePicUrlHD as string) || (item.profilePicUrl as string) || null,
        is_business: !!(item.isBusinessAccount),
        discovery_method: 'ig_search',
      }));
  }

  /** Instagram Hashtag Scraper → extract unique ownerUsernames from posts */
  private parseIgHashtag(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const seen = new Map<string, NormalizedCompetitor>();

    for (const item of items) {
      const username = item.ownerUsername as string | undefined;
      if (!username) continue;

      const handle = username.toLowerCase();
      if (seen.has(handle)) continue; // deduplicate within this batch

      seen.set(handle, {
        handle,
        platform: 'INSTAGRAM',
        full_name: (item.ownerFullName as string) || null,
        biography: null, // hashtag scraper doesn't return bio
        followers_count: null,
        following_count: null,
        posts_count: null,
        avatar_url: null,
        is_business: false,
        discovery_method: 'ig_hashtag',
      });
    }

    return [...seen.values()];
  }

  /** Instagram Profile Scraper → extract relatedProfiles array */
  private parseIgRelated(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const competitors: NormalizedCompetitor[] = [];

    for (const profile of items) {
      const relatedProfiles = profile.relatedProfiles as Array<{
        username?: string;
        full_name?: string;
        profile_pic_url?: string;
        is_verified?: boolean;
      }> | undefined;

      if (!relatedProfiles || !Array.isArray(relatedProfiles)) continue;

      for (const related of relatedProfiles) {
        if (!related.username) continue;
        competitors.push({
          handle: related.username.toLowerCase(),
          platform: 'INSTAGRAM',
          full_name: related.full_name || null,
          biography: null,
          followers_count: null,
          following_count: null,
          posts_count: null,
          avatar_url: related.profile_pic_url || null,
          is_business: false,
          discovery_method: 'ig_related',
        });
      }
    }

    return competitors;
  }

  /** TikTok Scraper → profile search results */
  private parseTtSearch(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const seen = new Map<string, NormalizedCompetitor>();

    for (const item of items) {
      // TikTok scraper has multiple response shapes depending on what it returns
      const authorMeta = item.authorMeta as Record<string, unknown> | undefined;
      const authorStats = item.authorStats as Record<string, unknown> | undefined;
      const author = item.author as Record<string, unknown> | undefined;

      const handle = (
        (item.uniqueId as string) ||
        (authorMeta?.name as string) ||
        (author?.uniqueId as string)
      )?.toLowerCase();

      if (!handle || seen.has(handle)) continue;

      seen.set(handle, {
        handle,
        platform: 'TIKTOK',
        full_name: (authorMeta?.nickName as string) || (item.nickname as string) || null,
        biography: (authorMeta?.signature as string) || (item.signature as string) || null,
        followers_count:
          (authorMeta?.fans as number) || (authorStats?.followerCount as number) || null,
        following_count:
          (authorMeta?.following as number) || (authorStats?.followingCount as number) || null,
        posts_count:
          (authorMeta?.video as number) || (authorStats?.videoCount as number) || null,
        avatar_url: (authorMeta?.avatar as string) || (item.avatarThumb as string) || null,
        is_business: false,
        discovery_method: 'tt_search',
      });
    }

    return [...seen.values()];
  }

  /** Auto-detect platform from item shape (fallback for old webhook URLs) */
  private parseAutoDetect(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const competitors: NormalizedCompetitor[] = [];

    for (const item of items) {
      if (item.username) {
        competitors.push(...this.parseIgSearch([item]));
      } else if (item.ownerUsername) {
        competitors.push(...this.parseIgHashtag([item]));
      } else if (item.uniqueId || item.authorMeta) {
        competitors.push(...this.parseTtSearch([item]));
      }
    }

    return competitors;
  }
}
