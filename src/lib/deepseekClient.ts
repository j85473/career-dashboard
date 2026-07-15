import { prisma } from './prisma';

export const DEFAULT_DEEPSEEK_SCORING_MODEL = 'deepseek-v4-pro';

interface DeepseekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

interface DeepseekApiResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null };
  }>;
  usage?: DeepseekUsage;
}

export interface DeepseekJsonRequest<T> {
  purpose: 'standard_scoring' | 'wildcard_scoring' | 'manual_metadata';
  systemPrompt: string;
  payload: unknown;
  batchSize: number;
  maxTokens?: number;
  validate: (value: unknown) => T;
}

export interface DeepseekJsonResult<T> {
  value: T;
  model: string;
  requestId: string | null;
  finishReason: string;
}

class DeepseekRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = 'DeepseekRequestError';
  }
}

function positiveIntFromEnv(name: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const jsonText = fenced ? fenced[1].trim() : content.trim();
  if (!jsonText) throw new DeepseekRequestError('DeepSeek returned an empty response', true);
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new DeepseekRequestError('DeepSeek returned invalid JSON', true);
  }
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function estimatedCost(model: string, usage: DeepseekUsage | undefined): number {
  if (!usage) return 0;
  const rates = model.includes('v4-pro')
    ? { hit: 0.003625, miss: 0.435, output: 0.87 }
    : model.includes('v4-flash')
      ? { hit: 0.0028, miss: 0.14, output: 0.28 }
      : null;
  if (!rates) return 0;

  const hit = usage.prompt_cache_hit_tokens || 0;
  const miss = usage.prompt_cache_miss_tokens
    ?? Math.max(0, (usage.prompt_tokens || 0) - hit);
  const output = usage.completion_tokens || 0;
  return ((hit * rates.hit) + (miss * rates.miss) + (output * rates.output)) / 1_000_000;
}

async function recordUsage(input: {
  purpose: DeepseekJsonRequest<unknown>['purpose'];
  status: 'succeeded' | 'failed';
  model: string;
  requestId: string | null;
  batchSize: number;
  latencyMs: number;
  attempt: number;
  finishReason: string | null;
  usage?: DeepseekUsage;
  error?: string;
}) {
  const usage = input.usage;
  try {
    await prisma.aiUsageEvent.create({
      data: {
        provider: 'deepseek',
        purpose: input.purpose,
        status: input.status,
        model: input.model,
        requestId: input.requestId,
        batchSize: input.batchSize,
        latencyMs: input.latencyMs,
        attempt: input.attempt,
        finishReason: input.finishReason,
        promptTokens: usage?.prompt_tokens || 0,
        cacheHitTokens: usage?.prompt_cache_hit_tokens || 0,
        cacheMissTokens: usage?.prompt_cache_miss_tokens || 0,
        completionTokens: usage?.completion_tokens || 0,
        reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens || 0,
        totalTokens: usage?.total_tokens || 0,
        estimatedCost: estimatedCost(input.model, usage),
        error: input.error?.slice(0, 2_000),
      },
    });
  } catch (error) {
    console.warn('Unable to record DeepSeek usage metadata:', error instanceof Error ? error.message : String(error));
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export async function callDeepseekJson<T>(request: DeepseekJsonRequest<T>): Promise<DeepseekJsonResult<T>> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error('DEEPSEEK_API_KEY is not set in the environment variables.');

  const model = process.env.DEEPSEEK_SCORING_MODEL?.trim() || DEFAULT_DEEPSEEK_SCORING_MODEL;
  const attempts = positiveIntFromEnv('DEEPSEEK_MAX_RETRIES', 3, 5);
  const timeoutMs = positiveIntFromEnv('DEEPSEEK_TIMEOUT_MS', 90_000, 300_000);
  const maxTokens = request.maxTokens
    ?? positiveIntFromEnv('DEEPSEEK_SCORING_MAX_TOKENS', 8_000, 32_000);

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let responseData: DeepseekApiResponse | undefined;
    let finishReason: string | null = null;

    try {
      const attemptMaxTokens = Math.min(32_000, maxTokens * (2 ** (attempt - 1)));
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: request.systemPrompt },
            { role: 'user', content: JSON.stringify(request.payload) },
          ],
          thinking: { type: 'enabled' },
          reasoning_effort: 'high',
          max_tokens: attemptMaxTokens,
          stream: false,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 500);
        throw new DeepseekRequestError(
          `DeepSeek API error ${response.status}${detail ? `: ${detail}` : ''}`,
          retryableStatus(response.status),
        );
      }

      responseData = await response.json() as DeepseekApiResponse;
      const choice = responseData.choices?.[0];
      finishReason = choice?.finish_reason || null;
      if (finishReason !== 'stop') {
        const retryable = finishReason === 'length' || finishReason === 'insufficient_system_resource';
        throw new DeepseekRequestError(`DeepSeek stopped with finish_reason=${finishReason || 'missing'}`, retryable);
      }

      const parsed = extractJson(choice?.message?.content || '');
      let value: T;
      try {
        value = request.validate(parsed);
      } catch (error) {
        throw new DeepseekRequestError(`DeepSeek response schema was invalid: ${safeErrorMessage(error)}`, true);
      }

      await recordUsage({
        purpose: request.purpose,
        status: 'succeeded',
        model: responseData.model || model,
        requestId: responseData.id || null,
        batchSize: request.batchSize,
        latencyMs: Date.now() - startedAt,
        attempt,
        finishReason,
        usage: responseData.usage,
      });

      return {
        value,
        model: responseData.model || model,
        requestId: responseData.id || null,
        finishReason,
      };
    } catch (error) {
      lastError = error;
      const normalized = error instanceof DeepseekRequestError
        ? error
        : new DeepseekRequestError(
          controller.signal.aborted ? 'DeepSeek request timed out' : safeErrorMessage(error),
          true,
        );

      await recordUsage({
        purpose: request.purpose,
        status: 'failed',
        model: responseData?.model || model,
        requestId: responseData?.id || null,
        batchSize: request.batchSize,
        latencyMs: Date.now() - startedAt,
        attempt,
        finishReason,
        usage: responseData?.usage,
        error: normalized.message,
      });

      if (!normalized.retryable || attempt === attempts) {
        throw normalized;
      }

      const backoffMs = Math.min(8_000, 750 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 250);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('DeepSeek request failed');
}
