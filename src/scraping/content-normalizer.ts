import { ScrapePlatform } from './dto/scrape-self.dto';

/**
 * Normalized scraped_content row (subset of DB columns we set during normalization).
 * project_id, source_type, competitor_id are added by the caller.
 */
export interface NormalizedContent {
  platform: ScrapePlatform;
  external_id: string;
  post_url: string | null;
  content_type:
    | 'image'
    | 'video'
    | 'reel'
    | 'carousel'
    | 'story'
    | 'short'
    | 'long_video'
    | null;
  caption: string | null;
  hashtags: string[];
  mentions: string[];
  media_urls: string[];
  thumbnail_url: string | null;
  duration_seconds: number | null;
  likes_count: number;
  comments_count: number;
  views_count: number;
  shares_count: number;
  saves_count: number;
  engagement_rate: number | null;
  raw_data: Record<string, unknown>;
  published_at: string | null;
}

function extractHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const matches: string[] = caption.match(/#[A-Za-z0-9_]+/g) ?? [];
  return matches.map((h: string) => h.slice(1).toLowerCase());
}

function extractMentions(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const matches: string[] = caption.match(/@[A-Za-z0-9_.]+/g) ?? [];
  return matches.map((m: string) => m.slice(1).toLowerCase());
}

/**
 * Platforms report video length as fractional seconds (e.g. 87.2127) while
 * scraped_content.duration_seconds is an integer column — round it.
 */
function toSeconds(value: unknown): number | null {
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? parseFloat(value) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function toIsoString(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  return null;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = parseInt(value.replace(/[,.]/g, ''), 10);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function calcEngagementRate(
  likes: number,
  comments: number,
  views: number,
): number | null {
  if (views > 0) return Number(((likes + comments) / views).toFixed(4));
  return null;
}

/* ──────────────────────────────────────────────────────────
 * Per-platform normalizers
 * ────────────────────────────────────────────────────────── */

function normalizeInstagram(
  item: Record<string, unknown>,
): NormalizedContent | null {
  const externalId =
    asString(item.id) ?? asString(item.shortCode) ?? asString(item.shortcode);
  if (!externalId) return null;

  const caption = asString(item.caption);
  const typeRaw = asString(item.type) ?? asString(item.productType);
  let contentType: NormalizedContent['content_type'] = null;
  if (typeRaw === 'Sidecar' || typeRaw === 'GraphSidecar')
    contentType = 'carousel';
  else if (typeRaw === 'Video' || typeRaw === 'GraphVideo')
    contentType = 'video';
  else if (typeRaw === 'Image' || typeRaw === 'GraphImage')
    contentType = 'image';
  else if (asString(item.productType) === 'clips') contentType = 'reel';

  const likes = asNumber(item.likesCount);
  const comments = asNumber(item.commentsCount);
  const views = asNumber(item.videoViewCount) || asNumber(item.videoPlayCount);
  const hashtags =
    (item.hashtags as string[] | undefined) ?? extractHashtags(caption);
  const mentions =
    (item.mentions as string[] | undefined) ?? extractMentions(caption);

  return {
    platform: 'instagram',
    external_id: externalId,
    post_url:
      asString(item.url) ?? `https://www.instagram.com/p/${externalId}/`,
    content_type: contentType,
    caption,
    hashtags: hashtags.map((h) => h.replace(/^#/, '').toLowerCase()),
    mentions: mentions.map((m) => m.replace(/^@/, '').toLowerCase()),
    media_urls:
      (item.images as string[] | undefined) ??
      (item.videoUrl ? [item.videoUrl as string] : []),
    thumbnail_url: asString(item.displayUrl) ?? asString(item.thumbnailUrl),
    duration_seconds: toSeconds(item.videoDuration),
    likes_count: likes,
    comments_count: comments,
    views_count: views,
    shares_count: 0,
    saves_count: 0,
    engagement_rate: calcEngagementRate(likes, comments, views),
    raw_data: item,
    published_at: toIsoString(item.timestamp ?? item.takenAt),
  };
}

function normalizeTiktok(
  item: Record<string, unknown>,
): NormalizedContent | null {
  const externalId =
    asString(item.id) ??
    asString((item as { videoMeta?: { id?: string } }).videoMeta?.id);
  if (!externalId) return null;

  const caption = asString(item.text);
  const videoMeta = item.videoMeta as
    | { duration?: number; coverUrl?: string }
    | undefined;

  const likes = asNumber(item.diggCount);
  const comments = asNumber(item.commentCount);
  const views = asNumber(item.playCount);
  const shares = asNumber(item.shareCount);

  const hashtagsRaw =
    (item.hashtags as Array<{ name?: string }> | undefined) ?? [];
  const hashtags = hashtagsRaw
    .map((h) => h.name?.toLowerCase())
    .filter((h): h is string => !!h);

  return {
    platform: 'tiktok',
    external_id: externalId,
    post_url: asString(item.webVideoUrl) ?? null,
    content_type: 'video',
    caption,
    hashtags: hashtags.length ? hashtags : extractHashtags(caption),
    mentions: extractMentions(caption),
    media_urls: [],
    thumbnail_url: videoMeta?.coverUrl ?? null,
    duration_seconds: toSeconds(videoMeta?.duration),
    likes_count: likes,
    comments_count: comments,
    views_count: views,
    shares_count: shares,
    saves_count: asNumber(item.collectCount),
    engagement_rate: calcEngagementRate(likes, comments, views),
    raw_data: item,
    published_at: toIsoString(item.createTimeISO ?? item.createTime),
  };
}

function normalizeYouTube(
  item: Record<string, unknown>,
): NormalizedContent | null {
  const externalId =
    asString(item.id) ??
    asString(item.videoId) ??
    asString(
      (item as { snippet?: { resourceId?: { videoId?: string } } }).snippet
        ?.resourceId?.videoId,
    );
  if (!externalId) return null;

  const title = asString(item.title);
  const description = asString(item.description ?? item.text);
  const caption = [title, description].filter(Boolean).join('\n\n') || null;

  const likes = asNumber(item.likes);
  const comments = asNumber(item.commentsCount);
  const views = asNumber(item.viewCount ?? item.viewCountText);
  const duration = asNumber(item.duration);

  // YouTube shorts vs long-video
  const contentType: NormalizedContent['content_type'] =
    duration > 0 && duration <= 60 ? 'short' : 'long_video';

  return {
    platform: 'youtube',
    external_id: externalId,
    post_url:
      asString(item.url) ?? `https://www.youtube.com/watch?v=${externalId}`,
    content_type: contentType,
    caption,
    hashtags: extractHashtags(caption),
    mentions: extractMentions(caption),
    media_urls: [],
    thumbnail_url: asString(item.thumbnailUrl) ?? null,
    duration_seconds: toSeconds(duration),
    likes_count: likes,
    comments_count: comments,
    views_count: views,
    shares_count: 0,
    saves_count: 0,
    engagement_rate: calcEngagementRate(likes, comments, views),
    raw_data: item,
    published_at: toIsoString(item.date ?? item.publishedAt),
  };
}

function normalizeFacebook(
  item: Record<string, unknown>,
): NormalizedContent | null {
  const externalId =
    asString(item.postId) ?? asString(item.id) ?? asString(item.url);
  if (!externalId) return null;

  const caption = asString(item.text) ?? asString(item.message);
  const likes = asNumber(item.likesCount ?? item.likes);
  const comments = asNumber(item.commentsCount ?? item.comments);
  const shares = asNumber(item.sharesCount ?? item.shares);

  return {
    platform: 'facebook',
    external_id: externalId,
    post_url: asString(item.url) ?? asString(item.topLevelUrl),
    content_type: item.video ? 'video' : 'image',
    caption,
    hashtags: extractHashtags(caption),
    mentions: extractMentions(caption),
    media_urls: [],
    thumbnail_url: asString(item.thumbnailUrl) ?? asString(item.previewImage),
    duration_seconds: null,
    likes_count: likes,
    comments_count: comments,
    views_count: 0,
    shares_count: shares,
    saves_count: 0,
    engagement_rate: null,
    raw_data: item,
    published_at: toIsoString(item.time ?? item.publishedAt),
  };
}

export function normalizeScrapedItems(
  platform: ScrapePlatform,
  items: Record<string, unknown>[],
): NormalizedContent[] {
  const normalized: NormalizedContent[] = [];
  for (const item of items) {
    let row: NormalizedContent | null = null;
    switch (platform) {
      case 'instagram':
        row = normalizeInstagram(item);
        break;
      case 'tiktok':
        row = normalizeTiktok(item);
        break;
      case 'youtube':
        row = normalizeYouTube(item);
        break;
      case 'facebook':
        row = normalizeFacebook(item);
        break;
    }
    if (row) normalized.push(row);
  }
  return normalized;
}
