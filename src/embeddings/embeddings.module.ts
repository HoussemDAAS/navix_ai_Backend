import { Module } from '@nestjs/common';
import { EmbeddingsService } from './embeddings.service';
import { OpenAIService } from './openai.service';
import { EmbeddingsController } from './embeddings.controller';

@Module({
  controllers: [EmbeddingsController],
  providers: [EmbeddingsService, OpenAIService],
  exports: [EmbeddingsService, OpenAIService],
})
export class EmbeddingsModule {}
