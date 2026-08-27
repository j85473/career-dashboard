import type { Prisma } from '@prisma/client';

import { buildIngestionTaskKey, type IngestionTaskSpec } from './ingestionControl';
import {
  ATS_ACQUISITION_TASK_DEFINITION,
  atsPlatformTaskDefinition,
} from './ingestionTaskCatalog';

export type AtsTaskModeRow = {
  id: string;
  taskKey: string;
  source: string;
  ingestionMode: string;
  taskKind: string;
  lifecycleStatus: string;
  retiredAt: Date | null;
  status: string;
  leaseToken: string | null;
  leaseOwner: string | null;
  leaseStartedAt: Date | null;
  heartbeatAt: Date | null;
  leaseExpiresAt: Date | null;
  lastError: string | null;
};

type AtsTaskActivation = {
  spec: IngestionTaskSpec;
  row: AtsTaskModeRow | null;
};

export type AtsTaskModeTransitionPlan = {
  mode: 'split' | 'legacy';
  activate: AtsTaskActivation[];
  retire: AtsTaskModeRow[];
  stale: AtsTaskModeRow[];
  blocked: AtsTaskModeRow[];
};

export type AtsTaskModeTransitionResult = {
  mode: 'split' | 'legacy';
  activated: number;
  retired: number;
  recoveredStaleLeases: number;
  unchanged: number;
};

export class AtsTaskModeTransitionBlockedError extends Error {
  constructor(readonly taskKeys: readonly string[]) {
    super(`ATS task-mode transition is blocked by leased task(s): ${taskKeys.join(', ')}`);
    this.name = 'AtsTaskModeTransitionBlockedError';
  }
}

function legacyTaskRow(row: Pick<AtsTaskModeRow, 'source' | 'ingestionMode'>): boolean {
  return row.ingestionMode === 'ats' && row.source.startsWith('ATS-');
}

function rowNeedsActivation(row: AtsTaskModeRow): boolean {
  return row.taskKind !== 'search'
    || row.lifecycleStatus !== 'active'
    || row.retiredAt !== null;
}

function rowHasLeaseState(row: AtsTaskModeRow): boolean {
  return row.leaseToken !== null || row.status === 'running';
}

function rowHasLiveLease(row: AtsTaskModeRow, now: Date): boolean {
  if (!rowHasLeaseState(row)) return false;
  // A missing expiry cannot prove that an owner is dead, so it fails closed.
  return row.leaseExpiresAt === null || row.leaseExpiresAt.getTime() > now.getTime();
}

function rowHasExpiredLease(row: AtsTaskModeRow, now: Date): boolean {
  return rowHasLeaseState(row)
    && row.leaseExpiresAt !== null
    && row.leaseExpiresAt.getTime() <= now.getTime();
}

/** Pure transition planning keeps the lease policy independently testable. */
export function planAtsTaskModeTransition(input: {
  splitEnabled: boolean;
  rows: readonly AtsTaskModeRow[];
  legacyPlatforms: readonly string[];
  now?: Date;
}): AtsTaskModeTransitionPlan {
  const now = input.now || new Date();
  const acquisitionSpec = ATS_ACQUISITION_TASK_DEFINITION.spec;
  const acquisitionKey = buildIngestionTaskKey(acquisitionSpec);
  const rowsByKey = new Map(input.rows.map((row) => [row.taskKey, row]));
  const existingLegacyPlatforms = input.rows
    .filter(legacyTaskRow)
    .map((row) => row.source.slice('ATS-'.length))
    .filter(Boolean);
  const legacyPlatforms = [...new Set([
    ...input.legacyPlatforms,
    ...existingLegacyPlatforms,
  ])].sort();
  const activeSpecs = input.splitEnabled
    ? [acquisitionSpec]
    : legacyPlatforms.map((platform) => atsPlatformTaskDefinition(platform).spec);
  const activeKeys = new Set(activeSpecs.map(buildIngestionTaskKey));
  const retireRows = input.rows.filter((row) => input.splitEnabled
    ? legacyTaskRow(row) && !activeKeys.has(row.taskKey)
    : row.taskKey === acquisitionKey);

  const activate = activeSpecs.flatMap((spec) => {
    const row = rowsByKey.get(buildIngestionTaskKey(spec)) || null;
    return row && !rowNeedsActivation(row) ? [] : [{ spec, row }];
  });
  const retire = retireRows.filter((row) => row.lifecycleStatus !== 'retired' || row.retiredAt === null);
  const stale = input.rows.filter((row) => rowHasExpiredLease(row, now));
  const blocked = [
    ...activate.flatMap((action) => action.row && rowHasLiveLease(action.row, now) ? [action.row] : []),
    // A lease on the lane being deactivated is a conflict even if its row was
    // already marked retired: the prior owner may still be finishing work.
    ...retireRows.filter((row) => rowHasLiveLease(row, now)),
  ];

  return {
    mode: input.splitEnabled ? 'split' : 'legacy',
    activate,
    retire,
    stale,
    blocked: [...new Map(blocked.map((row) => [row.id, row])).values()],
  };
}

type AtsTaskModeClient = Pick<Prisma.TransactionClient, 'atsCompany' | 'ingestionTask'>;

/**
 * Switch only the two direct-ATS scheduler lanes. Existing counters, cursors,
 * watermarks, error history, cadence, and completion timestamps are retained.
 * Every update has a lease predicate so a race can fail closed but can never
 * rewrite a task another process owns.
 */
export async function applyAtsTaskModeTransition(
  client: AtsTaskModeClient,
  input: { splitEnabled: boolean; now?: Date },
): Promise<AtsTaskModeTransitionResult> {
  const now = input.now || new Date();
  const [platformRows, rows] = await Promise.all([
    client.atsCompany.findMany({
      distinct: ['platform'],
      select: { platform: true },
    }),
    client.ingestionTask.findMany({
      where: {
        OR: [
          { taskKey: buildIngestionTaskKey(ATS_ACQUISITION_TASK_DEFINITION.spec) },
          { source: { startsWith: 'ATS-' }, ingestionMode: 'ats' },
        ],
      },
      select: {
        id: true,
        taskKey: true,
        source: true,
        ingestionMode: true,
        taskKind: true,
        lifecycleStatus: true,
        retiredAt: true,
        status: true,
        leaseToken: true,
        leaseOwner: true,
        leaseStartedAt: true,
        heartbeatAt: true,
        leaseExpiresAt: true,
        lastError: true,
      },
    }),
  ]);
  const plan = planAtsTaskModeTransition({
    splitEnabled: input.splitEnabled,
    rows,
    legacyPlatforms: platformRows.map((row) => row.platform),
    now,
  });
  if (plan.blocked.length > 0) {
    throw new AtsTaskModeTransitionBlockedError(plan.blocked.map((row) => row.taskKey));
  }

  // A crashed prior lane can leave a token after its bounded lease has
  // expired. Recover it inside this same transaction before changing mode;
  // otherwise the transition runs before the ordinary cleanup loop and can
  // deadlock every future pipeline start. The expiry predicate prevents a
  // concurrent heartbeat from being overwritten.
  let recoveredStaleLeases = 0;
  for (const row of plan.stale) {
    const result = await client.ingestionTask.updateMany({
      where: {
        id: row.id,
        leaseExpiresAt: { lte: now },
        ...(row.leaseToken !== null
          ? { leaseToken: row.leaseToken }
          : { leaseToken: null, status: 'running' }),
      },
      data: {
        status: 'failed',
        leaseToken: null,
        leaseOwner: null,
        leaseStartedAt: null,
        heartbeatAt: now,
        leaseExpiresAt: null,
        lastError: [row.lastError, 'ATS task lease expired before the ingestion mode transition.']
          .filter(Boolean)
          .join(' | ')
          .slice(0, 1000),
      },
    });
    if (result.count !== 1) {
      throw new AtsTaskModeTransitionBlockedError([row.taskKey]);
    }
    recoveredStaleLeases++;
  }

  let activated = 0;
  for (const action of plan.activate) {
    if (action.row) {
      const result = await client.ingestionTask.updateMany({
        where: {
          id: action.row.id,
          leaseToken: null,
          status: { not: 'running' },
        },
        data: {
          source: action.spec.source,
          queryFamily: action.spec.queryFamily || null,
          searchQuery: action.spec.searchQuery || null,
          geoLane: action.spec.geoLane,
          ingestionMode: action.spec.ingestionMode,
          taskKind: 'search',
          lifecycleStatus: 'active',
          retiredAt: null,
        },
      });
      if (result.count !== 1) {
        throw new AtsTaskModeTransitionBlockedError([action.row.taskKey]);
      }
    } else {
      await client.ingestionTask.create({
        data: {
          taskKey: buildIngestionTaskKey(action.spec),
          source: action.spec.source,
          queryFamily: action.spec.queryFamily || null,
          searchQuery: action.spec.searchQuery || null,
          geoLane: action.spec.geoLane,
          ingestionMode: action.spec.ingestionMode,
          taskKind: 'search',
          lifecycleStatus: 'active',
          nextRunAt: now,
        },
      });
    }
    activated++;
  }

  let retired = 0;
  for (const row of plan.retire) {
    const result = await client.ingestionTask.updateMany({
      where: {
        id: row.id,
        leaseToken: null,
        status: { not: 'running' },
      },
      data: { lifecycleStatus: 'retired', retiredAt: now },
    });
    if (result.count !== 1) {
      throw new AtsTaskModeTransitionBlockedError([row.taskKey]);
    }
    retired++;
  }

  return {
    mode: plan.mode,
    activated,
    retired,
    recoveredStaleLeases,
    unchanged: rows.length - new Set([
      ...plan.stale.map((row) => row.id),
      ...plan.retire.map((row) => row.id),
      ...plan.activate.flatMap((action) => action.row ? [action.row.id] : []),
    ]).size,
  };
}
