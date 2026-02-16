import { Body, Controller, Post } from '@nestjs/common';
import { ScraperService } from './scraper.service';

// 1. @Controller('scraper') means all routes in this file start with /scraper
@Controller('scraper')
export class ScraperController {
  
  // Dependency Injection: NestJS automatically gives us the ScraperService
  constructor(private readonly scraperService: ScraperService) {}

  // 2. @Post('discover') creates a POST endpoint at /scraper/discover
  @Post('discover')
  async discoverCompetitors(@Body() body: { niche: string; location: string }) {
    // 3. We extract niche and location from the request body
    const { niche, location } = body;
    
    // 4. We delegate the "heavy lifting" to the Service
    return this.scraperService.searchCompetitors(niche, location);
  }
}
