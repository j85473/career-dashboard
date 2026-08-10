import fs from 'node:fs';
import path from 'node:path';
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';

export type IngestionState = {
  lastCompletedStepIndex: number; // Used for legacy/standard steps if needed
  lastRunCareerforce: number;
  lastRunPaidApis: number;
  lastRunApify: number;
  lastRunAts: number;
  lastRunStandard: number;
  atsIndex: number;
};

const RUNTIME_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'runtime');
const STATE_FILE = process.env.INGESTION_STATE_FILE || path.join(RUNTIME_DIR, 'ingestion-state.json');

const INITIAL_STATE: IngestionState = {
  lastCompletedStepIndex: -1,
  lastRunCareerforce: 0,
  lastRunPaidApis: 0,
  lastRunApify: 0,
  lastRunAts: 0,
  lastRunStandard: 0,
  atsIndex: 0,
};

const DURABLE_SCHEDULER_TASK_KEY = 'scheduler:v2:legacy-orchestration';

function ensureRuntimeDirectory() {
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(STATE_FILE), { recursive: true });
}

export function readIngestionState(): IngestionState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ STATE_FILE, 'utf8'),
    ) as Partial<IngestionState> & { lastRunTimestamp?: number };

    // Migrate from old state if necessary
    const fallbackTime = typeof parsed.lastRunTimestamp === 'number' ? parsed.lastRunTimestamp : INITIAL_STATE.lastRunStandard;

    return {
      lastCompletedStepIndex: typeof parsed.lastCompletedStepIndex === 'number' ? parsed.lastCompletedStepIndex : INITIAL_STATE.lastCompletedStepIndex,
      lastRunCareerforce: typeof parsed.lastRunCareerforce === 'number' ? parsed.lastRunCareerforce : fallbackTime,
      lastRunPaidApis: typeof parsed.lastRunPaidApis === 'number' ? parsed.lastRunPaidApis : fallbackTime,
      lastRunApify: typeof parsed.lastRunApify === 'number' ? parsed.lastRunApify : fallbackTime,
      lastRunAts: typeof parsed.lastRunAts === 'number' ? parsed.lastRunAts : fallbackTime,
      lastRunStandard: typeof parsed.lastRunStandard === 'number' ? parsed.lastRunStandard : fallbackTime,
      atsIndex: typeof parsed.atsIndex === 'number' ? parsed.atsIndex : INITIAL_STATE.atsIndex,
    };
  } catch {
    return { ...INITIAL_STATE };
  }
}

export function writeIngestionState(state: IngestionState): void {
  ensureRuntimeDirectory();
  const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(/* turbopackIgnore: true */ temporaryFile, JSON.stringify(state));
  fs.renameSync(/* turbopackIgnore: true */ temporaryFile, STATE_FILE);
}

function normalizeState(parsed: Partial<IngestionState> & { lastRunTimestamp?: number }): IngestionState {
  const fallbackTime = typeof parsed.lastRunTimestamp === 'number'
    ? parsed.lastRunTimestamp
    : INITIAL_STATE.lastRunStandard;
  return {
    lastCompletedStepIndex: typeof parsed.lastCompletedStepIndex === 'number' ? parsed.lastCompletedStepIndex : INITIAL_STATE.lastCompletedStepIndex,
    lastRunCareerforce: typeof parsed.lastRunCareerforce === 'number' ? parsed.lastRunCareerforce : fallbackTime,
    lastRunPaidApis: typeof parsed.lastRunPaidApis === 'number' ? parsed.lastRunPaidApis : fallbackTime,
    lastRunApify: typeof parsed.lastRunApify === 'number' ? parsed.lastRunApify : fallbackTime,
    lastRunAts: typeof parsed.lastRunAts === 'number' ? parsed.lastRunAts : fallbackTime,
    lastRunStandard: typeof parsed.lastRunStandard === 'number' ? parsed.lastRunStandard : fallbackTime,
    atsIndex: typeof parsed.atsIndex === 'number' ? parsed.atsIndex : INITIAL_STATE.atsIndex,
  };
}

function isMissingDurableSchema(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error.code === 'P2021' || error.code === 'P2022');
}

/**
 * Database state is authoritative after the expand migration. The JSON file is
 * retained only as a fail-soft bridge for development and pre-migration hosts.
 */
export async function readDurableIngestionState(): Promise<IngestionState> {
  const fileState = readIngestionState();
  try {
    const task = await prisma.ingestionTask.upsert({
      where: { taskKey: DURABLE_SCHEDULER_TASK_KEY },
      update: {},
      create: {
        taskKey: DURABLE_SCHEDULER_TASK_KEY,
        source: 'scheduler',
        queryFamily: 'all',
        searchQuery: null,
        geoLane: 'all',
        ingestionMode: 'orchestration',
        status: 'succeeded',
        nextRunAt: new Date(0),
        cursor: fileState as unknown as Prisma.InputJsonValue,
      },
    });
    if (!task.cursor || typeof task.cursor !== 'object' || Array.isArray(task.cursor)) return fileState;
    return normalizeState(task.cursor as Partial<IngestionState>);
  } catch (error) {
    if (isMissingDurableSchema(error)) return fileState;
    throw error;
  }
}

export async function writeDurableIngestionState(state: IngestionState): Promise<void> {
  try {
    await prisma.ingestionTask.upsert({
      where: { taskKey: DURABLE_SCHEDULER_TASK_KEY },
      update: {
        cursor: state as unknown as Prisma.InputJsonValue,
        status: 'succeeded',
        lastCompletedAt: new Date(),
      },
      create: {
        taskKey: DURABLE_SCHEDULER_TASK_KEY,
        source: 'scheduler',
        queryFamily: 'all',
        searchQuery: null,
        geoLane: 'all',
        ingestionMode: 'orchestration',
        status: 'succeeded',
        nextRunAt: new Date(0),
        cursor: state as unknown as Prisma.InputJsonValue,
        lastCompletedAt: new Date(),
      },
    });
  } catch (error) {
    if (!isMissingDurableSchema(error)) throw error;
  }

  // Maintain a local recovery copy, but never rely on it as the durable source.
  try {
    writeIngestionState(state);
  } catch (error) {
    console.warn('Could not write the optional ingestion-state recovery file:', error);
  }
}
