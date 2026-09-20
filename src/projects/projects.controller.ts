import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { ProfileInsightsService } from './profile-insights.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { CreateBrandKitDto } from './dto/create-brand-kit.dto';
import { UpdateCompetitorDto } from './dto/update-competitor.dto';
import { AddCompetitorDto } from './dto/add-competitor.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';
import { ScrapingService } from '../scraping/scraping.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';

@Controller('projects')
@UseGuards(SupabaseAuthGuard)
export class ProjectsController {
  constructor(
    private readonly projectsService: ProjectsService,
    private readonly profileInsightsService: ProfileInsightsService,
    private readonly scrapingService: ScrapingService,
    private readonly embeddingsService: EmbeddingsService,
  ) {}

  @Get()
  async getAllProjects(@CurrentUser() user: AuthUser) {
    const projects = await this.projectsService.findAllByUser(user.id);
    return {
      message: 'Projects retrieved successfully',
      data: projects,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createProject(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateProjectDto,
  ) {
    const project = await this.projectsService.createProject(dto, user.id);
    return {
      message: 'Project created successfully',
      data: project,
    };
  }

  @Get(':id')
  async getProject(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const project = await this.projectsService.getProject(id, user.id);
    return {
      message: 'Project retrieved successfully',
      data: project,
    };
  }

  @Get(':id/brand-kit')
  async getBrandKit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const brandKit = await this.projectsService.getBrandKit(id, user.id);
    return {
      message: 'Brand kit retrieved successfully',
      data: brandKit,
    };
  }

  @Post(':id/brand-kit')
  @HttpCode(HttpStatus.OK)
  async saveBrandKit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateBrandKitDto,
  ) {
    const brandKit = await this.projectsService.saveBrandKit(id, dto, user.id);
    return {
      message: 'Brand kit saved successfully',
      data: brandKit,
    };
  }

  @Get(':id/discovery')
  async getDiscoveryStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const status = await this.projectsService.getDiscoveryStatus(id, user.id);
    return {
      message: 'Discovery status retrieved successfully',
      data: status,
    };
  }

  @Get(':id/insights')
  async getInsights(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh?: string,
  ) {
    const insights = await this.projectsService.getInsights(
      id,
      user.id,
      refresh === 'true',
    );
    return {
      message: 'Insights retrieved successfully',
      data: insights,
    };
  }

  @Get(':id/competitors')
  async getCompetitors(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const competitors = await this.projectsService.getCompetitors(id, user.id);
    return {
      message: 'Competitors retrieved successfully',
      data: competitors,
    };
  }

  @Post(':id/competitors')
  @HttpCode(HttpStatus.CREATED)
  async addCompetitor(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: AddCompetitorDto,
  ) {
    const competitor = await this.projectsService.addCompetitor(id, dto.link, user.id);
    return { message: 'Competitor added successfully', data: competitor };
  }

  @Get(':id/competitors/:competitorId/profile')
  async getCompetitorProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh?: string,
  ) {
    const data = await this.profileInsightsService.getCompetitorProfile(
      id,
      competitorId,
      user.id,
      refresh === 'true',
    );
    return { message: 'Competitor profile retrieved successfully', data };
  }

  @Get(':id/self-profile')
  async getSelfProfile(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Query('refresh') refresh?: string,
  ) {
    const data = await this.profileInsightsService.getSelfProfile(id, user.id, refresh === 'true');
    return { message: 'Profile retrieved successfully', data };
  }

  /** Manual data refresh of the brand's own account (cooldown applies). */
  @Post(':id/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  async refreshProjectData(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const data = await this.scrapingService.refreshSelfData(id, user.id, { manual: true });
    return { message: data.started ? 'Refresh started' : 'Refresh not started', data };
  }

  /** Manual data refresh of one competitor (cooldown applies). */
  @Post(':id/competitors/:competitorId/refresh')
  @HttpCode(HttpStatus.ACCEPTED)
  async refreshCompetitorData(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const data = await this.scrapingService.refreshCompetitorData(id, competitorId, user.id, {
      manual: true,
    });
    return { message: data.started ? 'Refresh started' : 'Refresh not started', data };
  }

  /** Embed every captioned post that has no embedding yet (RAG coverage). */
  @Post(':id/embeddings/backfill')
  async backfillEmbeddings(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    await this.projectsService.getProject(id, user.id);
    const data = await this.embeddingsService.backfillProject(id);
    return { message: 'Embedding backfill complete', data };
  }

  /** Derive the brand kit from the account's own posts (fills empty fields; ?overwrite=true replaces). */
  @Post(':id/brand-kit/autofill')
  async autofillBrandKit(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Query('overwrite') overwrite?: string,
  ) {
    const data = await this.projectsService.autofillBrandKit(id, user.id, overwrite === 'true');
    return { message: 'Brand kit derived from your posts', data };
  }

  @Patch(':id/competitors/:competitorId')
  async updateCompetitor(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('competitorId', ParseUUIDPipe) competitorId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateCompetitorDto,
  ) {
    const competitor = await this.projectsService.updateCompetitor(
      id,
      competitorId,
      dto,
      user.id,
    );
    return {
      message: 'Competitor updated successfully',
      data: competitor,
    };
  }
}
