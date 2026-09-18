import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = process.cwd();

test('external ingestion standardizes company before identity and duplicate checks', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/lib/jobIngestion.ts'), 'utf8');
  const start = source.indexOf('export async function ingestExternalJob(');
  const end = source.indexOf('\nexport ', start + 1);
  const body = source.slice(start, end > start ? end : undefined);
  const standardize = body.indexOf('await standardizeIncomingCompany(');
  const fingerprint = body.indexOf('generateV4Fingerprint(title, company, location)');
  const dedupe = body.indexOf('await findLikelyDuplicateJob({');
  assert.ok(standardize >= 0 && standardize < fingerprint && fingerprint < dedupe);
});

test('ordinary ingestion repeats company standardization after canonical URL recovery', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/lib/jobIngestion.ts'), 'utf8');
  const canonical = source.indexOf('finalCanonicalUrl = normalizeUrl(finalCanonicalUrl);');
  const standardize = source.indexOf('company = await standardizeIncomingCompany({', canonical);
  const fingerprint = source.indexOf('identityFingerprint = generateV4Fingerprint(title, company, location);', standardize);
  const enrichedDedupe = source.indexOf('const enrichedDuplicate = await findLikelyDuplicateJob({', fingerprint);
  assert.ok(canonical >= 0 && canonical < standardize && standardize < fingerprint && fingerprint < enrichedDedupe);
});

test('an explicit company edit records future normalization authority transactionally', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'src/app/api/jobs/[id]/route.ts'), 'utf8');
  const transaction = source.indexOf('const mutation = await prisma.$transaction(async (tx) => {');
  const update = source.indexOf('let updated = await tx.job.update({ where: { id }, data });', transaction);
  const correction = source.indexOf('await recordCompanyNameCorrection(tx, {', update);
  const transactionEnd = source.indexOf('\n    });', correction);
  assert.ok(transaction >= 0 && transaction < update && update < correction && correction < transactionEnd);
});
