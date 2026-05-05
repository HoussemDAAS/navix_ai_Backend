import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface MarketAnalysisInput {
  competitors: Record<string, unknown>[];
  signals: Record<string, unknown>[];
  brand_kit: Record<string, unknown> | null;
}

export interface DirectionGenerationInput {
  analysis: Record<string, unknown>;
  brand_kit: Record<string, unknown> | null;
  objectives: string[];
}

export interface DraftGenerationInput {
  directions: Record<string, unknown>[];
  brand_kit: Record<string, unknown> | null;
}

export interface BrandMemoryInput {
  feedback: Record<string, unknown>[];
  current_brand_kit: Record<string, unknown>;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private readonly baseUrl: string;
  private readonly timeoutMs = 120_000;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl = this.configService.get<string>('AI_SERVICE_URL') ?? 'http://localhost:8000';
    this.logger.log(`AI Service URL configured: ${this.baseUrl}`);
  }

  async runMarketAnalysis(data: MarketAnalysisInput): Promise<Record<string, unknown>> {
    return this.callEndpoint('/agents/market-analysis', data);
  }

  async generateDirections(data: DirectionGenerationInput): Promise<Record<string, unknown>> {
    return this.callEndpoint('/agents/direction-generation', data);
  }

  async generateDrafts(data: DraftGenerationInput): Promise<Record<string, unknown>> {
    return this.callEndpoint('/agents/draft-generation', data);
  }

  async updateBrandMemory(data: BrandMemoryInput): Promise<Record<string, unknown>> {
    return this.callEndpoint('/agents/brand-memory', data);
  }

  private async callEndpoint(path: string, body: MarketAnalysisInput | DirectionGenerationInput | DraftGenerationInput | BrandMemoryInput): Promise<Record<string, unknown>> {
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
        throw new Error(
          `AI service returned ${response.status}: ${errorBody}`,
        );
      }

      const result = await response.json();
      this.logger.log(`AI service response received from ${path}`);
      return result as Record<string, unknown>;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`AI service timeout after ${this.timeoutMs}ms on ${path}`);
      }
      throw new Error(`AI service call failed on ${path}: ${(err as Error).message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
}
