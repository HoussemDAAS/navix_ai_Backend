import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AuthUser, CurrentUser } from '../auth/current-user.decorator';

@Controller('projects/:id/embeddings')
@UseGuards(SupabaseAuthGuard)
export class EmbeddingsController {
  private readonly logger = new Logger(EmbeddingsController.name);

  constructor(private readonly embeddingsService: EmbeddingsService) {}

  @Post('reindex')
  @HttpCode(HttpStatus.OK)
  async reindex(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    this.logger.log(`Reindex requested project=${projectId} user=${user.id}`);
    const result = await this.embeddingsService.reindexProject(
      projectId,
      user.id,
    );
    return {
      message: 'Embeddings reindex completed',
      data: result,
    };
  }

  @Get('stats')
  async stats(
    @Param('id', ParseUUIDPipe) projectId: string,
    @CurrentUser() user: AuthUser,
  ) {
    const stats = await this.embeddingsService.getStats(projectId, user.id);
    return {
      message: 'Embedding stats retrieved successfully',
      data: stats,
    };
  }
}
