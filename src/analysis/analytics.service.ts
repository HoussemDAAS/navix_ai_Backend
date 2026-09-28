import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AiService } from '../ai/ai.service';

/**
 * Field analytics computed straight from scraped posts — no LLM involved.
 * This is the quantitative layer of the analysis page: real engagement
 * numbers, format mixes, cadence and top posts for every tracked account
 * and for the user's own account.
 */

export interface ContentRow {
  competitor_id: string | null;
  source_type: string;
  platform: string;
  content_type: string | null;
  caption: string | null;
  hashtags: string[] | null;
  likes_count: number | null;
  comments_count: number | null;
  views_count: number | null;
  engagement_rate: number | null;
  published_at: string | null;
  thumbnail_url: string | null;
  post_url: string | null;
  /** Filled by the content-understanding pass when the post was read */
  transcript?: string | null;
  visual_summary?: string | null;
}

interface CompetitorRow {
  id: string;
  handle: string;
  platform: string;
  avatar_url: string | null;
  followers_count: number | null;
  validated_by_user: boolean;
  rejected_by_user: boolean;
}

export interface TopPost {
  post_url: string | null;
  thumbnail_url: string | null;
  caption: string | null;
  content_type: string | null;
  likes_count: number;
  comments_count: number;
  views_count: number;
  published_at: string | null;
}

export interface AccountAnalytics {
  id: string | null;
  handle: string;
  platform: string;
  avatar_url: string | null;
  followers_count: number | null;
  tracked: boolean;
  posts: number;
  avg_likes: number;
  avg_comments: number;
  avg_views: number;
  /** Mean of per-post engagement rates ((likes+comments)/views) when views exist */
  engagement_rate: number | null;
  posts_per_week: number | null;
  dominant_format: string | null;
  format_mix: Array<{ format: string; count: number }>;
  top_posts: TopPost[];
}

export interface FieldAnalytics {
  generated_from: {
    posts: number;
    self_posts: number;
    competitors_with_content: number;
    oldest_post: string | null;
    newest_post: string | null;
  };
  field: {
    avg_engagement_rate: number | null;
    posts_per_week: number | null;
    format_mix: Array<{ format: string; count: number; share: number }>;
    top_hashtags: Array<{ tag: string; count: number }>;
    posting_days: Array<{ day: string; count: number }>;
    posting_hours: Array<{ hour: number; count: number }>;
  };
  competitors: AccountAnalytics[];
  self: AccountAnalytics | null;
  comparison: {
    engagement_vs_field: number | null;
    cadence_vs_field: number | null;
  };
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ── Weekly digest (Home) ─────────────────────────────────── */

export interface DigestPost extends TopPost {
  /** This post's interactions over the account's usual interactions */
  vs_avg: number | null;
}

export interface DigestIdea {
  title: string;
  why: string;
  format: string | null;
  studio_prompt: string;
}

export interface WeeklyDigest {
  period: { from: string; to: string; days: number };
  account: {
    followers_now: number | null;
    followers_delta: number | null;
    engagement_now: number | null;
    engagement_delta: number | null;
    /** The baseline snapshot the deltas are measured from */
    since: string | null;
    snapshots: number;
  };
  you: {
    posts: number;
    /** 7 when they posted this week, else 30 (the month is shown instead) */
    window_days: number;
    days_since_last_post: number | null;
    best_post: DigestPost | null;
  };
  field: {
    posts: number;
    window_days: number;
    accounts_posted: number;
    most_active: { handle: string; posts: number } | null;
    /** 7 when a post really broke out this week, else the month's best is shown */
    breakout_window_days: number;
    breakout: (DigestPost & { competitor_id: string; handle: string; avatar_url: string | null }) | null;
  };
  pipeline: {
    pending_review: number;
    scheduled: number;
    next: { title: string; scheduled_at: string; platform: string } | null;
    posted: Array<{ caption: string | null; vs_avg_interactions: number | null; published_at: string | null }>;
  };
  ai: {
    headline: string | null;
    idea: DigestIdea | null;
    generated_at: string | null;
    stale: boolean;
  };
}

interface DigestCache {
  fingerprint?: string;
  generated_at?: string | null;
  headline?: string | null;
  idea?: DigestIdea | null;
}

interface SnapshotRow {
  captured_at: string;
  followers_count: number | null;
  engagement_rate: number | null;
}

interface DigestDraftRow {
  id: string;
  caption_text: string | null;
  status: string;
  published_at: string | null;
  performance: { vs_avg_interactions?: number | null } | null;
}

const DAY_MS = 24 * 3600 * 1000;
const DIGEST_TTL_MS = 24 * 3600 * 1000;
/** A post counts as a breakout when it beats its account's usual interactions by this factor */
const BREAKOUT_MIN_RATIO = 1.5;
const CONTENT_COLUMNS =
  'competitor_id, source_type, platform, content_type, caption, hashtags, likes_count, comments_count, views_count, engagement_rate, published_at, thumbnail_url, post_url';

function interactions(r: ContentRow): number {
  return (r.likes_count ?? 0) + (r.comments_count ?? 0);
}

function publishedAfter(r: ContentRow, since: Date): boolean {
  if (!r.published_at) return false;
  const t = new Date(r.published_at).getTime();
  return Number.isFinite(t) && t >= since.getTime();
}

function delta(a: number | null | undefined, b: number | null | undefined): number | null {
  return a != null && b != null ? a - b : null;
}

function digestPost(r: ContentRow, avgInteractions: number): DigestPost {
  return {
    post_url: r.post_url,
    thumbnail_url: r.thumbnail_url,
    caption: r.caption ? r.caption.slice(0, 160) : null,
    content_type: r.content_type,
    likes_count: r.likes_count ?? 0,
    comments_count: r.comments_count ?? 0,
    views_count: r.views_count ?? 0,
    published_at: r.published_at,
    vs_avg: avgInteractions > 0 ? round(interactions(r) / avgInteractions, 2) : null,
  };
}

/* ── Creator memory (projects.creator_memory) ─────────────── */

export interface CreatorMemoryItem {
  id: string;
  text: string;
  kind: string;
  source: string;
  learned_at: string;
}

export interface CreatorMemory {
  summary: string;
  learned: CreatorMemoryItem[];
}

export const MEMORY_KINDS = ['preference', 'avoid', 'topic', 'format', 'voice', 'audience', 'goal'] as const;

const MEMORY_KIND_LABEL: Record<string, string> = {
  preference: 'Prefers',
  avoid: 'Avoid',
  topic: 'Recurring topics',
  format: 'Formats they choose',
  voice: 'Voice',
  audience: 'Audience',
  goal: 'Goals',
};

/** Tolerant read of the jsonb column: never trust its shape blindly. */
export function normalizeCreatorMemory(raw: unknown): CreatorMemory {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as { summary?: unknown; learned?: unknown };
  const learned = Array.isArray(obj.learned)
    ? obj.learned
        .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object')
        .map((i) => ({
          id: String(i.id ?? ''),
          text: String(i.text ?? '').trim(),
          kind: String(i.kind ?? 'preference'),
          source: String(i.source ?? ''),
          learned_at: String(i.learned_at ?? ''),
        }))
        .filter((i) => i.text.length > 0)
    : [];
  return { summary: typeof obj.summary === 'string' ? obj.summary : '', learned };
}

/** Render the memory for a prompt: the summary, then one line per kind. */
export function formatCreatorMemory(raw: unknown): string | null {
  const memory = normalizeCreatorMemory(raw);
  if (!memory.summary && memory.learned.length === 0) return null;
  const lines: string[] = [];
  if (memory.summary) lines.push(`Summary: ${memory.summary}`);
  for (const kind of MEMORY_KINDS) {
    const items = memory.learned.filter((i) => i.kind === kind).map((i) => i.text);
    if (items.length > 0) lines.push(`${MEMORY_KIND_LABEL[kind]}: ${items.join('; ')}`);
  }
  return lines.join('\n');
}

function round(n: number, digits = 1): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function postsPerWeek(rows: ContentRow[]): number | null {
  const dates = rows
    .map((r) => (r.published_at ? new Date(r.published_at).getTime() : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);
  if (dates.length < 2) return null;
  const weeks = Math.max((dates[dates.length - 1] - dates[0]) / (7 * 24 * 3600 * 1000), 1);
  return round(dates.length / weeks, 1);
}

function engagementOf(rows: ContentRow[]): number | null {
  const rates = rows
    .map((r) => r.engagement_rate)
    .filter((r): r is number => typeof r === 'number' && Number.isFinite(r) && r > 0);
  if (rates.length === 0) return null;
  return round(mean(rates), 4);
}

function formatMix(rows: ContentRow[]): Array<{ format: string; count: number }> {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const f = r.content_type || 'unknown';
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([format, count]) => ({ format, count }))
    .sort((a, b) => b.count - a.count);
}

function topPosts(rows: ContentRow[], limit = 3): TopPost[] {
  return [...rows]
    .sort(
      (a, b) =>
        (b.likes_count ?? 0) + (b.comments_count ?? 0) - ((a.likes_count ?? 0) + (a.comments_count ?? 0)),
    )
    .slice(0, limit)
    .map((r) => ({
      post_url: r.post_url,
      thumbnail_url: r.thumbnail_url,
      caption: r.caption ? r.caption.slice(0, 160) : null,
      content_type: r.content_type,
      likes_count: r.likes_count ?? 0,
      comments_count: r.comments_count ?? 0,
      views_count: r.views_count ?? 0,
      published_at: r.published_at,
    }));
}

export function accountAnalytics(
  base: { id: string | null; handle: string; platform: string; avatar_url: string | null; followers_count: number | null; tracked: boolean },
  rows: ContentRow[],
): AccountAnalytics {
  const mix = formatMix(rows);
  return {
    ...base,
    posts: rows.length,
    avg_likes: Math.round(mean(rows.map((r) => r.likes_count ?? 0))),
    avg_comments: Math.round(mean(rows.map((r) => r.comments_count ?? 0))),
    avg_views: Math.round(mean(rows.map((r) => r.views_count ?? 0))),
    engagement_rate: engagementOf(rows),
    posts_per_week: postsPerWeek(rows),
    dominant_format: mix[0]?.format ?? null,
    format_mix: mix,
    top_posts: topPosts(rows),
  };
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly aiService: AiService,
  ) {}

  /**
   * Who the account is (persona) and what its numbers say (field analytics) —
   * the grounding every AI agent receives with its request. Never throws: a
   * missing model degrades the prompt, it must not fail the job.
   */
  async groundingFor(projectId: string): Promise<{
    persona: string | null;
    account_model: Record<string, unknown> | null;
    creator_memory: string | null;
    /** Who reads the output: the brand itself, or the agency that manages it */
    audience: 'owner' | 'agency';
  }> {
    const client = this.supabaseService.getClient();
    try {
      const { data: project } = await client
        .from('projects')
        .select('user_id, persona, creator_memory')
        .eq('id', projectId)
        .maybeSingle();
      const row = (project ?? null) as {
        user_id: string;
        persona: string | null;
        creator_memory: unknown;
      } | null;
      if (!row) return { persona: null, account_model: null, creator_memory: null, audience: 'owner' };

      const { data: profile } = await client
        .from('profiles')
        .select('persona')
        .eq('id', row.user_id)
        .maybeSingle();
      const accountType = ((profile ?? null) as { persona: string | null } | null)?.persona ?? null;
      // The project's type first: an agency's client is a brand or a creator, and
      // that is what the agents must reason about, not the agency behind it.
      const persona = row.persona ?? accountType;

      const model = await this.getFieldAnalytics(projectId, row.user_id).catch(() => null);
      return {
        persona,
        account_model: model as unknown as Record<string, unknown> | null,
        creator_memory: formatCreatorMemory(row.creator_memory),
        audience: accountType === 'agency' ? 'agency' : 'owner',
      };
    } catch {
      return { persona: null, account_model: null, creator_memory: null, audience: 'owner' };
    }
  }

  async getFieldAnalytics(projectId: string, userId: string): Promise<FieldAnalytics> {
    const client = this.supabaseService.getClient();

    const { data: project, error: pErr } = await client
      .from('projects')
      .select('id, user_id, instagram_handle, tiktok_handle')
      .eq('id', projectId)
      .single();
    if (pErr || !project) throw new NotFoundException(`Project ${projectId} not found`);
    if ((project as { user_id: string }).user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }

    const [{ data: competitors }, { data: content, error: cErr }] = await Promise.all([
      client
        .from('competitors')
        .select('id, handle, platform, avatar_url, followers_count, validated_by_user, rejected_by_user')
        .eq('project_id', projectId)
        .eq('rejected_by_user', false),
      client
        .from('scraped_content')
        .select(
          'competitor_id, source_type, platform, content_type, caption, hashtags, likes_count, comments_count, views_count, engagement_rate, published_at, thumbnail_url, post_url',
        )
        .eq('project_id', projectId)
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(1000),
    ]);
    if (cErr) {
      this.logger.error(`Failed to fetch scraped content for ${projectId}: ${cErr.message}`);
      throw new Error(`Failed to fetch scraped content: ${cErr.message}`);
    }

    const rows = (content ?? []) as ContentRow[];
    const compRows = (competitors ?? []) as CompetitorRow[];
    const selfRows = rows.filter((r) => r.source_type === 'self');
    const compContent = rows.filter((r) => r.source_type === 'competitor' && r.competitor_id);

    const byCompetitor = new Map<string, ContentRow[]>();
    for (const r of compContent) {
      const list = byCompetitor.get(r.competitor_id as string) ?? [];
      list.push(r);
      byCompetitor.set(r.competitor_id as string, list);
    }

    const competitorAnalytics = compRows
      .map((c) =>
        accountAnalytics(
          {
            id: c.id,
            handle: c.handle,
            platform: c.platform,
            avatar_url: c.avatar_url,
            followers_count: c.followers_count,
            tracked: c.validated_by_user,
          },
          byCompetitor.get(c.id) ?? [],
        ),
      )
      // Accounts with content first, tracked first, then by engagement
      .sort(
        (a, b) =>
          Number(b.posts > 0) - Number(a.posts > 0) ||
          Number(b.tracked) - Number(a.tracked) ||
          (b.engagement_rate ?? 0) - (a.engagement_rate ?? 0),
      );

    // Self account (project handles; profile bio lives on profiles)
    const selfHandle =
      (project as { instagram_handle: string | null }).instagram_handle ??
      (project as { tiktok_handle: string | null }).tiktok_handle;
    const self =
      selfRows.length > 0
        ? accountAnalytics(
            {
              id: null,
              handle: selfHandle ?? 'you',
              platform: selfRows[0].platform?.toUpperCase() ?? 'INSTAGRAM',
              avatar_url: null,
              followers_count: null,
              tracked: false,
            },
            selfRows,
          )
        : null;

    // Field aggregates (competitor content only)
    const hashtagCounts = new Map<string, number>();
    const dayCounts = new Map<number, number>();
    const hourCounts = new Map<number, number>();
    for (const r of compContent) {
      for (const h of r.hashtags ?? []) {
        const tag = h.toLowerCase();
        hashtagCounts.set(tag, (hashtagCounts.get(tag) ?? 0) + 1);
      }
      if (r.published_at) {
        const d = new Date(r.published_at);
        if (!isNaN(d.getTime())) {
          dayCounts.set(d.getUTCDay(), (dayCounts.get(d.getUTCDay()) ?? 0) + 1);
          hourCounts.set(d.getUTCHours(), (hourCounts.get(d.getUTCHours()) ?? 0) + 1);
        }
      }
    }
    const fieldMixRaw = formatMix(compContent);
    const fieldMix = fieldMixRaw.map((m) => ({
      ...m,
      share: compContent.length > 0 ? round(m.count / compContent.length, 3) : 0,
    }));
    const perAccountCadence = competitorAnalytics
      .map((c) => c.posts_per_week)
      .filter((v): v is number => v != null);
    const fieldEngagement = engagementOf(compContent);
    const fieldCadence = perAccountCadence.length > 0 ? round(mean(perAccountCadence), 1) : null;

    const publishedDates = compContent
      .concat(selfRows)
      .map((r) => r.published_at)
      .filter((d): d is string => !!d)
      .sort();

    return {
      generated_from: {
        posts: compContent.length,
        self_posts: selfRows.length,
        competitors_with_content: byCompetitor.size,
        oldest_post: publishedDates[0] ?? null,
        newest_post: publishedDates[publishedDates.length - 1] ?? null,
      },
      field: {
        avg_engagement_rate: fieldEngagement,
        posts_per_week: fieldCadence,
        format_mix: fieldMix,
        top_hashtags: [...hashtagCounts.entries()]
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 12),
        posting_days: [...dayCounts.entries()]
          .map(([day, count]) => ({ day: DAY_NAMES[day], count }))
          .sort((a, b) => DAY_NAMES.indexOf(a.day) - DAY_NAMES.indexOf(b.day)),
        posting_hours: [...hourCounts.entries()]
          .map(([hour, count]) => ({ hour, count }))
          .sort((a, b) => a.hour - b.hour),
      },
      competitors: competitorAnalytics,
      self,
      comparison: {
        engagement_vs_field:
          self?.engagement_rate != null && fieldEngagement != null && fieldEngagement > 0
            ? round(self.engagement_rate / fieldEngagement, 2)
            : null,
        cadence_vs_field:
          self?.posts_per_week != null && fieldCadence != null && fieldCadence > 0
            ? round(self.posts_per_week / fieldCadence, 2)
            : null,
      },
    };
  }

  /**
   * The Home digest: what moved this week (followers, engagement), the best own
   * post, the breakout post in the field, what sits in the pipeline, and one AI
   * idea grounded in those facts. Facts are recomputed on every read; the AI
   * part is cached on the project for a day or until the data changes.
   */
  async getWeeklyDigest(projectId: string, userId: string, refresh = false): Promise<WeeklyDigest> {
    const client = this.supabaseService.getClient();
    const { data: project, error: pErr } = await client
      .from('projects')
      .select('id, user_id, name, niche, language, instagram_handle, tiktok_handle, followers_count, weekly_digest')
      .eq('id', projectId)
      .single();
    if (pErr || !project) throw new NotFoundException(`Project ${projectId} not found`);
    const p = project as {
      user_id: string;
      name: string | null;
      niche: string | null;
      language: string | null;
      instagram_handle: string | null;
      tiktok_handle: string | null;
      followers_count: number | null;
      weekly_digest: DigestCache | null;
    };
    if (p.user_id !== userId) throw new ForbiddenException('You do not have access to this project');

    const now = new Date();
    const weekStart = new Date(now.getTime() - 7 * DAY_MS);
    const monthStart = new Date(now.getTime() - 30 * DAY_MS);
    const weekEnd = new Date(now.getTime() + 7 * DAY_MS);

    const [competitorsRes, contentRes, snapshotsRes, calendarRes, draftsRes] = await Promise.all([
      client
        .from('competitors')
        .select('id, handle, platform, avatar_url, followers_count, validated_by_user, rejected_by_user')
        .eq('project_id', projectId)
        .eq('rejected_by_user', false),
      client
        .from('scraped_content')
        .select(CONTENT_COLUMNS)
        .eq('project_id', projectId)
        .order('published_at', { ascending: false, nullsFirst: false })
        .limit(1000),
      client
        .from('account_snapshots')
        .select('captured_at, followers_count, engagement_rate')
        .eq('project_id', projectId)
        .eq('source_type', 'self')
        .order('captured_at', { ascending: false })
        .limit(30),
      client
        .from('calendar_items')
        .select('title, scheduled_at, platform, status')
        .eq('project_id', projectId)
        .eq('status', 'planned')
        .gte('scheduled_at', now.toISOString())
        .lte('scheduled_at', weekEnd.toISOString())
        .order('scheduled_at', { ascending: true }),
      client
        .from('drafts')
        .select('id, caption_text, status, published_at, performance, content_directions!inner(analysis_briefs!inner(project_id))')
        .eq('content_directions.analysis_briefs.project_id', projectId)
        .limit(500),
    ]);
    if (contentRes.error) {
      throw new Error(`Failed to fetch scraped content: ${contentRes.error.message}`);
    }

    const rows = (contentRes.data ?? []) as ContentRow[];
    const competitors = (competitorsRes.data ?? []) as CompetitorRow[];
    const snaps = (snapshotsRes.data ?? []) as SnapshotRow[];
    const calendar = (calendarRes.data ?? []) as Array<{ title: string; scheduled_at: string; platform: string; status: string }>;
    const draftRows = (draftsRes.data ?? []) as unknown as DigestDraftRow[];

    // Account: the latest snapshot against the last one taken before the window
    const latest = snaps[0] ?? null;
    const beforeWindow = snaps.find((s) => new Date(s.captured_at) < weekStart) ?? null;
    const inWindow = snaps.filter((s) => new Date(s.captured_at) >= weekStart);
    const baseline = beforeWindow ?? (inWindow.length > 1 ? inWindow[inWindow.length - 1] : null);
    const engagementDelta = delta(latest?.engagement_rate, baseline?.engagement_rate);
    const account: WeeklyDigest['account'] = {
      followers_now: latest?.followers_count ?? p.followers_count ?? null,
      followers_delta: delta(latest?.followers_count, baseline?.followers_count),
      engagement_now: latest?.engagement_rate != null ? round(latest.engagement_rate, 1) : null,
      engagement_delta: engagementDelta != null ? round(engagementDelta, 2) : null,
      since: baseline?.captured_at ?? null,
      snapshots: snaps.length,
    };

    // You: this week's posts, else the month's; the best one against your usual interactions
    const selfRows = rows.filter((r) => r.source_type === 'self');
    const selfAvg = mean(selfRows.map(interactions));
    const self7 = selfRows.filter((r) => publishedAfter(r, weekStart));
    const yourRows = self7.length > 0 ? self7 : selfRows.filter((r) => publishedAfter(r, monthStart));
    const yourBest = [...yourRows].sort((a, b) => interactions(b) - interactions(a))[0] ?? null;
    const lastSelf = selfRows
      .map((r) => (r.published_at ? new Date(r.published_at).getTime() : NaN))
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a)[0];
    const you: WeeklyDigest['you'] = {
      posts: yourRows.length,
      window_days: self7.length > 0 ? 7 : 30,
      days_since_last_post: lastSelf ? Math.floor((now.getTime() - lastSelf) / DAY_MS) : null,
      best_post: yourBest ? digestPost(yourBest, selfAvg) : null,
    };

    // Field: the post that beat its own account's usual numbers by the widest margin
    const compById = new Map(competitors.map((c) => [c.id, c]));
    const compContent = rows.filter(
      (r) => r.source_type === 'competitor' && r.competitor_id && compById.has(r.competitor_id),
    );
    const byComp = new Map<string, ContentRow[]>();
    for (const r of compContent) {
      const list = byComp.get(r.competitor_id as string) ?? [];
      list.push(r);
      byComp.set(r.competitor_id as string, list);
    }
    const fieldAvg = mean(compContent.map(interactions));
    // An account's own average only counts once it has a few posts; otherwise the field's
    const usualFor = (competitorId: string): number => {
      const own = byComp.get(competitorId) ?? [];
      return own.length >= 3 ? mean(own.map(interactions)) : fieldAvg;
    };
    const ratioOf = (r: ContentRow): number => {
      const usual = usualFor(r.competitor_id as string);
      return usual > 0 ? interactions(r) / usual : 0;
    };
    const comp7 = compContent.filter((r) => publishedAfter(r, weekStart));
    const comp30 = compContent.filter((r) => publishedAfter(r, monthStart));
    const fieldRows = comp7.length > 0 ? comp7 : comp30;
    const bestOf = (list: ContentRow[]): ContentRow | null =>
      [...list].sort((a, b) => ratioOf(b) - ratioOf(a) || interactions(b) - interactions(a))[0] ?? null;
    // A quiet week's "breakout" would be noise: show the month's unless a post really broke out
    const weekBest = bestOf(comp7);
    const weekBroke = !!weekBest && ratioOf(weekBest) >= BREAKOUT_MIN_RATIO;
    const breakoutRow = weekBroke ? weekBest : (bestOf(comp30) ?? weekBest);
    const breakoutComp = breakoutRow ? compById.get(breakoutRow.competitor_id as string) : undefined;
    const postsByComp = new Map<string, number>();
    for (const r of fieldRows) {
      postsByComp.set(r.competitor_id as string, (postsByComp.get(r.competitor_id as string) ?? 0) + 1);
    }
    const mostActive = [...postsByComp.entries()].sort((a, b) => b[1] - a[1])[0];
    const field: WeeklyDigest['field'] = {
      posts: fieldRows.length,
      window_days: comp7.length > 0 ? 7 : 30,
      accounts_posted: postsByComp.size,
      most_active: mostActive
        ? { handle: compById.get(mostActive[0])?.handle ?? 'unknown', posts: mostActive[1] }
        : null,
      breakout_window_days: weekBroke ? 7 : 30,
      breakout:
        breakoutRow && breakoutComp
          ? {
              ...digestPost(breakoutRow, usualFor(breakoutComp.id)),
              competitor_id: breakoutComp.id,
              handle: breakoutComp.handle,
              avatar_url: breakoutComp.avatar_url,
            }
          : null,
    };

    // Pipeline: what waits for review, what is planned, what got posted and how it did
    const posted = draftRows
      .filter((d) => d.published_at && new Date(d.published_at) >= monthStart)
      .sort((a, b) => new Date(b.published_at as string).getTime() - new Date(a.published_at as string).getTime())
      .slice(0, 3)
      .map((d) => ({
        caption: d.caption_text ? d.caption_text.slice(0, 120) : null,
        vs_avg_interactions: d.performance?.vs_avg_interactions ?? null,
        published_at: d.published_at,
      }));
    const pipeline: WeeklyDigest['pipeline'] = {
      pending_review: draftRows.filter((d) => d.status === 'PENDING').length,
      scheduled: calendar.length,
      next: calendar[0]
        ? { title: calendar[0].title, scheduled_at: calendar[0].scheduled_at, platform: calendar[0].platform }
        : null,
      posted,
    };

    const period = { from: weekStart.toISOString(), to: now.toISOString(), days: 7 };
    const facts = { period, account, you, field, pipeline };

    // AI headline + idea: reused until the underlying data changes or a day passes
    const fingerprint = [
      snaps.length,
      latest?.captured_at ?? '',
      selfRows.length,
      compContent.length,
      rows[0]?.published_at ?? '',
      draftRows.length,
      calendar.length,
    ].join(':');
    const cached = p.weekly_digest ?? null;
    const cacheAge = cached?.generated_at ? now.getTime() - new Date(cached.generated_at).getTime() : Infinity;
    const fresh = !!cached && cached.fingerprint === fingerprint && cacheAge < DIGEST_TTL_MS;
    let ai: WeeklyDigest['ai'] = {
      headline: cached?.headline ?? null,
      idea: cached?.idea ?? null,
      generated_at: cached?.generated_at ?? null,
      stale: !fresh,
    };
    const hasFacts = snaps.length > 0 || selfRows.length > 0 || compContent.length > 0;
    if (hasFacts && (refresh || !fresh)) {
      try {
        const [grounding, { data: brandKit }] = await Promise.all([
          this.groundingFor(projectId),
          client
            .from('brand_kits')
            .select('tone_of_voice, formality_level, target_audience, objective, preferred_cta')
            .eq('project_id', projectId)
            .maybeSingle(),
        ]);
        const result = await this.aiService.weeklyDigest({
          project_id: projectId,
          persona: grounding.persona,
          audience: grounding.audience,
          account_model: grounding.account_model,
          creator_memory: grounding.creator_memory,
          brand_kit: (brandKit as Record<string, unknown> | null) ?? null,
          project: {
            name: p.name,
            niche: p.niche,
            handle: p.instagram_handle ?? p.tiktok_handle,
            language: p.language,
          },
          facts,
        });
        ai = {
          headline: result.headline ?? null,
          idea: result.idea
            ? {
                title: result.idea.title,
                why: result.idea.why,
                format: result.idea.format ?? null,
                studio_prompt: result.idea.studio_prompt,
              }
            : null,
          generated_at: now.toISOString(),
          stale: false,
        };
        await client
          .from('projects')
          .update({ weekly_digest: { fingerprint, ...ai }, weekly_digest_at: now.toISOString() })
          .eq('id', projectId);
      } catch (err) {
        this.logger.warn(`Weekly digest AI part failed for ${projectId}: ${(err as Error).message}`);
      }
    }

    return { period, account, you, field, pipeline, ai };
  }
}
