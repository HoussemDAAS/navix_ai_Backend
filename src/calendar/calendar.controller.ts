import {
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
  UseGuards,
} from '@nestjs/common';
import { CalendarService } from './calendar.service';
import { CreateCalendarItemDto } from './dto/create-calendar-item.dto';
import { UpdateCalendarItemDto } from './dto/update-calendar-item.dto';
import { ListCalendarQueryDto } from './dto/list-calendar.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('projects/:id/calendar')
@UseGuards(SupabaseAuthGuard)
export class CalendarController {
  constructor(private readonly calendarService: CalendarService) {}

  @Get()
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Query() query: ListCalendarQueryDto,
  ) {
    const items = await this.calendarService.listItems(id, user.id, {
      from: query.from,
      to: query.to,
    });
    return {
      message: 'Calendar items retrieved successfully',
      data: items,
    };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateCalendarItemDto,
  ) {
    const item = await this.calendarService.createItem(id, user.id, dto);
    return {
      message: 'Calendar item created successfully',
      data: item,
    };
  }

  /** Approve → schedule: one draft onto the next best slot (or a given date). */
  @Post('schedule-draft')
  @HttpCode(HttpStatus.CREATED)
  async scheduleDraft(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    const data = await this.calendarService.scheduleDraft(id, user.id, body ?? {});
    return { message: data.already ? 'Already scheduled' : 'Draft scheduled', data };
  }

  /** Every approved, unscheduled draft gets a slot over the coming days, best days first. */
  @Post('plan-week')
  @HttpCode(HttpStatus.CREATED)
  async planWeek(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() body: Record<string, unknown>,
  ) {
    const data = await this.calendarService.planWeek(id, user.id, body ?? {});
    return { message: `${data.items.length} draft(s) scheduled`, data };
  }

  @Patch(':itemId')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateCalendarItemDto,
  ) {
    const item = await this.calendarService.updateItem(
      id,
      itemId,
      user.id,
      dto,
    );
    return {
      message: 'Calendar item updated successfully',
      data: item,
    };
  }

  @Delete(':itemId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    await this.calendarService.deleteItem(id, itemId, user.id);
  }
}
