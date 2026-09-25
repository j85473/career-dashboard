import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

/**
 * The tripwire that keeps employer names from splitting again.
 *
 * Before 2026-09-25 every feature that asked "same company?" normalized names
 * its own way, so each fix covered one feature and the next spelling slipped
 * past another. Every such question now goes through src/lib/employerIdentity.ts
 * (`employerIdentityKey`, `sameEmployer`, `Job.employer`). This test fails when a
 * file outside the list below starts comparing employers with one of the older
 * formatting keys. Route the new code through employerIdentity instead of
 * adding it here.
 */
const OLD_EMPLOYER_KEYS = /\b(companyIdentityKey|sameCompanyIdentity|companyDisplayGroupKey|repeatEmployerKey|employerRelation|normalizeCompany)\(/;

const ALLOWED: Readonly<Record<string, string>> = {
  'src/lib/companyIdentity.ts': 'defines the formatting key',
  'src/lib/companyPresentation.ts': 'defines display grouping',
  'src/lib/employerIdentity.ts': 'reads Joseph\'s rules written under the older key',
  'src/lib/companyNameStandardization.ts': 'arrival-time company standardization from Joseph\'s rules',
  'src/lib/appliedRepeatMatch.ts': 'defines the spelling comparison employerIdentity falls back to',
  'src/lib/jobIngestion.ts': 'posting fingerprints, which narrow duplicate retrieval and never group employers',
  'src/lib/companyIdentityFingerprintRepair.ts': 'repairs those fingerprints',
  'src/lib/atsDirectMatch.ts': 'finds an aggregator listing\'s posting on the employer\'s own ATS board',
  'src/lib/jobUrlReconciliation.ts': 'kept beside sameEmployer; either one lets a URL-edit merge proceed',
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(entry) ? [full] : [];
  });
}

test('every "same employer?" question goes through employerIdentity', () => {
  const root = process.cwd();
  const offenders = sourceFiles(path.join(root, 'src'))
    .map((file) => path.relative(root, file).split(path.sep).join('/'))
    .filter((file) => !(file in ALLOWED))
    .filter((file) => OLD_EMPLOYER_KEYS.test(readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(offenders, [], 'compare employers with employerIdentityKey / sameEmployer from src/lib/employerIdentity.ts');
});

test('cooldown, company pages and the dashboard read the canonical employer', () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), 'utf8');
  assert.match(read('src/lib/companyCooldown.ts'), /employerIdentityKey/);
  assert.match(read('src/lib/companyJobQuery.ts'), /employer: value/);
  assert.match(read('src/components/Dashboard.tsx'), /sameEmployer/);
  assert.match(read('src/components/JobCard.tsx'), /job\.employer \|\| companyDisplayName/);
  // Scoring keeps reading the source's own spelling; an export bound to the
  // derived name would be rejected at import whenever the name was refined.
  assert.doesNotMatch(read('src/lib/scoringExport.ts'), /\.employer\b/);
});
