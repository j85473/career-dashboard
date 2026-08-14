import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveAimCompensation } from '../aimCompensation';
import { allExactCodePointOccurrences } from '../aimEvidence';
import { aimEvidenceId } from '../aimIdentity';
import { loadAimQuestionRegistry } from '../aimQuestionRegistry';
import { loadAimScoringPolicy } from '../aimScoringPolicy';
import type { AimEvidenceEntry, AimFactualVector } from '../aimV2Types';

const { registry } = loadAimQuestionRegistry();
const { policy } = loadAimScoringPolicy(registry);
const metadata = { company: 'Example', title: 'Channel Manager', location: 'Minneapolis, MN' };

function vector(source: string, evidenceByQuestion: Record<string, string | string[]>): AimFactualVector {
  const catalog: AimEvidenceEntry[] = [];
  const answers = Object.entries(evidenceByQuestion).map(([questionId, supplied]) => {
    const entries = (Array.isArray(supplied) ? supplied : [supplied]).map((quote) => {
      const entry: AimEvidenceEntry = {
        evidenceId: '', source: 'original_jd', field: null, exactQuote: quote,
        occurrences: allExactCodePointOccurrences(source, quote),
      };
      entry.evidenceId = aimEvidenceId(entry);
      if (!catalog.some((existing) => existing.evidenceId === entry.evidenceId)) catalog.push(entry);
      return entry;
    });
    return { questionId, answer: 'yes' as const, evidenceIds: entries.map((entry) => entry.evidenceId) };
  });
  return { answers, evidenceCatalog: catalog } as unknown as AimFactualVector;
}

test('Aim compensation kills only an explicit annual USD total-cash maximum below 60000', () => {
  const belowSource = 'Maximum annual total cash compensation is USD 59,999.';
  const below = deriveAimCompensation(belowSource, vector(belowSource, { 'S2.CP.Q05': belowSource, 'S2.CP.Q18': belowSource, 'S2.CP.Q19': belowSource }), metadata, policy);
  assert.equal(below.upperBoundTotalCashCents, 5_999_900);
  assert.equal(below.floorOutcome, 'below');

  const exactSource = 'Maximum annual total cash compensation is USD 60,000.';
  const exact = deriveAimCompensation(exactSource, vector(exactSource, { 'S2.CP.Q05': exactSource, 'S2.CP.Q18': exactSource, 'S2.CP.Q19': exactSource }), metadata, policy);
  assert.equal(exact.floorOutcome, 'at_or_above');
  assert.equal(exact.preferencePoints, 1);
});

test('Aim compensation fails open for base-only and ordinary OTE below the floor', () => {
  const baseSource = 'Annual base salary is USD 50,000.';
  const base = deriveAimCompensation(baseSource, vector(baseSource, { 'S2.CP.Q01': baseSource, 'S2.CP.Q18': baseSource, 'S2.CP.Q19': baseSource }), metadata, policy);
  assert.equal(base.upperBoundTotalCashCents, null);
  assert.equal(base.floorOutcome, 'fail_open');

  const oteSource = 'Annual on-target earnings are USD 50,000.';
  const ote = deriveAimCompensation(oteSource, vector(oteSource, { 'S2.CP.Q04': oteSource, 'S2.CP.Q18': oteSource, 'S2.CP.Q19': oteSource }), metadata, policy);
  assert.equal(ote.upperBoundTotalCashCents, null);
  assert.equal(ote.floorOutcome, 'fail_open');

  const cappedBaseSource = 'Maximum annual base salary is USD 50,000.';
  const cappedBase = deriveAimCompensation(cappedBaseSource, vector(cappedBaseSource, {
    'S2.CP.Q01': cappedBaseSource,
  }), metadata, policy);
  assert.equal(cappedBase.upperBoundTotalCashCents, null);
  assert.equal(cappedBase.floorOutcome, 'fail_open');

  const cappedOteSource = 'Annual OTE is capped and cannot exceed USD 50,000.';
  const cappedOte = deriveAimCompensation(cappedOteSource, vector(cappedOteSource, {
    'S2.CP.Q04': cappedOteSource,
  }), metadata, policy);
  assert.equal(cappedOte.upperBoundTotalCashCents, 5_000_000);
  assert.equal(cappedOte.floorOutcome, 'below');
});

test('Aim compensation gives at most two points and uncapped upside cannot create a kill', () => {
  const source = 'Annual OTE is USD 120,000 and commission is uncapped.';
  const result = deriveAimCompensation(source, vector(source, {
    'S2.CP.Q04': source, 'S2.CP.Q11': source, 'S2.CP.Q18': source, 'S2.CP.Q19': source,
  }), metadata, policy);
  assert.equal(result.preferencePoints, 2);
  assert.equal(result.floorOutcome, 'fail_open');
  assert.equal(result.upperBoundTotalCashCents, null);
});

test('Aim compensation requires explicit USD and deterministic annualization', () => {
  const bareSource = 'Annual base salary is $120,000.';
  const bare = deriveAimCompensation(bareSource, vector(bareSource, { 'S2.CP.Q01': bareSource, 'S2.CP.Q19': bareSource }), metadata, policy);
  assert.equal(bare.comparisonState, 'non_comparable');
  assert.equal(bare.preferencePoints, 0);

  const monthlySource = 'Fixed pay is US$ 5,000 per month.';
  const monthly = deriveAimCompensation(monthlySource, vector(monthlySource, { 'S2.CP.Q02': monthlySource, 'S2.CP.Q18': monthlySource, 'S2.CP.Q19': monthlySource }), metadata, policy);
  assert.equal(monthly.referenceCashCents, 6_000_000);
  assert.equal(monthly.preferencePoints, 1);

  const hourlySource = 'Fixed pay is USD 30 per hour.';
  const hourly = deriveAimCompensation(hourlySource, vector(hourlySource, { 'S2.CP.Q02': hourlySource, 'S2.CP.Q18': hourlySource, 'S2.CP.Q19': hourlySource }), metadata, policy);
  assert.equal(hourly.comparisonState, 'non_comparable');
  assert.equal(hourly.referenceCashCents, null);
});

test('Aim compensation excludes sign-on and equity from recurring cash', () => {
  const source = 'The role receives a one-time USD 20,000 sign-on bonus and USD 150,000 in equity.';
  const result = deriveAimCompensation(source, vector(source, {
    'S2.CP.Q13': source, 'S2.CP.Q14': source, 'S2.CP.Q18': source,
  }), metadata, policy);
  assert.equal(result.referenceCashCents, null);
  assert.equal(result.preferencePoints, 0);
  assert.equal(result.floorOutcome, 'fail_open');
});

test('Aim compensation supports only an explicitly exhaustive fixed-plus-variable cash composition', () => {
  const base = 'Annual base salary is USD 40,000.';
  const variable = 'Annual variable compensation is USD 10,000.';
  const exhaustive = 'Base salary and variable compensation comprise all recurring cash compensation.';
  const source = `${base} ${variable} ${exhaustive}`;
  const result = deriveAimCompensation(source, vector(source, {
    'S2.CP.Q01': base,
    'S2.CP.Q08': variable,
    'S2.CP.Q17': exhaustive,
  }), metadata, policy);
  assert.equal(result.upperBoundTotalCashCents, 5_000_000);
  assert.equal(result.floorOutcome, 'below');

  const nonExhaustive = `${base} ${variable}`;
  const open = deriveAimCompensation(nonExhaustive, vector(nonExhaustive, {
    'S2.CP.Q01': base,
    'S2.CP.Q08': variable,
  }), metadata, policy);
  assert.equal(open.upperBoundTotalCashCents, null);
  assert.equal(open.floorOutcome, 'fail_open');
});

test('Aim compensation selects the most specific applicable geography before conflict detection', () => {
  const chicago = 'For Chicago, IL, annual base salary is USD 50,000.';
  const minneapolis = 'For Minneapolis, MN, annual base salary is USD 100,000.';
  const varies = 'Compensation varies by location.';
  const source = `${chicago} ${minneapolis} ${varies}`;
  const selected = deriveAimCompensation(source, vector(source, {
    'S2.CP.Q01': [chicago, minneapolis],
    'S2.CP.Q16': varies,
  }), metadata, policy);
  assert.equal(selected.comparisonState, 'comparable');
  assert.equal(selected.referenceCashCents, 10_000_000);
  assert.equal(selected.preferencePoints, 2);

  const minneapolisLower = 'For Minneapolis, MN, annual base salary is USD 80,000.';
  const conflictingSource = `${minneapolis} ${minneapolisLower} ${varies}`;
  const conflict = deriveAimCompensation(conflictingSource, vector(conflictingSource, {
    'S2.CP.Q01': [minneapolis, minneapolisLower],
    'S2.CP.Q16': varies,
  }), metadata, policy);
  assert.equal(conflict.comparisonState, 'conflicting');
  assert.equal(conflict.floorOutcome, 'fail_open');
  assert.equal(conflict.preferencePoints, 0);
});

test('Aim compensation annualizes hourly pay only with explicit hours or full-time evidence', () => {
  const fullTimeSource = 'Fixed pay is USD 30 per hour for this full-time role.';
  const fullTime = deriveAimCompensation(fullTimeSource, vector(fullTimeSource, {
    'S2.CP.Q02': fullTimeSource,
  }), metadata, policy);
  assert.equal(fullTime.referenceCashCents, 6_240_000);
  assert.equal(fullTime.preferencePoints, 1);

  const rateSource = 'Commission is 5% of sales.';
  const rate = deriveAimCompensation(rateSource, vector(rateSource, {
    'S2.CP.Q07': rateSource,
  }), metadata, policy);
  assert.equal(rate.comparisonState, 'non_comparable');
  assert.equal(rate.floorOutcome, 'fail_open');
});
