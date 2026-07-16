import fs from 'node:fs';
import path from 'node:path';

export type IngestionState = {
  lastCompletedStepIndex: number;
  lastRunTimestamp: number;
};

const RUNTIME_DIR = path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'runtime');
const STATE_FILE = process.env.INGESTION_STATE_FILE || path.join(RUNTIME_DIR, 'ingestion-state.json');

const INITIAL_STATE: IngestionState = {
  lastCompletedStepIndex: -1,
  lastRunTimestamp: 0,
};

function ensureRuntimeDirectory() {
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(STATE_FILE), { recursive: true });
}

export function readIngestionState(): IngestionState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ STATE_FILE, 'utf8'),
    ) as Partial<IngestionState>;
    return {
      lastCompletedStepIndex: typeof parsed.lastCompletedStepIndex === 'number' ? parsed.lastCompletedStepIndex : INITIAL_STATE.lastCompletedStepIndex,
      lastRunTimestamp: typeof parsed.lastRunTimestamp === 'number' ? parsed.lastRunTimestamp : INITIAL_STATE.lastRunTimestamp,
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
