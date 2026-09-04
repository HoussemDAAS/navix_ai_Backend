import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

interface OpenAIErrorResponse {
  error?: { message?: string; type?: string };
}

@Injectable()
export class OpenAIService {
  private readonly logger = new Logger(OpenAIService.name);
  private readonly apiKey: string;
  private readonly model = 'text-embedding-3-small';
  private readonly endpoint = 'https://api.openai.com/v1/embeddings';
  private readonly timeoutMs = 30_000;

  // Rate limiting: simple token-bucket-ish — 50 requests / second cap.
  // We track inflight count; each call awaits a free slot.
  private readonly maxRps = 50;
  private callTimestamps: number[] = [];

  constructor(private readonly configService: ConfigService) {
    const key = this.configService.get<string>('OPENAI_API_KEY');
    if (!key) {
      this.logger.warn('OPENAI_API_KEY not set — embeddings calls will fail.');
    }
    this.apiKey = key ?? '';
  }

  /**
   * Generate embeddings for a batch of texts.
   * OpenAI accepts up to 2048 inputs per request and 8191 tokens per input.
   * We cap each call to 96 inputs to keep memory + latency reasonable.
   */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const CHUNK = 96;
    const all: number[][] = [];
    for (let i = 0; i < texts.length; i += CHUNK) {
      const slice = texts.slice(i, i + CHUNK);
      await this.throttle();
      const result = await this.callApi(slice);
      // Ensure ordering by index
      const ordered = result.data
        .slice()
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      all.push(...ordered);
    }
    return all;
  }

  async embedSingle(text: string): Promise<number[]> {
    const [embedding] = await this.embedBatch([text]);
    return embedding;
  }

  /**
   * Small structured-output chat call (gpt-4o-mini, JSON mode).
   * Used for lightweight classification tasks like competitor relevance
   * filtering. Returns the parsed JSON object.
   */
  async chatJson<T>(systemPrompt: string, userPrompt: string): Promise<T> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY missing');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response
          .json()
          .catch(() => ({}))) as OpenAIErrorResponse;
        const message = body.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`OpenAI chat error: ${message}`);
      }

      const json = (await response.json()) as {
        choices: Array<{ message: { content: string } }>;
      };
      return JSON.parse(json.choices[0]?.message?.content ?? '{}') as T;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`OpenAI chat timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async throttle(): Promise<void> {
    const now = Date.now();
    // Drop timestamps older than 1s
    this.callTimestamps = this.callTimestamps.filter((t) => now - t < 1000);
    if (this.callTimestamps.length >= this.maxRps) {
      const oldest = this.callTimestamps[0];
      const wait = 1000 - (now - oldest);
      await new Promise((r) => setTimeout(r, Math.max(wait, 10)));
    }
    this.callTimestamps.push(Date.now());
  }

  private async callApi(inputs: string[]): Promise<OpenAIEmbeddingResponse> {
    if (!this.apiKey) {
      throw new Error('OPENAI_API_KEY missing');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: inputs,
          encoding_format: 'float',
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = (await response
          .json()
          .catch(() => ({}))) as OpenAIErrorResponse;
        const message = body.error?.message ?? `HTTP ${response.status}`;
        throw new Error(`OpenAI embeddings error: ${message}`);
      }

      const json = (await response.json()) as OpenAIEmbeddingResponse;
      this.logger.debug(
        `Embedded ${inputs.length} inputs, ${json.usage.total_tokens} tokens`,
      );
      return json;
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        throw new Error(`OpenAI embeddings timeout after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }
}
