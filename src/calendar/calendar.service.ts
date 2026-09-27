import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AnalyticsService, DAY_NAMES } from '../analysis/analytics.service';
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

/** A recommended posting slot and the data behind it. */
interface Slot {
  at: Date;
  reason: string;
}

const PLAN_HORIZON_DAYS = 14;
const DEFAULT_HOUR_UTC = 18;
const PLATFORMS: CalendarPlatform[] = ['instagram', 'tiktok'];

@Injectable()
export class CalendarService {
  private readonly logger = new Logger(CalendarService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly analyticsService: AnalyticsService,
  ) {}

  /* ── Studio hand-off: approve → schedule ─────────────────── */

  /**
   * Put one draft on the calendar. Without a date, the slot is the next best one
   * for this account's field (the weekday and hour where its posts land most),
   * skipping days that already have something planned. Approves a pending draft.
   */
  async scheduleDraft(
    projectId: string,
    userId: string,
    body: { draft_id?: unknown; scheduled_at?: unknown; platform?: unknown },
  ): Promise<{ item: CalendarItemRow; reason: string; already: boolean }> {
    await this.getProjectWithOwnershipCheck(projectId, userId);
    const draftId = typeof body.draft_id === 'string' ? body.draft_id : '';
    if (!draftId) throw new BadRequestException('draft_id is required');
    const draft = await this.loadDraftForProject(draftId, projectId);
    const client = this.supabaseService.getClient();

    const { data: existing } = await client
      .from('calendar_items')
      .select('*')
      .eq('project_id', projectId)
      .eq('draft_id', draftId)
      .neq('status', 'cancelled')
      .order('scheduled_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existing) {
      return { item: existing as CalendarItemRow, reason: 'Already on your calendar.', already: true };
    }

    let slot: Slot;
    if (typeof body.scheduled_at === 'string' && body.scheduled_at) {
      slot = { at: this.parseIsoDate(body.scheduled_at, 'scheduled_at'), reason: 'Scheduled at the time you picked.' };
    } else {
      const taken = await this.plannedDays(projectId);
      const [best] = await this.bestSlots(projectId, userId, 1, taken);
      slot = best;
    }

    const platform = this.resolvePlatform(body.platform, await this.defaultPlatform(projectId));
    const { data, error } = await client
      .from('calendar_items')
      .insert({
        project_id: projectId,
        draft_id: draftId,
        title: draft.title,
        scheduled_at: slot.at.toISOString(),
        platform,
        notes: slot.reason,
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(`Failed to schedule the draft: ${error?.message ?? 'unknown'}`);

    if (draft.status === 'PENDING') {
      await client.from('drafts').update({ status: 'APPROVED' }).eq('id', draftId);
    }
    this.logger.log(`Draft ${draftId} scheduled for ${slot.at.toISOString()} (project ${projectId})`);
    return { item: data as CalendarItemRow, reason: slot.reason, already: false };
  }

  /**
   * Plan the coming days: every approved draft that is not on the calendar yet
   * gets the next best slot, one per day, best days first.
   */
  async planWeek(
    projectId: string,
    userId: string,
    body: { draft_ids?: unknown },
  ): Promise<{ items: CalendarItemRow[]; reasons: string[]; skipped: number }> {
    await this.getProjectWithOwnershipCheck(projectId, userId);
    const client = this.supabaseService.getClient();

    const wanted = Array.isArray(body.draft_ids)
      ? body.draft_ids.filter((d): d is string => typeof d === 'string')
      : null;
    const { data: rows } = await client
      .from('drafts')
      .select(
        'id, status, caption_text, created_at, content_directions!inner(title_pillar, brief_id, analysis_briefs!inner(project_id))',
      )
      .eq('content_directions.analysis_briefs.project_id', projectId)
      .eq('status', 'APPROVED')
      .order('created_at', { ascending: true })
      .limit(30);
    const { data: planned } = await client
      .from('calendar_items')
      .select('draft_id, scheduled_at')
      .eq('project_id', projectId)
      .neq('status', 'cancelled');
    const alreadyScheduled = new Set(
      ((planned ?? []) as Array<{ draft_id: string | null }>).map((p) => p.draft_id).filter(Boolean),
    );

    const candidates = ((rows ?? []) as Array<Record<string, unknown>>)
      .filter((r) => !alreadyScheduled.has(r.id as string))
      .filter((r) => (wanted ? wanted.includes(r.id as string) : true));
    if (candidates.length === 0) return { items: [], reasons: [], skipped: 0 };

    const taken = new Set(
      ((planned ?? []) as Array<{ scheduled_at: string }>).map((p) => p.scheduled_at.slice(0, 10)),
    );
    const slots = await this.bestSlots(projectId, userId, candidates.length, taken);
    const platform = await this.defaultPlatform(projectId);

    const items: CalendarItemRow[] = [];
    const reasons: string[] = [];
    for (let i = 0; i < candidates.length && i < slots.length; i++) {
      const r = candidates[i];
      const title = this.titleFor(r);
      const { data, error } = await client
        .from('calendar_items')
        .insert({
          project_id: projectId,
          draft_id: r.id as string,
          title,
          scheduled_at: slots[i].at.toISOString(),
          platform,
          notes: slots[i].reason,
        })
        .select('*')
        .single();
      if (error || !data) {
        this.logger.warn(`Plan week: draft ${String(r.id)} not scheduled: ${error?.message ?? 'unknown'}`);
        continue;
      }
      items.push(data as CalendarItemRow);
      reasons.push(slots[i].reason);
    }
    return { items, reasons, skipped: candidates.length - items.length };
  }

  /** Days (YYYY-MM-DD, UTC) that already hold a planned item. */
  private async plannedDays(projectId: string): Promise<Set<string>> {
    const { data } = await this.supabaseService
      .getClient()
      .from('calendar_items')
      .select('scheduled_at')
      .eq('project_id', projectId)
      .eq('status', 'planned')
      .gte('scheduled_at', new Date().toISOString());
    return new Set(((data ?? []) as Array<{ scheduled_at: string }>).map((p) => p.scheduled_at.slice(0, 10)));
  }

  /**
   * The next `count` posting slots, best weekday first, one per day, at the hour
   * the field posts most (UTC, like the analytics). Falls back to Tue/Thu/Sat 18:00
   * when there is no field data yet.
   */
  private async bestSlots(projectId: string, userId: string, count: number, taken: Set<string>): Promise<Slot[]> {
    const analytics = await this.analyticsService.getFieldAnalytics(projectId, userId).catch(() => null);
    const dayCounts = new Map<number, number>();
    for (const d of analytics?.field.posting_days ?? []) {
      const idx = DAY_NAMES.indexOf(d.day);
      if (idx >= 0) dayCounts.set(idx, d.count);
    }
    const hours = [...(analytics?.field.posting_hours ?? [])].sort((a, b) => b.count - a.count);
    const bestHour = hours[0]?.hour ?? DEFAULT_HOUR_UTC;
    const hasData = dayCounts.size > 0;
    if (!hasData) for (const idx of [2, 4, 6]) dayCounts.set(idx, 1);

    const now = new Date();
    const candidates: Array<{ at: Date; score: number }> = [];
    for (let offset = 0; offset < PLAN_HORIZON_DAYS; offset++) {
      const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offset, bestHour, 0, 0));
      if (at.getTime() <= now.getTime()) continue;
      if (taken.has(at.toISOString().slice(0, 10))) continue;
      const score = dayCounts.get(at.getUTCDay()) ?? 0;
      candidates.push({ at, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.at.getTime() - b.at.getTime());
    const picked = candidates.slice(0, Math.max(1, count)).sort((a, b) => a.at.getTime() - b.at.getTime());

    const LONG_DAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return picked.map(({ at, score }) => {
      const day = LONG_DAY[at.getUTCDay()];
      const hour = `${String(bestHour).padStart(2, '0')}:00 UTC`;
      const reason = hasData
        ? `${day}s around ${hour} are when your field posts most (${score} of their posts) — good odds your audience is there too.`
        : `No field data yet, so ${day} at ${hour} is a sensible default — refine it once competitors are scraped.`;
      return { at, reason };
    });
  }

  private async loadDraftForProject(draftId: string, projectId: string): Promise<{ status: string; title: string }> {
    const { data } = await this.supabaseService
      .getClient()
      .from('drafts')
      .select('id, status, caption_text, content_directions!inner(title_pillar, brief_id, analysis_briefs!inner(project_id))')
      .eq('id', draftId)
      .eq('content_directions.analysis_briefs.project_id', projectId)
      .maybeSingle();
    if (!data) throw new NotFoundException('Draft not found in this project');
    const r = data as Record<string, unknown>;
    return { status: String(r.status ?? 'PENDING'), title: this.titleFor(r) };
  }

  private titleFor(r: Record<string, unknown>): string {
    const joined = r.content_directions as { title_pillar?: string } | Array<{ title_pillar?: string }> | null;
    const direction = Array.isArray(joined) ? joined[0] : joined;
    const fromDirection = direction?.title_pillar?.trim();
    if (fromDirection) return fromDirection.slice(0, 255);
    const caption = String(r.caption_text ?? '').split('\n').find((l) => l.trim()) ?? 'Post';
    return caption.trim().slice(0, 80);
  }

  private async defaultPlatform(projectId: string): Promise<CalendarPlatform> {
    const { data } = await this.supabaseService
      .getClient()
      .from('projects')
      .select('instagram_handle, tiktok_handle')
      .eq('id', projectId)
      .maybeSingle();
    const p = (data ?? null) as { instagram_handle: string | null; tiktok_handle: string | null } | null;
    return p?.instagram_handle ? 'instagram' : p?.tiktok_handle ? 'tiktok' : 'instagram';
  }

  private resolvePlatform(value: unknown, fallback: CalendarPlatform): CalendarPlatform {
    return typeof value === 'string' && (PLATFORMS as string[]).includes(value) ? (value as CalendarPlatform) : fallback;
  }

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
