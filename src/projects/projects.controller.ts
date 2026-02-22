import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { CreateBrandKitDto } from './dto/create-brand-kit.dto';

@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createProject(@Body() dto: CreateProjectDto) {
    const project = await this.projectsService.createProject(dto);
    return {
      message: 'Project created successfully',
      data: project,
    };
  }

  @Get(':id')
  async getProject(@Param('id', ParseUUIDPipe) id: string) {
    const project = await this.projectsService.getProject(id);
    return {
      message: 'Project retrieved successfully',
      data: project,
    };
  }

  @Post(':id/brand-kit')
  @HttpCode(HttpStatus.OK)
  async saveBrandKit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateBrandKitDto,
  ) {
    const brandKit = await this.projectsService.saveBrandKit(id, dto);
    return {
      message: 'Brand kit saved successfully',
      data: brandKit,
    };
  }
}
