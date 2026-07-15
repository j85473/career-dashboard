import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export async function GET() {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const [usage, recentDeepseekEvents] = await Promise.all([
      prisma.usageTracking.findUnique({ where: { date: today } }),
      prisma.aiUsageEvent.findMany({
        where: {
          provider: 'deepseek',
          createdAt: { gte: new Date(Date.now() - 36 * 60 * 60 * 1_000) },
        },
        select: {
          status: true,
          promptTokens: true,
          cacheHitTokens: true,
          cacheMissTokens: true,
          completionTokens: true,
          reasoningTokens: true,
          totalTokens: true,
          estimatedCost: true,
          latencyMs: true,
          createdAt: true,
        },
      }),
    ]);

    const deepseekEvents = recentDeepseekEvents.filter((event) => (
      event.createdAt.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }) === today
    ));
    const deepseek = deepseekEvents.reduce((totals, event) => ({
      attempts: totals.attempts + 1,
      succeeded: totals.succeeded + (event.status === 'succeeded' ? 1 : 0),
      failed: totals.failed + (event.status === 'failed' ? 1 : 0),
      inputTokens: totals.inputTokens + event.promptTokens,
      cacheHitTokens: totals.cacheHitTokens + event.cacheHitTokens,
      cacheMissTokens: totals.cacheMissTokens + event.cacheMissTokens,
      outputTokens: totals.outputTokens + event.completionTokens,
      reasoningTokens: totals.reasoningTokens + event.reasoningTokens,
      totalTokens: totals.totalTokens + event.totalTokens,
      estimatedCost: totals.estimatedCost + event.estimatedCost,
      totalLatencyMs: totals.totalLatencyMs + event.latencyMs,
    }), {
      attempts: 0,
      succeeded: 0,
      failed: 0,
      inputTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      totalLatencyMs: 0,
    });

    const gemini = {
      inputTokens: usage?.inputTokens || 0,
      outputTokens: usage?.outputTokens || 0,
      cost: usage?.cost || 0,
    };

    return NextResponse.json({
      // Preserve the original top-level fields for existing dashboard consumers.
      ...gemini,
      gemini,
      deepseek: {
        attempts: deepseek.attempts,
        succeeded: deepseek.succeeded,
        failed: deepseek.failed,
        inputTokens: deepseek.inputTokens,
        cacheHitTokens: deepseek.cacheHitTokens,
        cacheMissTokens: deepseek.cacheMissTokens,
        outputTokens: deepseek.outputTokens,
        reasoningTokens: deepseek.reasoningTokens,
        totalTokens: deepseek.totalTokens,
        estimatedCost: deepseek.estimatedCost,
        averageLatencyMs: deepseek.attempts > 0
          ? Math.round(deepseek.totalLatencyMs / deepseek.attempts)
          : 0,
      },
    });
  } catch (error) {
    console.error('Failed to fetch usage:', error);
    return NextResponse.json({ error: 'Failed to fetch usage' }, { status: 500 });
  }
}
