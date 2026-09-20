import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { StudioService, type StudioEvent } from './studio.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SendMessageDto } from './dto/send-message.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('projects/:id/studio')
@UseGuards(SupabaseAuthGuard)
export class StudioController {
  constructor(private readonly studioService: StudioService) {}

  @Get('sessions')
  async listSessions(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: AuthUser) {
    const data = await this.studioService.listSessions(id, user.id);
    return { message: 'Sessions retrieved', data };
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
