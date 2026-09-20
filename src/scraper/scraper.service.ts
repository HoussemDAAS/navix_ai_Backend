import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  DiscoveryIngestService,
  type DiscoveryContext,
  type NormalizedCompetitor,
  candidateKey,
} from './discovery-ingest.service';
import { AvatarStorageService } from './avatar-storage.service';
import { OpenAIService } from '../embeddings/openai.service';
import { JobsService } from '../jobs/jobs.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ApifyGateService } from '../apify/apify-gate.service';
import { splitSeed } from '../common/social-links';

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

/** Represents one planned discovery signal */
export interface RunInfo {
  query: string;
  platform: string;
  strategy: string;
}

/** Normalized profile data returned by scrapeProfile */
/** A single public post read by URL (Studio references). */
export interface ScrapedPost {
  platform: 'instagram' | 'tiktok';
  post_url: string;
  author: string | null;
  caption: string;
  likes: number | null;
  comments: number | null;
  views: number | null;
  shares: number | null;
  duration_seconds: number | null;
  video_url: string | null;
  thumbnail_url: string | null;
}

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

/** Options passed from the controller / onboarding bootstrap */
export interface DiscoveryOptions {
  niche: string;
  location?: string;
  projectId?: string;
  /** Owner of the project — lets discovery refresh the profile's bio/followers/avatar */
  userId?: string;
  persona?: string;
  entityName?: string;
  instagramHandle?: string;
  tiktokHandle?: string;
  nicheDescription?: string;
  keywords?: string[];
  targetMarket?: string;
  /** Seed/benchmark accounts as "platform:handle" */
  seedAccounts?: string[];
  language?: string;
}

interface GeneratedQueries {
  search_queries: string[];
  hashtags: string[];
  tiktok_queries: string[];
}

interface DiscoveryProgress {
  stage: string;
  message: string;
  candidates_found: number;
  enriched: number;
  kept: number;
  expand_from?: string;
}

/** The competitor a "find similar" expansion is anchored on */
interface AnchorAccount {
  id: string | null;
  handle: string;
  platform: 'INSTAGRAM' | 'TIKTOK';
  full_name: string | null;
  biography: string | null;
  followers_count: number | null;
  /** Hashtags the account actually posts with (from its scraped content) */
  hashtags: string[];
}

const MAX_IG_CANDIDATES = 40;
const MAX_TT_CANDIDATES = 20;
const MAX_SECOND_HOP = 25;
const MAX_EXPAND = 20;

function buildSearchQueries(niche: string, location?: string): string[] {
  const parts = niche.split(/\s*[—–\-/]\s*/);
  const category = parts[0]?.trim() || niche;
  const sub = parts[1]?.trim() || '';
  const queries: string[] = [];
  if (sub) {
    queries.push(`${sub} ${category}`.toLowerCase());
    queries.push(sub.toLowerCase());
  } else {
    queries.push(category.toLowerCase());
  }
  if (location && queries[0]) queries.push(`${queries[0]} ${location}`.toLowerCase());
  return [...new Set(queries)].slice(0, 3);
}

function buildHashtags(niche: string): string[] {
  const parts = niche.split(/\s*[—–\-/]\s*/);
  const category = parts[0]?.trim() || niche;
  const sub = parts[1]?.trim() || '';
  const stopWords = new Set(['and', '&', 'the', 'of', 'for', 'in', 'a', 'an']);
  const toHashtag = (text: string) =>
    text.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w)).join('');
  const tags: string[] = [];
  if (sub) {
    const catWords = category.toLowerCase().split(/\s+/).filter((w) => !stopWords.has(w));
    tags.push(toHashtag(`${sub} ${catWords[0] || ''}`));
    tags.push(toHashtag(sub));
  }
  tags.push(toHashtag(category));
  return [...new Set(tags.filter((t) => t.length >= 3))].slice(0, 4);
}

function normalizeHandle(handle: string): string {
  return handle.replace(/^@/, '').trim().toLowerCase();
}

function cleanList(arr: unknown, max: number): string[] {
  return Array.isArray(arr)
    ? arr
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 1)
        .map((s) => s.trim())
        .slice(0, max)
    : [];
}

function toHashtagToken(h: string): string {
  return h.replace(/^#/, '').replace(/\s+/g, '').toLowerCase();
}

@Injectable()
export class ScraperService {
  private readonly logger = new Logger(ScraperService.name);

  constructor(
    private readonly discoveryIngestService: DiscoveryIngestService,
    private readonly openaiService: OpenAIService,
    private readonly jobsService: JobsService,
    private readonly supabaseService: SupabaseService,
    private readonly avatarStorage: AvatarStorageService,
    private readonly apify: ApifyGateService,
  ) {}

  /**
   * Competitor discovery pipeline. Returns immediately; the work runs in the
   * background and reports progress in a `jobs` row (type competitor_discovery):
   *   1. read the user's own profile (bio, followers, related accounts)
   *   2. LLM search plan from the full brand context (never the brand's name)
   *   3. gather candidates: Instagram search, niche hashtags, own related
   *      accounts, seed accounts; then TikTok search (Apify memory quota)
   *   4. ENRICH every Instagram candidate that lacks a bio (profile scraper),
   *      and collect the accounts Instagram lists next to them (second hop)
   *   5. judge relevance on the enriched data, score, persist with avatars
   */
  discoverCompetitors(opts: DiscoveryOptions): { runs: RunInfo[] } {
    const seeds = (opts.seedAccounts ?? []).map(splitSeed).filter((s): s is NonNullable<typeof s> => !!s);
    this.logger.log(
      `Starting discovery — niche: "${opts.niche}", location: "${opts.location || 'global'}", project: ${opts.projectId || 'none'}, seeds: ${seeds.length}`,
    );

    const planned: RunInfo[] = [
      { query: '(generated)', platform: 'INSTAGRAM', strategy: 'ig_search' },
      { query: '(generated)', platform: 'INSTAGRAM', strategy: 'ig_hashtag' },
      { query: '(generated)', platform: 'TIKTOK', strategy: 'tt_search' },
    ];
    if (opts.instagramHandle) planned.push({ query: `@${normalizeHandle(opts.instagramHandle)}`, platform: 'INSTAGRAM', strategy: 'ig_related' });
    for (const s of seeds) planned.push({ query: `@${s.handle}`, platform: s.platform.toUpperCase(), strategy: `seed_${s.platform === 'tiktok' ? 'tt' : 'ig'}` });

    void this.runDiscovery(opts, seeds).catch((err) => {
      this.logger.error(`Discovery orchestration failed: ${(err as Error).message}`);
    });
    return { runs: planned };
  }

  /**
   * "Track to refine": find accounts similar to a competitor the user just
   * tracked. Instagram no longer exposes "related profiles" through the
   * scraper, so the expansion searches the space the user and the tracked
   * account SHARE: an LLM turns both bios (plus the hashtags the competitor
   * really posts with) into account searches and hashtags, the results are
   * enriched and judged against both, and new accounts are added as
   * "Similar to @x you track". Runs in the background with its own job.
   */
  expandFromCompetitor(
    projectId: string,
    competitor: { handle: string; platform: string },
    opts: DiscoveryOptions,
  ): void {
    void this.runExpand(projectId, competitor, opts).catch((err) => {
      this.logger.error(`Expand from @${competitor.handle} failed: ${(err as Error).message}`);
    });
  }

  /* ──────────────────────────────────────────────────────────
   * Pipeline
   * ────────────────────────────────────────────────────────── */

  private buildContext(opts: DiscoveryOptions): DiscoveryContext {
    return {
      projectId: opts.projectId ?? '',
      niche: opts.niche,
      persona: opts.persona,
      location: opts.location,
      entityName: opts.entityName,
      nicheDescription: opts.nicheDescription,
      keywords: opts.keywords,
      targetMarket: opts.targetMarket,
      ownIg: opts.instagramHandle ? normalizeHandle(opts.instagramHandle) : undefined,
      ownTt: opts.tiktokHandle ? normalizeHandle(opts.tiktokHandle) : undefined,
    };
  }

  private async runDiscovery(
    opts: DiscoveryOptions,
    seeds: Array<{ platform: string; handle: string }>,
  ): Promise<void> {
    const projectId = opts.projectId;
    if (!projectId) {
      this.logger.warn('Discovery without project_id — nothing to persist');
      return;
    }
    const ctx = this.buildContext(opts);
    const job = await this.jobsService.createJob(projectId, 'competitor_discovery', {
      niche: opts.niche,
      location: opts.location ?? null,
      seeds: seeds.length,
    });
    await this.jobsService.setActive(job.id);
    const progress: DiscoveryProgress = {
      stage: 'reading_profile',
      message: 'Reading your profile',
      candidates_found: 0,
      enriched: 0,
      kept: 0,
    };
    const report = (pct: number, patch: Partial<DiscoveryProgress>) => {
      Object.assign(progress, patch);
      return this.jobsService.updateProgress(job.id, pct, { ...progress });
    };

    try {
      // 1. Own profile → bio, followers, related accounts
      let own: ScrapedProfile | null = null;
      if (ctx.ownIg) {
        await report(5, { stage: 'reading_profile', message: `Reading @${ctx.ownIg}` });
        own = await this.scrapeInstagramProfile(ctx.ownIg).catch((err) => {
          this.logger.warn(`Own profile scrape failed: ${(err as Error).message}`);
          return null;
        });
        if (own) {
          ctx.ownBio = own.biography || null;
          ctx.ownFollowers = own.followers_count || null;
          await this.refreshOwnProfile(opts.userId, own);
        }
      }

      // 2. Search plan
      await report(12, { stage: 'planning', message: 'Planning the search from your profile and niche' });
      const queries = await this.generateQueries(opts, own);
      this.logger.log(
        `Search plan: queries=${JSON.stringify(queries.search_queries)} hashtags=${JSON.stringify(queries.hashtags)} tiktok=${JSON.stringify(queries.tiktok_queries)}`,
      );

      // 3. Gather candidates (wave 1: Instagram)
      await report(20, { stage: 'searching', message: 'Searching Instagram' });
      const candidates = new Map<string, NormalizedCompetitor>();
      const add = (list: NormalizedCompetitor[]) => {
        for (const c of list) {
          const key = candidateKey(c);
          const prev = candidates.get(key);
          if (!prev || (!prev.biography && c.biography)) candidates.set(key, { ...prev, ...c });
        }
        void report(Math.min(44, 20 + candidates.size), { candidates_found: candidates.size });
      };
      let hashtagItems: Record<string, unknown>[] = [];

      const wave1: Array<Promise<void>> = [];
      if (queries.search_queries.length > 0) {
        wave1.push(
          this.runActor('IG Search', 'apify/instagram-search-scraper', {
            search: queries.search_queries.join(', '),
            searchType: 'user',
            searchLimit: 10,
          }).then((items) => add(this.discoveryIngestService.parseByStrategy('ig_search', items))),
        );
      }
      if (queries.hashtags.length > 0) {
        wave1.push(
          this.runActor('IG Hashtag', 'apify/instagram-hashtag-scraper', {
            hashtags: queries.hashtags,
            resultsType: 'posts',
            resultsLimit: 8,
          }).then((items) => {
            hashtagItems = items;
            add(this.discoveryIngestService.parseByStrategy('ig_hashtag', items));
          }),
        );
      }
      if (own && own.related_profiles.length > 0) {
        add(
          own.related_profiles.map((h) => ({
            handle: h,
            platform: 'INSTAGRAM' as const,
            full_name: null,
            biography: null,
            followers_count: null,
            following_count: null,
            posts_count: null,
            avatar_url: null,
            is_business: false,
            discovery_method: 'ig_related',
            expanded_from: ctx.ownIg,
          })),
        );
      }
      const igSeeds = seeds.filter((s) => s.platform === 'instagram').map((s) => s.handle);
      if (igSeeds.length > 0) {
        wave1.push(
          this.runActor('Seeds IG', 'apify/instagram-profile-scraper', { usernames: igSeeds.slice(0, 5) }).then(
            (items) => add(this.discoveryIngestService.parseByStrategy('seed_ig', items)),
          ),
        );
      }
      await Promise.allSettled(wave1);

      // Wave 2: TikTok
      await report(45, { stage: 'searching_tiktok', message: 'Searching TikTok' });
      const wave2: Array<Promise<void>> = [];
      if (queries.tiktok_queries.length > 0) {
        wave2.push(
          this.runActor('TT Search', 'clockworks/tiktok-scraper', {
            searchQueries: queries.tiktok_queries.slice(0, 2),
            searchSection: '/user' as const,
            maxProfilesPerQuery: 10,
            resultsPerPage: 1,
          }).then((items) => add(this.discoveryIngestService.parseByStrategy('tt_search', items))),
        );
      }
      const ttSeeds = seeds.filter((s) => s.platform === 'tiktok').map((s) => s.handle);
      if (ttSeeds.length > 0) {
        wave2.push(
          this.runActor('Seeds TT', 'clockworks/tiktok-scraper', { profiles: ttSeeds.slice(0, 5), resultsPerPage: 1 }).then(
            (items) => add(this.discoveryIngestService.parseByStrategy('seed_tt', items)),
          ),
        );
      }
      await Promise.allSettled(wave2);

      // 4. Enrich + second hop
      const all = this.capCandidates([...candidates.values()], ctx);
      await report(55, {
        stage: 'enriching',
        message: `Analyzing ${all.length} accounts (bio, audience, related accounts)`,
        candidates_found: all.length,
      });
      const enriched = await this.enrichInstagram(all);
      await report(68, { enriched: enriched.filter((c) => c.platform === 'INSTAGRAM' && c.biography).length });

      const known = new Set(enriched.map(candidateKey));
      if (ctx.ownIg) known.add(`INSTAGRAM:${ctx.ownIg}`);
      const secondHop = this.collectRelated(enriched, known, MAX_SECOND_HOP);
      let hop: NormalizedCompetitor[] = [];
      if (secondHop.length > 0) {
        await report(72, { message: `Looking at ${secondHop.length} accounts Instagram lists next to your matches` });
        hop = await this.enrichInstagram(secondHop);
      }

      // 5. Judge + persist
      const finalCandidates = [...enriched, ...hop];
      await report(80, {
        stage: 'analyzing',
        message: `Judging ${finalCandidates.length} accounts against your brand`,
        candidates_found: finalCandidates.length,
        enriched: finalCandidates.filter((c) => c.biography).length,
      });
      const upserted = await this.discoveryIngestService.finalizeCandidates(finalCandidates, ctx);
      if (hashtagItems.length > 0 && upserted.length > 0) {
        await this.discoveryIngestService.persistHashtagPosts(projectId, upserted, hashtagItems);
      }

      await report(100, { stage: 'done', message: `${upserted.length} competitors ready`, kept: upserted.length });
      await this.jobsService.setCompleted(job.id, { ...progress });
      this.logger.log(`Discovery finished for project ${projectId}: ${upserted.length} competitors`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Discovery failed for project ${projectId}: ${message}`);
      await this.jobsService.setFailed(job.id, message);
    }
  }

  private async runExpand(
    projectId: string,
    competitor: { handle: string; platform: string },
    opts: DiscoveryOptions,
  ): Promise<void> {
    const ctx = this.buildContext(opts);
    const from = normalizeHandle(competitor.handle);
    const platform: 'INSTAGRAM' | 'TIKTOK' = competitor.platform.toUpperCase() === 'TIKTOK' ? 'TIKTOK' : 'INSTAGRAM';
    const job = await this.jobsService.createJob(projectId, 'competitor_discovery', {
      expand_from: from,
      platform,
    });
    await this.jobsService.setActive(job.id);
    const progress: DiscoveryProgress = {
      stage: 'expanding',
      message: `Reading @${from}`,
      candidates_found: 0,
      enriched: 0,
      kept: 0,
      expand_from: from,
    };
    const report = (pct: number, patch: Partial<DiscoveryProgress>) => {
      Object.assign(progress, patch);
      return this.jobsService.updateProgress(job.id, pct, { ...progress });
    };

    try {
      await report(8, {});
      const anchor = await this.loadAnchor(projectId, from, platform);
      ctx.anchor = { handle: from, bio: anchor.biography, followers: anchor.followers_count };
      await this.loadOwnProfileContext(opts.userId, ctx);
      const known = await this.discoveryIngestService.existingHandles(projectId);
      if (ctx.ownIg) known.add(`INSTAGRAM:${ctx.ownIg}`);
      if (ctx.ownTt) known.add(`TIKTOK:${ctx.ownTt}`);

      // 1. Plan: the space the user and the tracked account share
      await report(15, { stage: 'planning', message: `Planning a search around you and @${from}` });
      const plan = await this.generateExpandPlan(opts, ctx, anchor);
      this.logger.log(
        `Expand plan for @${from}: queries=${JSON.stringify(plan.search_queries)} hashtags=${JSON.stringify(plan.hashtags)} tiktok=${JSON.stringify(plan.tiktok_queries)}`,
      );

      // 2. Search that space
      await report(25, { stage: 'searching', message: `Searching accounts in the same space as @${from}` });
      const found = new Map<string, NormalizedCompetitor>();
      const add = (list: NormalizedCompetitor[]) => {
        for (const c of list) {
          const key = candidateKey(c);
          if (known.has(key) || c.handle === from) continue;
          const prev = found.get(key);
          if (!prev || (!prev.biography && c.biography)) found.set(key, { ...prev, ...c });
        }
        void report(Math.min(45, 25 + found.size), { candidates_found: found.size });
      };
      let hashtagItems: Record<string, unknown>[] = [];
      const runs: Array<Promise<void>> = [];
      if (plan.search_queries.length > 0) {
        runs.push(
          this.runActor('IG Expand Search', 'apify/instagram-search-scraper', {
            search: plan.search_queries.join(', '),
            searchType: 'user',
            searchLimit: 10,
          }).then((items) => add(this.discoveryIngestService.parseByStrategy('ig_search', items))),
        );
      }
      if (plan.hashtags.length > 0) {
        runs.push(
          this.runActor('IG Expand Hashtag', 'apify/instagram-hashtag-scraper', {
            hashtags: plan.hashtags,
            resultsType: 'posts',
            resultsLimit: 10,
          }).then((items) => {
            hashtagItems = items;
            add(this.discoveryIngestService.parseByStrategy('ig_hashtag', items));
          }),
        );
      }
      if (platform === 'TIKTOK' && plan.tiktok_queries.length > 0) {
        runs.push(
          this.runActor('TT Expand', 'clockworks/tiktok-scraper', {
            searchQueries: plan.tiktok_queries.slice(0, 2),
            searchSection: '/user' as const,
            maxProfilesPerQuery: 10,
            resultsPerPage: 1,
          }).then((items) => add(this.discoveryIngestService.parseTtSearch(items))),
        );
      }
      await Promise.allSettled(runs);

      const candidates = [...found.values()]
        .slice(0, MAX_EXPAND)
        .map((c) => ({ ...c, discovery_method: 'expand', expanded_from: from }));
      await report(50, {
        candidates_found: candidates.length,
        message: `Analyzing ${candidates.length} accounts found next to @${from}`,
      });
      if (candidates.length === 0) {
        await report(100, { stage: 'done', message: `No new accounts found around @${from}` });
        await this.jobsService.setCompleted(job.id, { ...progress });
        return;
      }

      // 3. Enrich, judge against both accounts, persist
      const enriched = await this.enrichInstagram(candidates);
      await report(78, {
        stage: 'analyzing',
        enriched: enriched.filter((c) => c.biography).length,
        message: `Judging ${enriched.length} accounts against you and @${from}`,
      });
      const upserted = await this.discoveryIngestService.finalizeCandidates(enriched, ctx);
      if (hashtagItems.length > 0 && upserted.length > 0) {
        await this.discoveryIngestService.persistHashtagPosts(projectId, upserted, hashtagItems);
      }
      await report(100, {
        stage: 'done',
        kept: upserted.length,
        message:
          upserted.length > 0
            ? `${upserted.length} new accounts similar to @${from}`
            : `No strong matches around @${from} this time`,
      });
      await this.jobsService.setCompleted(job.id, { ...progress });
      this.logger.log(`Expand from @${from}: ${upserted.length} new competitors for project ${projectId}`);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Expand from @${from} failed: ${message}`);
      await this.jobsService.setFailed(job.id, message);
    }
  }

  /** The tracked competitor as stored (bio, audience) + the hashtags it posts with. */
  private async loadAnchor(projectId: string, handle: string, platform: 'INSTAGRAM' | 'TIKTOK'): Promise<AnchorAccount> {
    const client = this.supabaseService.getClient();
    const { data } = await client
      .from('competitors')
      .select('id, full_name, biography, followers_count')
      .eq('project_id', projectId)
      .eq('handle', handle)
      .eq('platform', platform.toLowerCase())
      .maybeSingle();
    const row = (data ?? null) as { id: string; full_name: string | null; biography: string | null; followers_count: number | null } | null;

    let hashtags: string[] = [];
    if (row?.id) {
      const { data: posts } = await client
        .from('scraped_content')
        .select('hashtags')
        .eq('competitor_id', row.id)
        .limit(40);
      const counts = new Map<string, number>();
      for (const p of (posts ?? []) as Array<{ hashtags: string[] | null }>) {
        for (const h of p.hashtags ?? []) {
          const t = toHashtagToken(h);
          if (t.length >= 3) counts.set(t, (counts.get(t) ?? 0) + 1);
        }
      }
      hashtags = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([t]) => t);
    }

    if (row && (row.biography || row.followers_count)) {
      return { id: row.id, handle, platform, full_name: row.full_name, biography: row.biography, followers_count: row.followers_count, hashtags };
    }
    // Not enriched yet — read the profile now
    const profile =
      platform === 'INSTAGRAM'
        ? await this.scrapeInstagramProfile(handle).catch(() => null)
        : await this.scrapeTiktokProfile(handle).catch(() => null);
    return {
      id: row?.id ?? null,
      handle,
      platform,
      full_name: profile?.full_name ?? row?.full_name ?? null,
      biography: profile?.biography ?? row?.biography ?? null,
      followers_count: profile?.followers_count ?? row?.followers_count ?? null,
      hashtags,
    };
  }

  /** The judge needs the user's own bio/followers; discovery sets them in-process, expansion reads the profile row. */
  private async loadOwnProfileContext(userId: string | undefined, ctx: DiscoveryContext): Promise<void> {
    if (!userId || ctx.ownBio) return;
    const { data } = await this.supabaseService
      .getClient()
      .from('profiles')
      .select('biography, followers_count')
      .eq('id', userId)
      .maybeSingle();
    const row = (data ?? null) as { biography: string | null; followers_count: number | null } | null;
    if (row) {
      ctx.ownBio = row.biography;
      ctx.ownFollowers = row.followers_count;
    }
  }

  /** Search plan for "accounts like @x": the space the brand and the tracked account share. */
  private async generateExpandPlan(
    opts: DiscoveryOptions,
    ctx: DiscoveryContext,
    anchor: AnchorAccount,
  ): Promise<GeneratedQueries> {
    const heuristic = buildSearchQueries(opts.niche, opts.location);
    const fallback: GeneratedQueries = {
      search_queries: heuristic,
      hashtags: anchor.hashtags.length > 0 ? anchor.hashtags.slice(0, 3) : buildHashtags(opts.niche),
      tiktok_queries: heuristic.slice(0, 2),
    };
    const banned = [opts.entityName, opts.instagramHandle, opts.tiktokHandle, anchor.handle, anchor.full_name]
      .filter((s): s is string => !!s && s.trim().length > 2)
      .map((s) => normalizeHandle(s).replace(/[^a-z0-9]/g, ''));
    const notOwn = (q: string) => !banned.some((b) => b && q.toLowerCase().replace(/[^a-z0-9]/g, '').includes(b));
    try {
      const result = await this.openaiService.chatJson<GeneratedQueries>(
        `You plan social media searches to find MORE accounts like a competitor the user just decided to track. ` +
          `You receive the user's brand (bio, niche, country) and the tracked competitor (bio, audience size, ` +
          `hashtags it really posts with). Identify the space they SHARE — same activity, same audience, same ` +
          `market and language — and produce search terms that OTHER accounts in that exact space would have in ` +
          `their handle, name or bio, plus hashtags such accounts post with. Be specific (activity + audience + ` +
          `place, in the market's language); avoid single generic words. NEVER use the name or handle of the brand ` +
          `or of the tracked competitor. Respond with JSON: {"search_queries": [3 short account-search queries], ` +
          `"hashtags": [3 hashtags without #, lowercase, no spaces], "tiktok_queries": [2 short queries]}`,
        JSON.stringify({
          brand: {
            niche: opts.niche,
            description: opts.nicheDescription ?? null,
            bio: ctx.ownBio ?? null,
            followers: ctx.ownFollowers ?? null,
            keywords: opts.keywords ?? [],
            country: opts.location ?? null,
            language: opts.language ?? null,
          },
          tracked_competitor: {
            bio: anchor.biography,
            followers: anchor.followers_count,
            hashtags_used: anchor.hashtags,
            platform: anchor.platform,
          },
        }),
      );
      const plan: GeneratedQueries = {
        search_queries: cleanList(result.search_queries, 3).filter(notOwn),
        hashtags: cleanList(result.hashtags, 3).map(toHashtagToken).filter((h) => h.length >= 3 && notOwn(h)),
        tiktok_queries: cleanList(result.tiktok_queries, 2).filter(notOwn),
      };
      if (plan.search_queries.length === 0) plan.search_queries = fallback.search_queries;
      if (plan.hashtags.length === 0) plan.hashtags = fallback.hashtags;
      if (plan.tiktok_queries.length === 0) plan.tiktok_queries = fallback.tiktok_queries;
      return plan;
    } catch (err) {
      this.logger.warn(`Expand plan generation failed, using heuristics: ${(err as Error).message}`);
      return fallback;
    }
  }

  /** Keep the most promising candidates within the enrichment budget. */
  private capCandidates(list: NormalizedCompetitor[], ctx: DiscoveryContext): NormalizedCompetitor[] {
    const rank = (c: NormalizedCompetitor) =>
      c.discovery_method === 'seed' ? 0 : c.discovery_method === 'ig_related' ? 1 : c.discovery_method === 'ig_search' ? 2 : 3;
    const own = new Set([ctx.ownIg, ctx.ownTt].filter(Boolean));
    const sorted = list.filter((c) => !own.has(c.handle)).sort((a, b) => rank(a) - rank(b));
    const ig = sorted.filter((c) => c.platform === 'INSTAGRAM').slice(0, MAX_IG_CANDIDATES);
    const tt = sorted.filter((c) => c.platform === 'TIKTOK').slice(0, MAX_TT_CANDIDATES);
    return [...ig, ...tt];
  }

  /** Profile-scrape Instagram candidates that lack a bio and merge the full data in. */
  private async enrichInstagram(list: NormalizedCompetitor[]): Promise<NormalizedCompetitor[]> {
    const needs = list.filter((c) => c.platform === 'INSTAGRAM' && !c.biography).map((c) => c.handle);
    if (needs.length === 0) return list;
    const items = await this.runActor('IG Enrich', 'apify/instagram-profile-scraper', {
      usernames: [...new Set(needs)].slice(0, MAX_IG_CANDIDATES),
    });
    const full = new Map(
      this.discoveryIngestService.parseIgProfiles(items, 'enriched').map((p) => [p.handle, p] as const),
    );
    return list.map((c) => {
      if (c.platform !== 'INSTAGRAM') return c;
      const p = full.get(c.handle);
      if (!p) return c;
      return {
        ...c,
        full_name: p.full_name ?? c.full_name,
        biography: p.biography,
        followers_count: p.followers_count,
        following_count: p.following_count,
        posts_count: p.posts_count,
        avatar_url: p.avatar_url ?? c.avatar_url,
        is_business: p.is_business,
        related_handles: p.related_handles,
      };
    });
  }

  /** Accounts Instagram lists next to the enriched candidates (one hop, capped). */
  private collectRelated(
    enriched: NormalizedCompetitor[],
    known: Set<string>,
    max: number,
  ): NormalizedCompetitor[] {
    const out: NormalizedCompetitor[] = [];
    const seen = new Set<string>();
    // Prefer related accounts of the best-looking candidates (bio + audience)
    const ordered = [...enriched]
      .filter((c) => c.platform === 'INSTAGRAM' && c.related_handles && c.related_handles.length > 0)
      .sort((a, b) => (b.followers_count ?? 0) - (a.followers_count ?? 0));
    for (const c of ordered) {
      for (const h of c.related_handles ?? []) {
        const key = `INSTAGRAM:${h}`;
        if (known.has(key) || seen.has(key)) continue;
        seen.add(key);
        out.push({
          handle: h,
          platform: 'INSTAGRAM',
          full_name: null,
          biography: null,
          followers_count: null,
          following_count: null,
          posts_count: null,
          avatar_url: null,
          is_business: false,
          discovery_method: 'ig_related',
          expanded_from: c.handle,
        });
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  /** Keep the user's own profile fresh (bio, counts, permanent avatar). */
  private async refreshOwnProfile(userId: string | undefined, own: ScrapedProfile): Promise<void> {
    if (!userId) return;
    try {
      const client = this.supabaseService.getClient();
      const avatar = own.avatar_url
        ? (await this.avatarStorage.persist(own.avatar_url, `profiles/${userId}`)) ?? own.avatar_url
        : null;
      const { error } = await client
        .from('profiles')
        .update({
          biography: own.biography || null,
          followers_count: own.followers_count || null,
          following_count: own.following_count || null,
          posts_count: own.posts_count || null,
          is_verified: own.is_verified,
          avatar_url: avatar,
        })
        .eq('id', userId);
      if (error) this.logger.warn(`Profile refresh failed: ${error.message}`);
    } catch (err) {
      this.logger.warn(`Profile refresh failed: ${(err as Error).message}`);
    }
  }

  /** Run an actor to completion (through the Apify gate) and return its dataset items (empty on failure). */
  private async runActor(
    label: string,
    actorId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    try {
      this.logger.log(`[${label}] Launching actor ${actorId}`);
      const items = await this.apify.items(label, actorId, input);
      this.logger.log(`[${label}] ${items.length} items`);
      return items;
    } catch (err) {
      this.logger.error(`[${label}] failed: ${(err as Error).message}`);
      return [];
    }
  }

  /**
   * LLM-generated search plan from the full brand context (bio included).
   * Falls back to the heuristic query builder if the model call fails.
   */
  private async generateQueries(opts: DiscoveryOptions, own: ScrapedProfile | null): Promise<GeneratedQueries> {
    const fallback: GeneratedQueries = {
      search_queries: buildSearchQueries(opts.niche, opts.location),
      hashtags: buildHashtags(opts.niche),
      tiktok_queries: buildSearchQueries(opts.niche, opts.location).slice(0, 2),
    };
    try {
      const result = await this.openaiService.chatJson<GeneratedQueries>(
        `You plan social media searches to find the DIRECT COMPETITORS of a brand or creator. ` +
          `Infer what the account is really about from its bio and description (the niche label is coarse). ` +
          `Produce search terms that real Instagram/TikTok accounts in that exact space and country would ` +
          `have in their handle, name or bio: specific activity + audience + place (e.g. "coach business tunis", ` +
          `"formation entrepreneuriat tunisie"), in the language actually used in that market. ` +
          `NEVER use the brand's own name or handle as a query. Avoid single generic words like "business". ` +
          `Respond with JSON: {"search_queries": [3 short account-search queries], ` +
          `"hashtags": [4 hashtags without #, lowercase, no spaces, that peers in this niche actually use], ` +
          `"tiktok_queries": [2 short queries]}`,
        JSON.stringify({
          niche: opts.niche,
          description: opts.nicheDescription ?? null,
          bio: own?.biography ?? null,
          followers: own?.followers_count ?? null,
          keywords: opts.keywords ?? [],
          target_audience: opts.targetMarket ?? null,
          country: opts.location ?? null,
          language: opts.language ?? null,
          persona: opts.persona ?? null,
        }),
      );
      const banned = [opts.entityName, opts.instagramHandle, opts.tiktokHandle]
        .filter((s): s is string => !!s)
        .map((s) => normalizeHandle(s).replace(/[^a-z0-9]/g, ''));
      const notOwn = (q: string) => !banned.some((b) => b && q.toLowerCase().replace(/[^a-z0-9]/g, '').includes(b));
      const plan: GeneratedQueries = {
        search_queries: cleanList(result.search_queries, 3).filter(notOwn),
        hashtags: cleanList(result.hashtags, 4).map(toHashtagToken).filter(notOwn),
        tiktok_queries: cleanList(result.tiktok_queries, 2).filter(notOwn),
      };
      if (plan.search_queries.length === 0) plan.search_queries = fallback.search_queries;
      if (plan.hashtags.length === 0) plan.hashtags = fallback.hashtags;
      if (plan.tiktok_queries.length === 0) plan.tiktok_queries = fallback.tiktok_queries;
      return plan;
    } catch (err) {
      this.logger.warn(`Query generation failed, using heuristics: ${(err as Error).message}`);
      return fallback;
    }
  }

  /* ──────────────────────────────────────────────────────────
   * Profile scraping (also used by the /scraper/profile endpoint)
   * ────────────────────────────────────────────────────────── */

  async getActorRun(runId: string) {
    return this.apify.apify.run(runId).get();
  }

  async getDatasetItems(datasetId: string) {
    return this.apify.apify.dataset(datasetId).listItems();
  }

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

  /**
   * One public post by URL (Instagram post/reel or TikTok video): caption, metrics,
   * author and a downloadable video URL when there is one. Used by Studio references.
   */
  async scrapePost(url: string): Promise<ScrapedPost> {
    const clean = url.trim();
    const isTikTok = /tiktok\.com/i.test(clean);
    const isInstagram = /instagram\.com\/(p|reel|reels|tv)\//i.test(clean);
    if (!isTikTok && !isInstagram) {
      throw new BadRequestException('Paste a link to an Instagram post/reel or a TikTok video.');
    }

    if (isTikTok) {
      const items = await this.apify.items('TT Post', 'clockworks/tiktok-scraper', {
        postURLs: [clean],
        resultsPerPage: 1,
        shouldDownloadVideos: true,
        shouldDownloadCovers: false,
        shouldDownloadSubtitles: false,
        shouldDownloadSlideshowImages: false,
      });
      const raw = (items[0] ?? null) as Record<string, unknown> | null;
      if (!raw) throw new BadRequestException('That TikTok video could not be read (private or removed?).');
      const author = raw.authorMeta as { name?: string; nickName?: string } | undefined;
      const videoMeta = raw.videoMeta as { duration?: number; downloadAddr?: string; coverUrl?: string } | undefined;
      const media = raw.mediaUrls as string[] | undefined;
      return {
        platform: 'tiktok',
        post_url: (raw.webVideoUrl as string) || clean,
        author: author?.name ?? null,
        caption: (raw.text as string) ?? '',
        likes: (raw.diggCount as number) ?? null,
        comments: (raw.commentCount as number) ?? null,
        views: (raw.playCount as number) ?? null,
        shares: (raw.shareCount as number) ?? null,
        duration_seconds: videoMeta?.duration ?? null,
        video_url: media?.[0] ?? videoMeta?.downloadAddr ?? null,
        thumbnail_url: videoMeta?.coverUrl ?? null,
      };
    }

    const items = await this.apify.items('IG Post', 'apify/instagram-scraper', {
      directUrls: [clean],
      resultsType: 'posts',
      resultsLimit: 1,
      addParentData: false,
    });
    const raw = (items[0] ?? null) as Record<string, unknown> | null;
    if (!raw || (raw.error as string | undefined)) {
      throw new BadRequestException('That Instagram post could not be read (private or removed?).');
    }
    return {
      platform: 'instagram',
      post_url: (raw.url as string) || clean,
      author: (raw.ownerUsername as string) ?? null,
      caption: (raw.caption as string) ?? '',
      likes: (raw.likesCount as number) ?? null,
      comments: (raw.commentsCount as number) ?? null,
      views: ((raw.videoPlayCount ?? raw.videoViewCount) as number | undefined) ?? null,
      shares: null,
      duration_seconds: (raw.videoDuration as number) ?? null,
      video_url: (raw.videoUrl as string) ?? null,
      thumbnail_url: (raw.displayUrl as string) ?? null,
    };
  }

  private async scrapeInstagramProfile(handle: string): Promise<ScrapedProfile> {
    const items = await this.apify.items(`IG Profile @${handle}`, 'apify/instagram-profile-scraper', { usernames: [handle] });
    if (!items.length) throw new BadRequestException(`No profile data found for Instagram handle @${handle}`);
    const raw = items[0] as unknown as InstagramProfileRaw;
    const relatedProfiles = (raw.relatedProfiles || [])
      .map((rp) => rp.username?.toLowerCase())
      .filter((u): u is string => !!u);
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
    const items = await this.apify.items(`TT Profile @${handle}`, 'clockworks/tiktok-scraper', { profiles: [handle], resultsPerPage: 1 });
    if (!items.length) throw new BadRequestException(`No profile data found for TikTok handle @${handle}`);
    const raw = items[0] as unknown as TiktokProfileRaw;
    const meta = raw.authorMeta;
    const stats = raw.authorStats;
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
