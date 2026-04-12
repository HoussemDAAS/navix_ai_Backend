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
  UseGuards,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { CreateBrandKitDto } from './dto/create-brand-kit.dto';
import { UpdateCompetitorDto } from './dto/update-competitor.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('projects')
@UseGuards(SupabaseAuthGuard)
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

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
