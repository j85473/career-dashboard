import assert from 'node:assert/strict';
import test from 'node:test';

import {
  extractMandatoryRequirementCandidates,
  mandatoryRequirementCandidatesMatch,
} from '../mandatoryRequirements';

test('extracts every ButterflyMX REQUIRED EXPERIENCE bullet in order', () => {
  const description = `ROLE OVERVIEW
Own and grow the reseller network.

REQUIRED EXPERIENCE

- 3+ years in a quota-carrying channel sales, partner management, or business development role.
- Track record of building and growing partner relationships from Bronze through strategic tier.
- Comfort engaging at all levels of a partner organization, from owner to install tech to CFO.
- Fluency in Salesforce, Excel, and standard business software.
- Ability to work independently, prioritize across competing demands, and operate against quarterly milestones.
- Strong written and verbal communication.
- Willing to travel approximately 50% of the time in-territory.

COMPENSATION
$90,000 to $100,000 base.`;
  const candidates = extractMandatoryRequirementCandidates(description, 'Channel Sales Territory Manager');
  assert.deepEqual(
    candidates.map((candidate) => candidate.text),
    [
      '3+ years in a quota-carrying channel sales, partner management, or business development role.',
      'Track record of building and growing partner relationships from Bronze through strategic tier.',
      'Comfort engaging at all levels of a partner organization, from owner to install tech to CFO.',
      'Fluency in Salesforce, Excel, and standard business software.',
      'Ability to work independently, prioritize across competing demands, and operate against quarterly milestones.',
      'Strong written and verbal communication.',
      'Willing to travel approximately 50% of the time in-territory.',
    ],
  );
  assert.ok(candidates.every((candidate) => candidate.mandatoryByText));
  assert.equal(new Set(candidates.map((candidate) => candidate.requirementId)).size, candidates.length);
});

test('excludes preferred tenure and resumes extraction in a required Abilities section', () => {
  const description = `Required Experience:
Bachelor’s degree or equivalent practical experience.
5+ years experience in partner management.

Preferred Experience:
5+ years experience in a SaaS software company.
Experience in Radiation Oncology.

Abilities
Strong analytical skills.
Ability to travel up to 40% of the time.

AI & Hiring Integrity At Example we do not permit generated interview answers.
Benefits & Perks — comprehensive medical coverage.`;
  const candidates = extractMandatoryRequirementCandidates(description, 'International Channel Manager');
  assert.deepEqual(candidates.map((candidate) => candidate.text), [
    'Bachelor’s degree or equivalent practical experience.',
    '5+ years experience in partner management.',
    'Strong analytical skills.',
    'Ability to travel up to 40% of the time.',
  ]);
});

test('does not misclassify a title-cased required bullet as a new section heading', () => {
  const description = [
    'REQUIRED QUALIFICATIONS',
    'Strong Communication Skills',
    'Ability to travel 50 percent',
    'BENEFITS',
    'Medical and dental coverage',
  ].join('\n');

  assert.deepEqual(
    extractMandatoryRequirementCandidates(description, 'Channel Manager').map((candidate) => candidate.text),
    ['Strong Communication Skills', 'Ability to travel 50 percent'],
  );
});

test('optional checklist language ends a broad what-you-bring section until requirements resume', () => {
  const description = [
    "WHAT WE'RE LOOKING FOR",
    'The ideal candidate brings as many of the following as possible. Candidates strong on three of the four are competitive:',
    '- Existing West Coast relationships',
    '- Commercial vertical exposure',
    'REQUIRED EXPERIENCE',
    '- Track record of building partner relationships',
    '- Willing to travel approximately 50% of the time',
  ].join('\n');

  assert.deepEqual(
    extractMandatoryRequirementCandidates(description, 'Channel Manager').map((candidate) => candidate.text),
    [
      'Track record of building partner relationships',
      'Willing to travel approximately 50% of the time',
    ],
  );
});

test('mandatory prose is captured while explicit not-required prose is ignored', () => {
  const description = `In this role you will manage channel partners and territory growth.
Candidates must have at least four years of partner management experience.
Prior employment as an installer or integrator is not required.
The role requires quarterly travel and excellent communication.`;
  const candidates = extractMandatoryRequirementCandidates(description, 'Partner Manager');
  assert.deepEqual(candidates.map((candidate) => candidate.text), [
    'Candidates must have at least four years of partner management experience.',
    'The role requires quarterly travel and excellent communication.',
  ]);
});

test('candidate binding detects tampered requirement text and falls back to a core function', () => {
  const fallback = extractMandatoryRequirementCandidates(
    'You will own and grow partner relationships across a regional territory.',
    'Channel Partner Manager',
  );
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].source, 'core_function');
  assert.equal(mandatoryRequirementCandidatesMatch(fallback, fallback), true);
  assert.equal(mandatoryRequirementCandidatesMatch(fallback, [{ ...fallback[0], text: 'Tampered' }]), false);
});
