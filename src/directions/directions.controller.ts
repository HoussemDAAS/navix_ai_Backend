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
import { DirectionsService } from './directions.service';
import { GenerateDirectionsDto } from './dto/generate-directions.dto';
import { UpdateDirectionDto } from './dto/update-direction.dto';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CurrentUser, AuthUser } from '../auth/current-user.decorator';

@Controller('projects/:id/directions')
@UseGuards(SupabaseAuthGuard)
export class DirectionsController {
  constructor(private readonly directionsService: DirectionsService) {}

  @Post('generate')
  @HttpCode(HttpStatus.ACCEPTED)
  async generate(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: GenerateDirectionsDto,
  ) {
    const job = await this.directionsService.generateDirections(id, user.id, {
      briefId: dto.briefId,
      numDirections: dto.numDirections,
    });
    return {
      message: 'Direction generation started',
      data: { jobId: job.id },
    };
  }

  @Get()
  async list(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthUser,
  ) {
    const directions = await this.directionsService.getDirections(id, user.id);
    return {
      message: 'Directions retrieved successfully',
      data: directions,
    };
  }

  @Patch(':directionId')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('directionId', ParseUUIDPipe) directionId: string,
    @CurrentUser() user: AuthUser,
    @Body() dto: UpdateDirectionDto,
  ) {
    const direction = await this.directionsService.updateDirection(
      id,
      directionId,
      user.id,
      dto,
    );
    return {
      message: 'Direction updated successfully',
      data: direction,
    };
  }
}
