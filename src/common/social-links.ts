/**
 * Parses a pasted social profile link into a platform + handle.
 * Mirrored on the frontend in lib/social-links.ts — keep both in sync.
 *
 * Share links (vm.tiktok.com/…, facebook.com/share/…, instagram.com/share/…)
 * do not contain the handle: use resolveSocialLink() which follows the
 * redirect first.
 */
export type SocialPlatform = 'instagram' | 'tiktok' | 'youtube' | 'facebook';

export interface ParsedSocialLink {
  platform: SocialPlatform;
  handle: string;
  url: string;
}

const IG_RESERVED = new Set([
  'p', 'reel', 'reels', 'stories', 'explore', 'accounts', 'direct', 'tv', 'share', 'stories',
]);
const FB_RESERVED = new Set([
  'share', 'reel', 'reels', 'watch', 'photo', 'photos', 'posts', 'videos', 'groups',
  'events', 'marketplace', 'stories', 'story.php', 'permalink.php', 'people', 'pages',
  'login', 'sharer', 'sharer.php', 'dialog', 'hashtag',
]);
const TT_RESERVED = new Set(['share', 'video', 'tag', 'discover', 'search', 'music', 'foryou', 'explore', 't']);
const YT_PREFIXES = new Set(['c', 'user', 'channel']);
const HANDLE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const SHARE_HOSTS = /^(vm|vt)\.tiktok\.com$|^fb\.watch$|^l\.instagram\.com$/i;

function toUrl(raw: string): URL | null {
  const input = (raw ?? '').trim();
  if (!input) return null;
  try {
    return new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    return null;
  }
}

function cleanHost(host: string): string {
  return host.toLowerCase().replace(/^(www|m|mobile|web|business)\./, '');
}

/** True for redirect-style share links that must be resolved before parsing. */
export function isShareLink(raw: string): boolean {
  const url = toUrl(raw);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (SHARE_HOSTS.test(host)) return true;
  const first = url.pathname.split('/').filter(Boolean)[0]?.toLowerCase();
  const site = cleanHost(host);
  return (
    first === 'share' &&
    (site === 'facebook.com' || site === 'instagram.com' || site === 'tiktok.com' || site === 'fb.com')
  );
}

export function parseSocialLink(raw: string): ParsedSocialLink | null {
  const url = toUrl(raw);
  if (!url) return null;
  if (SHARE_HOSTS.test(url.hostname.toLowerCase())) return null;

  const host = cleanHost(url.hostname);
  const segments = url.pathname.split('/').filter(Boolean);
  const first = segments[0];

  if (host === 'instagram.com' || host.endsWith('.instagram.com')) {
    if (!first || IG_RESERVED.has(first.toLowerCase())) return null;
    const handle = first.replace(/^@/, '').toLowerCase();
    if (!HANDLE_RE.test(handle)) return null;
    return { platform: 'instagram', handle, url: `https://www.instagram.com/${handle}/` };
  }

  if (host === 'tiktok.com' || host.endsWith('.tiktok.com')) {
    const at = segments.find((s) => s.startsWith('@'));
    const candidate = at ?? first;
    if (!candidate || (!at && TT_RESERVED.has(candidate.toLowerCase()))) return null;
    const handle = candidate.replace(/^@/, '').toLowerCase();
    if (!HANDLE_RE.test(handle)) return null;
    return { platform: 'tiktok', handle, url: `https://www.tiktok.com/@${handle}` };
  }

  if (host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtu.be') {
    if (!first) return null;
    if (first.startsWith('@')) {
      const handle = first.slice(1);
      if (!HANDLE_RE.test(handle)) return null;
      return { platform: 'youtube', handle, url: `https://www.youtube.com/@${handle}` };
    }
    if (YT_PREFIXES.has(first.toLowerCase()) && segments[1]) {
      // Keep the prefix so the scraper can rebuild a valid URL (e.g. channel/UC...)
      const handle = `${first.toLowerCase()}/${segments[1]}`;
      return { platform: 'youtube', handle, url: `https://www.youtube.com/${handle}` };
    }
    return null;
  }

  if (host === 'facebook.com' || host.endsWith('.facebook.com') || host === 'fb.com') {
    if (!first) return null;
    if (first.toLowerCase() === 'profile.php') {
      const id = url.searchParams.get('id');
      if (!id || !/^\d+$/.test(id)) return null;
      return {
        platform: 'facebook',
        handle: `profile.php?id=${id}`,
        url: `https://www.facebook.com/profile.php?id=${id}`,
      };
    }
    if (FB_RESERVED.has(first.toLowerCase())) return null;
    const handle = first.replace(/^@/, '');
    if (!HANDLE_RE.test(handle)) return null;
    return { platform: 'facebook', handle, url: `https://www.facebook.com/${handle}` };
  }

  return null;
}

/**
 * Parses a link, following the redirect of share links first
 * (vm.tiktok.com/…, facebook.com/share/…). Returns null when the final URL
 * does not identify a profile (e.g. a share link to a single post).
 */
export async function resolveSocialLink(raw: string): Promise<ParsedSocialLink | null> {
  const direct = parseSocialLink(raw);
  if (direct) return direct;
  if (!isShareLink(raw)) return null;

  const url = toUrl(raw);
  if (!url) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url.toString(), {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
      signal: controller.signal,
    });
    const finalUrl = response.url || url.toString();
    return parseSocialLink(finalUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parses a seed/benchmark account given as a link or a bare "@handle"
 * (bare handles are assumed to be Instagram). Returns "platform:handle".
 */
export async function resolveSeedAccount(raw: string): Promise<string | null> {
  const input = (raw ?? '').trim();
  if (!input) return null;
  const parsed = await resolveSocialLink(input);
  if (parsed) return `${parsed.platform}:${parsed.handle}`;
  const bare = input.replace(/^@/, '').toLowerCase();
  if (HANDLE_RE.test(bare) && !bare.includes('/') && !bare.includes('.com')) return `instagram:${bare}`;
  return null;
}

/** Synchronous variant (no redirect resolution) — kept for non-async call sites. */
export function parseSeedAccount(raw: string): string | null {
  const input = (raw ?? '').trim();
  if (!input) return null;
  const parsed = parseSocialLink(input);
  if (parsed) return `${parsed.platform}:${parsed.handle}`;
  const bare = input.replace(/^@/, '').toLowerCase();
  if (HANDLE_RE.test(bare) && !bare.includes('/') && !bare.includes('.com')) return `instagram:${bare}`;
  return null;
}

export function splitSeed(seed: string): { platform: SocialPlatform; handle: string } | null {
  const idx = seed.indexOf(':');
  if (idx <= 0) return null;
  const platform = seed.slice(0, idx) as SocialPlatform;
  const handle = seed.slice(idx + 1);
  if (!['instagram', 'tiktok', 'youtube', 'facebook'].includes(platform) || !handle) return null;
  return { platform, handle };
}
