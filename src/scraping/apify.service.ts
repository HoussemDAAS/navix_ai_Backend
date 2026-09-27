import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApifyClient, WebhookEventType } from 'apify-client';
import { createHmac } from 'crypto';
import { ScrapePlatform } from './dto/scrape-self.dto';
import { ApifyGateService } from '../apify/apify-gate.service';

export const APIFY_ACTORS: Record<ScrapePlatform, string> = {
  instagram: 'apify/instagram-scraper',
  tiktok: 'clockworks/tiktok-scraper',
};

interface ApifyWebhookConfig {
  eventTypes: WebhookEventType[];
  requestUrl: string;
  payloadTemplate?: string;
  headersTemplate?: string;
}

interface ApifyActorStartResult {
  id: string; // runId
  actId: string;
  defaultDatasetId?: string;
  status?: string;
}

function cleanHandleForLog(handle: string): string {
  return handle.replace(/^@/, '').trim();
}

interface ApifyRunStatus {
  id: string;
  status:
    | 'READY'
    | 'RUNNING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'TIMING-OUT'
    | 'TIMED-OUT'
    | 'ABORTING'
    | 'ABORTED';
  defaultDatasetId?: string;
  finishedAt?: string;
  startedAt?: string;
}

@Injectable()
export class ApifyService {
  private readonly logger = new Logger(ApifyService.name);
  private readonly client: ApifyClient;
  private readonly apiBase = 'https://api.apify.com/v2';
  private readonly token: string;
  private readonly webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly gate: ApifyGateService,
  ) {
    this.token = this.configService.get<string>('APIFY_TOKEN') ?? '';
    this.webhookSecret =
      this.configService.get<string>('APIFY_WEBHOOK_SECRET') ?? '';

    if (!this.token) {
      this.logger.warn('APIFY_TOKEN missing — Apify calls will fail');
    }
    this.client = new ApifyClient({ token: this.token });
  }

  /**
   * Compute HMAC signature for a scrape_job id. Apify forwards this back to us via
   * the headersTemplate so we can verify the webhook is genuine.
   */
  signJobId(jobId: string): string {
    if (!this.webhookSecret) return '';
    return createHmac('sha256', this.webhookSecret).update(jobId).digest('hex');
  }

  verifySignature(jobId: string, signature: string): boolean {
    if (!this.webhookSecret) {
      this.logger.warn(
        'APIFY_WEBHOOK_SECRET not set — accepting webhook without verification',
      );
      return true;
    }
    return this.signJobId(jobId) === signature;
  }

  /**
   * Start an Apify actor run for a specific platform + handle.
   * Returns the runId — we persist it on scrape_jobs.
   */
  async startScrapeRun(
    platform: ScrapePlatform,
    handle: string,
    scrapeJobId: string,
    webhookUrl: string | undefined,
    options: { maxItems?: number } = {},
  ): Promise<ApifyActorStartResult> {
    const actorId = APIFY_ACTORS[platform];
    const maxItems = options.maxItems ?? 30;
    const input = this.buildActorInput(platform, handle, maxItems);
    const webhooks = this.buildWebhooks(scrapeJobId, webhookUrl);

    this.logger.log(
      `Starting Apify actor=${actorId} platform=${platform} handle=${handle} scrapeJob=${scrapeJobId}`,
    );

    // Through the gate: bounded concurrency + explicit memory + quota retry
    const run = await this.gate.start(`Scrape ${platform} @${cleanHandleForLog(handle)}`, actorId, input, {
      webhooks,
    });

    return {
      id: run.id,
      actId: run.actId,
      defaultDatasetId: run.defaultDatasetId,
      status: run.status,
    };
  }

  /**
   * Get a single run's metadata. Use to verify the run actually succeeded.
   */
  async getRunStatus(runId: string): Promise<ApifyRunStatus | null> {
    if (!runId) return null;
    const run = await this.client.run(runId).get();
    if (!run) return null;
    return {
      id: run.id,
      status: run.status,
      defaultDatasetId: run.defaultDatasetId,
      finishedAt: run.finishedAt?.toISOString(),
      startedAt: run.startedAt?.toISOString(),
    };
  }

  /**
   * Fetch dataset items for a completed run. Uses paginated listItems.
   */
  async getDatasetItems(
    datasetId: string,
    limit = 200,
  ): Promise<Record<string, unknown>[]> {
    if (!datasetId) return [];
    const { items } = await this.client.dataset(datasetId).listItems({ limit });
    return items as Record<string, unknown>[];
  }

  /* ──────────────────────────────────────────────────────────
   * Helpers
   * ────────────────────────────────────────────────────────── */

  private buildWebhooks(
    scrapeJobId: string,
    webhookUrl: string | undefined,
  ): ApifyWebhookConfig[] | undefined {
    if (!webhookUrl) return undefined;

    const url = new URL(webhookUrl);
    url.searchParams.set('scrape_job_id', scrapeJobId);

    const headers: Record<string, string> = {};
    const signature = this.signJobId(scrapeJobId);
    if (signature) headers['X-Apify-Signature'] = signature;

    const eventTypes: WebhookEventType[] = [
      'ACTOR.RUN.SUCCEEDED' as WebhookEventType,
      'ACTOR.RUN.FAILED' as WebhookEventType,
      'ACTOR.RUN.ABORTED' as WebhookEventType,
      'ACTOR.RUN.TIMED_OUT' as WebhookEventType,
    ];
    return [
      {
        eventTypes,
        requestUrl: url.toString(),
        headersTemplate: JSON.stringify(headers),
      },
    ];
  }

  private buildActorInput(
    platform: ScrapePlatform,
    handle: string,
    maxItems: number,
  ): Record<string, unknown> {
    const cleanHandle = handle.replace(/^@/, '').trim();
    switch (platform) {
      case 'instagram':
        return {
          directUrls: [`https://www.instagram.com/${cleanHandle}/`],
          resultsType: 'posts',
          resultsLimit: maxItems,
          searchType: 'user',
          searchLimit: 1,
          addParentData: false,
        };
      case 'tiktok':
        return {
          profiles: [cleanHandle],
          resultsPerPage: maxItems,
          // TikTok's own CDN links refuse server-side downloads; stored copies give
          // the content-understanding pass a durable file to transcribe.
          shouldDownloadVideos: true,
          shouldDownloadCovers: false,
          shouldDownloadSubtitles: false,
        };
    }
  }
}
