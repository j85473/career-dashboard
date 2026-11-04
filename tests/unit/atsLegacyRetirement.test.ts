import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NON_API_ATS_PLATFORMS } from '../../src/lib/browserAtsBoards';
import { legacyAtsWorkerShouldRun } from '../../src/lib/atsAcquisitionCompatibility';
import { planLegacyAtsRetirement, type LegacyAtsRetirementSnapshot } from '../../src/lib/atsLegacyRetirement';

const releaseId = 'a'.repeat(40);
const fixture = (): LegacyAtsRetirementSnapshot => ({
  gate: { minimumWriterVersion: 3, compatibilityWriterVersion: 3, activatedLedgerVersion: 2,
    v2AuthorityActivatedAt: new Date('2026-09-01'), legacyAcquisitionRetiredAt: null, legacyAcquisitionRetirementReleaseId: null },
  unfinished: { unfinishedBatches: 0, runningAttempts: 0, convertingBatches: 0, convertingBoards: 0 },
  workers: { matchingV2: 8, otherRelease: 0 },
});

test('retirement requires drained legacy work and a healthy worker from one deployed release', () => {
  const ready = planLegacyAtsRetirement(fixture(), releaseId);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.blockers, []);
  for (const kind of Object.keys(fixture().unfinished) as Array<keyof LegacyAtsRetirementSnapshot['unfinished']>) {
    const snapshot = fixture(); snapshot.unfinished[kind] = 1;
    const blocked = planLegacyAtsRetirement(snapshot, releaseId);
    assert.equal(blocked.ready, false); assert.match(blocked.blockers.join(' '), new RegExp(kind));
    assert.notEqual(blocked.selectionHash, ready.selectionHash);
  }
  for (const workers of [{ matchingV2: 0, otherRelease: 0 }, { matchingV2: 8, otherRelease: 1 }]) {
    assert.equal(planLegacyAtsRetirement({ ...fixture(), workers }, releaseId).ready, false);
  }
  const inactive = fixture(); inactive.gate!.v2AuthorityActivatedAt = null;
  assert.equal(planLegacyAtsRetirement(inactive, releaseId).ready, false);
  assert.equal(planLegacyAtsRetirement({ ...fixture(), gate: null }, releaseId).ready, false);
  assert.throws(() => planLegacyAtsRetirement(fixture(), 'main'), /exact deployed Git release/);
});

test('retirement survives restart and cannot fall back to a disabled v2 dispatcher', () => {
  const gate = fixture().gate!;
  assert.equal(legacyAtsWorkerShouldRun(gate, false), true);
  assert.equal(legacyAtsWorkerShouldRun(gate, true), true);
  gate.legacyAcquisitionRetiredAt = new Date(); gate.legacyAcquisitionRetirementReleaseId = releaseId;
  assert.equal(legacyAtsWorkerShouldRun(gate, true), false);
  assert.throws(() => legacyAtsWorkerShouldRun(gate, false), /retired/);
  assert.equal(planLegacyAtsRetirement({ ...fixture(), gate }, releaseId).retired, true);
  assert.equal(planLegacyAtsRetirement({ ...fixture(), gate }, releaseId).ready, false);
});

test('the database retirement fence excludes every separately owned public-board collector', () => {
  const sql = readFileSync('prisma/migrations/20261104210000_ats_legacy_worker_retirement/migration.sql', 'utf8');
  const list = /SELECT platform NOT IN \(([^;]+)\);/.exec(sql)![1];
  const providers = [...list.matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(providers.sort(), [...NON_API_ATS_PLATFORMS].sort());
});
