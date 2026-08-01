import fs from 'node:fs';
import path from 'node:path';

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
