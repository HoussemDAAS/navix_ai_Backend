import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { OpenAIService } from '../embeddings/openai.service';
import { ScraperService } from '../scraper/scraper.service';
import { AvatarStorageService } from '../scraper/avatar-storage.service';
import {
  accountAnalytics,
  DAY_NAMES,
  type AccountAnalytics,
  type ContentRow,
} from '../analysis/analytics.service';

/**
 * Deep profile pages: one competitor (or the user's own account) with its real
 * scraped posts, computed stats, and an AI read grounded ONLY in that data.
 * The AI read is cached on the row (competitors.ai_insight / projects.ai_insight)
 * so a page view costs nothing; refresh=true regenerates.
 */

const INSIGHT_TTL_MS = 7 * 24 * 3600 * 1000;
const POST_COLUMNS =
  'id, post_url, thumbnail_url, caption, transcript, visual_summary, content_type, hashtags, likes_count, comments_count, views_count, shares_count, saves_count, engagement_rate, duration_seconds, published_at, competitor_id, source_type, platform';

export interface CompetitorInsight {
  summary: string;
  what_works: string[];
  weaknesses: string[];
  threat: { level: 'low' | 'medium' | 'high'; reason: string };
  steal: string[];
}

export interface SelfInsight {
  summary: string;
  voice: string;
  what_works: string[];
  gaps: string[];
  next_moves: string[];
}

type InsightStatus = 'ready' | 'stale' | 'unavailable' | 'no_data';

interface InsightResult<T> {
  value: T | null;
  status: InsightStatus;
  error: string | null;
  generated_at: string | null;
}

function friendlyAiError(message: string): string {
  if (/quota|credit|429|billing/i.test(message)) {
    return 'The OpenAI account is out of credits — add credits and hit refresh.';
  }
  return 'The AI read failed — try refreshing in a moment.';
}

function topPostsForPrompt(posts: ContentRow[], limit = 10) {
  return [...posts]
    .sort(
      (a, b) =>
        (b.likes_count ?? 0) + (b.comments_count ?? 0) - ((a.likes_count ?? 0) + (a.comments_count ?? 0)),
    )
    .slice(0, limit)
    .map((p) => ({
      format: p.content_type,
      caption: p.caption ? p.caption.slice(0, 220) : null,
      spoken: p.transcript ? p.transcript.slice(0, 400) : undefined,
      visual: p.visual_summary ? p.visual_summary.slice(0, 200) : undefined,
      likes: p.likes_count ?? 0,
      comments: p.comments_count ?? 0,
      views: p.views_count ?? 0,
      posted: p.published_at ? p.published_at.slice(0, 10) : null,
    }));
}

function postingDays(posts: ContentRow[]): Array<{ day: string; count: number }> {
  const counts = new Map<number, number>();
  for (const p of posts) {
    if (!p.published_at) continue;
    const d = new Date(p.published_at);
    if (!isNaN(d.getTime())) counts.set(d.getUTCDay(), (counts.get(d.getUTCDay()) ?? 0) + 1);
  }
  return DAY_NAMES.map((day, i) => ({ day, count: counts.get(i) ?? 0 }));
}

@Injectable()
export class ProfileInsightsService {
  private readonly logger = new Logger(ProfileInsightsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly openaiService: OpenAIService,
    private readonly scraperService: ScraperService,
    private readonly avatarStorage: AvatarStorageService,
  ) {}

  /* ── Competitor profile ─────────────────────────────────── */

  async getCompetitorProfile(projectId: string, competitorId: string, userId: string, refresh: boolean) {
    const project = await this.ownProject(projectId, userId);
    const client = this.supabaseService.getClient();

    const { data: comp, error } = await client
      .from('competitors')
      .select('*')
      .eq('id', competitorId)
      .eq('project_id', projectId)
      .single();
    if (error || !comp) throw new NotFoundException('Competitor not found in this project');
    const c = comp as Record<string, unknown>;

    const posts = await this.fetchPosts(projectId, { competitorId });
    const stats = accountAnalytics(
      {
        id: competitorId,
        handle: c.handle as string,
        platform: c.platform as string,
        avatar_url: (c.avatar_url as string) ?? null,
        followers_count: (c.followers_count as number) ?? null,
        tracked: !!c.validated_by_user,
      },
      posts,
    );

    const insight = await this.resolveInsight<CompetitorInsight>({
      cached: (c.ai_insight as CompetitorInsight) ?? null,
      cachedAt: (c.ai_insight_at as string) ?? null,
      refresh,
      hasData: posts.length > 0 || !!c.biography,
      generate: () => this.generateCompetitorInsight(project, c, stats, posts),
      persist: async (value) => {
        await client
          .from('competitors')
          .update({ ai_insight: value, ai_insight_at: new Date().toISOString() })
          .eq('id', competitorId);
      },
    });

    return {
      competitor: comp,
      stats,
      posting_days: postingDays(posts),
      posts,
      insight: insight.value,
      insight_status: insight.status,
      insight_error: insight.error,
      insight_generated_at: insight.generated_at,
    };
  }

  /* ── Own profile ────────────────────────────────────────── */

  async getSelfProfile(projectId: string, userId: string, refresh: boolean) {
    const project = await this.ownProject(projectId, userId);
    const client = this.supabaseService.getClient();

    const { data: profile, error } = await client.from('profiles').select('*').eq('id', userId).single();
    if (error || !profile) throw new NotFoundException('Profile not found');
    const p = profile as Record<string, unknown>;

    // The project is the brand under analysis, so its own-account data lives on the
    // project row; the profile only fills gaps left by accounts onboarded before that.
    const acct: Record<string, unknown> = {
      instagram_handle: (project.instagram_handle as string | null) ?? (p.instagram_handle as string | null) ?? null,
      tiktok_handle: (project.tiktok_handle as string | null) ?? (p.tiktok_handle as string | null) ?? null,
      followers_count: (project.followers_count as number | null) ?? (p.followers_count as number | null) ?? null,
      following_count: (project.following_count as number | null) ?? (p.following_count as number | null) ?? null,
      posts_count: (project.posts_count as number | null) ?? (p.posts_count as number | null) ?? null,
      biography: (project.biography as string | null) || (p.biography as string | null) || null,
      avatar_url: (project.avatar_url as string | null) || (p.avatar_url as string | null) || null,
      is_verified: (project.is_verified as boolean | null) ?? (p.is_verified as boolean | null) ?? false,
      last_scraped_at: (project.last_scraped_at as string | null) ?? null,
    };

    const posts = await this.fetchPosts(projectId, { self: true });
    const handle =
      (acct.instagram_handle as string | null) ?? (acct.tiktok_handle as string | null) ?? 'you';

    // The dossier must show the brand's real identity. If followers/bio/photo are
    // missing, read them from the platform once, persist the photo to our storage
    // and save everything on the project. Single-brand personas also mirror it to
    // the profile, which the dashboard identity strip still reads.
    const missingIdentity = acct.followers_count == null || !acct.biography || !acct.avatar_url;
    if (missingIdentity && handle !== 'you') {
      try {
        const platform = acct.instagram_handle ? 'instagram' : 'tiktok';
        const fresh = await this.scraperService.scrapeProfile(handle, platform);
        const avatar = fresh.avatar_url
          ? ((await this.avatarStorage.persist(fresh.avatar_url, `projects/${projectId}`)) ?? fresh.avatar_url)
          : ((acct.avatar_url as string | null) ?? null);
        const patch = {
          biography: fresh.biography || ((acct.biography as string | null) ?? null),
          followers_count: fresh.followers_count || ((acct.followers_count as number | null) ?? null),
          following_count: fresh.following_count || ((acct.following_count as number | null) ?? null),
          posts_count: fresh.posts_count || ((acct.posts_count as number | null) ?? null),
          is_verified: fresh.is_verified,
          avatar_url: avatar,
        };
        const { error: upErr } = await client.from('projects').update(patch).eq('id', projectId);
        if (upErr) this.logger.warn(`Project identity save failed: ${upErr.message}`);
        if (p.persona !== 'agency') {
          await client.from('profiles').update(patch).eq('id', userId);
        }
        Object.assign(acct, patch);
        this.logger.log(`Refreshed own identity for @${handle}: ${fresh.followers_count} followers`);
      } catch (err) {
        this.logger.warn(`Own identity refresh failed for @${handle}: ${(err as Error).message}`);
      }
    }
    const stats = accountAnalytics(
      {
        id: null,
        handle,
        platform: 'INSTAGRAM',
        avatar_url: (acct.avatar_url as string) ?? null,
        followers_count: (acct.followers_count as number) ?? null,
        tracked: false,
      },
      posts,
    );

    // The dossier is the project's: its name and type, never the account's (an agency is not its client)
    const me = {
      ...p,
      ...acct,
      full_name: (project.name as string | null) ?? p.full_name,
      entity_name: (project.name as string | null) ?? p.entity_name,
      persona: (project.persona as string | null) ?? p.persona,
    };
    const insight = await this.resolveInsight<SelfInsight>({
      cached: (project.ai_insight as SelfInsight | null) ?? (p.ai_insight as SelfInsight | null) ?? null,
      cachedAt: (project.ai_insight_at as string | null) ?? (p.ai_insight_at as string | null) ?? null,
      refresh,
      hasData: posts.length > 0,
      generate: () => this.generateSelfInsight(project, me, stats, posts),
      persist: async (value) => {
        await client
          .from('projects')
          .update({ ai_insight: value, ai_insight_at: new Date().toISOString() })
          .eq('id', projectId);
      },
    });

    return {
      profile: me,
      stats,
      posting_days: postingDays(posts),
      posts,
      insight: insight.value,
      insight_status: insight.status,
      insight_error: insight.error,
      insight_generated_at: insight.generated_at,
    };
  }

  /* ── Internals ──────────────────────────────────────────── */

  private async ownProject(projectId: string, userId: string): Promise<Record<string, unknown>> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client.from('projects').select('*').eq('id', projectId).single();
    if (error || !data) throw new NotFoundException(`Project ${projectId} not found`);
    if ((data as { user_id: string }).user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }
    return data as Record<string, unknown>;
  }

  private async fetchPosts(
    projectId: string,
    target: { competitorId?: string; self?: boolean },
  ): Promise<ContentRow[]> {
    const client = this.supabaseService.getClient();
    let query = client
      .from('scraped_content')
      .select(POST_COLUMNS)
      .eq('project_id', projectId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(60);
    query = target.self
      ? query.eq('source_type', 'self')
      : query.eq('competitor_id', target.competitorId as string);
    const { data, error } = await query;
    if (error) {
      this.logger.error(`Failed to fetch posts for project ${projectId}: ${error.message}`);
      throw new Error(`Failed to fetch posts: ${error.message}`);
    }
    return (data ?? []) as unknown as ContentRow[];
  }

  private async resolveInsight<T>(opts: {
    cached: T | null;
    cachedAt: string | null;
    refresh: boolean;
    hasData: boolean;
    generate: () => Promise<T>;
    persist: (value: T) => Promise<void>;
  }): Promise<InsightResult<T>> {
    const { cached, cachedAt, refresh, hasData } = opts;
    const fresh = cachedAt != null && Date.now() - new Date(cachedAt).getTime() < INSIGHT_TTL_MS;
    if (cached && fresh && !refresh) {
      return { value: cached, status: 'ready', error: null, generated_at: cachedAt };
    }
    if (!hasData) {
      return { value: cached, status: cached ? 'ready' : 'no_data', error: null, generated_at: cachedAt };
    }
    try {
      const value = await opts.generate();
      await opts.persist(value);
      return { value, status: 'ready', error: null, generated_at: new Date().toISOString() };
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`AI insight generation failed: ${message}`);
      return {
        value: cached,
        status: cached ? 'stale' : 'unavailable',
        error: friendlyAiError(message),
        generated_at: cachedAt,
      };
    }
  }

  private async generateCompetitorInsight(
    project: Record<string, unknown>,
    comp: Record<string, unknown>,
    stats: AccountAnalytics,
    posts: ContentRow[],
  ): Promise<CompetitorInsight> {
    const brand = await this.brandContext(project);
    const agency = await this.readByAgency(project);
    return this.openaiService.chatJson<CompetitorInsight>(
      `You are Navix, a senior social media strategist writing an intelligence read on ONE competitor account ` +
        (agency
          ? `for a brand managed by the reader's agency. You receive the brand's context and the competitor's REAL scraped posts and stats. `
          : `for a brand (the user). You receive the brand's context and the competitor's REAL scraped posts and stats. `) +
        `Ground every claim in the provided data — cite concrete numbers, formats and actual post topics; never invent. ` +
        (agency
          ? `The reader is the agency, so name the brand ("${String(brand.name ?? 'the brand')}") in the third person; never "you". `
          : `Address the user as "you". `) +
        `Write tight, specific sentences a marketer would pay for. ` +
        `Respond with JSON: {"summary": "2 sentences: what this account is and its content strategy", ` +
        `"what_works": ["3 bullets, each naming a real content pattern WITH a number from the data"], ` +
        `"weaknesses": ["1-2 real gaps you can see in their content"], ` +
        `"threat": {"level": "low|medium|high", "reason": "1 sentence comparing them to the brand"}, ` +
        `"steal": ["2 concrete post ideas the brand can adapt to its own voice, based on what works for this account"]}`,
      JSON.stringify({
        brand,
        competitor: {
          handle: comp.handle,
          bio: comp.biography,
          followers: comp.followers_count,
          avg_likes: stats.avg_likes,
          avg_comments: stats.avg_comments,
          avg_views: stats.avg_views,
          engagement_rate: stats.engagement_rate,
          posts_per_week: stats.posts_per_week,
          dominant_format: stats.dominant_format,
          format_mix: stats.format_mix,
        },
        competitor_top_posts: topPostsForPrompt(posts),
      }),
    );
  }

  private async generateSelfInsight(
    project: Record<string, unknown>,
    profile: Record<string, unknown>,
    stats: AccountAnalytics,
    posts: ContentRow[],
  ): Promise<SelfInsight> {
    // The profile row carries the ACCOUNT type: an agency reads its client's dossier
    const agency = profile.persona === 'agency';
    return this.openaiService.chatJson<SelfInsight>(
      (agency
        ? `You are Navix, a senior social media strategist giving an agency an honest read of a client's account ("${String(project.name ?? 'the brand')}"). `
        : `You are Navix, a senior social media strategist giving a brand an honest read of their OWN account. `) +
        `You receive their real scraped posts and stats. Ground everything in the data — concrete numbers, ` +
        `formats, actual topics; never invent. ` +
        (agency
          ? `Name the brand and use the third person ("they", "their"); never "you". `
          : `Address them as "you". `) +
        `Be honest about weaknesses; they want truth. ` +
        `Respond with JSON: {"summary": "2 sentences on what this account is today", ` +
        `"voice": "1-2 sentences describing the tone and recurring topics of their posts", ` +
        `"what_works": ["3 bullets naming real patterns WITH numbers"], ` +
        `"gaps": ["2 things missing vs a strong account in this niche"], ` +
        `"next_moves": ["2 specific actions grounded in their own data"]}`,
      JSON.stringify({
        account: {
          handle: stats.handle,
          bio: profile.biography,
          followers: profile.followers_count,
          niche: project.niche,
          niche_description: project.niche_description,
          avg_likes: stats.avg_likes,
          avg_comments: stats.avg_comments,
          avg_views: stats.avg_views,
          engagement_rate: stats.engagement_rate,
          posts_per_week: stats.posts_per_week,
          dominant_format: stats.dominant_format,
          format_mix: stats.format_mix,
        },
        top_posts: topPostsForPrompt(posts),
      }),
    );
  }

  /** True when the account that owns the project is an agency reading a client's data. */
  private async readByAgency(project: Record<string, unknown>): Promise<boolean> {
    const client = this.supabaseService.getClient();
    const { data } = await client
      .from('profiles')
      .select('persona')
      .eq('id', project.user_id as string)
      .maybeSingle();
    return ((data ?? null) as { persona: string | null } | null)?.persona === 'agency';
  }

  private async brandContext(project: Record<string, unknown>): Promise<Record<string, unknown>> {
    const client = this.supabaseService.getClient();
    const { data: profile } = await client
      .from('profiles')
      .select('biography, followers_count')
      .eq('id', project.user_id as string)
      .maybeSingle();
    const p = (profile ?? {}) as Record<string, unknown>;
    return {
      name: project.name,
      niche: project.niche,
      description: project.niche_description ?? null,
      bio: p.biography ?? null,
      followers: p.followers_count ?? null,
      country: project.location ?? null,
    };
  }
}
