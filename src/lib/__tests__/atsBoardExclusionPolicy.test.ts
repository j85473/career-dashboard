import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  ATS_EXCLUSION_MIN_LOCATED_POSTINGS,
  ATS_EXCLUSION_MIN_UNPRODUCTIVE_EVIDENCE,
  classifyBoardForAbsence,
  classifyBoardForExclusion,
  type BoardAbsenceEvidence,
} from '../atsBoardExclusionPolicy';
import { ATS_YIELD_MIN_EVIDENCE } from '../atsBoardYield';
import { locationIsPlaceable } from '../../../scripts/exclude_unproductive_ats_boards';

const evidence = (over: Partial<Parameters<typeof classifyBoardForExclusion>[0]> = {}) => ({
  storedJobs: 0, survivingJobs: 0, locallyScoredJobs: 0, locatedJobs: 0, outOfTerritoryJobs: 0, ...over,
});

test('one surviving job protects a board from permanent exclusion forever', () => {
  // Finding these is the entire purpose of the rotation, so evidence that this
  // board once worked outranks any efficiency argument for dropping it.
  const verdict = classifyBoardForExclusion(evidence({
    storedJobs: 5_000, survivingJobs: 1, locatedJobs: 5_000, outOfTerritoryJobs: 5_000,
  }));
  assert.equal(verdict.exclude, false);
});

test('a job that passed local scoring keeps its board, whatever became of that job', () => {
  // Axon, from the live catalog: thirty-eight postings cleared the deterministic
  // local gates -- territory, title, language, metadata -- and were scored, then
  // were dismissed later. Judging on lifecycle status alone read that board as
  // dead and retired it, because a dismissed-after-scoring job is indistinguishable
  // from one rejected at the prefilter. Being scored at all is the proof that a
  // board publishes the right kind of role in the right place.
  const axon = classifyBoardForExclusion(evidence({
    storedJobs: 900, survivingJobs: 0, locallyScoredJobs: 38,
    locatedJobs: 900, outOfTerritoryJobs: 900,
  }));
  assert.equal(axon.exclude, false);
  assert.match(axon.reason, /38 job\(s\) from this board passed local scoring/);
  // Without that signal the same board is excluded on territory, which is
  // exactly the call that needed correcting.
  assert.equal(classifyBoardForExclusion(evidence({
    storedJobs: 900, survivingJobs: 0, locallyScoredJobs: 0,
    locatedJobs: 900, outOfTerritoryJobs: 900,
  })).exclude, true);
});

test('a board with no attributed postings has not been judged and is never excluded', () => {
  // Most of these are boards the overdue rotation simply has not reached.
  const verdict = classifyBoardForExclusion(evidence({ storedJobs: 0 }));
  assert.equal(verdict.exclude, false);
  assert.match(verdict.reason, /never been judged/);
});

test('the permanent bar is stricter than the reversible demotion bar', () => {
  // Demotion is safe at 50 postings because a demoted board returns and is
  // re-judged. Exclusion never re-judges, so it cannot inherit that bar: at the
  // measured 3.13% median survival rate, a productive board shows zero
  // survivors about 20% of the time in 50 postings and about 0.9% in 150.
  assert.ok(ATS_EXCLUSION_MIN_UNPRODUCTIVE_EVIDENCE >= ATS_YIELD_MIN_EVIDENCE);
  assert.equal(classifyBoardForExclusion(evidence({ storedJobs: 149 })).exclude, false);
  assert.equal(classifyBoardForExclusion(evidence({ storedJobs: 150 })).exclude, true);
});

test('a Minnesota employer is never retired on triage history alone', () => {
  // Essentia Health, from the live catalog: 157 postings, 149 of them in
  // Minnesota, zero survivors. One posting over the unproductive bar, and the
  // arm that would have caught it is a sample statistic about triage, not a
  // fact about where the employer hires. Geography wins that tie.
  const essentia = classifyBoardForExclusion(evidence({
    storedJobs: 157, locatedJobs: 157, outOfTerritoryJobs: 8,
  }));
  assert.equal(essentia.exclude, false);
  assert.match(essentia.reason, /149 Minnesota posting/);
  // A board with no placeable postings has no territory evidence either way and
  // is still judgeable on yield.
  assert.equal(classifyBoardForExclusion(evidence({ storedJobs: 500 })).exclude, true);
});

test('a board hiring only outside Minnesota is excluded on far less evidence', () => {
  // Geography is a standing fact about an employer, not a sample statistic, so
  // it does not weaken when the sweep falls behind.
  const verdict = classifyBoardForExclusion(evidence({
    storedJobs: 40, locatedJobs: 40, outOfTerritoryJobs: 40,
  }));
  assert.equal(verdict.exclude, true);
  assert.equal(verdict.exclude && verdict.basis, 'out_of_territory');
});

test('a single Minnesota posting defeats the territory arm', () => {
  const verdict = classifyBoardForExclusion(evidence({
    storedJobs: 100, locatedJobs: 100, outOfTerritoryJobs: 99,
  }));
  assert.equal(verdict.exclude, false);
});

test('too few located postings cannot establish a hiring footprint', () => {
  const below = ATS_EXCLUSION_MIN_LOCATED_POSTINGS - 1;
  const verdict = classifyBoardForExclusion(evidence({
    storedJobs: below, locatedJobs: below, outOfTerritoryJobs: below,
  }));
  assert.equal(verdict.exclude, false);
});

test('ambiguous locations are left out of the territory denominator', () => {
  for (const ambiguous of ['Remote', 'United States', 'Unknown Location', '', '   ']) {
    assert.equal(locationIsPlaceable(ambiguous), false, `${ambiguous} must not be placeable`);
  }
  for (const placed of ['Minneapolis, MN', 'New Orleans, LA', 'Columbus, Ohio']) {
    assert.equal(locationIsPlaceable(placed), true, `${placed} must be placeable`);
  }
});

test('exclusion writes never touch Job rows', () => {
  // Excluding a board retires future sweeps. Jobs already stored from it keep
  // their status, score, and history, per the score preservation rule.
  const script = readFileSync(
    path.join(process.cwd(), 'scripts/exclude_unproductive_ats_boards.ts'), 'utf8',
  );
  const applyBlock = script.slice(script.indexOf('if (!apply) return;'));
  assert.doesNotMatch(applyBlock, /transaction\.job\.|prisma\.job\./);
  assert.match(applyBlock, /status: 'excluded'/);
  // Dry-run must remain the default, and applying must pin the reviewed set.
  assert.match(script, /if \(argv\.length === 0\) return \{ apply: false/);
  assert.match(script, /Selection hash mismatch/);
});

const absent = (over: Partial<BoardAbsenceEvidence> = {}): BoardAbsenceEvidence => ({
  historicalNotFound: 0,
  historicalOffHostRedirect: 0,
  everResponded2xx: false,
  everYieldedJobs: false,
  jobsInserted: 0,
  liveStatus: null,
  liveRedirectedOffHost: false,
  ...over,
});

test('a board that answers only from the vendor\'s own site is absent, and the keep-signals still win', () => {
  // A retired BambooHR subdomain redirects to www.bamboohr.com and answers 200
  // with HTML. Nothing status-based can see that, which is why 4,729 dead
  // boards stayed in rotation.
  const dead = absent({ historicalOffHostRedirect: 6, liveStatus: 200, liveRedirectedOffHost: true });
  assert.equal(classifyBoardForAbsence(dead).exclude, true);

  // Every existing keep-signal is absolute here too: a board that ever returned
  // a real listing, or ever produced a stored job, is never retired this way.
  assert.equal(classifyBoardForAbsence({ ...dead, everResponded2xx: true }).exclude, false);
  assert.equal(classifyBoardForAbsence({ ...dead, everYieldedJobs: true }).exclude, false);
  assert.equal(classifyBoardForAbsence({ ...dead, jobsInserted: 1 }).exclude, false);

  // Serving a page at the board's *own* address is not absence: that is a login
  // wall or an error page, and the board has not been shown to be gone.
  assert.equal(classifyBoardForAbsence({ ...dead, liveRedirectedOffHost: false }).exclude, false);

  // A live redirect with no such response ever recorded is a single unverified
  // observation, and does not retire anything.
  assert.equal(
    classifyBoardForAbsence({ ...dead, historicalOffHostRedirect: 0 }).exclude,
    false,
  );

  // A check that never completed stays unconfirmed, exactly as for a 404.
  assert.equal(classifyBoardForAbsence({ ...dead, liveStatus: null }).exclude, false);

  // The original not-found arm is unchanged.
  assert.equal(
    classifyBoardForAbsence(absent({ historicalNotFound: 3, liveStatus: 404 })).exclude,
    true,
  );
  assert.equal(
    classifyBoardForAbsence(absent({ historicalNotFound: 0, liveStatus: 404 })).exclude,
    false,
  );
});
