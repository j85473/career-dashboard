import fs from 'node:fs';
import path from 'node:path';
import {
  canonicalJson,
  MANAGER_PROMPT_VERSION,
  manifestHash,
  NATIVE_SCORING_CHUNK_SIZE,
  NATIVE_SCORING_SCHEMA_VERSION,
  NativeScoringChunk,
  NativeScoringJob,
  NativeScoringManifest,
  sha256,
  STANDARD_PROMPT_VERSION,
  WILDCARD_PROMPT_VERSION,
} from '../src/lib/nativeScoringBatch';

type JsonRecord = Record<string, unknown>;

interface ExportJob {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  submittedUpdatedAt: string;
}

interface ScoringExport {
  batchId: string;
  resume: string;
  contextRules: string;
  userPreferences: unknown[];
  wildcardProfile: string;
  explicitWildcardFeedback: string;
  standardJobs: ExportJob[];
  wildcardJobs: ExportJob[];
}

const projectRoot = process.cwd();
const agentsRoot = path.join(projectRoot, '.agents');
const exportPath = path.join(agentsRoot, 'export.json');
const runsRoot = path.join(agentsRoot, 'eval_runs');
const lockPath = path.join(agentsRoot, 'scoring-lock.json');

const promptFiles = {
  standard: '.agents/agents/standard-job-evaluator-v6/agent.md',
  wildcard: '.agents/agents/wildcard-job-evaluator-v6/agent.md',
  manager: '.agents/agents/scoring-manager-v6/agent.md',
} as const;
const evidenceFile = '.agents/minified_evidence.json';

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(record: JsonRecord, expectedKeys: string[], field: string): void {
  const expected = [...expectedKeys].sort();
  const actual = Object.keys(record).sort();
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw new Error(`${field} must contain exactly: ${expected.join(', ')}`);
  }
}

function requiredString(record: JsonRecord, key: string, field: string, allowEmpty = false): string {
  const value = record[key];
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.includes('\u0000')) {
    throw new Error(`${field}.${key} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function parseExportJob(value: unknown, field: string): ExportJob {
  if (!isRecord(value)) {
    throw new Error(`${field} must be an object`);
  }
  exactKeys(
    value,
    ['id', 'title', 'company', 'location', 'description', 'submittedUpdatedAt'],
    field,
  );
  const submittedUpdatedAt = requiredString(value, 'submittedUpdatedAt', field);
  const parsedTimestamp = new Date(submittedUpdatedAt);
  if (
    Number.isNaN(parsedTimestamp.valueOf())
    || parsedTimestamp.toISOString() !== submittedUpdatedAt
  ) {
    throw new Error(
      `${field}.submittedUpdatedAt is missing or invalid. Re-export the batch with the hardened export route.`,
    );
  }
  return {
    id: requiredString(value, 'id', field),
    title: requiredString(value, 'title', field),
    company: requiredString(value, 'company', field),
    location: requiredString(value, 'location', field, true),
    description: requiredString(value, 'description', field),
    submittedUpdatedAt,
  };
}

function parseExport(value: unknown): ScoringExport {
  if (!isRecord(value)) {
    throw new Error('The scoring export must be an object');
  }
  exactKeys(
    value,
    [
      'batchId',
      'resume',
      'contextRules',
      'userPreferences',
      'wildcardProfile',
      'explicitWildcardFeedback',
      'standardJobs',
      'wildcardJobs',
    ],
    'export',
  );
  if (!Array.isArray(value.userPreferences)) {
    throw new Error('export.userPreferences must be an array');
  }
  if (!Array.isArray(value.standardJobs) || !Array.isArray(value.wildcardJobs)) {
    throw new Error('export.standardJobs and export.wildcardJobs must be arrays');
  }
  const standardJobs = value.standardJobs.map((job, index) => parseExportJob(job, `export.standardJobs[${index}]`));
  const wildcardJobs = value.wildcardJobs.map((job, index) => parseExportJob(job, `export.wildcardJobs[${index}]`));
  const allIds = [...standardJobs, ...wildcardJobs].map((job) => job.id);
  if (new Set(allIds).size !== allIds.length) {
    throw new Error('The scoring export contains duplicate job IDs');
  }
  if (allIds.length === 0) {
    throw new Error('The scoring export contains no jobs');
  }
  return {
    batchId: requiredString(value, 'batchId', 'export'),
    resume: requiredString(value, 'resume', 'export'),
    contextRules: requiredString(value, 'contextRules', 'export'),
    userPreferences: value.userPreferences,
    wildcardProfile: requiredString(value, 'wildcardProfile', 'export'),
    explicitWildcardFeedback: requiredString(value, 'explicitWildcardFeedback', 'export', true),
    standardJobs,
    wildcardJobs,
  };
}

function atomicWrite(filePath: string, content: string): void {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  fs.renameSync(temporaryPath, filePath);
}

function readRequiredFile(relativePath: string): Buffer {
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Required file is missing: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath);
}

function chunkJobs(
  type: 'standard' | 'wildcard',
  jobs: ExportJob[],
  batchId: string,
  startingIndex: number,
  chunksDir: string,
): { manifestChunks: NativeScoringManifest['chunks']; nextIndex: number } {
  const manifestChunks: NativeScoringManifest['chunks'] = [];
  let chunkIndex = startingIndex;

  for (let offset = 0; offset < jobs.length; offset += NATIVE_SCORING_CHUNK_SIZE) {
    const chunkId = `chunk_${String(chunkIndex).padStart(4, '0')}`;
    const chunkJobsForFile: NativeScoringJob[] = jobs
      .slice(offset, offset + NATIVE_SCORING_CHUNK_SIZE)
      .map((job) => ({ ...job }));
    const chunk: NativeScoringChunk = {
      schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
      batchId,
      chunkId,
      type,
      jobs: chunkJobsForFile,
    };
    const serializedChunk = `${JSON.stringify(chunk, null, 2)}\n`;
    const inputFile = `chunks/${chunkId}.json`;
    const resultFile = `results/${chunkId}.result.json`;
    atomicWrite(path.join(chunksDir, `${chunkId}.json`), serializedChunk);
    manifestChunks.push({
      chunkId,
      type,
      inputFile,
      resultFile,
      inputHash: sha256(serializedChunk),
      jobs: chunkJobsForFile.map((job) => ({
        id: job.id,
        submittedUpdatedAt: job.submittedUpdatedAt,
      })),
    });
    chunkIndex += 1;
  }

  return { manifestChunks, nextIndex: chunkIndex };
}

function main(): void {
  if (!fs.existsSync(exportPath)) {
    throw new Error(
      'Export file not found. Save a fresh /api/scoring/export response to .agents/export.json.',
    );
  }
  if (fs.existsSync(lockPath)) {
    throw new Error(
      'A scoring lock already exists. Finish or explicitly release that run before preparing another.',
    );
  }

  const rawExport = fs.readFileSync(exportPath);
  const exportData = parseExport(JSON.parse(rawExport.toString('utf8')));
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(exportData.batchId)) {
    throw new Error('The export batchId contains unsafe path characters');
  }

  const runRoot = path.join(runsRoot, exportData.batchId);
  if (fs.existsSync(runRoot)) {
    throw new Error(
      `Run directory already exists and will not be overwritten: ${path.relative(projectRoot, runRoot)}`,
    );
  }

  const chunksDir = path.join(runRoot, 'chunks');
  const resultsDir = path.join(runRoot, 'results');
  fs.mkdirSync(chunksDir, { recursive: true });
  fs.mkdirSync(resultsDir, { recursive: true });

  const exportSnapshotName = 'export.snapshot.json';
  atomicWrite(path.join(runRoot, exportSnapshotName), rawExport.toString('utf8'));
  atomicWrite(
    path.join(runRoot, 'trusted-context.snapshot.json'),
    `${JSON.stringify({
      resume: exportData.resume,
      contextRules: exportData.contextRules,
      userPreferences: exportData.userPreferences,
      wildcardProfile: exportData.wildcardProfile,
      explicitWildcardFeedback: exportData.explicitWildcardFeedback,
    }, null, 2)}\n`,
  );

  const standard = chunkJobs('standard', exportData.standardJobs, exportData.batchId, 0, chunksDir);
  const wildcard = chunkJobs(
    'wildcard',
    exportData.wildcardJobs,
    exportData.batchId,
    standard.nextIndex,
    chunksDir,
  );
  const chunks = [...standard.manifestChunks, ...wildcard.manifestChunks];

  const standardPrompt = readRequiredFile(promptFiles.standard);
  const wildcardPrompt = readRequiredFile(promptFiles.wildcard);
  const managerPrompt = readRequiredFile(promptFiles.manager);
  const evidence = readRequiredFile(evidenceFile);
  const evidenceBlock = /### Minified Evidence Inventory\s*```json\s*([\s\S]*?)\s*```/.exec(
    standardPrompt.toString('utf8'),
  );
  if (!evidenceBlock) {
    throw new Error('The standard evaluator does not contain a parseable baked evidence inventory');
  }
  if (
    canonicalJson(JSON.parse(evidenceBlock[1]))
    !== canonicalJson(JSON.parse(evidence.toString('utf8')))
  ) {
    throw new Error(
      'The baked standard-evaluator evidence does not exactly match .agents/minified_evidence.json',
    );
  }
  const createdAt = new Date().toISOString();

  const unsignedManifest: Omit<NativeScoringManifest, 'manifestHash'> = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: exportData.batchId,
    createdAt,
    chunkSize: NATIVE_SCORING_CHUNK_SIZE,
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'flash',
      expectedModel: 'gemini-3.6-flash',
    },
    prompts: {
      standard: {
        version: STANDARD_PROMPT_VERSION,
        file: promptFiles.standard,
        sha256: sha256(standardPrompt),
      },
      wildcard: {
        version: WILDCARD_PROMPT_VERSION,
        file: promptFiles.wildcard,
        sha256: sha256(wildcardPrompt),
      },
      manager: {
        version: MANAGER_PROMPT_VERSION,
        file: promptFiles.manager,
        sha256: sha256(managerPrompt),
      },
    },
    evidence: {
      file: evidenceFile,
      sha256: sha256(evidence),
    },
    exportSnapshot: {
      file: exportSnapshotName,
      sha256: sha256(rawExport),
    },
    chunks,
  };
  const manifest: NativeScoringManifest = {
    ...unsignedManifest,
    manifestHash: manifestHash(unsignedManifest),
  };
  const manifestPath = path.join(runRoot, 'manifest.json');
  atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const lock = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: exportData.batchId,
    runRoot: path.relative(projectRoot, runRoot),
    manifestFile: path.relative(projectRoot, manifestPath),
    createdAt,
  };
  atomicWrite(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

  console.log(`Prepared immutable native-scoring run ${exportData.batchId}.`);
  console.log(`Standard jobs: ${exportData.standardJobs.length}`);
  console.log(`Wildcard jobs: ${exportData.wildcardJobs.length}`);
  console.log(`Chunks: ${chunks.length}`);
  console.log(`Manifest: ${path.relative(projectRoot, manifestPath)}`);
  console.log('The Antigravity scoring lock is active. Run managers in bounded waves of at most 20 chunks.');
}

try {
  main();
} catch (error: unknown) {
  console.error(`Scoring run preparation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
