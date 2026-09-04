import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { OpenAIService } from '../embeddings/openai.service';
import { AvatarStorageService } from './avatar-storage.service';

export interface NormalizedCompetitor {
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
  /** Handle of the tracked/seed account this candidate was found next to */
  expanded_from?: string;
  /** Related handles Instagram lists next to this account (from enrichment) */
  related_handles?: string[];
}

export interface DiscoveryContext {
  projectId: string;
  niche: string;
  ownIg?: string;
  ownTt?: string;
  ownBio?: string | null;
  ownFollowers?: number | null;
  persona?: string;
  location?: string;
  entityName?: string;
  nicheDescription?: string;
  keywords?: string[];
  targetMarket?: string;
  /** Competitor the user just tracked — an expansion looks for accounts like it */
  anchor?: { handle: string; bio: string | null; followers: number | null };
}

export interface UpsertedCompetitor {
  id: string;
  handle: string;
  platform: string;
  avatar_url: string | null;
}

interface RelevanceVerdict {
  keep: Array<{ handle: string; relevance: number; reason: string }>;
}

const SEED_METHOD = 'seed';
const EXPAND_METHOD = 'expand';
const SEED_CONFIDENCE = 92;
/** Competitors persisted per finalize pass (best confidence first) */
const MAX_KEEP = 30;

export function candidateKey(c: { platform: string; handle: string }): string {
  return `${c.platform}:${c.handle.toLowerCase()}`;
}

function scoreConfidence(
  c: NormalizedCompetitor,
  nicheKeywords: string[],
  ownFollowers: number | null | undefined,
): number {
  let score = 45;

  if (c.biography) {
    const bioLower = c.biography.toLowerCase();
    const matches = nicheKeywords.filter((kw) => bioLower.includes(kw));
    score += Math.min(matches.length * 6, 18);
  }

  if (c.followers_count) {
    if (c.followers_count >= 1_000 && c.followers_count <= 500_000) score += 12;
    else if (c.followers_count > 500_000 && c.followers_count <= 2_000_000) score += 6;
    else if (c.followers_count >= 500 && c.followers_count < 1_000) score += 4;
    // Tiny accounts are rarely meaningful competitors unless the brand is tiny too
    if (c.followers_count < 300 && (ownFollowers ?? 0) >= 500) score -= 12;
  }

  if (c.posts_count && c.posts_count > 20) score += 5;
  if (c.is_business) score += 5;

  if (c.discovery_method === 'ig_related') score += 10;
  else if (c.discovery_method === EXPAND_METHOD) score += 12;
  else if (c.discovery_method === 'ig_hashtag') score += 6;

  return Math.max(20, Math.min(score, 98));
}

function buildInclusionReason(c: NormalizedCompetitor, niche: string): string {
  switch (c.discovery_method) {
    case SEED_METHOD:
      return 'Chosen by you as a benchmark account.';
    case EXPAND_METHOD:
      return c.expanded_from
        ? `Found in the same space as @${c.expanded_from}, which you track.`
        : 'Similar to an account you track.';
    case 'ig_related':
      return c.expanded_from
        ? `Instagram lists this account next to @${c.expanded_from}.`
        : 'Instagram recommends this account as similar to yours.';
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

function extractNicheKeywords(niche: string, extra: string[] = []): string[] {
  const stopWords = new Set(['and', '&', 'the', 'of', 'for', 'in', 'a', 'an', 'to']);
  const fromNiche = niche
    .toLowerCase()
    .split(/[\s—–\-&,/]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !stopWords.has(w));
  const fromExtra = extra.map((k) => k.toLowerCase().trim()).filter((k) => k.length >= 3);
  return [...new Set([...fromNiche, ...fromExtra])];
}

/**
 * Turns candidate accounts into competitors rows: relevance judging on the
 * enriched data, scoring, idempotent upsert, avatar persistence, and
 * post-level persistence for hashtag results.
 */
@Injectable()
export class DiscoveryIngestService {
  private readonly logger = new Logger(DiscoveryIngestService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly openaiService: OpenAIService,
    private readonly avatarStorage: AvatarStorageService,
  ) {}

  /**
   * Legacy single-run path (Apify webhook): parse one run's items and
   * finalize them immediately. The in-process pipeline in ScraperService
   * gathers, enriches and finalizes all signals together instead.
   */
  async ingestRunItems(
    strategy: string,
    items: Record<string, unknown>[],
    ctx: DiscoveryContext,
  ): Promise<number> {
    const candidates = this.parseByStrategy(strategy, items);
    const upserted = await this.finalizeCandidates(candidates, ctx);
    if (strategy === 'ig_hashtag') {
      await this.persistHashtagPosts(ctx.projectId, upserted, items);
    }
    return upserted.length;
  }

  /** Handles already stored for a project (to avoid re-adding / re-judging them). */
  async existingHandles(projectId: string): Promise<Set<string>> {
    const client = this.supabaseService.getClient();
    const { data } = await client
      .from('competitors')
      .select('handle, platform')
      .eq('project_id', projectId);
    return new Set(((data ?? []) as Array<{ handle: string; platform: string }>).map(candidateKey));
  }

  /**
   * Judge, score and upsert candidates. Returns the upserted rows.
   */
  async finalizeCandidates(
    input: NormalizedCompetitor[],
    ctx: DiscoveryContext,
  ): Promise<UpsertedCompetitor[]> {
    if (input.length === 0) return [];

    // Dedupe by platform+handle, drop the user's own handles
    const ownHandles = new Set<string>();
    if (ctx.ownIg) ownHandles.add(ctx.ownIg.toLowerCase());
    if (ctx.ownTt) ownHandles.add(ctx.ownTt.toLowerCase());
    const byKey = new Map<string, NormalizedCompetitor>();
    for (const c of input) {
      if (ownHandles.has(c.handle.toLowerCase())) continue;
      const key = candidateKey(c);
      const prev = byKey.get(key);
      // Prefer the richer record (with bio) when the same account came from two signals
      if (!prev || (!prev.biography && c.biography)) byKey.set(key, { ...prev, ...c });
    }
    const all = [...byKey.values()];
    const seeds = all.filter((c) => c.discovery_method === SEED_METHOD);
    const candidates = all.filter((c) => c.discovery_method !== SEED_METHOD);

    const verdicts = candidates.length > 0 ? await this.judgeRelevance(candidates, ctx) : new Map();

    const nicheKeywords = extractNicheKeywords(ctx.niche || '', ctx.keywords ?? []);
    const nicheLabel = ctx.niche || '';

    const kept = [
      ...seeds,
      ...candidates.filter((c) => !verdicts || verdicts.has(c.handle.toLowerCase())),
    ];

    const scored = kept.map((c) => {
      const verdict = verdicts?.get(c.handle.toLowerCase());
      const heuristic = scoreConfidence(c, nicheKeywords, ctx.ownFollowers);
      const confidence =
        c.discovery_method === SEED_METHOD
          ? SEED_CONFIDENCE
          : verdict
            ? Math.min(Math.round(heuristic * 0.4 + verdict.relevance * 100 * 0.6), 98)
            : heuristic;
      const baseReason = verdict?.reason || buildInclusionReason(c, nicheLabel);
      const reason =
        c.discovery_method === EXPAND_METHOD && c.expanded_from
          ? `Similar to @${c.expanded_from} you track — ${baseReason}`
          : baseReason;
      return {
        project_id: ctx.projectId,
        handle: c.handle,
        platform: c.platform,
        full_name: c.full_name,
        biography: c.biography,
        followers_count: c.followers_count,
        following_count: c.following_count,
        posts_count: c.posts_count,
        avatar_url: c.avatar_url,
        discovery_method: c.discovery_method,
        confidence_score: parseFloat(confidence.toFixed(1)),
        inclusion_reason: reason,
      };
    });
    // Best matches first; seeds always survive the cap
    const rows = [
      ...scored.filter((r) => r.discovery_method === SEED_METHOD),
      ...scored
        .filter((r) => r.discovery_method !== SEED_METHOD)
        .sort((a, b) => b.confidence_score - a.confidence_score),
    ].slice(0, MAX_KEEP);
    if (scored.length > rows.length) {
      this.logger.log(`Capped ${scored.length} judged candidates to the best ${rows.length}`);
    }

    if (rows.length === 0) {
      this.logger.log(`Nothing kept out of ${all.length} candidates for project ${ctx.projectId}`);
      return [];
    }

    const client = this.supabaseService.getClient();
    const { data: upserted, error } = await client
      .from('competitors')
      .upsert(rows, { onConflict: 'project_id,handle,platform', ignoreDuplicates: false })
      .select('id, handle, platform, avatar_url');

    if (error) {
      this.logger.error(`Supabase batch upsert error: ${JSON.stringify(error)}`);
      return [];
    }

    const upsertedRows = (upserted ?? []) as UpsertedCompetitor[];
    this.logger.log(
      `Kept ${rows.length}/${all.length} candidates for project ${ctx.projectId} (seeds: ${seeds.length})`,
    );

    // Persist avatars to our own storage (CDN URLs expire) — awaited so that
    // the first render of the list already shows real pictures.
    await this.persistAvatars(upsertedRows);
    return upsertedRows;
  }

  private async persistAvatars(rows: UpsertedCompetitor[]): Promise<void> {
    const client = this.supabaseService.getClient();
    const pending = rows.filter((r) => r.avatar_url && !this.avatarStorage.isStorageUrl(r.avatar_url));
    // Small concurrency to keep it quick without hammering the CDN
    const CONCURRENCY = 4;
    for (let i = 0; i < pending.length; i += CONCURRENCY) {
      await Promise.all(
        pending.slice(i, i + CONCURRENCY).map(async (row) => {
          const stored = await this.avatarStorage.persist(row.avatar_url, `competitors/${row.id}`);
          if (!stored) return;
          const { error } = await client.from('competitors').update({ avatar_url: stored }).eq('id', row.id);
          if (error) this.logger.warn(`Failed to save stored avatar for ${row.id}: ${error.message}`);
        }),
      );
    }
  }

  /**
   * Asks gpt-4o-mini which candidates could plausibly compete with the user's
   * brand for the same audience. Returns a map handle -> {relevance, reason}
   * for accounts to KEEP, or null if the LLM call failed (caller keeps all).
   */
  private async judgeRelevance(
    candidates: NormalizedCompetitor[],
    ctx: DiscoveryContext,
  ): Promise<Map<string, { relevance: number; reason: string }> | null> {
    if (candidates.length === 0) return new Map();

    const brand = {
      name: ctx.entityName || 'unknown',
      handle: ctx.ownIg || ctx.ownTt || null,
      bio: ctx.ownBio || null,
      followers: ctx.ownFollowers ?? null,
      persona: ctx.persona || 'unknown',
      niche: ctx.niche || 'unknown',
      description: ctx.nicheDescription || null,
      keywords: ctx.keywords ?? [],
      target_audience: ctx.targetMarket || null,
      country: ctx.location || 'unknown',
      already_tracked: ctx.anchor
        ? { handle: ctx.anchor.handle, bio: ctx.anchor.bio, followers: ctx.anchor.followers }
        : null,
    };
    const list = candidates.map((c) => ({
      handle: c.handle,
      platform: c.platform,
      name: c.full_name,
      bio: c.biography ? c.biography.slice(0, 220) : null,
      followers: c.followers_count,
      posts: c.posts_count,
      found_via: c.discovery_method,
    }));

    try {
      const verdict = await this.openaiService.chatJson<RelevanceVerdict>(
        `You are a senior social media strategist selecting the REAL competitors of a brand: ` +
          `accounts that fight for the same audience, in the same market, with a comparable positioning. ` +
          `You receive the brand (bio, followers, niche, country) and candidate accounts with their bio and audience. ` +
          `KEEP an account only if a marketer would benchmark against it. ` +
          `DROP: global media/news outlets, official platform/product accounts, celebrities, generic ` +
          `motivational/meme/quote pages, agencies or service providers that are not peers (unless the brand is one too), ` +
          `accounts in a different category or serving a different geography/language than the brand, ` +
          `and accounts with no bio AND no audience data. Prefer accounts with an established, comparable audience ` +
          `(the brand's follower count is given; a competitor 50x smaller or 500x bigger is rarely useful). ` +
          `KEEP every account a marketer could reasonably benchmark against — when the pool allows, keep 10 to 20. ` +
          `Express doubt through the relevance score (0.3-0.5 = weaker but usable peer, 0.7+ = direct competitor) ` +
          `instead of dropping borderline accounts; drop only the clear mismatches listed above. ` +
          `If "already_tracked" is given, the user chose that account as a competitor: accounts similar to it ` +
          `(same activity, audience, market, language) are especially wanted and deserve a higher relevance. ` +
          `Respond with JSON: {"keep": [{"handle": "...", "relevance": 0.0-1.0, ` +
          `"reason": "one concrete sentence (mention what they post and who they target) that a user will read"}]}`,
        JSON.stringify({ brand, candidates: list }),
      );

      const map = new Map<string, { relevance: number; reason: string }>();
      for (const k of verdict.keep ?? []) {
        if (k.handle) {
          map.set(k.handle.toLowerCase(), {
            relevance: Math.max(0, Math.min(1, k.relevance ?? 0.5)),
            reason: k.reason || '',
          });
        }
      }
      this.logger.log(
        `Relevance filter kept ${map.size}/${candidates.length} candidates for project ${ctx.projectId}`,
      );
      return map;
    } catch (err) {
      this.logger.warn(`Relevance filter failed (keeping all candidates): ${(err as Error).message}`);
      return null;
    }
  }

  async persistHashtagPosts(
    projectId: string,
    upsertedCompetitors: Array<{ id: string; handle: string; platform: string }>,
    items: Record<string, unknown>[],
  ): Promise<void> {
    const handleToCompetitorId = new Map<string, string>();
    for (const c of upsertedCompetitors) handleToCompetitorId.set(c.handle.toLowerCase(), c.id);

    const client = this.supabaseService.getClient();
    const rows: Array<Record<string, unknown>> = [];

    for (const item of items) {
      const owner = (item.ownerUsername as string | undefined)?.toLowerCase();
      const externalId = (item.id as string | undefined) ?? (item.shortCode as string | undefined);
      if (!owner || !externalId) continue;
      const competitorId = handleToCompetitorId.get(owner);
      if (!competitorId) continue;

      const caption = (item.caption as string | undefined) ?? null;
      const hashtags = (caption?.match(/#[A-Za-z0-9_]+/g) ?? []).map((h) => h.slice(1).toLowerCase());
      const mentions = (caption?.match(/@[A-Za-z0-9_.]+/g) ?? []).map((m) => m.slice(1).toLowerCase());

      rows.push({
        project_id: projectId,
        source_type: 'competitor',
        competitor_id: competitorId,
        platform: 'instagram',
        external_id: externalId,
        post_url: (item.url as string | undefined) ?? `https://www.instagram.com/p/${externalId}/`,
        content_type: item.type === 'Video' ? 'video' : item.type === 'Sidecar' ? 'carousel' : 'image',
        caption,
        hashtags,
        mentions,
        media_urls: [],
        thumbnail_url: (item.displayUrl as string | undefined) ?? null,
        likes_count: (item.likesCount as number | undefined) ?? 0,
        comments_count: (item.commentsCount as number | undefined) ?? 0,
        views_count: (item.videoViewCount as number | undefined) ?? 0,
        shares_count: 0,
        saves_count: 0,
        engagement_rate: null,
        raw_data: item,
        published_at: item.timestamp ? new Date(item.timestamp as string).toISOString() : null,
      });
    }

    if (rows.length === 0) return;

    const { data, error } = await client
      .from('scraped_content')
      .upsert(rows, { onConflict: 'project_id,platform,external_id', ignoreDuplicates: false })
      .select('id');
    if (error) {
      this.logger.error(`Failed to upsert competitor scraped_content: ${error.message}`);
      return;
    }
    const insertedIds = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    this.logger.log(`Persisted ${insertedIds.length} competitor posts to scraped_content`);
    this.embeddingsService.embedScrapedContentBatch(insertedIds).catch((err) => {
      this.logger.error(`Competitor post embedding failed: ${(err as Error).message}`);
    });
  }

  /* ──────────────────────────────────────────────────────────
   * Strategy-specific parsers
   * ────────────────────────────────────────────────────────── */

  parseByStrategy(strategy: string, items: Record<string, unknown>[]): NormalizedCompetitor[] {
    switch (strategy) {
      case 'ig_search':
        return this.parseIgProfiles(items, 'ig_search');
      case 'ig_hashtag':
        return this.parseIgHashtag(items);
      case 'ig_related':
        return this.parseIgRelated(items);
      case 'seed_ig':
        return [...this.parseIgProfiles(items, SEED_METHOD), ...this.parseIgRelated(items)];
      case 'tt_search':
        return this.parseTtSearch(items);
      case 'seed_tt':
        return this.parseTtSearch(items).map((c) => ({ ...c, discovery_method: SEED_METHOD }));
      default:
        return this.parseAutoDetect(items);
    }
  }

  /** Instagram profile-shaped items (search or profile scraper) */
  parseIgProfiles(items: Record<string, unknown>[], method: string): NormalizedCompetitor[] {
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
        is_business: !!item.isBusinessAccount,
        discovery_method: method,
        related_handles: Array.isArray(item.relatedProfiles)
          ? (item.relatedProfiles as Array<{ username?: string }>)
              .map((r) => r.username?.toLowerCase())
              .filter((u): u is string => !!u)
          : [],
      }));
  }

  private parseIgHashtag(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const seen = new Map<string, NormalizedCompetitor>();
    for (const item of items) {
      const username = item.ownerUsername as string | undefined;
      if (!username) continue;
      const handle = username.toLowerCase();
      if (seen.has(handle)) continue;
      seen.set(handle, {
        handle,
        platform: 'INSTAGRAM',
        full_name: (item.ownerFullName as string) || null,
        biography: null,
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

  private parseIgRelated(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const competitors: NormalizedCompetitor[] = [];
    for (const profile of items) {
      const from = typeof profile.username === 'string' ? (profile.username as string).toLowerCase() : undefined;
      const relatedProfiles = profile.relatedProfiles as
        | Array<{ username?: string; full_name?: string; profile_pic_url?: string }>
        | undefined;
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
          expanded_from: from,
        });
      }
    }
    return competitors;
  }

  parseTtSearch(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const seen = new Map<string, NormalizedCompetitor>();
    for (const item of items) {
      const authorMeta = item.authorMeta as Record<string, unknown> | undefined;
      const authorStats = item.authorStats as Record<string, unknown> | undefined;
      const author = item.author as Record<string, unknown> | undefined;
      const handle = (
        (item.uniqueId as string) || (authorMeta?.name as string) || (author?.uniqueId as string)
      )?.toLowerCase();
      if (!handle || seen.has(handle)) continue;
      seen.set(handle, {
        handle,
        platform: 'TIKTOK',
        full_name: (authorMeta?.nickName as string) || (item.nickname as string) || null,
        biography: (authorMeta?.signature as string) || (item.signature as string) || null,
        followers_count: (authorMeta?.fans as number) || (authorStats?.followerCount as number) || null,
        following_count: (authorMeta?.following as number) || (authorStats?.followingCount as number) || null,
        posts_count: (authorMeta?.video as number) || (authorStats?.videoCount as number) || null,
        avatar_url: (authorMeta?.avatar as string) || (item.avatarThumb as string) || null,
        is_business: false,
        discovery_method: 'tt_search',
      });
    }
    return [...seen.values()];
  }

  private parseAutoDetect(items: Record<string, unknown>[]): NormalizedCompetitor[] {
    const competitors: NormalizedCompetitor[] = [];
    for (const item of items) {
      if (item.username) competitors.push(...this.parseIgProfiles([item], 'ig_search'));
      else if (item.ownerUsername) competitors.push(...this.parseIgHashtag([item]));
      else if (item.uniqueId || item.authorMeta) competitors.push(...this.parseTtSearch([item]));
    }
    return competitors;
  }
}
