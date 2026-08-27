export const TICKER_FALLBACK_MESSAGE = 'Waiting for telemetry...';

type TickerMessageNode = {
  textContent: string | null;
};

type AtsBatchProgress = {
  platform: string;
  slug: string;
  jobs: readonly unknown[];
  processingOffset: number;
  totalJobCount: number;
};

export function currentTickerMessage(text: string | null | undefined): string {
  return text?.trim() ? text : TICKER_FALLBACK_MESSAGE;
}

/**
 * The marquee keeps several repeated DOM nodes so it can scroll seamlessly.
 * Refresh every existing copy when telemetry changes; otherwise an old company
 * remains visible until its entire (often very long) message scrolls away.
 */
export function synchronizeTickerMessageNodes(
  nodes: readonly TickerMessageNode[],
  text: string | null | undefined,
): string {
  const message = currentTickerMessage(text);
  for (const node of nodes) {
    if (node.textContent !== message) node.textContent = message;
  }
  return message;
}

function atsBatchIdentity(batch: Pick<AtsBatchProgress, 'platform' | 'slug'>): string {
  return `${batch.platform}:${batch.slug}`;
}

export function describeAtsBatchChunk(batch: AtsBatchProgress): string {
  const total = Math.max(0, Math.trunc(batch.totalJobCount));
  if (batch.jobs.length === 0 || total === 0) {
    return `${atsBatchIdentity(batch)} - processing synchronized empty batch`;
  }

  const first = Math.max(0, Math.trunc(batch.processingOffset)) + 1;
  const last = Math.min(total, first + batch.jobs.length - 1);
  return `${atsBatchIdentity(batch)} - processing jobs ${first}-${last} of ${total}`;
}

export function describeAtsBatchJob(batch: AtsBatchProgress, chunkJobIndex: number): string {
  const total = Math.max(0, Math.trunc(batch.totalJobCount));
  const current = Math.min(
    total,
    Math.max(0, Math.trunc(batch.processingOffset)) + Math.max(0, Math.trunc(chunkJobIndex)) + 1,
  );
  return `${atsBatchIdentity(batch)} - processing job ${current} of ${total}`;
}
