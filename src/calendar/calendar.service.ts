import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import {
  CalendarPlatform,
  CreateCalendarItemDto,
} from './dto/create-calendar-item.dto';
import {
  CalendarStatus,
  UpdateCalendarItemDto,
} from './dto/update-calendar-item.dto';

export interface CalendarItemRow {
  id: string;
  project_id: string;
  draft_id: string | null;
  title: string;
  scheduled_at: string;
  platform: CalendarPlatform;
  status: CalendarStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async listItems(
    projectId: string,
    userId: string,
    range: { from?: string; to?: string },
  ): Promise<CalendarItemRow[]> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    const { from, to } = this.resolveRange(range);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('calendar_items')
      .select('*')
      .eq('project_id', projectId)
      .gte('scheduled_at', from)
      .lte('scheduled_at', to)
      .order('scheduled_at', { ascending: true });

    if (error) {
      this.logger.error(
        `Failed to fetch calendar items for project ${projectId}: ${error.message}`,
      );
      throw new Error(`Failed to fetch calendar items: ${error.message}`);
    }

    return (data ?? []) as CalendarItemRow[];
  }

  async createItem(
    projectId: string,
    userId: string,
    dto: CreateCalendarItemDto,
  ): Promise<CalendarItemRow> {
    await this.getProjectWithOwnershipCheck(projectId, userId);

    // If a draftId is supplied, validate it belongs to this project
    if (dto.draftId) {
      await this.ensureDraftBelongsToProject(dto.draftId, projectId);
    }

    const scheduledAt = this.parseIsoDate(dto.scheduledAt, 'scheduledAt');

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('calendar_items')
      .insert({
        project_id: projectId,
        draft_id: dto.draftId ?? null,
        title: dto.title,
        scheduled_at: scheduledAt.toISOString(),
        platform: dto.platform,
        notes: dto.notes ?? null,
      })
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(
        `Failed to create calendar item for project ${projectId}: ${error?.message ?? 'unknown'}`,
      );
      throw new Error(
        `Failed to create calendar item: ${error?.message ?? 'unknown'}`,
      );
    }

    this.logger.log(
      `Calendar item created: ${(data as CalendarItemRow).id} project=${projectId}`,
    );
    return data as CalendarItemRow;
  }

  async updateItem(
    projectId: string,
    itemId: string,
    userId: string,
    dto: UpdateCalendarItemDto,
  ): Promise<CalendarItemRow> {
    await this.getProjectWithOwnershipCheck(projectId, userId);
    await this.ensureItemBelongsToProject(itemId, projectId);

    if (
      dto.scheduledAt === undefined &&
      dto.status === undefined &&
      dto.notes === undefined
    ) {
      throw new BadRequestException('No fields to update');
    }

    const update: Record<string, unknown> = {};
    if (dto.scheduledAt !== undefined) {
      update.scheduled_at = this.parseIsoDate(
        dto.scheduledAt,
        'scheduledAt',
      ).toISOString();
    }
    if (dto.status !== undefined) update.status = dto.status;
    if (dto.notes !== undefined) update.notes = dto.notes;

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('calendar_items')
      .update(update)
      .eq('id', itemId)
      .select('*')
      .single();

    if (error || !data) {
      this.logger.error(
        `Failed to update calendar item ${itemId}: ${error?.message ?? 'unknown'}`,
      );
      throw new Error(
        `Failed to update calendar item: ${error?.message ?? 'unknown'}`,
      );
    }

    return data as CalendarItemRow;
  }

  async deleteItem(
    projectId: string,
    itemId: string,
    userId: string,
  ): Promise<void> {
    await this.getProjectWithOwnershipCheck(projectId, userId);
    await this.ensureItemBelongsToProject(itemId, projectId);

    const client = this.supabaseService.getClient();
    const { error } = await client
      .from('calendar_items')
      .delete()
      .eq('id', itemId);

    if (error) {
      this.logger.error(
        `Failed to delete calendar item ${itemId}: ${error.message}`,
      );
      throw new Error(`Failed to delete calendar item: ${error.message}`);
    }

    this.logger.log(`Calendar item deleted: ${itemId} project=${projectId}`);
  }

  private resolveRange(range: { from?: string; to?: string }): {
    from: string;
    to: string;
  } {
    if (range.from && range.to) {
      const fromDate = this.parseIsoDate(range.from, 'from');
      const toDate = this.parseIsoDate(range.to, 'to');
      if (fromDate > toDate) {
        throw new BadRequestException('`from` must be earlier than `to`');
      }
      return { from: fromDate.toISOString(), to: toDate.toISOString() };
    }

    // Default: current month [first day 00:00:00, last day 23:59:59]
    const now = new Date();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
    );
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999),
    );
    return { from: start.toISOString(), to: end.toISOString() };
  }

  private parseIsoDate(value: string, field: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(`Invalid ISO date for ${field}`);
    }
    return d;
  }

  private async ensureDraftBelongsToProject(
    draftId: string,
    projectId: string,
  ): Promise<void> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('drafts')
      .select(
        'id, content_directions!inner(brief_id, analysis_briefs!inner(project_id))',
      )
      .eq('id', draftId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Draft ${draftId} not found`);
    }

    const row = data as unknown as {
      content_directions: {
        analysis_briefs: { project_id: string } | { project_id: string }[];
      };
    };
    const ab = row.content_directions?.analysis_briefs;
    const ownerProjectId = Array.isArray(ab)
      ? ab[0]?.project_id
      : ab?.project_id;
    if (ownerProjectId !== projectId) {
      throw new ForbiddenException('Draft does not belong to this project');
    }
  }

  private async ensureItemBelongsToProject(
    itemId: string,
    projectId: string,
  ): Promise<void> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('calendar_items')
      .select('id, project_id')
      .eq('id', itemId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Calendar item ${itemId} not found`);
    }
    if ((data as { project_id: string }).project_id !== projectId) {
      throw new ForbiddenException(
        'Calendar item does not belong to this project',
      );
    }
  }

  private async getProjectWithOwnershipCheck(
    projectId: string,
    userId: string,
  ): Promise<Record<string, unknown>> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }

    if ((data as Record<string, unknown>).user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }

    return data as Record<string, unknown>;
  }
}
