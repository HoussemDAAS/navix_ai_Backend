import {
  Injectable,
  Logger,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { OpenAIService } from './openai.service';

export type EmbeddingSourceType =
  | 'self_post'
  | 'competitor_post'
  | 'brand_kit'
  | 'feedback'
  | 'analysis_brief'
  | 'direction'
  | 'draft';

interface ScrapedContentRow {
  id: string;
  project_id: string;
  source_type: 'self' | 'competitor';
  platform: string;
  caption: string | null;
  hashtags: string[] | null;
  mentions: string[] | null;
  content_type: string | null;
  competitor_id: string | null;
  /** What the post says (video transcript) and shows (vision description), when read */
  transcript?: string | null;
  visual_summary?: string | null;
}

interface EmbeddingInsert {
  project_id: string;
  source_type: EmbeddingSourceType;
  source_id: string | null;
  scraped_content_id: string | null;
  chunk_index: number;
  chunk_text: string;
  token_count: number;
  embedding: number[];
  metadata: Record<string, unknown>;
}

export interface EmbeddingStatsRow {
  source_type: EmbeddingSourceType;
  count: number;
}

const MAX_CHUNK_CHARS = 2000; // ~500 tokens at 4 chars/token
const APPROX_CHARS_PER_TOKEN = 4;

@Injectable()
export class EmbeddingsService {
  private readonly logger = new Logger(EmbeddingsService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly openai: OpenAIService,
  ) {}

  /**
   * Embed a single scraped_content row: chunk → embed → insert.
   * Idempotent: deletes existing embeddings for this scraped_content_id first.
   */
  async embedScrapedContent(scrapedContentId: string): Promise<number> {
    const client = this.supabaseService.getClient();
    const { data: row, error } = await client
      .from('scraped_content')
      .select(
        'id, project_id, source_type, platform, caption, hashtags, mentions, content_type, competitor_id, transcript, visual_summary',
      )
      .eq('id', scrapedContentId)
      .single();

    if (error || !row) {
      this.logger.warn(
        `embedScrapedContent: row ${scrapedContentId} not found`,
      );
      return 0;
    }

    const scraped = row as ScrapedContentRow;
    const text = this.buildTextFromScrapedContent(scraped);
    if (!text.trim()) {
      this.logger.debug(`Skipping ${scrapedContentId}: empty text`);
      return 0;
    }

    // Clean up old embeddings for this content (idempotent)
    await client
      .from('embeddings')
      .delete()
      .eq('scraped_content_id', scrapedContentId);

    const chunks = this.chunkText(text, MAX_CHUNK_CHARS);
    const embeddings = await this.openai.embedBatch(chunks);

    const sourceType: EmbeddingSourceType =
      scraped.source_type === 'self' ? 'self_post' : 'competitor_post';

    const rows: EmbeddingInsert[] = chunks.map((chunk, idx) => ({
      project_id: scraped.project_id,
      source_type: sourceType,
      source_id: scraped.competitor_id,
      scraped_content_id: scraped.id,
      chunk_index: idx,
      chunk_text: chunk,
      token_count: Math.ceil(chunk.length / APPROX_CHARS_PER_TOKEN),
      embedding: embeddings[idx],
      metadata: {
        platform: scraped.platform,
        content_type: scraped.content_type,
        hashtags: scraped.hashtags ?? [],
      },
    }));

    const { error: insertError } = await client.from('embeddings').insert(rows);
    if (insertError) {
      throw new Error(`Failed to insert embeddings: ${insertError.message}`);
    }

    this.logger.log(
      `Embedded scraped_content=${scrapedContentId} as ${chunks.length} chunks (${sourceType})`,
    );
    return chunks.length;
  }

  /**
   * Embed many scraped_content rows. Returns total chunk count.
   */
  async embedScrapedContentBatch(scrapedContentIds: string[]): Promise<number> {
    let total = 0;
    for (const id of scrapedContentIds) {
      try {
        total += await this.embedScrapedContent(id);
      } catch (err) {
        this.logger.error(
          `Failed to embed scraped_content=${id}: ${(err as Error).message}`,
        );
      }
    }
    return total;
  }

  /**
   * Embed a brand kit document. Useful for grounding the agent in user's brand voice.
   */
  /**
   * Embed every captioned post of a project that has no embedding yet, so RAG
   * retrieval sees the whole corpus. Cheap when nothing is missing; run by the
   * data-refresh sweep and on demand.
   */
  async backfillProject(projectId: string): Promise<{ missing: number; chunks: number }> {
    const client = this.supabaseService.getClient();
    const [{ data: posts, error: postsErr }, { data: done, error: doneErr }] = await Promise.all([
      client
        .from('scraped_content')
        .select('id, caption, transcript, visual_summary')
        .eq('project_id', projectId)
        .limit(5000),
      client
        .from('embeddings')
        .select('scraped_content_id')
        .eq('project_id', projectId)
        .not('scraped_content_id', 'is', null)
        .limit(5000),
    ]);
    if (postsErr) throw new Error(`Failed to list posts for backfill: ${postsErr.message}`);
    if (doneErr) throw new Error(`Failed to list embeddings for backfill: ${doneErr.message}`);

    const embedded = new Set(
      ((done ?? []) as Array<{ scraped_content_id: string }>).map((r) => r.scraped_content_id),
    );
    const missing = (
      (posts ?? []) as Array<{
        id: string;
        caption: string | null;
        transcript: string | null;
        visual_summary: string | null;
      }>
    )
      .filter(
        (p) =>
          ((p.caption ?? '') + (p.transcript ?? '') + (p.visual_summary ?? '')).trim().length > 0 &&
          !embedded.has(p.id),
      )
      .map((p) => p.id);

    if (missing.length === 0) return { missing: 0, chunks: 0 };
    this.logger.log(`Backfilling embeddings for ${missing.length} posts in project ${projectId}`);
    const chunks = await this.embedScrapedContentBatch(missing);
    return { missing: missing.length, chunks };
  }

  /** Embed a Studio reference (transcript, PDF text, image description) for retrieval. */
  async embedReference(referenceId: string): Promise<number> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('references')
      .select('id, project_id, kind, title, extracted_text, summary')
      .eq('id', referenceId)
      .single();
    if (error || !data) throw new Error(`Reference ${referenceId} not found`);
    const ref = data as {
      id: string;
      project_id: string;
      kind: string;
      title: string;
      extracted_text: string | null;
      summary: string | null;
    };
    const text = [ref.title, ref.summary, ref.extracted_text].filter(Boolean).join('\n\n').trim();
    if (!text) return 0;

    await client.from('embeddings').delete().eq('source_type', 'reference').eq('source_id', ref.id);

    const chunks = this.chunkText(text, MAX_CHUNK_CHARS).slice(0, 40);
    const embeddings = await this.openai.embedBatch(chunks);
    const rows = chunks.map((chunk, idx) => ({
      project_id: ref.project_id,
      source_type: 'reference',
      source_id: ref.id,
      scraped_content_id: null,
      chunk_index: idx,
      chunk_text: chunk,
      token_count: Math.ceil(chunk.length / APPROX_CHARS_PER_TOKEN),
      embedding: embeddings[idx],
      metadata: { kind: ref.kind, title: ref.title },
    }));
    const { error: insertError } = await client.from('embeddings').insert(rows);
    if (insertError) throw new Error(`Failed to insert reference embeddings: ${insertError.message}`);
    return chunks.length;
  }

  async embedBrandKit(
    projectId: string,
    brandKit: Record<string, unknown>,
  ): Promise<number> {
    const client = this.supabaseService.getClient();
    const parts: string[] = [];
    const fields = [
      'tone_of_voice',
      'formality_level',
      'vocab_exclude',
      'objective',
      'target_audience',
      'constraints',
      'preferred_cta',
    ];

    for (const field of fields) {
      const value = brandKit[field];
      if (Array.isArray(value)) {
        parts.push(`${field}: ${value.join(', ')}`);
      } else if (typeof value === 'string' && value.trim()) {
        parts.push(`${field}: ${value}`);
      } else if (typeof value === 'number' || typeof value === 'boolean') {
        parts.push(`${field}: ${String(value)}`);
      }
    }

    const text = parts.join('\n');
    if (!text.trim()) {
      this.logger.debug(
        `Skipping brand_kit embedding for project ${projectId}: empty content`,
      );
      return 0;
    }

    // Idempotent: clear previous brand_kit embeddings for this project
    await client
      .from('embeddings')
      .delete()
      .eq('project_id', projectId)
      .eq('source_type', 'brand_kit');

    const chunks = this.chunkText(text, MAX_CHUNK_CHARS);
    const embeddings = await this.openai.embedBatch(chunks);

    const rows: EmbeddingInsert[] = chunks.map((chunk, idx) => ({
      project_id: projectId,
      source_type: 'brand_kit',
      source_id: (brandKit.id as string) ?? null,
      scraped_content_id: null,
      chunk_index: idx,
      chunk_text: chunk,
      token_count: Math.ceil(chunk.length / APPROX_CHARS_PER_TOKEN),
      embedding: embeddings[idx],
      metadata: {},
    }));

    const { error } = await client.from('embeddings').insert(rows);
    if (error) {
      throw new Error(
        `Failed to insert brand_kit embeddings: ${error.message}`,
      );
    }

    this.logger.log(
      `Embedded brand_kit for project=${projectId} (${chunks.length} chunks)`,
    );
    return chunks.length;
  }

  /**
   * Embed an approved draft so future generations can learn from it.
   */
  async embedDraft(draftId: string): Promise<number> {
    const client = this.supabaseService.getClient();

    const { data, error } = await client
      .from('drafts')
      .select(
        'id, direction_id, caption_text, video_script, content_directions(brief_id, analysis_briefs(project_id))',
      )
      .eq('id', draftId)
      .single();

    if (error || !data) {
      this.logger.warn(`embedDraft: draft ${draftId} not found`);
      return 0;
    }

    const draft = data as unknown as {
      id: string;
      caption_text: string | null;
      video_script: string | null;
      content_directions?:
        | {
            brief_id: string;
            analysis_briefs?:
              | { project_id: string }
              | { project_id: string }[]
              | null;
          }
        | {
            brief_id: string;
            analysis_briefs?:
              | { project_id: string }
              | { project_id: string }[]
              | null;
          }[]
        | null;
    };

    // Supabase returns joined rows as arrays or objects depending on relationship cardinality.
    const direction = Array.isArray(draft.content_directions)
      ? draft.content_directions[0]
      : draft.content_directions;
    const brief = direction?.analysis_briefs;
    const briefRow = Array.isArray(brief) ? brief[0] : brief;
    const projectId = briefRow?.project_id;

    if (!projectId) {
      this.logger.warn(
        `embedDraft: cannot resolve project_id for draft ${draftId}`,
      );
      return 0;
    }

    const text = [draft.caption_text, draft.video_script]
      .filter(Boolean)
      .join('\n');
    if (!text.trim()) return 0;

    // Idempotent: replace previous embeddings for this draft
    await client
      .from('embeddings')
      .delete()
      .eq('source_type', 'draft')
      .eq('source_id', draftId);

    const chunks = this.chunkText(text, MAX_CHUNK_CHARS);
    const embeddings = await this.openai.embedBatch(chunks);

    const rows: EmbeddingInsert[] = chunks.map((chunk, idx) => ({
      project_id: projectId,
      source_type: 'draft',
      source_id: draftId,
      scraped_content_id: null,
      chunk_index: idx,
      chunk_text: chunk,
      token_count: Math.ceil(chunk.length / APPROX_CHARS_PER_TOKEN),
      embedding: embeddings[idx],
      metadata: {},
    }));

    const { error: insertError } = await client.from('embeddings').insert(rows);
    if (insertError) {
      throw new Error(
        `Failed to insert draft embeddings: ${insertError.message}`,
      );
    }

    this.logger.log(`Embedded draft=${draftId} (${chunks.length} chunks)`);
    return chunks.length;
  }

  /**
   * Reindex everything for a project: scraped_content, brand_kit, drafts.
   */
  async reindexProject(
    projectId: string,
    userId: string,
  ): Promise<{
    scraped: number;
    brand_kit: number;
    drafts: number;
  }> {
    await this.assertOwnership(projectId, userId);

    const client = this.supabaseService.getClient();

    // Wipe all embeddings for this project
    await client.from('embeddings').delete().eq('project_id', projectId);

    // Re-embed scraped_content
    const scrapedResponse = await client
      .from('scraped_content')
      .select('id')
      .eq('project_id', projectId);

    const scrapedIds = (
      (scrapedResponse.data ?? []) as Array<{ id: string }>
    ).map((r) => r.id);
    const scrapedChunks = await this.embedScrapedContentBatch(scrapedIds);

    // Re-embed brand kit
    const brandKitResponse = await client
      .from('brand_kits')
      .select('*')
      .eq('project_id', projectId)
      .maybeSingle();

    let brandKitChunks = 0;
    if (brandKitResponse.data) {
      brandKitChunks = await this.embedBrandKit(
        projectId,
        brandKitResponse.data as Record<string, unknown>,
      );
    }

    // Re-embed approved drafts (joining via direction → brief → project)
    const draftsResponse = await client
      .from('drafts')
      .select(
        'id, status, content_directions!inner(brief_id, analysis_briefs!inner(project_id))',
      )
      .eq('content_directions.analysis_briefs.project_id', projectId)
      .eq('status', 'APPROVED');

    let draftChunks = 0;
    for (const d of (draftsResponse.data ?? []) as Array<{ id: string }>) {
      try {
        draftChunks += await this.embedDraft(d.id);
      } catch (err) {
        this.logger.error(
          `Reindex draft ${d.id} failed: ${(err as Error).message}`,
        );
      }
    }

    this.logger.log(
      `Reindexed project=${projectId}: scraped=${scrapedChunks}, brand_kit=${brandKitChunks}, drafts=${draftChunks}`,
    );

    return {
      scraped: scrapedChunks,
      brand_kit: brandKitChunks,
      drafts: draftChunks,
    };
  }

  /**
   * Aggregate embedding counts by source_type for a project.
   */
  async getStats(
    projectId: string,
    userId: string,
  ): Promise<EmbeddingStatsRow[]> {
    await this.assertOwnership(projectId, userId);

    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('embeddings')
      .select('source_type')
      .eq('project_id', projectId);

    if (error) {
      throw new Error(`Failed to fetch embedding stats: ${error.message}`);
    }

    const counts = new Map<EmbeddingSourceType, number>();
    for (const row of (data ?? []) as Array<{
      source_type: EmbeddingSourceType;
    }>) {
      counts.set(row.source_type, (counts.get(row.source_type) ?? 0) + 1);
    }

    return [...counts.entries()].map(([source_type, count]) => ({
      source_type,
      count,
    }));
  }

  private buildTextFromScrapedContent(row: ScrapedContentRow): string {
    const parts: string[] = [];
    if (row.caption) parts.push(row.caption);
    if (row.transcript) parts.push(`Spoken in the video: ${row.transcript}`);
    if (row.visual_summary) parts.push(`Visual: ${row.visual_summary}`);
    if (row.hashtags && row.hashtags.length > 0) {
      parts.push(`Hashtags: ${row.hashtags.map((h) => `#${h}`).join(' ')}`);
    }
    if (row.mentions && row.mentions.length > 0) {
      parts.push(`Mentions: ${row.mentions.map((m) => `@${m}`).join(' ')}`);
    }
    return parts.join('\n');
  }

  /**
   * Simple character-based chunker. Splits on paragraph/sentence boundaries when possible.
   */
  private chunkText(text: string, maxChars: number): string[] {
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > maxChars) {
      // Try to break at a sensible boundary (paragraph, sentence, space)
      let cut = remaining.lastIndexOf('\n\n', maxChars);
      if (cut < maxChars * 0.5) cut = remaining.lastIndexOf('. ', maxChars);
      if (cut < maxChars * 0.5) cut = remaining.lastIndexOf(' ', maxChars);
      if (cut < maxChars * 0.5) cut = maxChars;

      chunks.push(remaining.slice(0, cut).trim());
      remaining = remaining.slice(cut).trim();
    }
    if (remaining.length > 0) chunks.push(remaining);
    return chunks;
  }

  private async assertOwnership(
    projectId: string,
    userId: string,
  ): Promise<void> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    if (error || !data) {
      throw new NotFoundException(`Project ${projectId} not found`);
    }
    if ((data as { user_id: string }).user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }
  }
}
