import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

const BUCKET = 'avatars';
// Generous: several scrape batches can persist thumbnails at the same time,
// and Instagram's CDN slows down under parallel pulls — 10s aborted many.
const FETCH_TIMEOUT_MS = 30_000;

/**
 * Copies external avatar images (Instagram/TikTok CDN URLs expire after a
 * couple of weeks) into a public Supabase Storage bucket so that the URLs we
 * store never break.
 */
@Injectable()
export class AvatarStorageService implements OnModuleInit {
  private readonly logger = new Logger(AvatarStorageService.name);
  private ready = false;

  constructor(private readonly supabaseService: SupabaseService) {}

  async onModuleInit(): Promise<void> {
    const client = this.supabaseService.getClient();
    try {
      const { data } = await client.storage.getBucket(BUCKET);
      if (!data) {
        const { error } = await client.storage.createBucket(BUCKET, {
          public: true,
        });
        if (error && !/already exists/i.test(error.message)) {
          throw new Error(error.message);
        }
        this.logger.log(`Created public storage bucket "${BUCKET}"`);
      }
      this.ready = true;
    } catch (err) {
      this.logger.warn(
        `Avatar bucket unavailable (${(err as Error).message}) — avatars will keep their original URLs`,
      );
    }
  }

  isStorageUrl(url: string | null | undefined): boolean {
    return !!url && url.includes('/storage/v1/object/public/');
  }

  /**
   * Downloads the image at sourceUrl and stores it as avatars/<key>.
   * Returns the permanent public URL, or null if anything fails.
   */
  async persist(sourceUrl: string | null | undefined, key: string): Promise<string | null> {
    if (!sourceUrl) return null;
    if (this.isStorageUrl(sourceUrl)) return sourceUrl;
    if (!this.ready) return null;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(sourceUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'image/*',
        },
        signal: controller.signal,
      });
      if (!response.ok) return null;

      const contentType = response.headers.get('content-type') ?? 'image/jpeg';
      if (!contentType.startsWith('image/')) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > 5 * 1024 * 1024) return null;

      const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
      const path = `${key}.${ext}`;
      const client = this.supabaseService.getClient();
      const { error } = await client.storage
        .from(BUCKET)
        .upload(path, bytes, { contentType, upsert: true });
      if (error) {
        this.logger.warn(`Avatar upload failed for ${key}: ${error.message}`);
        return null;
      }
      const { data } = client.storage.from(BUCKET).getPublicUrl(path);
      // Cache-bust so a re-scraped avatar replaces the old one in browsers
      return `${data.publicUrl}?v=${Date.now()}`;
    } catch (err) {
      this.logger.debug(`Avatar fetch failed for ${key}: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }
}
