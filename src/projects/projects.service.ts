import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { ScrapingService } from '../scraping/scraping.service';
import { OpenAIService } from '../embeddings/openai.service';
import { ScraperService } from '../scraper/scraper.service';
import { AvatarStorageService } from '../scraper/avatar-storage.service';
import { JobsService } from '../jobs/jobs.service';
import { resolveSeedAccount, resolveSocialLink } from '../common/social-links';

export interface DiscoveryStatus {
  status: 'idle' | 'pending' | 'active' | 'completed' | 'failed';
  progress: number;
  stage: string | null;
  message: string | null;
  expand_from: string | null;
  counts: { candidates: number; enriched: number; kept: number; total: number };
  error: string | null;
  updated_at: string | null;
}
import { CreateProjectDto } from './dto/create-project.dto';
import { CreateBrandKitDto } from './dto/create-brand-kit.dto';
import { UpdateCompetitorDto } from './dto/update-competitor.dto';

interface AiInsightsVerdict {
  headline: string;
  profile_insight: string;
  competitor_insights: Array<{ handle: string; insight: string }>;
  opportunity: string;
}

const INSIGHTS_TTL_MS = 30 * 60 * 1000; // regenerate at most every 30 min

type ProjectPersona = 'ecommerce' | 'agency' | 'creator';
/**
 * Projects per account. A creator has exactly one by design (their own brand);
 * e-commerce and agency accounts get more once paid plans exist.
 */
const PROJECT_LIMITS: Record<ProjectPersona, number> = { creator: 1, ecommerce: 1, agency: 1 };
const DEFAULT_PROJECT_LIMIT = 1;

function projectLimitFor(persona: string | null | undefined): number {
  return persona && persona in PROJECT_LIMITS
    ? PROJECT_LIMITS[persona as ProjectPersona]
    : DEFAULT_PROJECT_LIMIT;
}

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);
  private readonly insightsCache = new Map<
    string,
    { data: Record<string, unknown>; ts: number }
  >();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly scrapingService: ScrapingService,
    private readonly openaiService: OpenAIService,
    private readonly scraperService: ScraperService,
    private readonly avatarStorage: AvatarStorageService,
    private readonly jobsService: JobsService,
  ) {}

  /**
   * Manual add: paste any Instagram/TikTok profile link (or @handle) and it
   * becomes a fully-enriched, tracked competitor — real profile data now,
   * content scrape and "find similar" refinement in the background.
   */
  async addCompetitor(projectId: string, link: string, userId: string) {
    await this.getProject(projectId, userId);
    const parsed = await resolveSocialLink(link.trim());
    if (!parsed) {
      throw new BadRequestException("That doesn't look like a social profile link or @handle.");
    }
    if (parsed.platform !== 'instagram' && parsed.platform !== 'tiktok') {
      throw new BadRequestException('Only Instagram and TikTok profiles can be added for now.');
    }
    const handle = parsed.handle.toLowerCase();
    // Platforms are stored lower-case everywhere (scraped_content, scrape_jobs, snapshots)
    const platform = parsed.platform.toLowerCase();
    const client = this.supabaseService.getClient();

    const { data: dup } = await client
      .from('competitors')
      .select('id')
      .eq('project_id', projectId)
      .eq('handle', handle)
      .eq('platform', platform)
      .maybeSingle();
    if (dup) throw new BadRequestException(`@${handle} is already in your competitor list.`);

    // Read the real profile so the card is complete from the first render
    const profile = await this.scraperService.scrapeProfile(handle, parsed.platform).catch((err) => {
      this.logger.warn(`Manual add: profile scrape failed for @${handle}: ${(err as Error).message}`);
      return null;
    });

    const { data: inserted, error } = await client
      .from('competitors')
      .insert({
        project_id: projectId,
        handle,
        platform,
        full_name: profile?.full_name ?? null,
        biography: profile?.biography ?? null,
        followers_count: profile?.followers_count ?? null,
        following_count: profile?.following_count ?? null,
        posts_count: profile?.posts_count ?? null,
        avatar_url: profile?.avatar_url ?? null,
        discovery_method: 'manual',
        confidence_score: 90,
        inclusion_reason: 'Added by you.',
        validated_by_user: true,
      })
      .select()
      .single();
    if (error || !inserted) {
      throw new Error(`Failed to add competitor: ${error?.message ?? 'unknown'}`);
    }
    const row = inserted as Record<string, unknown>;

    if (profile?.avatar_url) {
      const stored = await this.avatarStorage.persist(profile.avatar_url, `competitors/${row.id as string}`);
      if (stored) {
        await client.from('competitors').update({ avatar_url: stored }).eq('id', row.id as string);
        row.avatar_url = stored;
      }
    }
    this.insightsCache.delete(projectId);
    this.logger.log(`Manual competitor added: @${handle} (${platform}) to project ${projectId}`);

    // Same follow-ups as tracking: scrape their content + find similar accounts
    this.scrapingService
      .scrapeCompetitor(projectId, row.id as string, userId, {})
      .catch((err) => this.logger.error(`Manual add auto-scrape failed: ${(err as Error).message}`));
    const { data: project } = await client
      .from('projects')
      .select('name, niche, location, persona, instagram_handle, tiktok_handle, niche_description, keywords')
      .eq('id', projectId)
      .single();
    const p = (project ?? {}) as Record<string, unknown>;
    this.scraperService.expandFromCompetitor(projectId, { handle, platform }, {
      niche: (p.niche as string) ?? '',
      location: (p.location as string) ?? undefined,
      projectId,
      userId,
      persona: (p.persona as string) ?? undefined,
      entityName: (p.name as string) ?? undefined,
      instagramHandle: (p.instagram_handle as string) ?? undefined,
      tiktokHandle: (p.tiktok_handle as string) ?? undefined,
      nicheDescription: (p.niche_description as string) ?? undefined,
      keywords: (p.keywords as string[]) ?? undefined,
    });

    return row;
  }

  /** Live status of the latest discovery/expand job for the project overview and competitors screen. */
  async getDiscoveryStatus(projectId: string, userId: string): Promise<DiscoveryStatus> {
    await this.getProject(projectId, userId);
    const client = this.supabaseService.getClient();
    const [job, { count }] = await Promise.all([
      this.jobsService.getLatestJob(projectId, 'competitor_discovery'),
      client.from('competitors').select('id', { count: 'exact', head: true }).eq('project_id', projectId),
    ]);
    const output = (job?.output ?? {}) as Record<string, unknown>;
    return {
      status: job ? job.status : 'idle',
      progress: job?.progress ?? 0,
      stage: (output.stage as string) ?? null,
      message: (output.message as string) ?? null,
      expand_from: (output.expand_from as string) ?? null,
      counts: {
        candidates: (output.candidates_found as number) ?? 0,
        enriched: (output.enriched as number) ?? 0,
        kept: (output.kept as number) ?? 0,
        total: count ?? 0,
      },
      error: job?.error ?? null,
      updated_at: job?.completed_at ?? job?.started_at ?? job?.created_at ?? null,
    };
  }

  async findAllByUser(userId: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('user_id', userId)
      // The primary project always comes first — it is where single-brand accounts land
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      this.logger.error(`Failed to fetch projects for user ${userId}`, error);
      throw new Error(error.message);
    }

    return data;
  }

  async createProject(dto: CreateProjectDto, userId: string) {
    const client = this.supabaseService.getClient();

    // Every persona gets one project until paid plans raise the limit. The first
    // project is the primary one — where single-brand accounts land.
    const [{ data: profile }, { count }] = await Promise.all([
      client.from('profiles').select('persona').eq('id', userId).maybeSingle(),
      client.from('projects').select('id', { count: 'exact', head: true }).eq('user_id', userId),
    ]);
    const persona =
      dto.persona ?? ((profile as { persona: string | null } | null)?.persona ?? null);
    const existing = count ?? 0;
    const limit = projectLimitFor(persona);
    if (existing >= limit) {
      throw new ForbiddenException(
        persona === 'creator'
          ? 'A creator account has one project — your own brand. Switch to a Marketing Agency account to manage several.'
          : `Your plan includes ${limit} project${limit === 1 ? '' : 's'} for now — adding more clients or stores is coming with paid plans.`,
      );
    }

    const seedAccounts = (
      await Promise.all((dto.seed_accounts ?? []).map((s) => resolveSeedAccount(s)))
    ).filter((s): s is string => !!s);
    const { data, error } = await client
      .from('projects')
      .insert({
        user_id: userId,
        name: dto.name,
        niche: dto.niche,
        location: dto.location ?? null,
        persona,
        is_primary: existing === 0,
        facebook_handle: dto.facebook_handle ?? null,
        niche_description: dto.niche_description?.trim() || null,
        keywords: (dto.keywords ?? []).map((k) => k.trim().toLowerCase()).filter(Boolean),
        seed_accounts: [...new Set(seedAccounts)],
        website: dto.website ?? null,
        instagram_handle: dto.instagram_handle ?? null,
        tiktok_handle: dto.tiktok_handle ?? null,
        youtube_handle: dto.youtube_handle ?? null,
      })
      .select()
      .single();

    if (error) {
      this.logger.error('Failed to create project', error);
      throw new Error(error.message);
    }

    this.logger.log(`Project created: ${data.id}`);
    return data;
  }

  async getProject(projectId: string, userId: string) {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if (data.user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }

    return data;
  }

  async getBrandKit(projectId: string, userId: string) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('brand_kits')
      .select('*')
      .eq('project_id', projectId)
      .single();

    if (error && error.code !== 'PGRST116') {
      this.logger.error(
        `Failed to fetch brand kit for project ${projectId}`,
        error,
      );
      throw new Error(error.message);
    }

    return data ?? null;
  }

  async saveBrandKit(
    projectId: string,
    dto: CreateBrandKitDto,
    userId: string,
  ) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();
    const payload: Record<string, unknown> = {
      project_id: projectId,
      updated_at: new Date().toISOString(),
    };

    if (dto.tone_of_voice !== undefined) payload.tone_of_voice = dto.tone_of_voice;
    if (dto.formality_level !== undefined) payload.formality_level = dto.formality_level;
    if (dto.vocab_exclude !== undefined) payload.vocab_exclude = dto.vocab_exclude;
    if (dto.objective !== undefined) payload.objective = dto.objective;
    if (dto.target_audience !== undefined) payload.target_audience = dto.target_audience;
    if (dto.constraints !== undefined) payload.constraints = dto.constraints;
    if (dto.preferred_cta !== undefined) payload.preferred_cta = dto.preferred_cta;

    const { data, error } = await client
      .from('brand_kits')
      .upsert(payload, { onConflict: 'project_id' })
      .select()
      .single();

    if (error) {
      this.logger.error('Failed to save brand kit', error);
      throw new Error(error.message);
    }

    this.logger.log(`Brand kit saved for project: ${projectId}`);
    return data;
  }

  async getCompetitors(projectId: string, userId: string) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('competitors')
      .select('*')
      .eq('project_id', projectId)
      .order('confidence_score', { ascending: false });

    if (error) {
      this.logger.error(
        `Failed to fetch competitors for project ${projectId}`,
        error,
      );
      throw new Error(error.message);
    }

    return data;
  }

  async updateCompetitor(
    projectId: string,
    competitorId: string,
    dto: UpdateCompetitorDto,
    userId: string,
  ) {
    await this.getProject(projectId, userId);

    const client = this.supabaseService.getClient();

    // Verify the competitor belongs to this project
    const { data: existing, error: fetchError } = await client
      .from('competitors')
      .select('id, project_id, handle, platform')
      .eq('id', competitorId)
      .eq('project_id', projectId)
      .single();

    if (fetchError || !existing) {
      throw new NotFoundException(
        `Competitor ${competitorId} not found in project ${projectId}`,
      );
    }

    const updatePayload: Record<string, boolean> = {};
    if (dto.validatedByUser !== undefined) {
      updatePayload.validated_by_user = dto.validatedByUser;
    }
    if (dto.rejectedByUser !== undefined) {
      updatePayload.rejected_by_user = dto.rejectedByUser;
    }

    const { data, error } = await client
      .from('competitors')
      .update(updatePayload)
      .eq('id', competitorId)
      .select()
      .single();

    if (error) {
      this.logger.error(
        `Failed to update competitor ${competitorId}`,
        error,
      );
      throw new Error(error.message);
    }

    this.logger.log(`Competitor ${competitorId} updated in project ${projectId}`);

    // Decisions change the competitive picture — next insights read regenerates
    this.insightsCache.delete(projectId);

    // Tracking a competitor (1) kicks off a content scrape of their account so
    // the market analysis has real posts, and (2) refines discovery: accounts
    // similar to the tracked one are found, enriched and judged in the
    // background ("track to refine"). Both are fire & forget with their own
    // job tracking.
    if (dto.validatedByUser === true) {
      this.scrapingService
        .scrapeCompetitor(projectId, competitorId, userId, {})
        .then((jobIds) => {
          this.logger.log(
            `Auto-scrape started for tracked competitor ${competitorId}: jobs=${jobIds.join(',')}`,
          );
        })
        .catch((err) => {
          this.logger.error(
            `Auto-scrape failed for tracked competitor ${competitorId}: ${(err as Error).message}`,
          );
        });

      const tracked = existing as { handle: string; platform: string };
      const { data: project } = await client
        .from('projects')
        .select('name, niche, location, persona, instagram_handle, tiktok_handle, niche_description, keywords')
        .eq('id', projectId)
        .single();
      const p = (project ?? {}) as Record<string, unknown>;
      this.scraperService.expandFromCompetitor(projectId, tracked, {
        niche: (p.niche as string) ?? '',
        location: (p.location as string) ?? undefined,
        projectId,
        userId,
        persona: (p.persona as string) ?? undefined,
        entityName: (p.name as string) ?? undefined,
        instagramHandle: (p.instagram_handle as string) ?? undefined,
        tiktokHandle: (p.tiktok_handle as string) ?? undefined,
        nicheDescription: (p.niche_description as string) ?? undefined,
        keywords: (p.keywords as string[]) ?? undefined,
      });
    }

    return data;
  }

  /**
   * AI snapshot for the project overview: reads the user's profile, their top
   * competitors and whatever content has been scraped so far, and produces a
   * short numbers-grounded analysis (gpt-4o-mini). Cached for 30 minutes;
   * invalidated when the user tracks/dismisses a competitor.
   */
  async getInsights(
    projectId: string,
    userId: string,
    refresh = false,
  ): Promise<Record<string, unknown>> {
    const project = (await this.getProject(projectId, userId)) as Record<string, unknown>;

    const cached = this.insightsCache.get(projectId);
    if (!refresh && cached && Date.now() - cached.ts < INSIGHTS_TTL_MS) {
      return cached.data;
    }

    const client = this.supabaseService.getClient();

    const { data: profile } = await client
      .from('profiles')
      .select(
        'full_name, entity_name, persona, niche, country, biography, followers_count, posts_count, instagram_handle, tiktok_handle',
      )
      .eq('id', userId)
      .single();

    const { data: comps, error: compError } = await client
      .from('competitors')
      .select('*')
      .eq('project_id', projectId)
      .eq('rejected_by_user', false)
      .order('validated_by_user', { ascending: false })
      .order('confidence_score', { ascending: false })
      .limit(5);

    if (compError) {
      throw new Error(`Failed to fetch competitors: ${compError.message}`);
    }
    if (!comps || comps.length === 0) {
      return { available: false, reason: 'no_competitors' };
    }

    const top = (comps as Record<string, unknown>[]).slice(0, 3);
    const compIds = (comps as Record<string, unknown>[]).map(
      (c) => c.id as string,
    );

    const { data: content } = await client
      .from('scraped_content')
      .select('source_type, competitor_id, caption, likes_count, views_count')
      .eq('project_id', projectId)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(80);

    const rows = (content ?? []) as Record<string, unknown>[];
    const myPosts = rows.filter((r) => r.source_type === 'self');
    const postsByCompetitor = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) {
      if (r.source_type !== 'competitor' || !r.competitor_id) continue;
      const list = postsByCompetitor.get(r.competitor_id as string) ?? [];
      if (list.length < 5) list.push(r);
      postsByCompetitor.set(r.competitor_id as string, list);
    }

    const snippet = (r: Record<string, unknown>) => ({
      caption: ((r.caption as string) ?? '').slice(0, 180),
      likes: r.likes_count ?? null,
      views: r.views_count ?? null,
    });

    const payload = {
      // The project is the brand under analysis; the profile only fills legacy gaps.
      me: {
        name: (project.name as string) || profile?.entity_name || profile?.full_name || 'unknown',
        persona: profile?.persona ?? (project.persona as string | null) ?? 'unknown',
        niche: (project.niche as string) || profile?.niche || 'unknown',
        country: (project.location as string | null) ?? profile?.country ?? 'unknown',
        bio: (project.biography as string | null) ?? profile?.biography ?? null,
        followers: (project.followers_count as number | null) ?? profile?.followers_count ?? null,
        posts_count: (project.posts_count as number | null) ?? profile?.posts_count ?? null,
        recent_posts: myPosts.slice(0, 5).map(snippet),
        posts_scraped: myPosts.length,
      },
      top_competitors: top.map((c) => ({
        handle: c.handle,
        platform: c.platform,
        full_name: c.full_name,
        bio: c.biography,
        followers: c.followers_count,
        tracked_by_user: c.validated_by_user === true,
        recent_posts: (postsByCompetitor.get(c.id as string) ?? []).map(
          snippet,
        ),
      })),
      total_competitors_found: compIds.length,
    };

    let ai: AiInsightsVerdict;
    try {
      ai = await this.openaiService.chatJson<AiInsightsVerdict>(
        `You are Navix's competitive-intelligence analyst. Given a user's social profile ` +
          `and their top competitors (with whatever scraped posts are available), write a ` +
          `sharp, concrete snapshot. Ground EVERY claim in the provided data (follower ` +
          `counts, bios, post engagement) — never invent numbers or facts. If scraped post ` +
          `data is thin, say so plainly and tell the user what tracking more competitors ` +
          `will unlock. Write in second person ("you"), confident and direct, no fluff. ` +
          `Respond with JSON: {"headline": "one punchy sentence about their competitive position", ` +
          `"profile_insight": "2-3 sentences about the user's own profile vs this field, citing real numbers", ` +
          `"competitor_insights": [{"handle": "...", "insight": "1-2 specific sentences about why this account matters to the user"}] (one per top competitor, same order), ` +
          `"opportunity": "1-2 sentences on the clearest gap the user can exploit"}`,
        JSON.stringify(payload),
      );
    } catch (err) {
      // AI being down (no credits, rate limit, outage) must never 500 the
      // overview — return an honest unavailable state the widget can render.
      const message = (err as Error).message;
      this.logger.warn(`Insights generation failed: ${message}`);
      const unavailable: Record<string, unknown> = {
        available: false,
        reason: /credit|quota|429|billing/i.test(message) ? 'no_ai_credits' : 'ai_error',
        top_competitors: top,
        thin_data: rows.length < 10,
      };
      this.insightsCache.set(projectId, { data: unavailable, ts: Date.now() });
      return unavailable;
    }

    const result: Record<string, unknown> = {
      available: true,
      generated_at: new Date().toISOString(),
      thin_data: rows.length < 10,
      top_competitors: top,
      headline: ai.headline,
      profile_insight: ai.profile_insight,
      competitor_insights: ai.competitor_insights ?? [],
      opportunity: ai.opportunity,
    };

    this.insightsCache.set(projectId, { data: result, ts: Date.now() });
    this.logger.log(`Insights generated for project ${projectId}`);
    return result;
  }
}
