import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { SupabaseService } from '../supabase/supabase.service';
import { AnalyticsService } from '../analysis/analytics.service';
import { EmbeddingsService } from '../embeddings/embeddings.service';
import { CreateSessionDto } from './dto/create-session.dto';
import { SendMessageDto } from './dto/send-message.dto';

/**
 * Studio: the conversational co-creation flow. The AI service streams one turn
 * as Server-Sent Events; this service persists the conversation and turns the
 * idea/draft cards into content_directions / drafts rows as they arrive, so the
 * rest of the product (libraries, feedback, brand memory, calendar) keeps working.
 */

const HISTORY_LIMIT = 24;
const AI_TIMEOUT_MS = 180_000;
const EXTRACT_TIMEOUT_MS = 240_000;
const REFERENCES_BUCKET = 'references';
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

export type ReferenceKind = 'image' | 'pdf' | 'text' | 'video' | 'audio' | 'link';

export interface ReferenceRow {
  id: string;
  project_id: string;
  session_id: string | null;
  kind: ReferenceKind;
  title: string;
  source_url: string | null;
  storage_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  status: 'processing' | 'ready' | 'failed';
  extracted_text: string | null;
  summary: string | null;
  meta: Record<string, unknown>;
  error: string | null;
  created_at: string;
}

/** What multer hands us for one uploaded file (typed locally: no @types/multer in the repo). */
export interface StudioUpload {
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

function kindOf(mime: string, name: string): ReferenceKind | null {
  const lower = mime.toLowerCase();
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (lower.startsWith('image/')) return 'image';
  if (lower === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (lower.startsWith('video/')) return 'video';
  if (lower.startsWith('audio/')) return 'audio';
  if (lower.startsWith('text/') || ['txt', 'md', 'markdown', 'csv'].includes(ext)) return 'text';
  return null;
}

export type StudioEvent =
  | { type: 'token'; text: string }
  | { type: 'tool'; name: string; query?: string; hits?: number }
  | { type: 'ideas'; ideas: StudioIdea[] }
  | { type: 'draft'; draft: StudioDraft }
  | { type: 'saved'; message_id: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

export interface StudioIdea {
  id?: string;
  title_pillar: string;
  angle: string;
  format: string;
  hook_suggestion: string;
  cta_suggestion: string;
  rationale: string;
}

export interface StudioDraft {
  id?: string;
  direction_id?: string;
  idea_title: string;
  format: string;
  language: string;
  caption_text: string;
  video_script?: string | null;
  hook_alternatives: string[];
  cta_alternatives: string[];
  tips: Record<string, string>;
  revises_draft_id?: string | null;
  version?: number;
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  content_language: string;
  created_at: string;
  last_message_at: string;
}

export interface MessageRow {
  id: string;
  session_id: string;
  role: 'user' | 'assistant';
  content: string;
  artifacts: Array<Record<string, unknown>>;
  created_at: string;
}

@Injectable()
export class StudioService {
  private readonly logger = new Logger(StudioService.name);
  private readonly aiBaseUrl: string;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly analyticsService: AnalyticsService,
    private readonly embeddingsService: EmbeddingsService,
    private readonly configService: ConfigService,
  ) {
    this.aiBaseUrl = this.configService.get<string>('AI_SERVICE_URL') ?? 'http://localhost:8000';
  }

  /* ── Sessions ───────────────────────────────────────────── */

  async listSessions(projectId: string, userId: string): Promise<SessionRow[]> {
    await this.ownProject(projectId, userId);
    const { data, error } = await this.supabaseService
      .getClient()
      .from('chat_sessions')
      .select('*')
      .eq('project_id', projectId)
      .order('last_message_at', { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return (data ?? []) as SessionRow[];
  }

  async createSession(projectId: string, userId: string, dto: CreateSessionDto) {
    const project = await this.ownProject(projectId, userId);
    const client = this.supabaseService.getClient();
    const { data, error } = await client
      .from('chat_sessions')
      .insert({
        project_id: projectId,
        content_language: dto.content_language ?? 'same as my posts',
      })
      .select('*')
      .single();
    if (error || !data) throw new Error(error?.message ?? 'Could not create the session');
    const session = data as SessionRow;

    // The opener is deterministic — built from the account's numbers, no LLM call
    const grounding = await this.analyticsService.groundingFor(projectId);
    const opener = this.buildOpener(project, grounding.account_model);
    const { data: msg } = await client
      .from('chat_messages')
      .insert({ session_id: session.id, role: 'assistant', content: opener })
      .select('*')
      .single();

    return { session, messages: msg ? [msg as MessageRow] : [] };
  }

  async getMessages(projectId: string, sessionId: string, userId: string) {
    await this.ownProject(projectId, userId);
    const session = await this.loadSession(projectId, sessionId);
    const { data, error } = await this.supabaseService
      .getClient()
      .from('chat_messages')
      .select('*')
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return { session, messages: (data ?? []) as MessageRow[] };
  }

  /* ── References (uploads the user shares as examples) ───── */

  async listReferences(projectId: string, sessionId: string, userId: string): Promise<ReferenceRow[]> {
    await this.ownProject(projectId, userId);
    const { data, error } = await this.supabaseService
      .getClient()
      .from('references')
      .select('*')
      .eq('project_id', projectId)
      .eq('session_id', sessionId)
      .order('created_at', { ascending: true })
      .limit(100);
    if (error) throw new Error(error.message);
    return (data ?? []) as ReferenceRow[];
  }

  /**
   * Store the file, extract what the agent can read (description, text, transcript),
   * summarize it and embed it. Synchronous: the composer waits for "ready" before sending.
   */
  async uploadReference(
    projectId: string,
    sessionId: string,
    userId: string,
    file: StudioUpload,
  ): Promise<ReferenceRow> {
    await this.ownProject(projectId, userId);
    await this.loadSession(projectId, sessionId);
    const kind = kindOf(file.mimetype, file.originalname);
    if (!kind) {
      throw new BadRequestException('Share a photo, a PDF, a text file, or a video/audio clip.');
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      throw new BadRequestException('Files up to 25 MB — upload a shorter or more compressed clip.');
    }

    const client = this.supabaseService.getClient();
    const safeName = file.originalname.replace(/[^\w.\-]+/g, '_').slice(0, 80);
    const storagePath = `${projectId}/${sessionId}/${randomUUID()}-${safeName}`;
    const { error: uploadErr } = await client.storage
      .from(REFERENCES_BUCKET)
      .upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
    if (uploadErr) throw new Error(`Upload failed: ${uploadErr.message}`);
    const publicUrl = client.storage.from(REFERENCES_BUCKET).getPublicUrl(storagePath).data.publicUrl;

    const { data: inserted, error: insertErr } = await client
      .from('references')
      .insert({
        project_id: projectId,
        session_id: sessionId,
        kind,
        title: file.originalname.slice(0, 120),
        source_url: publicUrl,
        storage_path: storagePath,
        mime_type: file.mimetype,
        size_bytes: file.size,
        status: 'processing',
      })
      .select('*')
      .single();
    if (insertErr || !inserted) throw new Error(insertErr?.message ?? 'Could not save the reference');
    const row = inserted as ReferenceRow;

    try {
      const extracted = await this.extractReference(row, publicUrl);
      const { data: ready } = await client
        .from('references')
        .update({
          status: 'ready',
          extracted_text: extracted.extracted_text,
          summary: extracted.summary,
          meta: extracted.meta ?? {},
        })
        .eq('id', row.id)
        .select('*')
        .single();
      this.embeddingsService.embedReference(row.id).catch((err) => {
        this.logger.warn(`Reference ${row.id} not embedded: ${(err as Error).message}`);
      });
      return (ready ?? { ...row, status: 'ready', ...extracted }) as ReferenceRow;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.warn(`Reference ${row.id} extraction failed: ${message}`);
      const { data: failed } = await client
        .from('references')
        .update({ status: 'failed', error: message.slice(0, 500) })
        .eq('id', row.id)
        .select('*')
        .single();
      return (failed ?? { ...row, status: 'failed', error: message }) as ReferenceRow;
    }
  }

  private async extractReference(
    row: ReferenceRow,
    url: string,
  ): Promise<{ extracted_text: string; summary: string; meta: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.aiBaseUrl}/references/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reference_id: row.id,
          kind: row.kind,
          url,
          mime_type: row.mime_type,
          title: row.title,
        }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as {
        detail?: string;
        extracted_text?: string;
        summary?: string;
        meta?: Record<string, unknown>;
      };
      if (!response.ok) throw new Error(body.detail ?? `AI service returned ${response.status}`);
      return {
        extracted_text: body.extracted_text ?? '',
        summary: body.summary ?? '',
        meta: body.meta ?? {},
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── One streamed turn ──────────────────────────────────── */

  async streamReply(
    projectId: string,
    sessionId: string,
    userId: string,
    dto: SendMessageDto,
    emit: (event: StudioEvent) => void,
  ): Promise<void> {
    const project = await this.ownProject(projectId, userId);
    const session = await this.loadSession(projectId, sessionId);
    const client = this.supabaseService.getClient();

    if (dto.language && dto.language !== session.content_language) {
      await client.from('chat_sessions').update({ content_language: dto.language }).eq('id', sessionId);
      session.content_language = dto.language;
    }

    // Attachments travel with the message as reference chips
    let attached: Array<{ type: 'reference'; id: string; title: string; kind: string }> = [];
    if (dto.reference_ids && dto.reference_ids.length > 0) {
      const { data: refs } = await client
        .from('references')
        .select('id, title, kind')
        .eq('project_id', projectId)
        .in('id', dto.reference_ids);
      attached = ((refs ?? []) as Array<{ id: string; title: string; kind: string }>).map((r) => ({
        type: 'reference',
        ...r,
      }));
    }

    const { error: userErr } = await client
      .from('chat_messages')
      .insert({ session_id: sessionId, role: 'user', content: dto.content, artifacts: attached });
    if (userErr) throw new Error(userErr.message);

    const [{ data: history }, { data: brandKit }, grounding, { data: sessionRefs }] = await Promise.all([
      client
        .from('chat_messages')
        .select('role, content, artifacts')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: false })
        .limit(HISTORY_LIMIT),
      client.from('brand_kits').select('*').eq('project_id', projectId).maybeSingle(),
      this.analyticsService.groundingFor(projectId),
      client
        .from('references')
        .select('id, kind, title, summary')
        .eq('session_id', sessionId)
        .eq('status', 'ready')
        .order('created_at', { ascending: true })
        .limit(30),
    ]);

    // Cards are not text: tell the model what the user saw so it can refer to them
    const messages = ((history ?? []) as Array<Pick<MessageRow, 'role' | 'content' | 'artifacts'>>)
      .reverse()
      .map((m) => ({ role: m.role, content: this.messageForModel(m) }));

    const payload = {
      project_id: projectId,
      persona: grounding.persona,
      account_model: grounding.account_model,
      brand_kit: brandKit ?? null,
      project: {
        name: project.name,
        niche: project.niche,
        handle: project.instagram_handle ?? project.tiktok_handle ?? null,
        location: project.location,
      },
      creator_memory: null,
      content_language: session.content_language,
      references: sessionRefs ?? [],
      messages,
    };

    let text = '';
    const artifacts: Array<Record<string, unknown>> = [];

    await this.consumeAiStream(payload, async (event) => {
      if (event.type === 'token') {
        text += event.text;
        emit(event);
        return;
      }
      if (event.type === 'ideas') {
        const saved = await this.saveIdeas(projectId, sessionId, event.ideas);
        artifacts.push(...saved.map((i) => ({ type: 'idea', ...i })));
        emit({ type: 'ideas', ideas: saved });
        return;
      }
      if (event.type === 'draft') {
        const saved = await this.saveDraft(projectId, sessionId, event.draft);
        artifacts.push({ type: 'draft', ...saved });
        emit({ type: 'draft', draft: saved });
        return;
      }
      if (event.type === 'error') {
        emit(event);
        return;
      }
      if (event.type === 'tool') emit(event);
    });

    const { data: assistant } = await client
      .from('chat_messages')
      .insert({ session_id: sessionId, role: 'assistant', content: text, artifacts })
      .select('id')
      .single();

    const patch: Record<string, unknown> = { last_message_at: new Date().toISOString() };
    if (session.title === 'New session') patch.title = dto.content.trim().slice(0, 60);
    await client.from('chat_sessions').update(patch).eq('id', sessionId);

    emit({ type: 'saved', message_id: (assistant as { id: string } | null)?.id ?? '' });
    emit({ type: 'done' });
  }

  /* ── Persistence of cards ───────────────────────────────── */

  private async saveIdeas(projectId: string, sessionId: string, ideas: StudioIdea[]): Promise<StudioIdea[]> {
    const client = this.supabaseService.getClient();
    const briefId = await this.ensureStudioBrief(projectId);
    const rows = ideas.map((i) => ({
      brief_id: briefId,
      session_id: sessionId,
      source: 'studio',
      title_pillar: i.title_pillar,
      angle: i.angle,
      format: i.format,
      hook_suggestion: i.hook_suggestion,
      cta_suggestion: i.cta_suggestion,
      rationale: i.rationale,
      selected: false,
    }));
    const { data, error } = await client.from('content_directions').insert(rows).select('id, title_pillar');
    if (error) {
      this.logger.warn(`Studio ideas not saved: ${error.message}`);
      return ideas;
    }
    const ids = new Map(((data ?? []) as Array<{ id: string; title_pillar: string }>).map((r) => [r.title_pillar, r.id]));
    return ideas.map((i) => ({ ...i, id: ids.get(i.title_pillar) }));
  }

  private async saveDraft(projectId: string, sessionId: string, draft: StudioDraft): Promise<StudioDraft> {
    const client = this.supabaseService.getClient();

    // A draft always develops a direction; reuse the session's idea with that title or create one
    let directionId: string | null = null;
    let parentVersion = 0;
    if (draft.revises_draft_id) {
      const { data: parent } = await client
        .from('drafts')
        .select('id, direction_id, version')
        .eq('id', draft.revises_draft_id)
        .maybeSingle();
      const p = (parent ?? null) as { id: string; direction_id: string; version: number } | null;
      if (p) {
        directionId = p.direction_id;
        parentVersion = p.version ?? 1;
      }
    }
    if (!directionId) {
      const { data: existing } = await client
        .from('content_directions')
        .select('id')
        .eq('session_id', sessionId)
        .eq('title_pillar', draft.idea_title)
        .maybeSingle();
      directionId = (existing as { id: string } | null)?.id ?? null;
    }
    if (!directionId) {
      const briefId = await this.ensureStudioBrief(projectId);
      const { data: created } = await client
        .from('content_directions')
        .insert({
          brief_id: briefId,
          session_id: sessionId,
          source: 'studio',
          title_pillar: draft.idea_title,
          angle: draft.tips?.why_this_format ?? null,
          format: draft.format,
          hook_suggestion: draft.hook_alternatives[0] ?? null,
          cta_suggestion: draft.cta_alternatives[0] ?? null,
          rationale: draft.tips?.modelled_on ?? null,
          selected: true,
        })
        .select('id')
        .single();
      directionId = (created as { id: string } | null)?.id ?? null;
    }
    if (!directionId) return draft;

    const { data, error } = await client
      .from('drafts')
      .insert({
        direction_id: directionId,
        session_id: sessionId,
        caption_text: draft.caption_text,
        video_script: draft.video_script ?? null,
        hook_alternatives: draft.hook_alternatives,
        cta_alternatives: draft.cta_alternatives,
        tips: draft.tips ?? {},
        language: draft.language ?? null,
        version: parentVersion + 1,
        parent_draft_id: draft.revises_draft_id ?? null,
        status: 'PENDING',
      })
      .select('id, version')
      .single();
    if (error || !data) {
      this.logger.warn(`Studio draft not saved: ${error?.message ?? 'unknown'}`);
      return draft;
    }
    const row = data as { id: string; version: number };
    return { ...draft, id: row.id, direction_id: directionId, version: row.version };
  }

  /** Studio ideas need a brief row to hang off; one lightweight brief per project is enough. */
  private async ensureStudioBrief(projectId: string): Promise<string> {
    const client = this.supabaseService.getClient();
    const { data: latest } = await client
      .from('analysis_briefs')
      .select('id')
      .eq('project_id', projectId)
      .order('generated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (latest) return (latest as { id: string }).id;
    const { data, error } = await client
      .from('analysis_briefs')
      .insert({ project_id: projectId, key_takeaways: ['Created in Studio, before any market analysis'] })
      .select('id')
      .single();
    if (error || !data) throw new Error(`Could not create a brief for Studio ideas: ${error?.message ?? 'unknown'}`);
    return (data as { id: string }).id;
  }

  /* ── AI stream consumption ──────────────────────────────── */

  private async consumeAiStream(
    payload: Record<string, unknown>,
    onEvent: (event: StudioEvent) => Promise<void>,
  ): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.aiBaseUrl}/agents/studio/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await response.text().catch(() => '');
        throw new Error(`AI service returned ${response.status}: ${detail.slice(0, 200)}`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split = buffer.indexOf('\n\n');
        while (split >= 0) {
          const frame = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (line) {
            try {
              await onEvent(JSON.parse(line.slice(6)) as StudioEvent);
            } catch (err) {
              this.logger.warn(`Studio event skipped: ${(err as Error).message}`);
            }
          }
          split = buffer.indexOf('\n\n');
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }

  /* ── Helpers ────────────────────────────────────────────── */

  private messageForModel(m: Pick<MessageRow, 'role' | 'content' | 'artifacts'>): string {
    const cards = (m.artifacts ?? []) as Array<Record<string, unknown>>;
    if (cards.length === 0) return m.content;
    if (m.role === 'user') {
      const attached = cards
        .filter((c) => c.type === 'reference')
        .map((c) => `${String(c.kind ?? 'file')} "${String(c.title ?? '')}" (id ${String(c.id ?? '?')})`)
        .join('; ');
      return attached ? `${m.content}\n[attached references: ${attached}]` : m.content;
    }
    const summary = cards
      .map((c) =>
        c.type === 'draft'
          ? `draft ${String(c.id ?? '?')} v${String(c.version ?? 1)} "${String(c.idea_title ?? '')}" (${String(c.format ?? '')})`
          : `idea ${String(c.id ?? '?')} "${String(c.title_pillar ?? '')}"`,
      )
      .join('; ');
    return `${m.content}\n[cards shown: ${summary}]`;
  }

  private buildOpener(project: Record<string, unknown>, model: Record<string, unknown> | null): string {
    const name = String(project.name ?? '').trim().split(/\s+/)[0] || 'there';
    const self = (model?.self ?? null) as {
      posts?: number;
      dominant_format?: string | null;
      posts_per_week?: number | null;
      engagement_rate?: number | null;
      top_posts?: Array<{ caption?: string | null }>;
    } | null;
    if (!self || !self.posts) {
      return `Hi ${name}. I haven't read your posts yet — refresh your data from Home and I'll learn your voice first. Meanwhile, what are we making: a reel, a carousel, or a series for the week?`;
    }
    const rate = self.engagement_rate != null ? (self.engagement_rate <= 1 ? self.engagement_rate * 100 : self.engagement_rate) : null;
    const comparison = (model?.comparison ?? null) as { engagement_vs_field?: number | null } | null;
    const vs = comparison?.engagement_vs_field;
    const vsText = vs != null ? ` (${vs >= 1 ? '+' : ''}${Math.round((vs - 1) * 100)}% vs your field)` : '';
    const best = self.top_posts?.[0]?.caption?.replace(/\s+/g, ' ').trim();
    const bestText = best ? ` Your best post so far: “${best.slice(0, 80)}${best.length > 80 ? '…' : ''}”.` : '';
    const cadence = self.posts_per_week != null ? `${self.posts_per_week} a week` : 'at your own pace';
    return `Hi ${name}. I've read your ${self.posts} posts: mostly ${self.dominant_format ?? 'post'}s, ${cadence}${rate != null ? `, ${rate.toFixed(1)}% engagement${vsText}` : ''}.${bestText} What are we making today — one reel, a carousel, or a series for the week? Give me the topic, or paste a reference you like.`;
  }

  private async ownProject(projectId: string, userId: string): Promise<Record<string, unknown>> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('projects')
      .select('id, user_id, name, niche, location, instagram_handle, tiktok_handle')
      .eq('id', projectId)
      .maybeSingle();
    if (error || !data) throw new NotFoundException(`Project ${projectId} not found`);
    if ((data as { user_id: string }).user_id !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }
    return data as Record<string, unknown>;
  }

  private async loadSession(projectId: string, sessionId: string): Promise<SessionRow> {
    const { data, error } = await this.supabaseService
      .getClient()
      .from('chat_sessions')
      .select('*')
      .eq('id', sessionId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (error || !data) throw new NotFoundException('Session not found');
    return data as SessionRow;
  }
}
