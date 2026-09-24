import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { StudioService, type StudioEvent, type StudioUpload } from './studio.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { AddLinkDto } from './dto/add-link.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

@Controller('projects/:id/studio')
@UseGuards(SupabaseAuthGuard)
export class StudioController {
  constructor(private readonly studioService: StudioService) {}

  @Get('sessions')
  async listSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const data = await this.studioService.listSessions(id, user.id);
    return { message: 'Sessions retrieved', data };
  }

  /** What Navix has learned about this creator across sessions. */
  @Get('memory')
  async getMemory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const data = await this.studioService.getMemory(id, user.id);
    return { message: 'Memory retrieved', data };
  }

  /** The user edits the memory: summary and/or the full list of items. */
  @Patch('memory')
  async updateMemory(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    const data = await this.studioService.updateMemory(id, user.id, body ?? {});
    return { message: 'Memory updated', data };
  }

  /** Learn from the most recent sessions now. */
  @Post('memory/refresh')
  async refreshMemory(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const data = await this.studioService.refreshMemory(id, user.id);
    return { message: 'Memory refreshed', data };
  }

  @Post('sessions')
  @HttpCode(HttpStatus.CREATED)
  async createSession(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateSessionDto,
  ) {
    const data = await this.studioService.createSession(id, user.id, dto);
    return { message: 'Session created', data };
  }

  @Get('sessions/:sessionId/messages')
  async getMessages(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const data = await this.studioService.getMessages(id, sessionId, user.id);
    return { message: 'Messages retrieved', data };
  }

  @Get('sessions/:sessionId/references')
  async listReferences(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const data = await this.studioService.listReferences(id, sessionId, user.id);
    return { message: 'References retrieved', data };
  }

  /** Upload one example (photo, PDF, text, video/audio); answers once it is readable by the agent. */
  @Post('sessions/:sessionId/references')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_UPLOAD_BYTES } }))
  async uploadReference(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
    @UploadedFile() file?: StudioUpload,
  ) {
    if (!file) throw new BadRequestException('No file received');
    const data = await this.studioService.uploadReference(id, sessionId, user.id, file);
    return { message: data.status === 'ready' ? 'Reference ready' : 'Reference could not be read', data };
  }

  /** A public Instagram/TikTok post by link; answers once caption, metrics and transcript are in. */
  @Post('sessions/:sessionId/references/link')
  @HttpCode(HttpStatus.CREATED)
  async addLinkReference(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: AddLinkDto,
  ) {
    const data = await this.studioService.addLinkReference(id, sessionId, user.id, dto.url);
    return { message: data.status === 'ready' ? 'Reference ready' : 'Reference could not be read', data };
  }

  /** One assistant turn, streamed as Server-Sent Events (fetch + ReadableStream on the client). */
  @Post('sessions/:sessionId/messages')
  async sendMessage(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('sessionId', ParseUUIDPipe) sessionId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: SendMessageDto,
    @Res() res: Response,
  ) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const write = (event: StudioEvent) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    try {
      await this.studioService.streamReply(id, sessionId, user.id, dto, write);
    } catch (err) {
      write({ type: 'error', message: (err as Error).message });
    } finally {
      res.end();
    }
  }
}
