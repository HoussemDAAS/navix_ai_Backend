import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { json, urlencoded } from 'express';
import { AppModule } from './app.module';

// Background work (scraping, discovery, AI jobs) runs inside this process. A stray
// rejection or a third-party socket error must not take the API down with it:
// log it loudly and keep serving. Jobs that die this way are reconciled by JobsService.
const processLogger = new Logger('Process');
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  processLogger.error(`Unhandled rejection: ${err.message}`, err.stack);
});
process.on('uncaughtException', (err) => {
  processLogger.error(`Uncaught exception (kept running): ${err.message}`, err.stack);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');

  // Base64 logo uploads can be 2-3 MB. Default 100kb body limit rejects them silently.
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ extended: true, limit: '10mb' }));

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:3001',
    ],
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }),
  );

  const port = process.env.PORT ?? 3001;
  await app.listen(port);
  logger.log(`Application listening on port ${port}`);
}
bootstrap();
