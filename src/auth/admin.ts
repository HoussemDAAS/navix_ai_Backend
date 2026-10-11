import { ConfigService } from '@nestjs/config';

/** Emails allowed into the admin area, from ADMIN_EMAILS="a@x.com,b@y.com". */
export function adminEmails(config: ConfigService): Set<string> {
  return new Set(
    (config.get<string>('ADMIN_EMAILS') ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isAdminEmail(config: ConfigService, email?: string | null): boolean {
  return !!email && adminEmails(config).has(email.trim().toLowerCase());
}
