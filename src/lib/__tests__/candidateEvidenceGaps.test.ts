import assert from 'node:assert/strict';
import test from 'node:test';

import {
  evidenceGapConceptKey,
  parseEvidenceGapAnnotations,
  renderEvidenceGapReport,
  type EvidenceGapSourceRow,
} from '../candidateEvidenceGaps';

function row(overrides: Partial<EvidenceGapSourceRow> = {}): EvidenceGapSourceRow {
  return {
    jobId: '11111111-1111-4111-8111-111111111111',
    title: 'Territory Sales Manager',
    company: 'Example',
    url: 'https://example.com/jobs/1',
    scoreEventId: 'event-1',
    createdAt: new Date('2026-08-01T12:00:00.000Z'),
    model: 'antigravity:gemini-3.6-flash-high',
    promptVersion: 'standard-job-evaluator-v7.0.0',
    evidenceHash: 'a'.repeat(64),
    assessments: [{
      requirementId: 'req-1',
      requirement: 'Active Property & Casualty insurance license.',
      originalRequirement: 'Required verification item: Active Property & Casualty insurance license.',
      classification: 'required',
      outcome: 'cannot_evaluate',
      scoreNeutral: true,
      evidenceIds: [],
      conflictEvidenceIds: [],
      rationale: 'Available evidence is insufficient.',
    }],
    ...overrides,
  };
}

const emptyAnnotations = parseEvidenceGapAnnotations({ schemaVersion: 1, entries: {} });

test('gap report deduplicates bounded wording variants while retaining every job and wording provenance', () => {
  const second = row({
    jobId: '22222222-2222-4222-8222-222222222222',
    scoreEventId: 'event-2',
    createdAt: new Date('2026-08-09T12:00:00.000Z'),
    company: 'Second Company',
    assessments: [{
      ...(row().assessments as Array<Record<string, unknown>>)[0],
      requirement: 'Active P&C insurance license required.',
      originalRequirement: 'Active P&C insurance license required.',
      classification: 'preferred',
    }],
  });
  const report = renderEvidenceGapReport([row(), second], emptyAnnotations);
  assert.equal((report.match(/^## /gm) || []).length, 1);
  assert.match(report, /2 total \(1 required, 1 preferred\)/);
  assert.match(report, /Example — Territory Sales Manager/);
  assert.match(report, /Second Company — Territory Sales Manager/);
  assert.match(report, /Required verification item: Active Property & Casualty insurance license/);
  assert.match(report, /Active P&C insurance license required/);
  assert.match(report, /event-1/);
  assert.match(report, /event-2/);
});

test('report generation is idempotent and annotations survive without becoming evidence', () => {
  const key = evidenceGapConceptKey('Active Property & Casualty insurance license.');
  const annotations = parseEvidenceGapAnnotations({
    schemaVersion: 1,
    entries: { [key]: { status: 'Answered', note: 'Candidate response awaiting inventory workflow.' } },
  });
  const first = renderEvidenceGapReport([row()], annotations);
  const second = renderEvidenceGapReport([row()], annotations);
  assert.equal(first, second);
  assert.match(first, /Status: Answered/);
  assert.match(first, /awaiting inventory workflow/);
  assert.match(first, /not evidence authority/i);
});

test('newer non-gap assessments remove resolved concepts and Not Applicable annotations suppress active entries', () => {
  const direct = row({ assessments: [{
    ...(row().assessments as Array<Record<string, unknown>>)[0],
    outcome: 'direct',
    scoreNeutral: false,
    evidenceIds: ['EVID-001'],
  }] });
  assert.match(renderEvidenceGapReport([direct], emptyAnnotations), /Active concepts: 0/);

  const key = evidenceGapConceptKey('Active Property & Casualty insurance license.');
  const notApplicable = parseEvidenceGapAnnotations({
    schemaVersion: 1,
    entries: { [key]: { status: 'Not Applicable' } },
  });
  assert.match(renderEvidenceGapReport([row()], notApplicable), /Active concepts: 0/);
});

test('administrative, travel, compensation, and does-not-meet items never enter the gap register', () => {
  const assessments = [
    "Valid driver's license.",
    'Travel up to 75%.',
    'Salary requirement of $100,000.',
  ].map((requirement, index) => ({
    requirementId: `req-${index}`,
    requirement,
    originalRequirement: requirement,
    classification: 'required',
    outcome: 'cannot_evaluate',
  }));
  assessments.push({
    requirementId: 'req-conflict',
    requirement: 'Five years of software engineering.',
    originalRequirement: 'Five years of software engineering.',
    classification: 'required',
    outcome: 'does_not_meet',
  });
  assert.match(renderEvidenceGapReport([row({ assessments })], emptyAnnotations), /Active concepts: 0/);
});
