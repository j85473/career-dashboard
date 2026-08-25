import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = process.cwd();

test('generic job edits maintain identity before duplicate suppression', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/api/jobs/[id]/route.ts'), 'utf8');
  assert.match(source, /const identityInputChanged = titleChanged \|\| companyChanged \|\| locationChanged/);
  assert.match(source, /shouldMaintainAppliedIdentity\(\{[\s\S]*status: effectiveStatus,[\s\S]*passReason: effectivePassReason,[\s\S]*identityInputChanged,[\s\S]*currentIdentityFingerprint: currentJob\.identityFingerprint/);
  assert.match(source, /data\.identityFingerprint = appliedIdentityFingerprint\(\{[\s\S]*title: effectiveTitle,[\s\S]*company: effectiveCompany,[\s\S]*location: effectiveLocation/);
  assert.ok(source.indexOf('data.identityFingerprint = appliedIdentityFingerprint') < source.indexOf('suppressLiveAppliedDuplicates(updated, tx)'));
});

test('the dedicated pass route fingerprints explicit Already applied evidence', () => {
  const source = fs.readFileSync(path.join(root, 'src/app/api/jobs/[id]/pass/route.ts'), 'utf8');
  assert.match(source, /isAlreadyAppliedReason\(reason\)/);
  assert.match(source, /identityFingerprint: appliedIdentityFingerprint\(current\)/);
  assert.match(source, /SELECT status, title, company, location FROM "Job" WHERE id = \$\{id\} FOR UPDATE/);
});

test('operator scripts expose uncovered evidence and keep activation separate from cleanup', () => {
  const audit = fs.readFileSync(path.join(root, 'scripts/dismiss_applied_duplicates.ts'), 'utf8');
  const backfill = fs.readFileSync(path.join(root, 'scripts/backfill_applied_identity_fingerprints.ts'), 'utf8');
  assert.match(audit, /uncovered protected evidence/);
  assert.match(audit, /requires identity backfill/);
  assert.match(audit, /listAppliedDuplicateEvidence/);
  assert.match(audit, /APPLIED_DUPLICATE_CANDIDATE_PROTECTED_STATUSES/);
  assert.doesNotMatch(audit, /DECIDED_STATUSES/);
  assert.match(audit, /historical Passed\/Cooldown activation:\s+excluded by policy/);
  assert.match(backfill, /Zero writes performed/);
  assert.match(backfill, /applyProtectedAppliedIdentityBackfill/);
});
