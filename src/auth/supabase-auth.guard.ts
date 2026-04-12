import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import { SupabaseService } from '../supabase/supabase.service';

interface SupabaseUser {
  id: string;
  email: string;
  [key: string]: unknown;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);

  constructor(private readonly supabaseService: SupabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) {
      throw new UnauthorizedException('Missing authorization token');
    }

    try {
      const client = this.supabaseService.getClient();
      const { data, error } = await client.auth.getUser(token);

      if (error || !data.user) {
        this.logger.warn(`Invalid token: ${error?.message ?? 'No user returned'}`);
        throw new UnauthorizedException('Invalid or expired token');
      }

      (request as Request & { user: SupabaseUser }).user = {
        id: data.user.id,
        email: data.user.email ?? '',
      };

      return true;
    } catch (err) {
      if (err instanceof UnauthorizedException) {
        throw err;
      }
      this.logger.error(`Auth guard error: ${(err as Error).message}`);
      throw new UnauthorizedException('Authentication failed');
    }
  }

  private extractToken(request: Request): string | null {
    const authHeader = request.headers.authorization;
    if (!authHeader) {
      return null;
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      return null;
    }

    return token;
  }
}
