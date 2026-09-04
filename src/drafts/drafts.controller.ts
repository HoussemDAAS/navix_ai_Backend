import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { DraftsService } from './drafts.service';
import { GenerateDraftsDto } from './dto/generate-drafts.dto';
import { UpdateDraftDto } from './dto/update-draft.dto';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('projects/:id/drafts')
@UseGuards(SupabaseAuthGuard)
export class DraftsController {
  constructor(private readonly draftsService: DraftsService) {}

  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  async generate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: GenerateDraftsDto,
  ) {
    const job = await this.draftsService.generateDrafts(
      id,
      user.id,
      dto.directionIds,
    );
    return {
      message: 'Draft generation started',
      data: { jobId: job.id },
    };
  }

  @Get()
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const drafts = await this.draftsService.getDrafts(id, user.id);
    return {
      message: 'Drafts retrieved successfully',
      data: drafts,
    };
  }

  @Patch(':draftId')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateDraftDto,
  ) {
    const draft = await this.draftsService.updateDraft(
      id,
      draftId,
      user.id,
      dto,
    );
    return {
      message: 'Draft updated successfully',
      data: draft,
    };
  }

  @Post(':draftId/feedback')
  @HttpCode(HttpStatus.CREATED)
  async feedback(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('draftId', ParseUUIDPipe) draftId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateFeedbackDto,
  ) {
    const feedback = await this.draftsService.addFeedback(
      id,
      draftId,
      user.id,
      dto,
    );
    return {
      message: 'Feedback recorded successfully',
      data: feedback,
    };
  }
}
