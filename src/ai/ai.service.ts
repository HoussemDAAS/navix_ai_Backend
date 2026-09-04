import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MarketAnalysisInput {
  project_id: string;
  competitors: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  /** AnalysisRequest requires an object — all fields optional, but never null */
  brand_kit: Record<string, unknown>;
}

export interface DirectionGenerationInput {
  project_id: string;
  brief_id: string;
  brand_kit: Record<string, unknown>;
  analysis: Record<string, unknown>;
  num_directions: number;
}

export interface DirectionGenerationResponse {
  directions: Array<{
    title_pillar: string;
    angle: string;
    format: string;
    hook_suggestion?: string;
    cta_suggestion?: string;
    rationale?: string;
  }>;
}

export interface DraftGenerationDirectionPayload {
  id?: string;
  title_pillar: string;
  angle: string;
  format: string;
  hook_suggestion?: string | null;
  cta_suggestion?: string | null;
}

export interface DraftGenerationInput {
  project_id: string;
  directions: DraftGenerationDirectionPayload[];
  brand_kit: Record<string, unknown>;
}

export interface DraftGenerationResponse {
  drafts: Array<{
    direction_title?: string;
    caption_text: string;
    video_script?: string | null;
    hook_alternatives?: string[];
    cta_alternatives?: string[];
  }>;
}

export interface BrandMemoryFeedbackPayload {
  draft_id: string;
  caption_text: string;
  action: 'approved' | 'rejected' | 'edited';
  notes?: string | null;
}

export interface BrandMemoryInput {
  project_id: string;
  feedback: BrandMemoryFeedbackPayload[];
  current_brand_kit: Record<string, unknown>;
}

export interface BrandMemoryResponse {
  updated_preferences?: Record<string, unknown>;
  learned_patterns?: string[];
}

type AiRequestBody =
  | MarketAnalysisInput
  | DirectionGenerationInput
  | DraftGenerationInput
  | BrandMemoryInput;

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs = 120_000;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl =
      this.configService.get<string>('AI_SERVICE_URL') ??
      'http://localhost:8000';
    this.logger.log(`AI Service URL configured: ${this.baseUrl}`);
  }

  async runMarketAnalysis(
    data: MarketAnalysisInput,
  ): Promise<Record<string, unknown>> {
    return this.callEndpoint('/agents/market-analysis', data);
  }

  async generateDirections(
    data: DirectionGenerationInput,
  ): Promise<DirectionGenerationResponse> {
    const result = await this.callEndpoint(
      '/agents/direction-generation',
      data,
    );
    return result as unknown as DirectionGenerationResponse;
  }

  async generateDrafts(
    data: DraftGenerationInput,
  ): Promise<DraftGenerationResponse> {
    const result = await this.callEndpoint('/agents/draft-generation', data);
    return result as unknown as DraftGenerationResponse;
  }

  async updateBrandMemory(
    data: BrandMemoryInput,
  ): Promise<BrandMemoryResponse> {
    const result = await this.callEndpoint('/agents/brand-memory', data);
    return result as unknown as BrandMemoryResponse;
  }

  private async callEndpoint(
    path: string,
    body: AiRequestBody,
  ): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    this.logger.log(`Calling AI service: POST ${url}`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`AI service returned ${response.status}: ${errorBody}`);
      }

      const result = await response.json();
      this.logger.log(`AI service response received from ${path}`);
      return result as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(
          `AI service timeout after ${this.timeoutMs}ms on ${path}`,
        );
      }
      throw new Error(
        `AI service call failed on ${path}: ${(err as Error).message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
