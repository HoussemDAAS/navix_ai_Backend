import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { EmbeddingsModule } from '../embeddings/embeddings.module';
import { AiModule } from '../ai/ai.module';
import { SupabaseModule } from '../supabase/supabase.module';

@Module({
  imports: [SupabaseModule, EmbeddingsModule, AiModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
