import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = (relativePath: string) => readFileSync(path.join(process.cwd(), relativePath), 'utf8');

test('operator fresh start preserves completed results and filters only unfinished detail items', () => {
  const reset = source('scripts/reset_ats_acquisition_fresh_start.ts');
  const ingestion = source('src/lib/jobIngestion.ts');
  const ledger = source('src/lib/atsAcquisitionLedger.ts');
  assert.match(reset, /item\."enrichmentStatus" = 'pending'/);
  assert.match(reset, /"enrichmentStatus" = 'terminal'/);
  assert.match(reset, /"status" = 'reset_draining'/);
  assert.match(reset, /status: 'operator_abandoned'/);
  assert.match(reset, /data: \{ state: 'failed', outcome: ATS_OPERATOR_RESET_ABANDONED_REASON \}/);
  assert.match(reset, /set_config\('career_dashboard\.ats_v2_writer', '2', true\)/);
  assert.match(reset, /withProviderTransactionRetry\(\(\) => prisma\.\$transaction/);
  assert.match(ingestion, /atsEnrichmentMarker\?\.reason === ATS_OPERATOR_RESET_ABANDONED_REASON/);
  assert.match(ingestion, /stats\.seen\+\+;[\s\S]+?stats\.filtered\+\+;/);
  assert.match(ledger, /resetDrain \? 'reset_draining' : 'partial'/);
  assert.match(ledger, /if \(complete && !resetDrain\)/);
});

test('fresh start realigns cohorts and stores an automatic admission-resume instant', () => {
  const reset = source('scripts/reset_ats_acquisition_fresh_start.ts');
  const coordination = source('src/lib/atsAcquisitionCoordination.ts');
  assert.match(reset, /INTERVAL '1 minute'/);
  assert.match(reset, /board\."checkDay" - schedule\.start_day \+ 7/);
  assert.match(reset, /admissionResumeAt: resumeAt/);
  assert.match(coordination, /admissionResumeAt: \{ lte: now \}/);
  assert.match(coordination, /admissionState: 'open'/);
});
