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
    model: 'gpt-5.6-terra',
    promptVersion: 'experience-workers-v1',
    evidenceHash: 'a'.repeat(64),
    assessments: {
      kind: 'evaluation',
      criteria: [{
        criterionId: 'criterion-1', classification: 'required', category: 'substantive', operator: 'single',
        normalizedMeaning: 'Experience with customer relationship management platforms.',
        source: { startCodePoint: 10, endCodePoint: 41, exactQuote: 'CRM platform experience required.' },
      }],
      outcomes: [{ criterionId: 'criterion-1', outcome: 'cannot_evaluate', leaves: [] }],
    },
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
    assessments: {
      kind: 'evaluation',
      criteria: [{
        criterionId: 'criterion-2', classification: 'preferred', category: 'substantive', operator: 'single',
        normalizedMeaning: 'Experience with CRM platforms.',
        source: { startCodePoint: 20, endCodePoint: 53, exactQuote: 'Customer relationship management experience.' },
      }],
      outcomes: [{ criterionId: 'criterion-2', outcome: 'cannot_evaluate', leaves: [] }],
    },
  });
  const report = renderEvidenceGapReport([row(), second], emptyAnnotations);
  assert.equal((report.match(/^## /gm) || []).length, 1);
  assert.match(report, /2 total \(1 required, 1 preferred\)/);
  assert.match(report, /Example — Territory Sales Manager/);
  assert.match(report, /Second Company — Territory Sales Manager/);
  assert.match(report, /CRM platform experience required/);
  assert.match(report, /Customer relationship management experience/);
  assert.match(report, /event-1/);
  assert.match(report, /event-2/);
});

test('report generation is idempotent and annotations survive without becoming evidence', () => {
  const key = evidenceGapConceptKey('Experience with customer relationship management platforms.');
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
  const directAssessments = structuredClone(row().assessments) as { outcomes: Array<Record<string, unknown>> };
  directAssessments.outcomes[0].outcome = 'direct';
  const direct = row({ assessments: directAssessments });
  assert.match(renderEvidenceGapReport([direct], emptyAnnotations), /Active concepts: 0/);

  const key = evidenceGapConceptKey('Experience with customer relationship management platforms.');
  const notApplicable = parseEvidenceGapAnnotations({
    schemaVersion: 1,
    entries: { [key]: { status: 'Not Applicable' } },
  });
  assert.match(renderEvidenceGapReport([row()], notApplicable), /Active concepts: 0/);
});

test('administrative, strict credential, and does-not-meet items never enter the gap register', () => {
  const criteria = [
    { criterionId: 'admin', classification: 'required', category: 'administrative', normalizedMeaning: "Valid driver's license.", source: { exactQuote: "Valid driver's license." } },
    { criterionId: 'credential', classification: 'required', category: 'role_defining_credential', normalizedMeaning: 'Active CPA license.', source: { exactQuote: 'Active CPA license required.' } },
    { criterionId: 'conflict', classification: 'required', category: 'substantive', normalizedMeaning: 'Five years of software engineering.', source: { exactQuote: 'Five years of software engineering.' } },
  ];
  const outcomes = [
    { criterionId: 'admin', outcome: 'cannot_evaluate' },
    { criterionId: 'credential', outcome: 'cannot_evaluate' },
    { criterionId: 'conflict', outcome: 'does_not_meet' },
  ];
  assert.match(renderEvidenceGapReport([row({ assessments: { kind: 'evaluation', criteria, outcomes } })], emptyAnnotations), /Active concepts: 0/);
});
