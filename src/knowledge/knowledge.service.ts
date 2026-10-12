import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { OpenAIService } from '../embeddings/openai.service';
import { AiService } from '../ai/ai.service';
import {
  KNOWLEDGE_FORMATS,
  KNOWLEDGE_FUNNELS,
  KNOWLEDGE_GOALS,
  KNOWLEDGE_LANGUAGES,
  KNOWLEDGE_SCRIPTS,
  KNOWLEDGE_STATUSES,
  KNOWLEDGE_TYPES,
  type KnowledgeType,
} from './dto/knowledge.dto';

export interface KnowledgeItemRow {
  id: string;
  type: string;
  title: string | null;
  content: string;
  language: string;
  script: string;
  field: string | null;
  format: string;
  goal: string;
  funnel: string;
  group_label: string | null;
  note: string | null;
  source_kind: string;
  source_url: string | null;
  origin_project_id: string | null;
  status: string;
  usage_count: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemInput {
  type: string;
  content: string;
  title?: string | null;
  language?: string | null;
  script?: string | null;
  field?: string | null;
  format?: string | null;
  goal?: string | null;
  funnel?: string | null;
  group_label?: string | null;
  note?: string | null;
  source_kind?: string | null;
  source_url?: string | null;
  origin_project_id?: string | null;
  status?: string | null;
}

export interface ListParams {
  type?: string;
  language?: string;
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface KnowledgeUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const MAX_CHUNK_CHARS = 2000;
const REFERENCES_BUCKET = 'references';
const TEXT_EXTENSIONS = ['.txt', '.md', '.csv', '.json', '.tsv'];
const SOURCE_KINDS = ['admin', 'article', 'user_approved', 'user_edit', 'user_published'];

function pick<T extends readonly string[]>(value: unknown, allowed: T, fallback: T[number]): T[number] {
  const v = String(value ?? '').trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T[number]) : fallback;
}

function clean(value: unknown, max: number): string | null {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
}

/**
 * Cheap language and script guess used when the AI tagger is off or fails.
 * Derja in Arabic letters is told apart from French/English by the script; Derja in
 * Latin letters ("Arabizi") by digits used as letters (3, 7, 9, 5) inside words.
 */
export function detectLanguage(text: string): { language: string; script: string } {
  const arabic = (text.match(/[؀-ۿ]/g) ?? []).length;
  const latin = (text.match(/[A-Za-zÀ-ÿ]/g) ?? []).length;
  const total = arabic + latin;
  if (total === 0) return { language: 'other', script: 'na' };
  const arabicShare = arabic / total;
  const script = arabicShare > 0.85 ? 'arabic' : arabicShare < 0.15 ? 'latin' : 'mixed';
  const arabizi = /\b[a-z]*[3795][a-z]+\b|\b[a-z]+[3795][a-z]*\b/i.test(text);
  const french = /\b(le|la|les|des|une|pour|avec|vous|votre|nous|est|pas|sur|dans|cette|très)\b/i.test(text);
  const english = /\b(the|and|your|with|this|that|you|for|how|what|our)\b/i.test(text);
  if (script === 'arabic') return { language: 'derja', script };
  if (script === 'mixed') return { language: 'mixed', script };
  if (arabizi) return { language: french || english ? 'mixed' : 'derja', script };
  if (french && !english) return { language: 'fr', script };
  if (english && !french) return { language: 'en', script };
  return { language: french && english ? 'mixed' : 'other', script };
}

/** A short line without brackets or sentence punctuation that introduces the lines below it. */
function looksLikeHeader(line: string): boolean {
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;
  if (/[\[\]\(\)]/.test(line)) return false;
  if (/[.!?؟]$/.test(line)) return false;
  return !/[,،:;]/.test(line) || /[/…]/.test(line);
}

const EXAMPLE_PREFIX = /^(مثال|exemple|example|ex)\s*[:：]\s*/i;

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly openai: OpenAIService,
    private readonly aiService: AiService,
  ) {}

  /* ── Reading ─────────────────────────────────────────────── */

  async list(params: ListParams): Promise<{ items: KnowledgeItemRow[]; total: number }> {
    const client = this.supabaseService.getClient();
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const offset = Math.max(params.offset ?? 0, 0);
    let query = client
      .from('knowledge_items')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (params.type) query = query.eq('type', params.type);
    if (params.language) query = query.eq('language', params.language);
    if (params.status) query = query.eq('status', params.status);
    if (params.q) {
      const q = params.q.replace(/[%,]/g, ' ').trim();
      if (q) query = query.or(`content.ilike.%${q}%,title.ilike.%${q}%,field.ilike.%${q}%,group_label.ilike.%${q}%`);
    }
    const { data, error, count } = await query;
    if (error) throw new Error(`Failed to list knowledge: ${error.message}`);
    return { items: (data ?? []) as KnowledgeItemRow[], total: count ?? 0 };
  }

  async stats(): Promise<{ total: number; by_type: Record<string, number>; by_status: Record<string, number>; by_language: Record<string, number> }> {
    const client = this.supabaseService.getClient();
    const { data, error } = await client.from('knowledge_items').select('type, status, language').limit(5000);
    if (error) throw new Error(`Failed to count knowledge: ${error.message}`);
    const rows = (data ?? []) as Array<{ type: string; status: string; language: string }>;
    const tally = (key: 'type' | 'status' | 'language') =>
      rows.reduce<Record<string, number>>((acc, r) => {
        acc[r[key]] = (acc[r[key]] ?? 0) + 1;
        return acc;
      }, {});
    return { total: rows.length, by_type: tally('type'), by_status: tally('status'), by_language: tally('language') };
  }

  async search(params: {
    query: string;
    type?: string;
    language?: string;
    script?: string;
    format?: string;
    goal?: string;
    field?: string;
    k?: number;
  }): Promise<Array<Record<string, unknown>>> {
    const client = this.supabaseService.getClient();
    const embedding = await this.openai.embedSingle(params.query.slice(0, 2000));
    const { data, error } = await client.rpc('match_knowledge', {
      query_embedding: embedding,
      match_count: params.k ?? 8,
      match_threshold: 0.0,
      filter_types: params.type ? [params.type] : null,
      filter_languages: params.language ? [params.language] : null,
      filter_scripts: params.script ? [params.script] : null,
      filter_formats: params.format ? [params.format] : null,
      filter_goals: params.goal ? [params.goal] : null,
      filter_field: params.field?.trim().toLowerCase() || null,
    });
    if (error) throw new Error(`Knowledge search failed: ${error.message}`);
    return (data ?? []) as Array<Record<string, unknown>>;
  }

  /* ── Writing ─────────────────────────────────────────────── */

  normalize(raw: unknown, defaults: Record<string, unknown> = {}): ItemInput | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    const content = String(r.content ?? '').trim();
    if (!content) return null;
    const type = pick(r.type ?? defaults.type, KNOWLEDGE_TYPES, 'rule');
    const guess = detectLanguage(content);
    const explicit = (key: string) => (r[key] !== undefined && r[key] !== null && r[key] !== '' ? r[key] : defaults[key]);
    return {
      type,
      content: content.slice(0, 300_000),
      title: clean(explicit('title'), 160),
      language: pick(explicit('language'), KNOWLEDGE_LANGUAGES, guess.language as (typeof KNOWLEDGE_LANGUAGES)[number]),
      script: pick(explicit('script'), KNOWLEDGE_SCRIPTS, guess.script as (typeof KNOWLEDGE_SCRIPTS)[number]),
      field: clean(explicit('field'), 80)?.toLowerCase() ?? null,
      format: pick(explicit('format'), KNOWLEDGE_FORMATS, 'any'),
      goal: pick(explicit('goal'), KNOWLEDGE_GOALS, 'any'),
      funnel: pick(explicit('funnel'), KNOWLEDGE_FUNNELS, 'any'),
      group_label: clean(explicit('group_label'), 120),
      note: clean(explicit('note'), 1000),
      source_kind: SOURCE_KINDS.includes(String(explicit('source_kind'))) ? String(explicit('source_kind')) : 'admin',
      source_url: clean(explicit('source_url'), 2000),
      origin_project_id: clean(explicit('origin_project_id'), 36),
      status: pick(explicit('status'), KNOWLEDGE_STATUSES, 'active'),
    };
  }

  /**
   * Insert items and index them. When autoTag is on, the AI fills the tags the
   * caller left empty (language, script, field, format, goal, funnel, title, note).
   */
  async createMany(
    rawItems: unknown[],
    options: { autoTag?: boolean; createdBy?: string | null; defaults?: Record<string, unknown>; explicitKeys?: Set<string> } = {},
  ): Promise<KnowledgeItemRow[]> {
    const items = rawItems.map((r) => this.normalize(r, options.defaults)).filter((x): x is ItemInput => !!x);
    if (items.length === 0) throw new BadRequestException('No item with content to import');

    if (options.autoTag !== false) {
      await this.applyAiTags(items, options.explicitKeys ?? new Set());
    }

    const client = this.supabaseService.getClient();
    const rows = items.map((it) => ({
      ...it,
      title: it.title ?? it.content.replace(/\s+/g, ' ').slice(0, 60),
      created_by: options.createdBy ?? null,
    }));
    const { data, error } = await client.from('knowledge_items').insert(rows).select('*');
    if (error) throw new Error(`Failed to insert knowledge items: ${error.message}`);
    const inserted = (data ?? []) as KnowledgeItemRow[];
    await this.embedItems(inserted);
    this.logger.log(`Knowledge: ${inserted.length} item(s) added`);
    return inserted;
  }

  /** Fill the tags the import did not set explicitly with the AI's suggestions. */
  private async applyAiTags(items: ItemInput[], explicitKeys: Set<string>): Promise<void> {
    const ids = items.map(() => randomUUID());
    try {
      const response = await this.aiService.tagKnowledge({
        items: items.map((it, i) => ({ id: ids[i], type: it.type, content: it.content, title: it.title ?? null })),
      });
      const byId = new Map(response.tags.map((t) => [t.id, t]));
      items.forEach((it, i) => {
        const t = byId.get(ids[i]);
        if (!t) return;
        const take = (key: keyof ItemInput, value: unknown) => {
          if (explicitKeys.has(key as string)) return;
          if (value === null || value === undefined || value === '') return;
          (it as unknown as Record<string, unknown>)[key] = value;
        };
        take('language', t.language);
        take('script', t.script);
        take('field', t.field);
        take('format', t.format);
        take('goal', t.goal);
        take('funnel', t.funnel);
        if (!it.title) take('title', t.title);
        if (!it.note) take('note', t.note);
      });
    } catch (err) {
      this.logger.warn(`AI tagging skipped: ${(err as Error).message}`);
    }
  }

  private chunk(text: string): string[] {
    const chunks: string[] = [];
    let rest = text.trim();
    while (rest.length > MAX_CHUNK_CHARS) {
      let cut = rest.lastIndexOf('\n', MAX_CHUNK_CHARS);
      if (cut < MAX_CHUNK_CHARS * 0.5) cut = rest.lastIndexOf(' ', MAX_CHUNK_CHARS);
      if (cut < MAX_CHUNK_CHARS * 0.5) cut = MAX_CHUNK_CHARS;
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) chunks.push(rest);
    return chunks.slice(0, 300);
  }

  private async embedItems(items: KnowledgeItemRow[]): Promise<void> {
    if (items.length === 0) return;
    const client = this.supabaseService.getClient();
    const pending: Array<{ item_id: string; chunk_index: number; chunk_text: string }> = [];
    for (const it of items) {
      const head = [it.type, it.title, it.field, it.group_label].filter(Boolean).join(' · ');
      const text = `${head}\n${it.content}${it.note ? `\n${it.note}` : ''}`;
      this.chunk(text).forEach((chunk_text, chunk_index) => pending.push({ item_id: it.id, chunk_index, chunk_text }));
    }
    for (let i = 0; i < pending.length; i += 50) {
      const batch = pending.slice(i, i + 50);
      const vectors = await this.openai.embedBatch(batch.map((p) => p.chunk_text));
      const rows = batch.map((p, j) => ({ ...p, embedding: vectors[j] }));
      const { error } = await client.from('knowledge_chunks').insert(rows);
      if (error) throw new Error(`Failed to index knowledge: ${error.message}`);
    }
  }

  async update(id: string, patch: Record<string, unknown>): Promise<KnowledgeItemRow> {
    const client = this.supabaseService.getClient();
    const { data: existing } = await client.from('knowledge_items').select('*').eq('id', id).maybeSingle();
    if (!existing) throw new NotFoundException('Knowledge item not found');
    const allowed = ['type', 'title', 'content', 'language', 'script', 'field', 'format', 'goal', 'funnel', 'group_label', 'note', 'status'];
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const key of allowed) {
      if (patch[key] !== undefined) update[key] = key === 'field' ? String(patch[key]).trim().toLowerCase() || null : patch[key];
    }
    const { data, error } = await client.from('knowledge_items').update(update).eq('id', id).select('*').single();
    if (error || !data) throw new Error(`Failed to update knowledge item: ${error?.message ?? 'no row'}`);
    const row = data as KnowledgeItemRow;
    const reindex = ['content', 'title', 'note', 'field', 'group_label', 'type'].some((k) => patch[k] !== undefined);
    if (reindex) {
      await client.from('knowledge_chunks').delete().eq('item_id', id);
      await this.embedItems([row]);
    }
    return row;
  }

  async remove(id: string): Promise<void> {
    const client = this.supabaseService.getClient();
    const { error } = await client.from('knowledge_items').delete().eq('id', id);
    if (error) throw new Error(`Failed to delete knowledge item: ${error.message}`);
  }

  /* ── Imports ─────────────────────────────────────────────── */

  /**
   * Split pasted text into items. Hooks and CTAs come one per line, with short header
   * lines kept as the group label and "مثال:" lines attached to the template above.
   */
  splitText(text: string, type: KnowledgeType, mode?: string): Array<{ content: string; group_label?: string; note?: string }> {
    const normalized = text.replace(/\r\n?/g, '\n').replace(/ /g, ' ');
    const split = mode ?? (type === 'hook' || type === 'cta' ? 'line' : 'none');
    if (split === 'none') return normalized.trim() ? [{ content: normalized.trim() }] : [];
    if (split === 'blank') {
      return normalized.split(/\n\s*\n+/).map((s) => s.trim()).filter(Boolean).map((content) => ({ content }));
    }
    if (split === 'marker') {
      return normalized.split(/^\s*(?:-{3,}|={3,}|\*{3,})\s*$/m).map((s) => s.trim()).filter(Boolean).map((content) => ({ content }));
    }
    const items: Array<{ content: string; group_label?: string; note?: string }> = [];
    let group: string | undefined;
    for (const rawLine of normalized.split('\n')) {
      // Layout noise from PDFs and OCR: a source link next to the line, tab-separated
      // cells, code fences, "INSPO HOOK:" captions, lines without any letters
      let line = rawLine.replace(/^[\s\-•*·]+/, '').trim();
      if (!line || /^`{3,}/.test(line)) continue;
      if (line.includes('\t')) {
        const cells = line.split('\t').map((c) => c.trim()).filter((c) => c && !/^https?:\/\//i.test(c));
        line = cells[0] ?? '';
      }
      line = line.replace(/\s*https?:\/\/\S+\s*$/i, '').trim();
      if (!line || /^https?:\/\//i.test(line)) continue;
      if (!/[A-Za-z؀-ۿ]/.test(line)) continue;
      if (/^(inspo|inspiration)\s*hook\s*:?\s*$/i.test(line) || /hook\s*:$/i.test(line)) continue;
      const example = line.match(EXAMPLE_PREFIX);
      if (example && items.length > 0) {
        const last = items[items.length - 1];
        const ex = line.slice(example[0].length).trim();
        last.note = last.note ? `${last.note} | Example: ${ex}` : `Example: ${ex}`;
        continue;
      }
      if (looksLikeHeader(line)) {
        group = line.replace(/[…:]+$/, '').trim();
        continue;
      }
      items.push({ content: line, group_label: group });
    }
    return items;
  }

  async importText(
    params: { text: string; type: string; split?: string; auto_tag?: boolean; defaults?: Record<string, string> },
    createdBy: string | null,
  ): Promise<KnowledgeItemRow[]> {
    const type = pick(params.type, KNOWLEDGE_TYPES, 'rule');
    const pieces = this.splitText(params.text, type, params.split);
    if (pieces.length === 0) throw new BadRequestException('Nothing to import in that text');
    if (pieces.length > 5000) throw new BadRequestException(`That is ${pieces.length} items; import at most 5000 at a time`);
    const defaults = Object.fromEntries(Object.entries(params.defaults ?? {}).filter(([, v]) => v !== '' && v != null));
    const explicitKeys = new Set(Object.keys(defaults));
    return this.createMany(
      pieces.map((p) => ({ ...p, type })),
      { autoTag: params.auto_tag !== false, createdBy, defaults: { ...defaults, type }, explicitKeys },
    );
  }

  async importFile(
    file: KnowledgeUpload,
    params: { type: string; split?: string; auto_tag?: boolean; defaults?: Record<string, string> },
    createdBy: string | null,
  ): Promise<KnowledgeItemRow[]> {
    const name = file.originalname.toLowerCase();
    const isText = file.mimetype.startsWith('text/') || TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
    const isDocx =
      name.endsWith('.docx') ||
      file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    let text: string;
    if (isText) {
      text = file.buffer.toString('utf8').replace(/^﻿/, '');
    } else if (isDocx) {
      text = await this.extractDocxText(file);
    } else if (name.endsWith('.doc')) {
      throw new BadRequestException('Old .doc files are not readable here: save the file as .docx or PDF and upload it again.');
    } else if (file.mimetype === 'application/pdf' || name.endsWith('.pdf')) {
      text = await this.extractPdfText(file);
    } else {
      throw new BadRequestException('Use a text, Markdown, CSV, Word (.docx) or PDF file, or paste the content.');
    }
    return this.importText({ ...params, text }, createdBy);
  }

  /** Word documents: paragraphs and table cells as plain text, one paragraph per line. */
  private async extractDocxText(file: KnowledgeUpload): Promise<string> {
    const mammoth = await import('mammoth');
    try {
      const result = await mammoth.extractRawText({ buffer: file.buffer });
      const text = (result.value ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) throw new BadRequestException('No readable text found in that Word file');
      return text;
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Could not read that Word file: ${(err as Error).message}`);
    }
  }

  /** PDFs go through the same reader the Studio uses for shared references. */
  private async extractPdfText(file: KnowledgeUpload): Promise<string> {
    const client = this.supabaseService.getClient();
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_').slice(0, 80);
    const storagePath = `knowledge/${randomUUID()}-${safeName}`;
    const { error } = await client.storage
      .from(REFERENCES_BUCKET)
      .upload(storagePath, file.buffer, { contentType: 'application/pdf', upsert: false });
    if (error) throw new Error(`Upload failed: ${error.message}`);
    const url = client.storage.from(REFERENCES_BUCKET).getPublicUrl(storagePath).data.publicUrl;
    // full: the library keeps the whole document, unlike a Studio reference
    let extracted: { extracted_text: string };
    try {
      extracted = await this.aiService.extractText({ kind: 'pdf', url, mime_type: 'application/pdf', title: file.originalname, full: true });
    } catch (err) {
      // Surface the reader's reason (no text layer, too large...) instead of a generic 500
      const detail = /"detail":"([^"]+)"/.exec((err as Error).message)?.[1];
      throw new BadRequestException(detail ?? `Could not read that PDF: ${(err as Error).message}`);
    }
    if (!extracted.extracted_text.trim()) throw new BadRequestException('No readable text found in that PDF');
    return extracted.extracted_text;
  }

  async addArticle(params: { url: string; field?: string; language?: string }, createdBy: string | null): Promise<KnowledgeItemRow[]> {
    const text = await this.fetchArticleText(params.url);
    const distilled = await this.aiService.distillArticle({ url: params.url, text, field: params.field ?? null });
    if (distilled.principles.length === 0) throw new BadRequestException('Nothing reusable was found in that page');
    const items = distilled.principles.map((p) => ({
      type: 'article',
      title: p.title,
      content: p.content,
      format: p.format ?? 'any',
      goal: p.goal ?? 'any',
      language: params.language ?? distilled.language,
      script: 'na',
      field: params.field ?? null,
      group_label: distilled.title || params.url,
      note: `From ${params.url}`,
      source_kind: 'article',
      source_url: params.url,
    }));
    return this.createMany(items, { autoTag: false, createdBy });
  }

  private async fetchArticleText(url: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NavixKnowledge/1.0)', Accept: 'text/html,text/plain' },
        redirect: 'follow',
      });
      if (!response.ok) throw new BadRequestException(`The page answered ${response.status}`);
      const html = await response.text();
      const body = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<(br|p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n\s*\n+/g, '\n')
        .trim();
      if (body.length < 200) throw new BadRequestException('The page did not contain enough readable text');
      return body.slice(0, 30_000);
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException(`Could not read that page: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
