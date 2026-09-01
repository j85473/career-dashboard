import type { AtsAcquisitionBackpressureTelemetry } from './atsAcquisition';

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
  detail?: PipelineStatusDetail;
};

export type PipelineStatusDetail = {
  kind: 'ats-acquisition';
  macSlots: number;
  globalSlots: number;
  state: string;
  cohorts: Array<{
    id: 'today' | 'backlog' | 'cooldown';
    label: string;
    completed: number;
    total: number;
  }>;
} | {
  kind: 'ats-stages';
  flow: string;
  pauseAt: number;
  resumeAt: number;
  stages: Array<{
    id: 'listing' | 'compaction' | 'enrichment' | 'sealing' | 'publication' | 'persistence';
    label: string;
    value: number;
  }>;
};

const CONCURRENT_LANE_BOUNDARY = /\s+\|\s+(?=ATS acquisition(?: PID \d+)?:|Backpressure:|ATS processing:|Local Scoring:|JD Extraction:)/i;

function stripLanePrefix(value: string, pattern: RegExp): string {
  return value.replace(pattern, '').trim() || TICKER_FALLBACK_MESSAGE;
}

export function formatAtsBackpressureTelemetry(
  telemetry: AtsAcquisitionBackpressureTelemetry,
): string {
  const number = (value: number | undefined) => (value ?? 0).toLocaleString('en-US');
  const pressureActive = telemetry.active || telemetry.publicationPaused === true;
  const flow = telemetry.admissionState === 'draining'
    ? 'Admissions paused'
    : pressureActive ? 'Throttled' : 'Normal';
  return [
    `Backpressure: Flow ${flow}`,
    `Listing ${number(telemetry.listingJobs)}`,
    `Compaction ${number(telemetry.compactionJobs)}`,
    `Enrichment ${number(telemetry.enrichmentJobs)}`,
    `Sealing ${number(telemetry.terminalUnsealedJobs ?? telemetry.publicationJobs)}`,
    `Publication ${number(telemetry.sealedUnpublishedJobs)}`,
    `Normalization & persistence ${number(telemetry.remainingJobs)}`,
    `Pause ${number(telemetry.highWatermark)}`,
    `Resume ${number(telemetry.lowWatermark)}`,
  ].join(' · ');
}

function telemetryNumber(value: string): number {
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

export function parseAtsAcquisitionDetail(value: string): PipelineStatusDetail | undefined {
  const match = value.match(
    /^Mac (\d+)\/(\d+) lanes · Today complete ([\d,]+)\/([\d,]+) · Backlog complete ([\d,]+)\/([\d,]+) · Cooldown complete ([\d,]+)\/([\d,]+) · (.+)$/,
  );
  if (!match) return undefined;
  return {
    kind: 'ats-acquisition',
    macSlots: telemetryNumber(match[1]),
    globalSlots: telemetryNumber(match[2]),
    state: match[9],
    cohorts: [
      { id: 'today', label: "Today's boards", completed: telemetryNumber(match[3]), total: telemetryNumber(match[4]) },
      { id: 'backlog', label: 'Backlog boards', completed: telemetryNumber(match[5]), total: telemetryNumber(match[6]) },
      { id: 'cooldown', label: 'Cooldown boards', completed: telemetryNumber(match[7]), total: telemetryNumber(match[8]) },
    ],
  };
}

export function parseAtsStageDetail(value: string): PipelineStatusDetail | undefined {
  const match = value.match(
    /^Flow ([^·]+) · Listing ([\d,]+) · Compaction ([\d,]+) · Enrichment ([\d,]+) · Sealing ([\d,]+) · Publication ([\d,]+) · Normalization & persistence ([\d,]+) · Pause ([\d,]+) · Resume ([\d,]+)$/,
  );
  if (!match) return undefined;
  return {
    kind: 'ats-stages',
    flow: match[1].trim(),
    pauseAt: telemetryNumber(match[8]),
    resumeAt: telemetryNumber(match[9]),
    stages: [
      { id: 'listing', label: 'Listing', value: telemetryNumber(match[2]) },
      { id: 'compaction', label: 'Compaction', value: telemetryNumber(match[3]) },
      { id: 'enrichment', label: 'Enrichment', value: telemetryNumber(match[4]) },
      { id: 'sealing', label: 'Sealing', value: telemetryNumber(match[5]) },
      { id: 'publication', label: 'Publication', value: telemetryNumber(match[6]) },
      { id: 'persistence', label: 'Normalization & persistence', value: telemetryNumber(match[7]) },
    ],
  };
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
  const backpressure = hasBackpressureLane
    ? stripLanePrefix(lanes[2], /^Backpressure:\s*/i)
    : 'Awaiting telemetry';
  const acquisitionDetail = acquisitionPid ? undefined : parseAtsAcquisitionDetail(acquisition);
  const stageDetail = parseAtsStageDetail(backpressure);

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
      ...(acquisitionDetail ? { detail: acquisitionDetail } : {}),
    },
    {
      id: 'backpressure',
      label: 'ATS stages',
      value: backpressure,
      ...(stageDetail ? { detail: stageDetail } : {}),
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

export function describeAtsBatchChunk(batch: AtsBatchProgress): string {
  const total = Math.max(0, Math.trunc(batch.totalJobCount));
  if (batch.jobs.length === 0 || total === 0) {
    return `Finalizing empty board · ${batch.platform} / ${batch.slug}`;
  }

  const first = Math.max(0, Math.trunc(batch.processingOffset)) + 1;
  const last = Math.min(total, first + batch.jobs.length - 1);
  return `Normalizing & persisting · ${batch.platform} / ${batch.slug} · jobs ${first}-${last} of ${total}`;
}

export function describeAtsBatchJob(batch: AtsBatchProgress, chunkJobIndex: number): string {
  const total = Math.max(0, Math.trunc(batch.totalJobCount));
  const current = Math.min(
    total,
    Math.max(0, Math.trunc(batch.processingOffset)) + Math.max(0, Math.trunc(chunkJobIndex)) + 1,
  );
  return `Normalizing & persisting · ${batch.platform} / ${batch.slug} · job ${current} of ${total}`;
}
