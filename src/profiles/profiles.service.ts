import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ScrapingService } from '../scraping/scraping.service';
import { ScraperService } from '../scraper/scraper.service';
import { AvatarStorageService } from '../scraper/avatar-storage.service';
import {
  resolveSocialLink,
  resolveSeedAccount,
  isShareLink,
  type SocialPlatform,
} from '../common/social-links';

export interface ProfileRow {
  id: string;
  full_name: string | null;
  persona: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  entity_name: string | null;
  niche: string | null;
  country: string | null;
  target_market: string | null;
  niche_description: string | null;
  keywords: string[] | null;
  seed_accounts: string[] | null;
  has_social_presence: boolean | null;
  languages: string[] | null;
  onboarding_step: string | null;
  [key: string]: unknown;
}

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);
  // The onboarding flow PATCHes twice within seconds (step='scraping', then
  // completed=true). Both would bootstrap; competitors haven't landed yet, so
  // a DB count can't guard against the race — this in-process set does.
  private readonly bootstrappedUsers = new Set<string>();

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly scrapingService: ScrapingService,
    private readonly scraperService: ScraperService,
    private readonly avatarStorage: AvatarStorageService,
  ) {}

  async getProfile(userId: string): Promise<ProfileRow> {
    const client = this.supabaseService.getClient();
    const response = await client
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (response.error || !response.data) {
      this.logger.error(
        `Profile not found for user ${userId}: ${response.error?.message ?? 'no row'}`,
      );
      throw new NotFoundException('Profile not found');
    }

    return response.data as ProfileRow;
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<ProfileRow> {
    const client = this.supabaseService.getClient();

    const payload: Record<string, unknown> = {
      updated_at: new Date().toISOString(),
    };

    // Identity
    if (dto.full_name !== undefined) payload.full_name = dto.full_name;
    if (dto.avatar_url !== undefined) payload.avatar_url = dto.avatar_url;
    if (dto.biography !== undefined) payload.biography = dto.biography;
    if (dto.persona !== undefined) payload.persona = dto.persona;

    // Social handles
    if (dto.instagram_handle !== undefined)
      payload.instagram_handle = dto.instagram_handle;
    if (dto.tiktok_handle !== undefined)
      payload.tiktok_handle = dto.tiktok_handle;

    // Pasted profile links → one handle per platform (replaces previous handles)
    if (dto.social_links !== undefined) {
      const handles: Record<SocialPlatform, string | null> = {
        instagram: null,
        tiktok: null,
      };
      for (const raw of dto.social_links) {
        if (!raw?.trim()) continue;
        const parsed = await resolveSocialLink(raw);
        if (!parsed) {
          throw new BadRequestException(
            isShareLink(raw)
              ? `"${raw}" is a share link to a post, not a profile. Open the profile and paste its link (e.g. tiktok.com/@username).`
              : `Unrecognized profile link: "${raw}". Paste a full Instagram or TikTok profile URL.`,
          );
        }
        handles[parsed.platform] = parsed.handle;
      }
      payload.instagram_handle = handles.instagram;
      payload.tiktok_handle = handles.tiktok;
      if (Object.values(handles).some(Boolean)) payload.has_social_presence = true;
    }
    if (dto.has_social_presence !== undefined)
      payload.has_social_presence = dto.has_social_presence;
    if (dto.niche_description !== undefined)
      payload.niche_description = dto.niche_description?.trim() || null;
    if (dto.keywords !== undefined)
      payload.keywords = dto.keywords
        .map((k) => k.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 15);
    if (dto.seed_accounts !== undefined) {
      const seeds: string[] = [];
      for (const raw of dto.seed_accounts) {
        if (!raw?.trim()) continue;
        const seed = await resolveSeedAccount(raw);
        if (!seed) {
          throw new BadRequestException(
            `Unrecognized account: "${raw}". Paste a profile link or an @handle.`,
          );
        }
        seeds.push(seed);
      }
      payload.seed_accounts = [...new Set(seeds)].slice(0, 5);
    }

    // Social stats
    if (dto.followers_count !== undefined)
      payload.followers_count = dto.followers_count;
    if (dto.following_count !== undefined)
      payload.following_count = dto.following_count;
    if (dto.posts_count !== undefined) payload.posts_count = dto.posts_count;
    if (dto.is_verified !== undefined) payload.is_verified = dto.is_verified;

    // Entity fields
    if (dto.entity_name !== undefined) payload.entity_name = dto.entity_name;
    if (dto.entity_logo_url !== undefined) {
      // The logo picker sends a base64 data URL; keep a real file in storage,
      // not a 200 KB string in the row. If storage is unavailable, keep the data URL.
      payload.entity_logo_url = dto.entity_logo_url?.startsWith('data:')
        ? ((await this.avatarStorage.persistDataUrl(dto.entity_logo_url, `logos/profiles/${userId}`)) ??
          dto.entity_logo_url)
        : dto.entity_logo_url;
    }
    if (dto.country !== undefined) payload.country = dto.country;
    if (dto.website_url !== undefined) payload.website_url = dto.website_url;
    if (dto.niche !== undefined) payload.niche = dto.niche;
    if (dto.target_market !== undefined)
      payload.target_market = dto.target_market;
    if (dto.product_category !== undefined)
      payload.product_category = dto.product_category;
    if (dto.product_subcategory !== undefined)
      payload.product_subcategory = dto.product_subcategory;
    if (dto.languages !== undefined) payload.languages = dto.languages;
    if (dto.timezone !== undefined) payload.timezone = dto.timezone;

    // Onboarding state
    if (dto.onboarding_step !== undefined)
      payload.onboarding_step = dto.onboarding_step;
    if (dto.onboarding_completed === true) payload.onboarding_completed = true;

    const response = await client
      .from('profiles')
      .update(payload)
      .eq('id', userId)
      .select()
      .single();

    if (response.error || !response.data) {
      this.logger.error(
        `Failed to update profile for user ${userId}: ${response.error?.message ?? 'no row'}`,
      );
      throw new Error(response.error?.message ?? 'Profile update failed');
    }

    const updated = response.data as ProfileRow;
    this.logger.log(`Profile updated for user ${userId}`);

    // Auto-create the user's default project and kick off self-scrape (if handles exist)
    // when onboarding finishes. Brands and creators ARE their project; an agency is
    // not: it manages client projects, each created (and scraped, and discovered)
    // from the Clients page, so its onboarding creates nothing.
    const isAgency = (dto.persona ?? updated.persona) === 'agency';
    const shouldBootstrapWorkspace =
      !isAgency && (dto.onboarding_step === 'scraping' || dto.onboarding_completed === true);

    if (shouldBootstrapWorkspace && !this.bootstrappedUsers.has(userId)) {
      this.bootstrappedUsers.add(userId);
      try {
        const { projectId } = await this.scrapingService.triggerOnboardingSelfScrape(
          userId,
          updated,
        );
        await this.maybeTriggerCompetitorDiscovery(projectId, updated);
      } catch (err) {
        this.bootstrappedUsers.delete(userId); // allow a retry on the next PATCH
        this.logger.error(
          `Failed to bootstrap workspace for user ${userId}: ${(err as Error).message}`,
        );
        // Do not throw — profile update succeeded; bootstrap failure is logged but non-fatal
      }
    }

    return updated;
  }

  /**
   * Fires multi-signal competitor discovery for the onboarding project.
   * Guarded on "no competitors yet" so repeat onboarding PATCHes (the
   * scraping step and the final completed=true step both bootstrap) don't
   * relaunch paid Apify runs.
   */
  private async maybeTriggerCompetitorDiscovery(
    projectId: string,
    profile: ProfileRow,
  ): Promise<void> {
    if (!profile.niche && !profile.niche_description) {
      this.logger.warn(
        `Skipping competitor discovery for project ${projectId} — profile has no niche`,
      );
      return;
    }
    if (!profile.niche) profile.niche = profile.niche_description ?? '';

    const client = this.supabaseService.getClient();
    const { count, error } = await client
      .from('competitors')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId);

    if (error) {
      this.logger.error(
        `Failed to count competitors for project ${projectId}: ${error.message}`,
      );
      return;
    }

    if ((count ?? 0) > 0) {
      this.logger.log(
        `Project ${projectId} already has ${count} competitors — skipping discovery`,
      );
      return;
    }

    this.scraperService.discoverCompetitors({
      niche: profile.niche,
      location: profile.country ?? undefined,
      projectId,
      userId: profile.id,
      persona: profile.persona ?? undefined,
      entityName: profile.entity_name ?? profile.full_name ?? undefined,
      instagramHandle: profile.instagram_handle ?? undefined,
      tiktokHandle: profile.tiktok_handle ?? undefined,
      nicheDescription: profile.niche_description ?? undefined,
      keywords: profile.keywords ?? undefined,
      targetMarket: profile.target_market ?? undefined,
      seedAccounts: profile.seed_accounts ?? undefined,
      language: profile.languages?.[0] ?? undefined,
    });
    this.logger.log(
      `Competitor discovery auto-triggered for onboarding project ${projectId}`,
    );
  }
}
