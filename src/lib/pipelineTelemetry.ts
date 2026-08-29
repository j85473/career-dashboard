export const TICKER_FALLBACK_MESSAGE = 'Waiting for telemetry...';

type AtsBatchProgress = {
  platform: string;
  slug: string;
  jobs: readonly unknown[];
  processingOffset: number;
  totalJobCount: number;
};

export type PipelineStatusRow = {
  id: 'ingestion' | 'ats-acquisition' | 'backpressure' | 'ats-processing' | 'local-scoring' | 'jd-extraction' | 'activity';
  label: string;
  value: string;
};

const CONCURRENT_LANE_BOUNDARY = /\s+\|\s+(?=ATS acquisition(?: PID \d+)?:|Backpressure:|ATS processing:|Local Scoring:|JD Extraction:)/i;

function stripLanePrefix(value: string, pattern: RegExp): string {
  return value.replace(pattern, '').trim() || TICKER_FALLBACK_MESSAGE;
}

/**
 * Turns the six-lane concurrent ticker message into a stable operator view.
 * The first lane intentionally accepts provider-specific progress such as
 * "Dejobs (...)" because ingestion callbacks do not all retain an Ingestion
 * prefix. Non-concurrent states remain a single truthful activity row.
 */
export function pipelineStatusRows(text: string | null | undefined): PipelineStatusRow[] {
  const message = currentTickerMessage(text);
  const lanes = message.split(CONCURRENT_LANE_BOUNDARY);

  if (lanes.length !== 5 && lanes.length !== 6) {
    return [{ id: 'activity', label: 'Current activity', value: message }];
  }

  const hasBackpressureLane = lanes.length === 6;
  const atsProcessingIndex = hasBackpressureLane ? 3 : 2;
  const localScoringIndex = hasBackpressureLane ? 4 : 3;
  const jdExtractionIndex = hasBackpressureLane ? 5 : 4;
  const acquisitionPid = lanes[1].match(/^ATS acquisition PID (\d+):\s*/i)?.[1];
  const acquisition = stripLanePrefix(lanes[1], /^ATS acquisition(?: PID \d+)?:\s*/i);

  return [
    {
      id: 'ingestion',
      label: 'Source ingestion',
      value: stripLanePrefix(lanes[0], /^Ingestion:\s*/i),
    },
    {
      id: 'ats-acquisition',
      label: 'ATS acquisition',
      value: acquisitionPid ? `PID ${acquisitionPid} · ${acquisition}` : acquisition,
    },
    {
      id: 'backpressure',
      label: 'Backpressure',
      value: hasBackpressureLane
        ? stripLanePrefix(lanes[2], /^Backpressure:\s*/i)
        : 'Awaiting telemetry',
    },
    {
      id: 'ats-processing',
      label: 'ATS processing',
      value: stripLanePrefix(lanes[atsProcessingIndex], /^ATS processing:\s*/i),
    },
    {
      id: 'local-scoring',
      label: 'Local scoring',
      value: stripLanePrefix(lanes[localScoringIndex], /^Local Scoring:\s*/i),
    },
    {
      id: 'jd-extraction',
      label: 'JD extraction',
      value: stripLanePrefix(lanes[jdExtractionIndex], /^JD Extraction:\s*/i),
    },
  ];
}

export function currentTickerMessage(text: string | null | undefined): string {
  return text?.trim() ? text : TICKER_FALLBACK_MESSAGE;
}

/**
 * Preserve every ticker item that has already entered the viewport and place
 * the latest state immediately after it. Items that have not appeared yet are
 * coalesced into the newest state so rapid telemetry cannot create a stale
 * backlog.
 */
export function rollingTickerMessageQueue(
  messages: readonly string[],
  enteredCount: number,
  text: string | null | undefined,
): string[] {
  const message = currentTickerMessage(text);
  const preserveCount = messages.length === 0
    ? 0
    : Math.min(messages.length, Math.max(1, Math.trunc(enteredCount)));
  const visibleMessages = messages.slice(0, preserveCount);

  return visibleMessages.at(-1) === message
    ? visibleMessages
    : [...visibleMessages, message];
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
