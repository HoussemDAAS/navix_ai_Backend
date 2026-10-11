import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { isAdminEmail } from './admin';

/**
 * Runs after SupabaseAuthGuard: the signed-in email must be in ADMIN_EMAILS.
 * Use as @UseGuards(SupabaseAuthGuard, AdminGuard).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<Request & { user?: { email?: string } }>();
    if (!isAdminEmail(this.config, request.user?.email)) {
      throw new ForbiddenException('Admin access only');
    }
    return true;
  }
}
