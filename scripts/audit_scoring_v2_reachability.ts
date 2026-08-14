import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const routePaths = [
  'src/app/api/jobs/export-ai/route.ts',
  'src/app/api/jobs/import-ai/route.ts',
  'src/app/api/jobs/retry/route.ts',
  'src/app/api/pipeline/context/route.ts',
  'src/app/api/pipeline/deepseek/route.ts',
  'src/app/api/scoring/requests/route.ts',
  'src/app/api/scoring/requests/[id]/retry/route.ts',
  'src/app/api/scoring/requests/[id]/cancel/route.ts',
  'src/app/api/scoring/requeue-local/route.ts',
] as const;
const retiredScripts = [
  'scripts/quarantine_scoring_result.ts', 'scripts/audit_scoring_calibration.ts', 'scripts/scoring_run_status.ts',
  'scripts/backfill_score_events.ts', 'scripts/queue_sellsig_cs_recovery.ts', 'scripts/reset_corrupted_scores.ts',
  'scripts/requeue_and_score.ts', 'scripts/requeue_db.ts', 'scripts/restore.ts', 'scripts/stage13.ts',
] as const;

for (const relative of routePaths) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  if (!source.includes("from '@/lib/scoringRetirement'") || !source.includes('nativeScoringRetiredResponse')) {
    throw new Error(`native scoring route is not a 410 retirement shim: ${relative}`);
  }
  if (/nativeScoring(?:Request|Batch|Auto|Lease)/.test(source)) throw new Error(`native route imports executable scoring: ${relative}`);
}
for (const relative of retiredScripts) if (fs.existsSync(path.join(root, relative))) throw new Error(`obsolete mutating script remains: ${relative}`);

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', '.next', '.git'].includes(entry.name)) return [];
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const activeFiles = [path.join(root, 'src'), path.join(root, 'scripts')].flatMap(walk)
  .filter((file) => /\.(?:ts|tsx|py)$/.test(file))
  .filter((file) => !file.endsWith('src/lib/nativeScoringBatch.ts') && !file.endsWith('scripts/scoring_protocol/aim_semantics.py'));
for (const file of activeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file);
  if (/from\s+['"][^'"]*nativeScoringBatch['"]|import\s+['"][^'"]*nativeScoringBatch['"]/.test(source)) {
    throw new Error(`native Aim batch remains executable from ${relative}`);
  }
  if (/from\s+['"][^'"]*aim_semantics['"]|import\s+['"][^'"]*aim_semantics['"]/.test(source)) {
    throw new Error(`historical Aim semantics remain executable from ${relative}`);
  }
  if (!relative.includes('__tests__') && !relative.startsWith('tests/')
    && !relative.endsWith('historical_aim_v1.py')
    && /(?:readFile|read_text|_prompt|load_json)[^\n]*(?:jd-cleaner-v[123]|jd-coverage-auditor-v[12]|aim-evaluator-v[123])/.test(source)) {
    throw new Error(`retired Aim prompt remains reachable from ${relative}`);
  }
}

const packageJson = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
if (/native[_:-]?scoring|quarantine_scoring_result|scoring_run_status|requeue_and_score/.test(packageJson)) {
  throw new Error('package.json exposes a retired scoring command');
}

const personalSkill = path.join(os.homedir(), '.codex/skills/career-dashboard-scoring-protocol/SKILL.md');
if (fs.existsSync(personalSkill)) {
  const source = fs.readFileSync(personalSkill, 'utf8');
  if (/native scoring|agy|aim-result-v1|aim-export-v1/i.test(source)) throw new Error('personal scoring skill dispatches a retired Aim path');
}

console.log(JSON.stringify({ status: 'pass', retiredRoutes: routePaths.length, scannedFiles: activeFiles.length }, null, 2));
