import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ActorRun, ActorStartOptions, ApifyClient } from 'apify-client';

/**
 * Single entry point for every Apify run started by the backend.
 *
 * The Apify free plan caps the memory of all *concurrently running* actors at
 * 16 GB, and actors default to 2–4 GB each. Tracking five competitors fires
 * five content scrapes plus five "find similar" expansions at once — enough to
 * hit "By launching this job you will exceed the memory limit". This gate:
 *   - limits how many runs are in flight at the same time (queue, FIFO),
 *   - starts each actor with an explicit, small memory size,
 *   - retries a launch that still hits the quota instead of failing the job.
 */

const MAX_CONCURRENT_RUNS = 3;
const QUOTA_RETRY_DELAY_MS = 20_000;
const QUOTA_MAX_WAIT_MS = 8 * 60_000;
const WAIT_FOR_FINISH_SECS = 60;
const MAX_WAIT_ROUNDS = 60; // ~1 hour before a slot is released regardless
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

/** Memory each actor is started with — our inputs are small (≤ 40 profiles, ≤ 30 posts). */
const ACTOR_MEMORY_MB: Record<string, number> = {
  'apify/instagram-profile-scraper': 1024,
  'apify/instagram-search-scraper': 1024,
  'apify/instagram-hashtag-scraper': 2048,
  'apify/instagram-scraper': 2048,
  'clockworks/tiktok-scraper': 2048,
};

export interface GateRunOptions {
  memory?: number;
  timeoutSecs?: number;
  webhooks?: ActorStartOptions['webhooks'];
}

@Injectable()
export class ApifyGateService {
  private readonly logger = new Logger(ApifyGateService.name);
  private readonly client: ApifyClient;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly configService: ConfigService) {
    const token = this.configService.get<string>('APIFY_TOKEN') ?? '';
    if (!token) this.logger.warn('APIFY_TOKEN missing — Apify calls will fail');
    this.client = new ApifyClient({ token });
  }

  /** Raw client for reads that do not start runs (datasets, run status). */
  get apify(): ApifyClient {
    return this.client;
  }

  /** Run an actor to completion. The slot is held for the whole run. */
  async call(
    label: string,
    actorId: string,
    input: Record<string, unknown>,
    opts: GateRunOptions = {},
  ): Promise<ActorRun> {
    const release = await this.acquire(label);
    try {
      return await this.withQuotaRetry(label, () =>
        this.client.actor(actorId).call(input, {
          memory: opts.memory ?? ACTOR_MEMORY_MB[actorId],
          timeout: opts.timeoutSecs,
          webhooks: opts.webhooks,
          // apify-client streams the actor's own log to our console by default over a
          // long-lived HTTP connection; a reset on that socket surfaced as an uncaught
          // error and took the whole backend down. We read results from the dataset,
          // not from the log, so the stream is disabled.
          log: null,
        }),
      );
    } finally {
      release();
    }
  }

  /** Run an actor to completion and return its dataset items ([] unless it succeeded). */
  async items(
    label: string,
    actorId: string,
    input: Record<string, unknown>,
    opts: GateRunOptions = {},
    limit = 500,
  ): Promise<Record<string, unknown>[]> {
    const run = await this.call(label, actorId, input, opts);
    this.logger.log(`[${label}] run ${run.id} finished with status=${run.status}`);
    if (run.status !== 'SUCCEEDED' || !run.defaultDatasetId) return [];
    const { items } = await this.client.dataset(run.defaultDatasetId).listItems({ limit });
    return items as Record<string, unknown>[];
  }

  /**
   * Start an actor without waiting for it. The slot stays reserved until the
   * run reaches a terminal state (watched in the background), so fire-and-
   * forget scrapes count against the concurrency limit like everything else.
   */
  async start(
    label: string,
    actorId: string,
    input: Record<string, unknown>,
    opts: GateRunOptions = {},
  ): Promise<ActorRun> {
    const release = await this.acquire(label);
    let run: ActorRun;
    try {
      run = await this.withQuotaRetry(label, () =>
        this.client.actor(actorId).start(input, {
          memory: opts.memory ?? ACTOR_MEMORY_MB[actorId],
          timeout: opts.timeoutSecs,
          webhooks: opts.webhooks,
        }),
      );
    } catch (err) {
      release();
      throw err;
    }
    void this.releaseWhenFinished(label, run.id, release);
    return run;
  }

  private async releaseWhenFinished(label: string, runId: string, release: () => void): Promise<void> {
    try {
      for (let round = 0; round < MAX_WAIT_ROUNDS; round++) {
        const run = await this.client.run(runId).waitForFinish({ waitSecs: WAIT_FOR_FINISH_SECS });
        if (!run || TERMINAL_STATUSES.has(run.status)) return;
      }
      this.logger.warn(`[${label}] run ${runId} still not finished after ${MAX_WAIT_ROUNDS} minutes — releasing its slot`);
    } catch (err) {
      this.logger.warn(`[${label}] could not watch run ${runId}: ${(err as Error).message}`);
    } finally {
      release();
    }
  }

  private acquire(label: string): Promise<() => void> {
    return new Promise((resolve) => {
      const grant = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.active < MAX_CONCURRENT_RUNS) {
        grant();
      } else {
        this.logger.log(
          `[${label}] waiting for a free Apify slot (${this.active} running, ${this.waiters.length + 1} queued)`,
        );
        this.waiters.push(grant);
      }
    });
  }

  private async withQuotaRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    for (;;) {
      try {
        return await fn();
      } catch (err) {
        const message = (err as Error).message ?? '';
        const isQuota = /memory limit|exceed the memory|concurrent runs/i.test(message);
        if (!isQuota || Date.now() - startedAt > QUOTA_MAX_WAIT_MS) throw err;
        this.logger.warn(`[${label}] Apify memory quota hit — retrying in ${QUOTA_RETRY_DELAY_MS / 1000}s`);
        await new Promise((r) => setTimeout(r, QUOTA_RETRY_DELAY_MS));
      }
    }
  }
}
