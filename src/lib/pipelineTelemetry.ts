import type { AtsAcquisitionBackpressureTelemetry } from './atsAcquisition';
// Type-only: this module is bundled into the client, and the telemetry reader
// it comes from imports Prisma.
import type { AtsAcquisitionState } from './atsDistributedTelemetry';

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
  state: AtsAcquisitionState;
  rotationDay: string;
  swept: number;
  total: number;
  readyNow: number;
  nextUnlockAt: string | null;
  unlockWithinHour: number;
  lanesBusy: number;
  lanesTotal: number;
  boardsPerHour: number;
  weekCovered: number;
  weekActive: number;
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

const count = (value: number) => value.toLocaleString('en-US');

function telemetryNumber(value: string): number {
  const parsed = Number(value.replaceAll(',', ''));
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

const ATS_ACQUISITION_STATES = ['working', 'waiting', 'stuck', 'done', 'blocked', 'stopped'] as const;

/**
 * Reads the labelled segments the acquisition lane emits.
 *
 * Each segment is read on its own rather than through one line-wide pattern, so
 * a producer that gains a field does not blank the whole panel on the readers
 * that have not caught up yet.
 */
export function parseAtsAcquisitionDetail(value: string): PipelineStatusDetail | undefined {
  const fields = new Map<string, string>();
  for (const segment of value.split('·')) {
    const match = segment.trim().match(/^([A-Za-z]+)\s+(.+)$/);
    if (match) fields.set(match[1], match[2].trim());
  }
  const state = fields.get('State');
  const boards = (fields.get('Boards') || '').match(/^([\d,]+)\/([\d,]+)$/);
  const lanes = (fields.get('Lanes') || '').match(/^([\d,]+)\/([\d,]+)$/);
  const week = (fields.get('Week') || '').match(/^([\d,]+)\/([\d,]+)$/);
  if (!state || !ATS_ACQUISITION_STATES.includes(state as AtsAcquisitionState)) return undefined;
  if (!boards || !lanes) return undefined;
  const unlock = fields.get('Unlock');
  return {
    kind: 'ats-acquisition',
    state: state as AtsAcquisitionState,
    rotationDay: fields.get('Rotation') || 'Rotation',
    swept: telemetryNumber(boards[1]),
    total: telemetryNumber(boards[2]),
    readyNow: telemetryNumber(fields.get('Ready') || '0'),
    nextUnlockAt: unlock && unlock !== 'none' ? unlock : null,
    unlockWithinHour: telemetryNumber(fields.get('Unlocking') || '0'),
    lanesBusy: telemetryNumber(lanes[1]),
    lanesTotal: telemetryNumber(lanes[2]),
    boardsPerHour: telemetryNumber(fields.get('Rate') || '0'),
    weekCovered: week ? telemetryNumber(week[1]) : 0,
    weekActive: week ? telemetryNumber(week[2]) : 0,
  };
}

export type AtsAcquisitionDetail = Extract<PipelineStatusDetail, { kind: 'ats-acquisition' }>;

const ACQUISITION_STATE_LABEL: Record<AtsAcquisitionState, string> = {
  working: 'Working',
  waiting: 'Waiting',
  stuck: 'Stuck',
  done: 'Done',
  blocked: 'Blocked',
  stopped: 'Stopped',
};

export function atsAcquisitionStateLabel(state: AtsAcquisitionState): string {
  return ACQUISITION_STATE_LABEL[state] || state;
}

const clockTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', {
  hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
});

/**
 * Says which kind of zero this is.
 *
 * A finished rotation, one whose remaining boards are all held behind a timer,
 * a paused gate and eight wedged lanes all report no progress. Printing the
 * count alone made them indistinguishable, so a count never appears here
 * without the reason beside it, and a zero is always spelled out in words.
 */
export function atsAcquisitionNote(detail: AtsAcquisitionDetail): string {
  const left = Math.max(0, detail.total - detail.swept);
  const unlock = detail.nextUnlockAt ? clockTime(detail.nextUnlockAt) : null;
  switch (detail.state) {
    case 'done':
      return `every ${detail.rotationDay} board swept — nothing left today`;
    case 'stopped':
      return 'no worker lanes are leased';
    case 'blocked':
      return 'admissions are paused — no new boards are being claimed';
    case 'stuck':
      return `nothing completed in over 30 minutes, and ${count(detail.readyNow)} boards are ready`;
    case 'waiting': {
      if (!unlock) return `${count(left)} left, none ready yet · nothing scheduled to unlock`;
      const within = detail.unlockWithinHour > 0
        ? `, ${count(detail.unlockWithinHour)} within the hour`
        : '';
      return `${count(left)} left, none ready yet · next unlocks ${unlock}${within}`;
    }
    default:
      return `${count(left)} left · ${count(detail.readyNow)} ready now`;
  }
}

/** The week beside the day, so seven good-looking days cannot hide a bad week. */
export function atsWeekHealth(
  covered: number,
  active: number,
): { label: string; tone: 'good' | 'warn' | 'bad' | 'idle' } {
  if (active <= 0) return { label: 'no active boards', tone: 'idle' };
  const percent = Math.round((covered / active) * 100);
  if (covered / active >= 0.99) return { label: `week on track (${percent}%)`, tone: 'good' };
  if (covered / active >= 0.95) return { label: `week slipping (${percent}%)`, tone: 'warn' };
  return { label: `week behind (${percent}%)`, tone: 'bad' };
}

export function atsThroughputLabel(boardsPerHour: number): string {
  return boardsPerHour > 0 ? `${count(boardsPerHour)} boards/hr` : 'no boards completed this hour';
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
