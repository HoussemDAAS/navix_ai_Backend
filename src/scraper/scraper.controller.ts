import { Controller, Post, Body, Logger, HttpCode, HttpStatus } from '@nestjs/common';
import { ScraperService } from './scraper.service';
import { DiscoverCompetitorsDto } from './dto/discover-competitors.dto';

@Controller('scraper')
export class ScraperController {
  private readonly logger = new Logger(ScraperController.name);

  constructor(private readonly scraperService: ScraperService) {}

  @Post('discover')
  @HttpCode(HttpStatus.CREATED)
  async discover(@Body() dto: DiscoverCompetitorsDto) {
    this.logger.log(`Received discovery request for niche: ${dto.niche}, location: ${dto.location || 'none'}.`);
    
    // Pass niche and location to the ScraperService
    const result = await this.scraperService.discoverCompetitors(dto.niche, dto.location);
    
    return {
      message: 'Discovery jobs initiated successfully',
      data: result,
    };
  }
}
