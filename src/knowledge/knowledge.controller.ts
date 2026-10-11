import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminGuard } from '../auth/admin.guard';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { KnowledgeService, type KnowledgeUpload } from './knowledge.service';
import {
  ArticleDto,
  CreateKnowledgeItemsDto,
  ImportTextDto,
  SearchKnowledgeDto,
  UpdateKnowledgeItemDto,
} from './dto/knowledge.dto';

const MAX_FILE_BYTES = 80 * 1024 * 1024;

/** Admin-only library of hooks, CTAs, frameworks, examples and rules shared by every project. */
@Controller('admin/knowledge')
@UseGuards(SupabaseAuthGuard, AdminGuard)
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  async list(
    @Query('type') type?: string,
    @Query('language') language?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const data = await this.knowledge.list({
      type: type || undefined,
      language: language || undefined,
      status: status || undefined,
      q: q || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
    return { message: 'Knowledge items retrieved', data };
  }

  @Get('stats')
  async stats() {
    return { message: 'Knowledge stats', data: await this.knowledge.stats() };
  }

  @Post('items')
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateKnowledgeItemsDto, @CurrentUser() user: AuthUser) {
    const data = await this.knowledge.createMany(dto.items, { autoTag: dto.auto_tag !== false, createdBy: user.id });
    return { message: `${data.length} item(s) added`, data };
  }

  @Post('import')
  @HttpCode(HttpStatus.CREATED)
  async importText(@Body() dto: ImportTextDto, @CurrentUser() user: AuthUser) {
    const data = await this.knowledge.importText(dto, user.id);
    return { message: `${data.length} item(s) imported`, data };
  }

  /** Multipart: file + the same fields as the text import (defaults as a JSON string). */
  @Post('import/file')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES } }))
  async importFile(
    @Body() body: Record<string, string>,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: KnowledgeUpload,
  ) {
    if (!file) throw new BadRequestException('No file received');
    if (!body.type) throw new BadRequestException('type is required');
    let defaults: Record<string, string> | undefined;
    if (body.defaults) {
      try {
        defaults = JSON.parse(body.defaults) as Record<string, string>;
      } catch {
        throw new BadRequestException('defaults must be a JSON object');
      }
    }
    const data = await this.knowledge.importFile(
      file,
      { type: body.type, split: body.split || undefined, auto_tag: body.auto_tag !== 'false', defaults },
      user.id,
    );
    return { message: `${data.length} item(s) imported from ${file.originalname}`, data };
  }

  @Post('article')
  @HttpCode(HttpStatus.CREATED)
  async article(@Body() dto: ArticleDto, @CurrentUser() user: AuthUser) {
    const data = await this.knowledge.addArticle(dto, user.id);
    return { message: `${data.length} principle(s) extracted`, data };
  }

  /** What the agents would retrieve for a brief: use it to check the library. */
  @Post('search')
  @HttpCode(HttpStatus.OK)
  async search(@Body() dto: SearchKnowledgeDto) {
    return { message: 'Search results', data: await this.knowledge.search(dto) };
  }

  @Patch(':id')
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateKnowledgeItemDto) {
    return { message: 'Knowledge item updated', data: await this.knowledge.update(id, dto as Record<string, unknown>) };
  }

  @Delete(':id')
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    await this.knowledge.remove(id);
    return { message: 'Knowledge item deleted', data: { id } };
  }
}
