import {
  Controller,
  Post,
  Body,
  Logger,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { DiscoverCompetitorsDto } from './dto/discover-competitors.dto';
import { ScrapeProfileDto } from './dto/scrape-profile.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { resolveSeedAccount } from '../common/social-links';

@Controller('scraper')
export class ScraperController {
  private readonly logger = new Logger(ScraperController.name);

  constructor(private readonly scraperService: ScraperService) {}

  @Post('discover')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(SupabaseAuthGuard)
  async discover(@Body() dto: DiscoverCompetitorsDto) {
    this.logger.log(
      `Discovery request — niche: ${dto.niche}, location: ${dto.location || 'none'}, project: ${dto.project_id || 'none'}`,
    );

    const seeds = (
      await Promise.all((dto.seed_accounts ?? []).map((s) => resolveSeedAccount(s)))
    ).filter((s): s is string => !!s);

    const result = this.scraperService.discoverCompetitors({
      niche: dto.niche,
      location: dto.location,
      projectId: dto.project_id,
      persona: dto.persona,
      entityName: dto.entity_name,
      instagramHandle: dto.instagram_handle,
      tiktokHandle: dto.tiktok_handle,
      nicheDescription: dto.niche_description,
      keywords: dto.keywords,
      targetMarket: dto.target_market,
      seedAccounts: seeds,
    });

    return {
      message: 'Discovery jobs initiated successfully',
      data: result,
    };
  }

  @Post('profile')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SupabaseAuthGuard)
  async scrapeProfile(@Body() dto: ScrapeProfileDto) {
    this.logger.log(`Profile scrape request — handle: @${dto.handle}, platform: ${dto.platform}`);

    const data = await this.scraperService.scrapeProfile(dto.handle, dto.platform);

    return {
      message: 'Profile scraped successfully',
      data,
    };
  }
}
