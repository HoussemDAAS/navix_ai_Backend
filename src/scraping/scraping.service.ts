import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseService } from '../supabase/supabase.service';
import { ApifyService, APIFY_ACTORS } from './apify.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { AvatarStorageService } from '../scraper/avatar-storage.service';
import { ScraperService } from '../scraper/scraper.service';
import { normalizeScrapedItems } from './content-normalizer';
import {
  ScrapeSelfDto,
  ScrapePlatform,
  SUPPORTED_PLATFORMS,
} from './dto/scrape-self.dto';
import { ScrapeCompetitorDto } from './dto/scrape-competitor.dto';

/** Answer of a data refresh request: the scrape itself finishes in the background. */
export interface RefreshOutcome {
  started: boolean;
  reason?: 'too_soon' | 'no_handle' | 'already_running' | 'failed';
  next_allowed_at?: string | null;
  scrape_job_ids?: string[];
}

export interface ScrapeJobRow {
  id: string;
  project_id: string;
  source_type: 'self' | 'competitor';
  competitor_id: string | null;
  platform: ScrapePlatform;
  target_handle: string;
  apify_actor_id: string | null;
  apify_run_id: string | null;
  apify_dataset_id: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  items_scraped: number;
  items_embedded: number;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface ProjectRow {
  id: string;
  user_id: string;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  youtube_handle: string | null;
  name: string | null;
}

interface ProfileMinimal {
  id: string;
  entity_name: string | null;
  full_name: string | null;
  niche: string | null;
  country: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  youtube_handle: string | null;
  facebook_handle?: string | null;
  persona?: string | null;
  niche_description?: string | null;
  keywords?: string[] | null;
  seed_accounts?: string[] | null;
  has_social_presence?: boolean | null;
  // The brand's own account as captured during onboarding
  followers_count?: number | null;
  following_count?: number | null;
  posts_count?: number | null;
  biography?: string | null;
  avatar_url?: string | null;
  is_verified?: boolean | null;
}

interface CompetitorRow {
  id: string;
  project_id: string;
  handle: string;
  platform: string;
}

const POLL_FALLBACK_DELAY_MS = 60_000; // 60s — if no webhook by then, poll Apify
const RECONCILE_INTERVAL_MS = 60_000; // sweep for stuck jobs every minute
const RECONCILE_MIN_AGE_MS = 45_000; // only consider jobs older than this
const START_TIMEOUT_MS = 15 * 60_000; // queued without a run id → give up
const SNAPSHOT_SAMPLE_SIZE = 60; // most recent posts averaged into each account snapshot
const DRAFT_MATCH_THRESHOLD = 0.45; // bigram Dice similarity between a draft and a real post

function captionTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#@][\w.]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);
}

/** Dice similarity over word bigrams — robust to emoji, hashtags and small edits. */
function captionSimilarity(a: string, b: string): number {
  const ta = captionTokens(a);
  const tb = captionTokens(b);
  if (ta.length < 3 || tb.length < 3) return 0;
  const bigrams = (t: string[]) => new Set(t.slice(0, -1).map((w, i) => `${w} ${t[i + 1]}`));
  const setA = bigrams(ta);
  const setB = bigrams(tb);
  let shared = 0;
  for (const g of setA) if (setB.has(g)) shared++;
  return (2 * shared) / (setA.size + setB.size);
}

// Data freshness. The sweep runs on boot and every few hours while the backend is up
// and refreshes only what is older than its threshold — so it behaves the same on a
// laptop that sleeps at night as on a server. Thresholds are hours, overridable by env.
const HOURS = 3600_000;
const envHours = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return (Number.isFinite(value) && value > 0 ? value : fallback) * HOURS;
};
const DATA_REFRESH_ENABLED = process.env.DATA_REFRESH_ENABLED !== 'false';
const REFRESH_SWEEP_BOOT_DELAY_MS = 90_000;
const REFRESH_SWEEP_INTERVAL_MS = envHours('DATA_REFRESH_SWEEP_HOURS', 6);
const SELF_STALE_AFTER_MS = envHours('SELF_REFRESH_HOURS', 24);
const COMPETITOR_STALE_AFTER_MS = envHours('COMPETITOR_REFRESH_HOURS', 72);
const MANUAL_REFRESH_COOLDOWN_MS = envHours('MANUAL_REFRESH_COOLDOWN_HOURS', 6);
const REFRESH_SWEEP_MAX_ACCOUNTS = 12; // per sweep, per kind — protects the Apify quota

@Injectable()
export class ScrapingService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ScrapingService.name);
  private readonly webhookUrl: string | undefined;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private reconciling = false;

  private refreshBootTimer?: ReturnType<typeof setTimeout>;
  private refreshTimer?: ReturnType<typeof setInterval>;
  private sweeping = false;

  constructor(
    private readonly configService: ConfigService,
    private readonly supabaseService: SupabaseService,
    private readonly apifyService: ApifyService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly avatarStorage: AvatarStorageService,
    private readonly scraperService: ScraperService,
  ) {
    this.webhookUrl = this.configService.get<string>(
      'APIFY_SCRAPE_WEBHOOK_URL',
    );
    if (!this.webhookUrl) {
      this.logger.warn(
        'APIFY_SCRAPE_WEBHOOK_URL not set — will rely on polling fallback',
      );
    }
  }

  /**
   * Durable completion: in-memory polling timers die with the process, and
   * webhooks may never arrive. On boot and every minute, look for jobs still
   * queued/running in the database and finish them from Apify's run status.
   */
  onModuleInit(): void {
    void this.reconcileStuckJobs();
    this.reconcileTimer = setInterval(() => {
      void this.reconcileStuckJobs();
    }, RECONCILE_INTERVAL_MS);
    this.reconcileTimer.unref();

    if (DATA_REFRESH_ENABLED) {
      this.refreshBootTimer = setTimeout(() => {
        void this.runDataRefreshSweep();
      }, REFRESH_SWEEP_BOOT_DELAY_MS);
      this.refreshBootTimer.unref();
      this.refreshTimer = setInterval(() => {
        void this.runDataRefreshSweep();
      }, REFRESH_SWEEP_INTERVAL_MS);
      this.refreshTimer.unref();
    }
  }

  onModuleDestroy(): void {
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.refreshBootTimer) clearTimeout(this.refreshBootTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
  }

  async reconcileStuckJobs(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const client = this.supabaseService.getClient();
      const cutoff = new Date(Date.now() - RECONCILE_MIN_AGE_MS).toISOString();
      const { data, error } = await client
        .from('scrape_jobs')
        .select('id, status, apify_run_id, created_at')
        .in('status', ['queued', 'running'])
        .lt('created_at', cutoff)
        .limit(50);
      if (error) {
        this.logger.warn(`Reconcile query failed: ${error.message}`);
        return;
      }
      const stuck = (data ?? []) as Array<{
        id: string;
        status: string;
        apify_run_id: string | null;
        created_at: string;
      }>;
      if (stuck.length === 0) return;
      this.logger.log(`Reconciling ${stuck.length} unfinished scrape job(s)`);

      for (const job of stuck) {
        try {
          if (!job.apify_run_id) {
            const age = Date.now() - new Date(job.created_at).getTime();
            if (age > START_TIMEOUT_MS) {
              await this.markFailed(job.id, 'Apify run was never started');
            }
            continue;
          }
          const status = await this.apifyService.getRunStatus(job.apify_run_id);
          if (!status) {
            await this.markFailed(job.id, `Apify run ${job.apify_run_id} not found`);
            continue;
          }
          if (['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(status.status)) {
            await this.processCompletedRun(job.id, job.apify_run_id);
          }
        } catch (err) {
          this.logger.error(
            `Reconcile failed for scrape_job=${job.id}: ${(err as Error).message}`,
          );
        }
      }
    } finally {
      this.reconciling = false;
    }
  }

  /* ──────────────────────────────────────────────────────────
   * Public API used by controllers
   * ────────────────────────────────────────────────────────── */

  async scrapeSelf(
    projectId: string,
    userId: string,
    dto: ScrapeSelfDto,
  ): Promise<string[]> {
    await this.assertProjectOwnership(projectId, userId);

    const jobIds: string[] = [];
    for (const platform of dto.platforms) {
      const handle = dto.handles[platform];
      if (!handle) {
        this.logger.warn(`No handle for platform=${platform}, skipping`);
        continue;
      }
      const jobId = await this.launchScrape(
        projectId,
        'self',
        null,
        platform,
        handle,
      );
      jobIds.push(jobId);
    }
    if (jobIds.length === 0) {
      throw new BadRequestException(
        'No valid platform+handle combinations provided',
      );
    }
    return jobIds;
  }

  async scrapeCompetitor(
    projectId: string,
    competitorId: string,
    userId: string,
    dto: ScrapeCompetitorDto,
  ): Promise<string[]> {
    await this.assertProjectOwnership(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('competitors')
      .select('id, project_id, handle, platform')
      .eq('id', competitorId)
      .eq('project_id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(
        `Competitor ${competitorId} not found in project ${projectId}`,
      );
    }

    const competitor = data as CompetitorRow;
    const handle = competitor.handle;

    // Decide which platforms to scrape — default to the competitor's stored platform
    const platforms: ScrapePlatform[] = dto.platforms ?? [
      competitor.platform.toLowerCase() as ScrapePlatform,
    ];

    const jobIds: string[] = [];
    for (const platform of platforms) {
      if (!SUPPORTED_PLATFORMS.includes(platform)) {
        this.logger.warn(
          `Unsupported platform=${platform} for competitor scrape`,
        );
        continue;
      }
      const jobId = await this.launchScrape(
        projectId,
        'competitor',
        competitor.id,
        platform,
        handle,
      );
      jobIds.push(jobId);
    }

    if (jobIds.length === 0) {
      throw new BadRequestException(
        'No valid platforms to scrape for this competitor',
      );
    }
    return jobIds;
  }

  async getProjectScrapeJobs(
    projectId: string,
    userId: string,
  ): Promise<ScrapeJobRow[]> {
    await this.assertProjectOwnership(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('scrape_jobs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) {
      throw new Error(`Failed to fetch scrape jobs: ${error.message}`);
    }
    return (data ?? []) as ScrapeJobRow[];
  }

  async getScrapeJob(
    scrapeJobId: string,
    userId: string,
  ): Promise<ScrapeJobRow> {
    const job = await this.getScrapeJobById(scrapeJobId);
    await this.assertProjectOwnership(job.project_id, userId);
    return job;
  }

  /** Replace expiring CDN thumbnail links on the given rows with permanent storage copies. */
  private async persistThumbnails(contentIds: string[]): Promise<void> {
    if (contentIds.length === 0) return;
    const client = this.supabaseService.getClient();
    const { data } = await client
      .from('scraped_content')
      .select('id, thumbnail_url')
      .in('id', contentIds)
      .not('thumbnail_url', 'is', null);
    const rows = ((data ?? []) as Array<{ id: string; thumbnail_url: string }>).filter(
      (r) => !this.avatarStorage.isStorageUrl(r.thumbnail_url),
    );
    if (rows.length === 0) return;

    let saved = 0;
    const queue = [...rows];
    const workers = Array.from({ length: 4 }, async () => {
      for (;;) {
        const row = queue.shift();
        if (!row) return;
        const url = await this.avatarStorage.persist(row.thumbnail_url, `posts/${row.id}`);
        if (url) {
          const { error } = await client
            .from('scraped_content')
            .update({ thumbnail_url: url })
            .eq('id', row.id);
          if (!error) saved += 1;
        }
      }
    });
    await Promise.all(workers);
    this.logger.log(`Persisted ${saved}/${rows.length} post thumbnails to storage`);
  }

  /**
   * Called from webhooks.controller when Apify webhook fires.
   * Also used by the polling fallback.
   */
  async processCompletedRun(scrapeJobId: string, runId: string): Promise<void> {
    const job = await this.getScrapeJobById(scrapeJobId);
    if (job.status === 'completed') {
      this.logger.log(
        `scrape_job=${scrapeJobId} already completed, skipping reprocess`,
      );
      return;
    }

    // Always verify the run by calling Apify directly — never trust webhook payload blindly
    const runStatus = await this.apifyService.getRunStatus(runId);
    if (!runStatus) {
      await this.markFailed(scrapeJobId, `Apify run ${runId} not found`);
      return;
    }

    if (runStatus.status !== 'SUCCEEDED') {
      await this.markFailed(
        scrapeJobId,
        `Apify run ended with status=${runStatus.status}`,
      );
      return;
    }

    if (!runStatus.defaultDatasetId) {
      await this.markFailed(
        scrapeJobId,
        'Apify run completed but no dataset attached',
      );
      return;
    }

    await this.updateJob(scrapeJobId, {
      status: 'running',
      apify_dataset_id: runStatus.defaultDatasetId,
    });

    const items = await this.apifyService.getDatasetItems(
      runStatus.defaultDatasetId,
    );
    this.logger.log(
      `scrape_job=${scrapeJobId} dataset=${runStatus.defaultDatasetId} fetched ${items.length} items`,
    );

    let normalized: ReturnType<typeof normalizeScrapedItems>;
    try {
      normalized = normalizeScrapedItems(job.platform, items);
    } catch (err) {
      await this.markFailed(scrapeJobId, `Normalization failed: ${(err as Error).message}`);
      return;
    }
    if (normalized.length === 0) {
      await this.updateJob(scrapeJobId, {
        status: 'completed',
        items_scraped: 0,
        items_embedded: 0,
        completed_at: new Date().toISOString(),
      });
      await this.recordFreshness(job);
      return;
    }

    let insertedIds: string[];
    try {
      insertedIds = await this.upsertScrapedContent(job, normalized);
    } catch (err) {
      // Surface the failure instead of leaving the job "running" forever
      await this.markFailed(scrapeJobId, (err as Error).message);
      return;
    }

    // Trigger embeddings asynchronously (non-blocking; logs errors internally)
    this.embeddingsService
      .embedScrapedContentBatch(insertedIds)
      .then(async (chunks) => {
        await this.updateJob(scrapeJobId, { items_embedded: chunks });
        this.logger.log(
          `scrape_job=${scrapeJobId} produced ${chunks} embedding chunks`,
        );
      })
      .catch((err) => {
        this.logger.error(
          `scrape_job=${scrapeJobId} embeddings failed: ${(err as Error).message}`,
        );
      });

    // Copy post thumbnails into our own storage while the CDN links are still
    // fresh — Instagram signs them and they die within weeks (non-blocking).
    this.persistThumbnails(insertedIds).catch((err) => {
      this.logger.warn(
        `scrape_job=${scrapeJobId} thumbnail persistence failed: ${(err as Error).message}`,
      );
    });

    await this.updateJob(scrapeJobId, {
      status: 'completed',
      items_scraped: insertedIds.length,
      completed_at: new Date().toISOString(),
    });
    await this.recordFreshness(job);

    this.logger.log(
      `scrape_job=${scrapeJobId} completed: ${insertedIds.length} content rows inserted`,
    );
  }

  /**
   * Called when ProfilesService sets onboarding_step='scraping'.
   * Find/create the user's default project, then enqueue a self-scrape for each handle.
   */
  async triggerOnboardingSelfScrape(
    userId: string,
    profile: ProfileMinimal,
  ): Promise<{ projectId: string; jobIds: string[] }> {
    const projectId = await this.ensureOnboardingProject(userId, profile);

    if (profile.has_social_presence === false) {
      this.logger.log(
        `User ${userId} has no social presence yet — skipping self-scrape`,
      );
      return { projectId, jobIds: [] };
    }

    const platforms: ScrapePlatform[] = [];
    const handles: Record<ScrapePlatform, string | undefined> = {
      instagram: profile.instagram_handle ?? undefined,
      tiktok: profile.tiktok_handle ?? undefined,
      youtube: profile.youtube_handle ?? undefined,
      facebook: profile.facebook_handle ?? undefined,
    };

    for (const p of SUPPORTED_PLATFORMS) {
      if (handles[p]) platforms.push(p);
    }

    if (platforms.length === 0) {
      this.logger.warn(
        `User ${userId} triggered scraping step with no handles set`,
      );
      return { projectId, jobIds: [] };
    }

    const jobIds = await this.scrapeSelf(projectId, userId, {
      platforms,
      handles,
    });

    this.logger.log(
      `Onboarding auto-scrape kicked off for user=${userId} project=${projectId} platforms=${platforms.join(',')}`,
    );
    return { projectId, jobIds };
  }

  /* ──────────────────────────────────────────────────────────
   * Internal helpers
   * ────────────────────────────────────────────────────────── */

  private async launchScrape(
    projectId: string,
    sourceType: 'self' | 'competitor',
    competitorId: string | null,
    platform: ScrapePlatform,
    handle: string,
  ): Promise<string> {
    const cleanHandle = handle.replace(/^@/, '').trim();
    const client = this.supabaseService.getClient();

    // Step 1: create scrape_jobs row (status=queued)
    const insertResponse = await client
      .from('scrape_jobs')
      .insert({
        project_id: projectId,
        source_type: sourceType,
        competitor_id: competitorId,
        platform,
        target_handle: cleanHandle,
        apify_actor_id: APIFY_ACTORS[platform],
        status: 'queued',
      })
      .select()
      .single();

    if (insertResponse.error || !insertResponse.data) {
      throw new Error(
        `Failed to create scrape_job: ${insertResponse.error?.message ?? 'unknown'}`,
      );
    }

    const job = insertResponse.data as ScrapeJobRow;

    // Step 2: kick off Apify actor (don't block — fire & forget once started)
    try {
      const run = await this.apifyService.startScrapeRun(
        platform,
        cleanHandle,
        job.id,
        this.webhookUrl,
      );

      await this.updateJob(job.id, {
        status: 'running',
        apify_run_id: run.id,
        apify_dataset_id: run.defaultDatasetId ?? null,
        started_at: new Date().toISOString(),
      });

      // Schedule a polling fallback in case the webhook never arrives
      this.schedulePollingFallback(job.id, run.id);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `Failed to start Apify run for scrape_job=${job.id}: ${message}`,
      );
      await this.markFailed(job.id, `Apify start failed: ${message}`);
    }

    return job.id;
  }

  private schedulePollingFallback(scrapeJobId: string, runId: string): void {
    const poll = async (): Promise<void> => {
      try {
        const current = await this.getScrapeJobById(scrapeJobId);
        if (current.status === 'completed' || current.status === 'failed') {
          return; // webhook already handled it
        }
        this.logger.log(
          `Polling fallback for scrape_job=${scrapeJobId} runId=${runId} (no webhook after ${POLL_FALLBACK_DELAY_MS}ms)`,
        );
        const status = await this.apifyService.getRunStatus(runId);
        if (
          status &&
          (status.status === 'SUCCEEDED' ||
            status.status === 'FAILED' ||
            status.status === 'ABORTED' ||
            status.status === 'TIMED-OUT')
        ) {
          await this.processCompletedRun(scrapeJobId, runId);
        } else {
          // Still running — schedule another check
          this.schedulePollingFallback(scrapeJobId, runId);
        }
      } catch (err) {
        this.logger.error(
          `Polling fallback failed for scrape_job=${scrapeJobId}: ${(err as Error).message}`,
        );
      }
    };

    setTimeout(() => {
      void poll();
    }, POLL_FALLBACK_DELAY_MS).unref();
  }

  private async upsertScrapedContent(
    job: ScrapeJobRow,
    normalized: ReturnType<typeof normalizeScrapedItems>,
  ): Promise<string[]> {
    const client = this.supabaseService.getClient();
    const rows = normalized.map((n) => ({
      project_id: job.project_id,
      source_type: job.source_type,
      competitor_id: job.competitor_id,
      platform: n.platform,
      external_id: n.external_id,
      post_url: n.post_url,
      content_type: n.content_type,
      caption: n.caption,
      hashtags: n.hashtags,
      mentions: n.mentions,
      media_urls: n.media_urls,
      thumbnail_url: n.thumbnail_url,
      duration_seconds: n.duration_seconds,
      likes_count: n.likes_count,
      comments_count: n.comments_count,
      views_count: n.views_count,
      shares_count: n.shares_count,
      saves_count: n.saves_count,
      engagement_rate: n.engagement_rate,
      raw_data: n.raw_data,
      published_at: n.published_at,
    }));

    const { data, error } = await client
      .from('scraped_content')
      .upsert(rows, {
        onConflict: 'project_id,platform,external_id',
        ignoreDuplicates: false,
      })
      .select('id');

    if (error) {
      throw new Error(`Failed to upsert scraped_content: ${error.message}`);
    }
    return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
  }

  private async ensureOnboardingProject(
    userId: string,
    profile: ProfileMinimal,
  ): Promise<string> {
    const client = this.supabaseService.getClient();

    // Look for an existing project for this user (we treat the first one as the default)
    const existingResponse = await client
      .from('projects')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existingResponse.data) {
      return (existingResponse.data as { id: string }).id;
    }

    const projectName =
      profile.entity_name?.trim() ||
      profile.full_name?.trim() ||
      'My workspace';

    const insertResponse = await client
      .from('projects')
      .insert({
        user_id: userId,
        name: projectName,
        niche: profile.niche ?? profile.niche_description?.slice(0, 120) ?? '',
        location: profile.country ?? null,
        persona: profile.persona ?? null,
        instagram_handle: profile.instagram_handle ?? null,
        tiktok_handle: profile.tiktok_handle ?? null,
        youtube_handle: profile.youtube_handle ?? null,
        facebook_handle: profile.facebook_handle ?? null,
        niche_description: profile.niche_description ?? null,
        keywords: profile.keywords ?? [],
        seed_accounts: profile.seed_accounts ?? [],
        // First project of the account → the one single-brand personas land on
        is_primary: true,
        // The brand's own account, as captured during onboarding
        followers_count: profile.followers_count ?? null,
        following_count: profile.following_count ?? null,
        posts_count: profile.posts_count ?? null,
        biography: profile.biography ?? null,
        avatar_url: profile.avatar_url ?? null,
        is_verified: profile.is_verified ?? false,
      })
      .select('id')
      .single();

    if (insertResponse.error || !insertResponse.data) {
      throw new Error(
        `Failed to create onboarding project: ${insertResponse.error?.message ?? 'unknown'}`,
      );
    }
    const newId = (insertResponse.data as { id: string }).id;
    this.logger.log(`Created onboarding project=${newId} for user=${userId}`);
    return newId;
  }

  /* ── Data freshness ─────────────────────────────────────── */

  /**
   * Refresh sweep: re-read every account whose data is older than its threshold —
   * the brand's own account daily, tracked competitors every three days. Untracked
   * accounts refresh only on demand. Everything goes through the Apify gate.
   */
  async runDataRefreshSweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    const startedAt = Date.now();
    let selfStarted = 0;
    let competitorsStarted = 0;

    try {
      const client = this.supabaseService.getClient();

      const selfCutoff = new Date(Date.now() - SELF_STALE_AFTER_MS).toISOString();
      const { data: projects } = await client
        .from('projects')
        .select('id, user_id')
        .or('instagram_handle.not.is.null,tiktok_handle.not.is.null')
        .or(`last_scraped_at.is.null,last_scraped_at.lt.${selfCutoff}`)
        .order('last_scraped_at', { ascending: true, nullsFirst: true })
        .limit(REFRESH_SWEEP_MAX_ACCOUNTS);
      for (const p of (projects ?? []) as Array<{ id: string; user_id: string }>) {
        const outcome = await this.refreshSelfData(p.id, p.user_id);
        if (outcome.started) selfStarted++;
      }

      const competitorCutoff = new Date(Date.now() - COMPETITOR_STALE_AFTER_MS).toISOString();
      const { data: competitors } = await client
        .from('competitors')
        .select('id, project_id, projects!inner(user_id)')
        .eq('validated_by_user', true)
        .eq('rejected_by_user', false)
        .or(`last_scraped_at.is.null,last_scraped_at.lt.${competitorCutoff}`)
        .order('last_scraped_at', { ascending: true, nullsFirst: true })
        .limit(REFRESH_SWEEP_MAX_ACCOUNTS);
      type StaleCompetitor = {
        id: string;
        project_id: string;
        projects: { user_id: string } | Array<{ user_id: string }> | null;
      };
      for (const c of (competitors ?? []) as StaleCompetitor[]) {
        const owner = Array.isArray(c.projects) ? c.projects[0]?.user_id : c.projects?.user_id;
        if (!owner) continue;
        const outcome = await this.refreshCompetitorData(c.project_id, c.id, owner);
        if (outcome.started) competitorsStarted++;
      }

      // RAG must see the whole corpus, including posts scraped before embeddings existed
      const { data: allProjects } = await client.from('projects').select('id').limit(50);
      for (const p of (allProjects ?? []) as Array<{ id: string }>) {
        await this.embeddingsService.backfillProject(p.id).catch((err) => {
          this.logger.warn(
            `Embedding backfill failed for project ${p.id}: ${(err as Error).message}`,
          );
        });
      }

      this.logger.log(
        `Data refresh sweep: ${selfStarted} own account(s) + ${competitorsStarted} competitor(s) queued in ${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
    } catch (err) {
      this.logger.error(`Data refresh sweep failed: ${(err as Error).message}`);
    } finally {
      this.sweeping = false;
    }
  }

  /** Re-read the brand's own account: identity first, then its posts. */
  async refreshSelfData(
    projectId: string,
    userId: string,
    opts: { manual?: boolean; force?: boolean } = {},
  ): Promise<RefreshOutcome> {
    await this.assertProjectOwnership(projectId, userId);
    const client = this.supabaseService.getClient();
    const { data } = await client
      .from('projects')
      .select('id, instagram_handle, tiktok_handle, last_scraped_at, avatar_url')
      .eq('id', projectId)
      .maybeSingle();
    const project = (data ?? null) as {
      instagram_handle: string | null;
      tiktok_handle: string | null;
      last_scraped_at: string | null;
      avatar_url: string | null;
    } | null;
    if (!project) return { started: false, reason: 'failed' };

    const platform: ScrapePlatform = project.instagram_handle ? 'instagram' : 'tiktok';
    const handle = project.instagram_handle ?? project.tiktok_handle;
    if (!handle) return { started: false, reason: 'no_handle' };

    const nextAllowedAt = this.cooldownUntil(
      project.last_scraped_at,
      opts.manual ? MANUAL_REFRESH_COOLDOWN_MS : SELF_STALE_AFTER_MS,
    );
    if (!opts.force && nextAllowedAt) {
      return { started: false, reason: 'too_soon', next_allowed_at: nextAllowedAt };
    }
    if (await this.hasActiveScrape(projectId, 'self', null)) {
      return { started: false, reason: 'already_running' };
    }

    await this.refreshIdentity('projects', projectId, handle, platform, project.avatar_url);
    try {
      const jobIds = await this.scrapeSelf(projectId, userId, {
        platforms: [platform],
        handles: { [platform]: handle },
      } as ScrapeSelfDto);
      return { started: true, scrape_job_ids: jobIds };
    } catch (err) {
      this.logger.warn(`Own-account refresh failed for project ${projectId}: ${(err as Error).message}`);
      return { started: false, reason: 'failed' };
    }
  }

  /** Re-read one competitor: identity first, then its posts. */
  async refreshCompetitorData(
    projectId: string,
    competitorId: string,
    userId: string,
    opts: { manual?: boolean; force?: boolean } = {},
  ): Promise<RefreshOutcome> {
    await this.assertProjectOwnership(projectId, userId);
    const client = this.supabaseService.getClient();
    const { data } = await client
      .from('competitors')
      .select('id, handle, platform, last_scraped_at, avatar_url')
      .eq('id', competitorId)
      .eq('project_id', projectId)
      .maybeSingle();
    const competitor = (data ?? null) as {
      handle: string;
      platform: string | null;
      last_scraped_at: string | null;
      avatar_url: string | null;
    } | null;
    if (!competitor) return { started: false, reason: 'failed' };

    const platform = (competitor.platform || 'instagram').toLowerCase() as ScrapePlatform;
    const nextAllowedAt = this.cooldownUntil(
      competitor.last_scraped_at,
      opts.manual ? MANUAL_REFRESH_COOLDOWN_MS : COMPETITOR_STALE_AFTER_MS,
    );
    if (!opts.force && nextAllowedAt) {
      return { started: false, reason: 'too_soon', next_allowed_at: nextAllowedAt };
    }
    if (await this.hasActiveScrape(projectId, 'competitor', competitorId)) {
      return { started: false, reason: 'already_running' };
    }

    await this.refreshIdentity('competitors', competitorId, competitor.handle, platform, competitor.avatar_url);
    try {
      const jobIds = await this.scrapeCompetitor(
        projectId,
        competitorId,
        userId,
        {} as ScrapeCompetitorDto,
      );
      return { started: true, scrape_job_ids: jobIds };
    } catch (err) {
      this.logger.warn(
        `Competitor refresh failed for competitor ${competitorId}: ${(err as Error).message}`,
      );
      return { started: false, reason: 'failed' };
    }
  }

  private cooldownUntil(lastScrapedAt: string | null, windowMs: number): string | null {
    if (!lastScrapedAt) return null;
    const next = new Date(lastScrapedAt).getTime() + windowMs;
    return next > Date.now() ? new Date(next).toISOString() : null;
  }

  private async hasActiveScrape(
    projectId: string,
    sourceType: 'self' | 'competitor',
    competitorId: string | null,
  ): Promise<boolean> {
    const client = this.supabaseService.getClient();
    // Older queued/running rows are stuck ones the reconciler will close — not a reason to wait
    const since = new Date(Date.now() - START_TIMEOUT_MS).toISOString();
    let query = client
      .from('scrape_jobs')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('source_type', sourceType)
      .in('status', ['queued', 'running'])
      .gte('created_at', since);
    if (competitorId) query = query.eq('competitor_id', competitorId);
    const { count } = await query;
    return (count ?? 0) > 0;
  }

  /**
   * Followers, bio and verification move, and the posts scrape does not carry
   * them — so the profile is read first and the snapshot taken at completion
   * sees current numbers. Never throws.
   */
  private async refreshIdentity(
    table: 'projects' | 'competitors',
    id: string,
    handle: string,
    platform: ScrapePlatform,
    currentAvatar: string | null,
  ): Promise<void> {
    if (platform !== 'instagram' && platform !== 'tiktok') return;
    try {
      const fresh = await this.scraperService.scrapeProfile(handle, platform);
      const patch: Record<string, unknown> = {
        followers_count: fresh.followers_count || null,
        following_count: fresh.following_count || null,
        posts_count: fresh.posts_count || null,
        is_verified: fresh.is_verified,
      };
      if (fresh.biography) patch.biography = fresh.biography;
      if (fresh.full_name && table === 'competitors') patch.full_name = fresh.full_name;
      // Avatars are copied into our storage once — CDN links expire, ours do not
      const alreadyStored = !!currentAvatar && currentAvatar.includes('/storage/v1/');
      if (fresh.avatar_url && !alreadyStored) {
        const stored = await this.avatarStorage.persist(fresh.avatar_url, `${table}/${id}`);
        if (stored) patch.avatar_url = stored;
      }
      const { error } = await this.supabaseService
        .getClient()
        .from(table)
        .update(patch)
        .eq('id', id);
      if (error) throw new Error(error.message);
    } catch (err) {
      this.logger.warn(
        `Identity refresh failed for ${table}=${id} (@${handle}): ${(err as Error).message}`,
      );
    }
  }

  /**
   * Every completed scrape stamps the account's freshness and appends one
   * snapshot row — the time series behind growth charts and trend-aware AI.
   * Never throws: bookkeeping must not fail a scrape that already succeeded.
   */
  private async recordFreshness(job: ScrapeJobRow): Promise<void> {
    const client = this.supabaseService.getClient();
    const isSelf = job.source_type === 'self';
    const accountId = isSelf ? job.project_id : job.competitor_id;
    if (!accountId) return;
    const table = isSelf ? 'projects' : 'competitors';
    const capturedAt = new Date().toISOString();

    try {
      const { error: stampErr } = await client
        .from(table)
        .update({ last_scraped_at: capturedAt })
        .eq('id', accountId);
      if (stampErr) throw new Error(stampErr.message);

      const { data: account } = await client
        .from(table)
        .select('followers_count, following_count, posts_count')
        .eq('id', accountId)
        .maybeSingle();
      const counts = (account ?? null) as {
        followers_count: number | null;
        following_count: number | null;
        posts_count: number | null;
      } | null;

      let query = client
        .from('scraped_content')
        .select('likes_count, comments_count, views_count')
        .eq('project_id', job.project_id)
        .eq('source_type', job.source_type)
        .eq('platform', job.platform);
      if (!isSelf) query = query.eq('competitor_id', accountId);
      const { data: posts } = await query
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(SNAPSHOT_SAMPLE_SIZE);
      const rows = (posts ?? []) as Array<{
        likes_count: number | null;
        comments_count: number | null;
        views_count: number | null;
      }>;

      const mean = (values: number[]) =>
        values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
      const followers = counts?.followers_count ?? null;
      const avgInteractions = mean(rows.map((r) => (r.likes_count ?? 0) + (r.comments_count ?? 0)));
      const engagementRate =
        followers && followers > 0 && avgInteractions != null
          ? (avgInteractions / followers) * 100
          : null;

      const { error: snapErr } = await client.from('account_snapshots').insert({
        project_id: job.project_id,
        competitor_id: isSelf ? null : accountId,
        source_type: job.source_type,
        platform: job.platform,
        captured_at: capturedAt,
        followers_count: followers,
        following_count: counts?.following_count ?? null,
        posts_count: counts?.posts_count ?? null,
        posts_sampled: rows.length,
        avg_likes: mean(rows.map((r) => r.likes_count ?? 0)),
        avg_comments: mean(rows.map((r) => r.comments_count ?? 0)),
        avg_views: mean(rows.map((r) => r.views_count ?? 0).filter((v) => v > 0)),
        engagement_rate: engagementRate,
      });
      if (snapErr) throw new Error(snapErr.message);
    } catch (err) {
      this.logger.warn(
        `Freshness bookkeeping failed for ${table}=${accountId}: ${(err as Error).message}`,
      );
    }

    if (isSelf) await this.matchPublishedDrafts(job.project_id);
  }

  /**
   * Performance loop: match the account's real posts to the drafts they came
   * from (caption similarity) and keep each draft's numbers against the
   * account's averages. Runs after every self scrape; never throws.
   */
  private async matchPublishedDrafts(projectId: string): Promise<void> {
    const client = this.supabaseService.getClient();
    try {
      const { data: draftRows } = await client
        .from('drafts')
        .select(
          'id, caption_text, status, created_at, published_content_id, content_directions!inner(brief_id, analysis_briefs!inner(project_id))',
        )
        .eq('content_directions.analysis_briefs.project_id', projectId)
        .neq('status', 'REJECTED')
        .not('caption_text', 'is', null)
        .order('created_at', { ascending: false })
        .limit(60);
      const drafts = (draftRows ?? []) as Array<{
        id: string;
        caption_text: string;
        status: string;
        created_at: string;
        published_content_id: string | null;
      }>;
      if (drafts.length === 0) return;

      const { data: postRows } = await client
        .from('scraped_content')
        .select('id, caption, likes_count, comments_count, views_count, published_at')
        .eq('project_id', projectId)
        .eq('source_type', 'self')
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(80);
      const posts = (postRows ?? []) as Array<{
        id: string;
        caption: string | null;
        likes_count: number | null;
        comments_count: number | null;
        views_count: number | null;
        published_at: string | null;
      }>;
      if (posts.length === 0) return;

      const mean = (values: number[]) =>
        values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0;
      const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;
      const avgLikes = mean(posts.map((p) => p.likes_count ?? 0));
      const avgComments = mean(posts.map((p) => p.comments_count ?? 0));
      const avgViews = mean(posts.map((p) => p.views_count ?? 0).filter((v) => v > 0));
      const avgInteractions = mean(posts.map((p) => (p.likes_count ?? 0) + (p.comments_count ?? 0)));
      const now = new Date().toISOString();
      let matched = 0;

      for (const draft of drafts) {
        let post = draft.published_content_id
          ? (posts.find((p) => p.id === draft.published_content_id) ?? null)
          : null;
        if (!post) {
          // Only a post published after the draft existed can be that draft
          let best: (typeof posts)[number] | null = null;
          let bestScore = 0;
          for (const candidate of posts) {
            if (!candidate.caption?.trim()) continue;
            if (candidate.published_at && candidate.published_at < draft.created_at) continue;
            const score = captionSimilarity(draft.caption_text, candidate.caption);
            if (score > bestScore) {
              bestScore = score;
              best = candidate;
            }
          }
          if (!best || bestScore < DRAFT_MATCH_THRESHOLD) continue;
          post = best;
        }

        const likes = post.likes_count ?? 0;
        const comments = post.comments_count ?? 0;
        const views = post.views_count ?? 0;
        const performance = {
          likes,
          comments,
          views,
          avg_likes: round(avgLikes),
          avg_comments: round(avgComments),
          avg_views: round(avgViews),
          vs_avg_likes: avgLikes > 0 ? round(likes / avgLikes, 2) : null,
          vs_avg_interactions: avgInteractions > 0 ? round((likes + comments) / avgInteractions, 2) : null,
          measured_at: now,
        };
        await client
          .from('drafts')
          .update({
            published_content_id: post.id,
            published_at: post.published_at ?? now,
            performance,
            status: 'APPROVED',
          })
          .eq('id', draft.id);
        await client
          .from('calendar_items')
          .update({ status: 'published' })
          .eq('draft_id', draft.id)
          .eq('status', 'planned');
        matched++;
      }
      if (matched > 0) this.logger.log(`Performance loop: ${matched} draft(s) matched to real posts in project ${projectId}`);
    } catch (err) {
      this.logger.warn(`Performance loop failed for project ${projectId}: ${(err as Error).message}`);
    }
  }

  private async getScrapeJobById(scrapeJobId: string): Promise<ScrapeJobRow> {
    const client = this.supabaseService.getClient();
    const response = await client
      .from('scrape_jobs')
      .select('*')
      .eq('id', scrapeJobId)
      .single();

    if (response.error || !response.data) {
      throw new NotFoundException(`scrape_job ${scrapeJobId} not found`);
    }
    return response.data as ScrapeJobRow;
  }

  private async updateJob(
    scrapeJobId: string,
    patch: Partial<ScrapeJobRow>,
  ): Promise<void> {
    const client = this.supabaseService.getClient();
    const { error } = await client
      .from('scrape_jobs')
      .update(patch)
      .eq('id', scrapeJobId);
    if (error) {
      this.logger.error(
        `Failed to update scrape_job=${scrapeJobId}: ${error.message}`,
      );
    }
  }

  private async markFailed(
    scrapeJobId: string,
    errorMsg: string,
  ): Promise<void> {
    await this.updateJob(scrapeJobId, {
      status: 'failed',
      error: errorMsg,
      completed_at: new Date().toISOString(),
    });
    this.logger.warn(`scrape_job=${scrapeJobId} marked FAILED: ${errorMsg}`);
  }

  private async assertProjectOwnership(
    projectId: string,
    userId: string,
  ): Promise<ProjectRow> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select(
        'id, user_id, instagram_handle, tiktok_handle, youtube_handle, name',
      )
      .eq('id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    if ((data as ProjectRow).user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }
    return data as ProjectRow;
  }
}
