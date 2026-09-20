import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

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

  constructor(private readonly supabaseService: SupabaseService) {}

  /**
   * Who the account is (persona) and what its numbers say (field analytics) —
   * the grounding every AI agent receives with its request. Never throws: a
   * missing model degrades the prompt, it must not fail the job.
   */
  async groundingFor(projectId: string): Promise<{
    persona: string | null;
    account_model: Record<string, unknown> | null;
  }> {
    const client = this.supabaseService.getClient();
    try {
      const { data: project } = await client
        .from('projects')
        .select('user_id, persona')
        .eq('id', projectId)
        .maybeSingle();
      const row = (project ?? null) as { user_id: string; persona: string | null } | null;
      if (!row) return { persona: null, account_model: null };

      const { data: profile } = await client
        .from('profiles')
        .select('persona')
        .eq('id', row.user_id)
        .maybeSingle();
      const persona =
        ((profile ?? null) as { persona: string | null } | null)?.persona ?? row.persona ?? null;

      const model = await this.getFieldAnalytics(projectId, row.user_id).catch(() => null);
      return { persona, account_model: model as unknown as Record<string, unknown> | null };
    } catch {
      return { persona: null, account_model: null };
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
}
