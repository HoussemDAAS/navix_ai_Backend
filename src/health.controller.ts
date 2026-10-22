import { Controller, Get } from '@nestjs/common';

// Public liveness route: used by the hosting platform and by the keep-alive pinger.
@Controller('health')
export class HealthController {
  @Get()
  check() {
    return { status: 'ok', service: 'navix-api', time: new Date().toISOString() };
  }
}
