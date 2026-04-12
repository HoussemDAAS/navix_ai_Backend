import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private client: SupabaseClient;

  constructor(private readonly configService: ConfigService) {}

  onModuleInit() {
    const supabaseUrl = this.configService.get<string>('SUPABASE_URL');
    // Use service role key to bypass RLS — backend handles auth via SupabaseAuthGuard
    const serviceRoleKey = this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = this.configService.get<string>('SUPABASE_KEY');
    const supabaseKey = serviceRoleKey || anonKey;

    this.logger.log(`Using ${serviceRoleKey ? 'service_role' : 'anon'} key`);

    if (!supabaseUrl || !supabaseKey) {
      this.logger.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is missing in environment variables');
      return;
    }

    this.client = createClient(supabaseUrl, supabaseKey);
    this.logger.log('Supabase client initialized');
  }

  getClient(): SupabaseClient {
    return this.client;
  }
}
