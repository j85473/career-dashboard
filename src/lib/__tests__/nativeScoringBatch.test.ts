import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyRequirementScope,
  CONTEXT_PROMPT_VERSION,
  directRequirementScopeViolation,
  MANAGER_PROMPT_VERSION,
  manifestHash,
  NATIVE_SCORING_SCHEMA_VERSION,
  NATIVE_SCORING_EXPECTED_MODEL,
  NativeScoringManifest,
  parseNativeScoringChunk,
  parseNativeScoringManifest,
  parseNativeResultDocument,
  parseContextResult,
  parseStandardResult,
  requirementScopeViolation,
  STANDARD_PROMPT_VERSION,
} from '../nativeScoringBatch';
import { extractMandatoryRequirementCandidates } from '../mandatoryRequirements';
import { buildNativeScoringEvaluationPacket } from '../nativeScoringPacket';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-07-29T12:00:00.000Z';
const digest = 'a'.repeat(64);
const scorableDescription = [
  'In this role you will own relationships with an assigned portfolio of channel partners across a multi-state territory.',
  'Responsibilities include developing joint business plans, leading quarterly performance reviews, growing sell-through, coordinating product launches, and traveling to distributor offices.',
  'You will partner with sales, marketing, operations, and executive stakeholders to identify account-growth opportunities and resolve performance gaps.',
  'Required qualifications include at least five years of channel sales or partner account management experience, excellent written and verbal communication, and experience managing a regional territory.',
  'A bachelor degree is preferred, along with familiarity with CRM reporting and distributor enablement programs.',
].join(' ');
const scorablePacket = buildNativeScoringEvaluationPacket({
  title: 'Channel Manager',
  company: 'Example',
  location: 'Minneapolis, MN',
  description: scorableDescription,
});

test('native result parsing surfaces evaluator input rejection instead of a misleading JSON error', () => {
  assert.throws(
    () => parseNativeResultDocument(
      'EVALUATION_INPUT_ERROR: Administrative eligibility and compensation boilerplate reached criteria.',
      'chunk_0000',
    ),
    /chunk_0000 evaluator rejected its sanitized input: Administrative eligibility and compensation boilerplate reached criteria/,
  );
  assert.throws(
    () => parseNativeResultDocument('not json', 'chunk_0001'),
    /chunk_0001 result is not bare JSON/,
  );
  assert.deepEqual(parseNativeResultDocument('{"standardScores":[]}', 'chunk_0002'), { standardScores: [] });
});

test('requirement scope classification is deterministic and evidence-specific', () => {
  assert.equal(
    classifyRequirementScope("Valid driver's license with a clean driving record."),
    'drivers_license',
  );
  assert.equal(
    classifyRequirementScope('Two years of sales experience and a valid Class D license.'),
    'unrestricted',
  );
  assert.equal(
    classifyRequirementScope('Active Property & Casualty insurance license.'),
    'personal_credential',
  );
  assert.equal(
    classifyRequirementScope('Experience managing enterprise software licenses.'),
    'unrestricted',
  );
  assert.equal(
    classifyRequirementScope('Experience designing partner certification programs.'),
    'partner_certification_program',
  );
  assert.equal(
    directRequirementScopeViolation('Experience designing partner certification programs.', ['DSI-021']),
    null,
  );
  assert.match(
    directRequirementScopeViolation('Supervise and coach a team of ten sales representatives.', ['DSI-002']) || '',
    /people-leadership/,
  );
  assert.match(
    directRequirementScopeViolation('Carry full financial accountability and allocate departmental spend.', ['DSI-002']) || '',
    /financial accountability/,
  );
  assert.match(
    directRequirementScopeViolation('Serve as the primary relationship owner for named Fortune 500 clients.', ['DSI-002']) || '',
    /enterprise\/national-account ownership/,
  );
  assert.match(
    requirementScopeViolation("Valid driver's license.", 'direct', ['DSI-002']) || '',
    /administrative eligibility.*score-neutral/,
  );
  assert.match(
    requirementScopeViolation("Valid driver's license.", 'adjacent', ['DSI-002']) || '',
    /administrative eligibility.*score-neutral/,
  );
  assert.match(
    requirementScopeViolation('Active Property & Casualty insurance license.', 'adjacent', ['DSI-002']) || '',
    /candidate-owned license.*adjacent/,
  );
  assert.equal(
    requirementScopeViolation('Experience managing enterprise software licenses.', 'adjacent', ['DSI-002']),
    null,
  );
});

function validManifest(): NativeScoringManifest {
  const unsigned: Omit<NativeScoringManifest, 'manifestHash'> = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'native_test_standard',
    createdAt: timestamp,
    chunkSize: 5,
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'flash',
      expectedModel: NATIVE_SCORING_EXPECTED_MODEL,
    },
    prompts: {
      context: {
        version: CONTEXT_PROMPT_VERSION,
        file: '.agents/agents/context-job-evaluator-v6/agent.md',
        sha256: digest,
      },
      standard: {
        version: STANDARD_PROMPT_VERSION,
        file: '.agents/agents/standard-job-evaluator-v6/agent.md',
        sha256: digest,
      },
      manager: {
        version: MANAGER_PROMPT_VERSION,
        file: '.agents/agents/scoring-manager-v6/agent.md',
        sha256: digest,
      },
    },
    evidence: {
      file: '.agents/minified_evidence.json',
      sha256: digest,
    },
    contextSnapshot: {
      file: 'context.snapshot.json',
      sha256: digest,
      submittedUpdatedAt: timestamp,
    },
    exportSnapshot: {
      file: 'export.snapshot.json',
      sha256: digest,
    },
    chunks: [{
      chunkId: 'chunk_0000',
      type: 'standard',
      inputFile: 'chunks/chunk_0000.json',
      resultFile: 'results/chunk_0000.result.json',
      inputHash: digest,
      jobs: [
        { id: firstId, submittedUpdatedAt: timestamp },
        { id: secondId, submittedUpdatedAt: timestamp },
      ],
    }],
  };
  return { ...unsigned, manifestHash: manifestHash(unsigned) };
}

test('manifest parser verifies exact keys, contiguous chunks, and its content hash', () => {
  const manifest = validManifest();
  assert.equal(parseNativeScoringManifest(manifest).manifestHash, manifest.manifestHash);

  assert.throws(
    () => parseNativeScoringManifest({ ...manifest, rogue: true }),
    /exactly these keys/,
  );
  assert.throws(
    () => parseNativeScoringManifest({ ...manifest, batchId: 'changed' }),
    /manifestHash/,
  );

  const mislabeledUnsigned = {
    ...manifest,
    prompts: {
      ...manifest.prompts,
      standard: {
        ...manifest.prompts.standard,
        version: 'standard-job-evaluator-v6.7.1',
      },
    },
  };
  const mislabeledWithoutHash = { ...mislabeledUnsigned };
  Reflect.deleteProperty(mislabeledWithoutHash, 'manifestHash');
  assert.throws(
    () => parseNativeScoringManifest({
      ...mislabeledWithoutHash,
      manifestHash: manifestHash(mislabeledWithoutHash),
    }),
    /must bind standard-job-evaluator-v8\.0\.0/,
  );

  assert.throws(
    () => parseNativeScoringManifest({
      ...manifest,
      model: {
        surface: 'antigravity-native-subagent',
        tier: 'pro',
        expectedModel: 'gemini-3.1-pro-high',
      },
    }),
    /must pin Gemini 3\.6 Flash High \(gemini-3\.6-flash-high\)/,
  );

  const mixedUnsigned = {
    ...manifest,
    chunks: [
      manifest.chunks[0],
      {
        ...manifest.chunks[0],
        chunkId: 'chunk_0001',
        type: 'context' as const,
        inputFile: 'chunks/chunk_0001.json',
        resultFile: 'results/chunk_0001.result.json',
        jobs: [{ id: '33333333-3333-4333-8333-333333333333', submittedUpdatedAt: timestamp }],
      },
    ],
  };
  const mixedWithoutHash = { ...mixedUnsigned };
  Reflect.deleteProperty(mixedWithoutHash, 'manifestHash');
  assert.throws(
    () => parseNativeScoringManifest({
      ...mixedWithoutHash,
      manifestHash: manifestHash(mixedWithoutHash),
    }),
    /one scoring phase/,
  );
});

test('chunk parser requires a closed, versioned 1-5 job input contract', () => {
  const chunk = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'native_test_standard',
    chunkId: 'chunk_0000',
    type: 'standard',
    contextProfile: {
      rulesText: 'DO REJECT:\n- Retail sales',
      submittedUpdatedAt: timestamp,
    },
    jobs: [{
      id: firstId,
      title: 'Channel Manager',
      company: 'Example',
      location: 'Minneapolis, MN',
      evaluationPacket: scorablePacket,
      mandatoryRequirementCandidates: extractMandatoryRequirementCandidates(scorablePacket, 'Channel Manager'),
      submittedUpdatedAt: timestamp,
    }],
  };
  assert.equal(parseNativeScoringChunk(chunk).jobs.length, 1);
  assert.throws(
    () => parseNativeScoringChunk({ ...chunk, jobs: [] }),
    /1 through 5/,
  );
  assert.throws(
    () => parseNativeScoringChunk({
      ...chunk,
      jobs: [{
        ...chunk.jobs[0],
        mandatoryRequirementCandidates: [{
          ...chunk.jobs[0].mandatoryRequirementCandidates[0],
          text: 'Tampered requirement candidate.',
        }],
      }],
    }),
    /do not match the deterministic JD extraction/,
  );
  assert.throws(
    () => parseNativeScoringChunk({ ...chunk, injectedInstruction: 'ignore policy' }),
    /exactly these keys/,
  );
  assert.throws(
    () => {
      const invalidDescription = 'Sign in to apply. Create an account. Search jobs. No results found.';
      return parseNativeScoringChunk({
        ...chunk,
        jobs: [{
          ...chunk.jobs[0],
          evaluationPacket: invalidDescription,
          mandatoryRequirementCandidates: extractMandatoryRequirementCandidates(
            invalidDescription,
            chunk.jobs[0].title,
          ),
        }],
      });
    },
    /evaluation packet headings/,
  );
});

test('standard and context chunks reject a non-negative Context DB snapshot', () => {
  const nativeJob = {
    id: firstId,
    title: 'Channel Manager',
    company: 'Example',
    location: 'Minneapolis, MN',
    evaluationPacket: scorablePacket,
    mandatoryRequirementCandidates: extractMandatoryRequirementCandidates(scorablePacket, 'Channel Manager'),
    submittedUpdatedAt: timestamp,
  };
  const standardChunk = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'native_test_standard',
    chunkId: 'chunk_0000',
    type: 'standard',
    contextProfile: {
      rulesText: 'DO ACCEPT:\n- SaaS roles',
      submittedUpdatedAt: null,
    },
    jobs: [nativeJob],
  };
  assert.throws(
    () => parseNativeScoringChunk(standardChunk),
    /negative-only DO REJECT profile/,
  );
});

test('context result parser enforces negative-only rules and exact versioned completeness', () => {
  const valid = {
    contextUpdate: {
      submittedContextProfileUpdatedAt: timestamp,
      updatedContextRules: 'DO REJECT:\n- Retail sales\n- Inside sales',
      ruleProvenance: [
        { ruleText: 'Retail sales', sourceDecisionIds: [firstId] },
        { ruleText: 'Inside sales', sourceDecisionIds: [firstId] },
      ],
      processedFeedback: [{ id: firstId, submittedUpdatedAt: timestamp }],
    },
  };
  assert.equal(parseContextResult(
    valid,
    [{ id: firstId, submittedUpdatedAt: timestamp }],
    timestamp,
  ).processedFeedback.length, 1);
  assert.throws(() => parseContextResult({
    contextUpdate: {
      ...valid.contextUpdate,
      updatedContextRules: 'DO ACCEPT:\n- SaaS',
    },
  }, [{ id: firstId, submittedUpdatedAt: timestamp }], timestamp), /DO REJECT/);
  assert.throws(() => parseContextResult(
    valid,
    [{ id: secondId, submittedUpdatedAt: timestamp }],
    timestamp,
  ), /exactly once/);
});

test('context result binds each new rule to its own feedback decisions without over-attribution', () => {
  const result = parseContextResult({
    contextUpdate: {
      submittedContextProfileUpdatedAt: timestamp,
      updatedContextRules: 'DO REJECT:\n- Retail sales\n- Roles dominated by cold prospecting.',
      ruleProvenance: [
        { ruleText: 'Retail sales', sourceDecisionIds: [] },
        { ruleText: 'Roles dominated by cold prospecting.', sourceDecisionIds: [secondId] },
      ],
      processedFeedback: [
        { id: firstId, submittedUpdatedAt: timestamp },
        { id: secondId, submittedUpdatedAt: timestamp },
      ],
    },
  }, [
    { id: firstId, submittedUpdatedAt: timestamp },
    { id: secondId, submittedUpdatedAt: timestamp },
  ], timestamp, 'DO REJECT:\n- Retail sales');
  assert.deepEqual(result.ruleProvenance[0].sourceDecisionIds, []);
  assert.deepEqual(result.ruleProvenance[1].sourceDecisionIds, [secondId]);

  assert.throws(() => parseContextResult({
    contextUpdate: {
      submittedContextProfileUpdatedAt: timestamp,
      updatedContextRules: 'DO REJECT:\n- Retail sales',
      ruleProvenance: [{ ruleText: 'Retail sales', sourceDecisionIds: [firstId] }],
      processedFeedback: [{ id: firstId, submittedUpdatedAt: timestamp }],
    },
  }, [{ id: firstId, submittedUpdatedAt: timestamp }], timestamp, 'DO REJECT:\n- Retail sales'), /unchanged Context rules/);
});

function criterionFixture(description = `RESPONSIBILITIES
- Manage distributor relationships and grow regional sales.
REQUIRED EXPERIENCE
- 5+ years of channel sales experience.
- Experience owning partner business plans.
PREFERRED EXPERIENCE
- Experience with Salesforce preferred.
TRAVEL
- Travel is 50-75%.
COMPENSATION
- Base salary: $100,000-$120,000 plus commission.`) {
  const evaluationPacket = buildNativeScoringEvaluationPacket({
    title: 'Channel Manager', company: 'Example', location: 'US Remote', description,
  });
  const candidates = extractMandatoryRequirementCandidates(evaluationPacket, 'Channel Manager');
  const directAssessment = (requirementId: string) => ({
    requirementId,
    outcome: 'direct',
    support: [{ evidenceId: 'DSI-002', claim: 'Directly establishes this criterion.' }],
    conflict: [],
    rationale: 'Verified experience directly establishes this criterion.',
  });
  return {
    evaluationPacket,
    candidates,
    candidatesByJob: new Map([[firstId, candidates]]),
    packetsByJob: new Map([[firstId, evaluationPacket]]),
    result: {
      standardScores: [{
        id: firstId,
        aimFitScore: 90,
        aimFitReason: 'Target channel role with compatible location.',
        criterionAssessments: candidates.map((candidate) => directAssessment(candidate.requirementId)),
      }],
    },
  };
}

test('criterion result accepts only ordered atomic outcomes and derives every aggregate', () => {
  const fixture = criterionFixture();
  const score = parseStandardResult(
    fixture.result,
    [firstId],
    new Set(['DSI-002']),
    fixture.candidatesByJob,
    fixture.packetsByJob,
  )[0];
  assert.equal(score.experienceFitScore, 100);
  assert.equal(score.qualificationBasis, 'direct');
  assert.equal(score.compensation, 'Base salary: $100,000-$120,000 plus commission.');
  assert.deepEqual(score.travelRange, {
    kind: 'range', minimumPercent: 50, maximumPercent: 75, label: '50-75%', sourceText: 'Travel is 50-75%',
  });
  assert.equal(score.travelScore, 75);
  assert.deepEqual(score.mandatoryRequirementAssessments.map((assessment) => assessment.classification), ['required', 'required', 'preferred']);
  assert.deepEqual(score.mandatoryRequirementAssessments.map((assessment) => assessment.originalRequirement), fixture.candidates.map((candidate) => candidate.originalText));
});

test('criterion result rejects holistic model fields and incomplete or reordered coverage', () => {
  const fixture = criterionFixture();
  const entry = fixture.result.standardScores[0];
  const parse = (value: unknown) => parseStandardResult(
    value, [firstId], new Set(['DSI-002']), fixture.candidatesByJob, fixture.packetsByJob,
  );
  assert.throws(() => parse({
    standardScores: [{ ...entry, experienceFitScore: 99 }],
  }), /exactly these keys/);
  assert.throws(() => parse({
    standardScores: [{ ...entry, criterionAssessments: entry.criterionAssessments.slice(1) }],
  }), /cover every supplied criterion/);
  assert.throws(() => parse({
    standardScores: [{ ...entry, criterionAssessments: [...entry.criterionAssessments].reverse() }],
  }), /exact ordered requirement IDs/);
});

test('cannot_evaluate is unknown, never does_not_meet, and deterministically caps required Experience at 69', () => {
  const fixture = criterionFixture();
  const entry = fixture.result.standardScores[0];
  const assessments = entry.criterionAssessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    outcome: 'cannot_evaluate',
    support: [],
    rationale: 'Available evidence is insufficient to decide this criterion.',
  } : assessment);
  const score = parseStandardResult({ standardScores: [{ ...entry, criterionAssessments: assessments }] }, [firstId], new Set(['DSI-002']), fixture.candidatesByJob, fixture.packetsByJob)[0];
  assert.equal(score.experienceFitScore, 60);
  assert.equal(score.mandatoryRequirementsMet, true);
  assert.deepEqual(score.unmetMandatoryRequirements, []);
  assert.match(score.experienceFitReason, /Verification needed.*cap 69/);

  const technicalIdentifier = assessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    rationale: 'Available evidence is insufficient to decide experience with TR-069 and TR-369 protocols.',
  } : assessment);
  assert.doesNotThrow(() => parseStandardResult(
    { standardScores: [{ ...entry, criterionAssessments: technicalIdentifier }] },
    [firstId],
    new Set(['DSI-002']),
    fixture.candidatesByJob,
    fixture.packetsByJob,
  ));

  const inventedEvidence = assessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    rationale: 'Available evidence DSI-999 is insufficient to decide this criterion.',
  } : assessment);
  assert.throws(() => parseStandardResult(
    { standardScores: [{ ...entry, criterionAssessments: inventedEvidence }] },
    [firstId],
    new Set(['DSI-002']),
    fixture.candidatesByJob,
    fixture.packetsByJob,
  ), /cites DSI-999 outside its evidence fields/);
});

test('does_not_meet requires affirmative verified conflict evidence and deterministically caps at 59', () => {
  const fixture = criterionFixture();
  const entry = fixture.result.standardScores[0];
  const conflicting = entry.criterionAssessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    outcome: 'does_not_meet',
    support: [],
    conflict: [{ evidenceId: 'DSI-002', claim: 'Affirmatively establishes a conflicting scope.' }],
    rationale: 'Verified evidence affirmatively establishes a conflicting scope.',
  } : assessment);
  const score = parseStandardResult({ standardScores: [{ ...entry, criterionAssessments: conflicting }] }, [firstId], new Set(['DSI-002']), fixture.candidatesByJob, fixture.packetsByJob)[0];
  assert.equal(score.experienceFitScore, 59);
  assert.equal(score.mandatoryRequirementsMet, false);
  assert.equal(score.unmetMandatoryRequirements.length, 1);
  const missingConflict = conflicting.map((assessment, index) => index === 0 ? { ...assessment, conflict: [] } : assessment);
  assert.throws(() => parseStandardResult({ standardScores: [{ ...entry, criterionAssessments: missingConflict }] }, [firstId], new Set(['DSI-002']), fixture.candidatesByJob, fixture.packetsByJob), /requires affirmative conflict evidence/);
});

test('professional credential unknowns are score-neutral and remain evidence gaps', () => {
  const fixture = criterionFixture(`RESPONSIBILITIES
- Manage agency relationships and grow regional sales.
REQUIRED EXPERIENCE
- 3+ years of property-and-casualty agency sales experience.
ROLE-DEFINING QUALIFICATIONS
- Required verification item: Active Property & Casualty insurance license.`);
  const entry = fixture.result.standardScores[0];
  const assessments = entry.criterionAssessments.map((assessment, index) => index === 1 ? {
    ...assessment,
    outcome: 'cannot_evaluate',
    support: [],
    rationale: 'Available evidence is insufficient to verify this professional credential.',
  } : assessment);
  const score = parseStandardResult({ standardScores: [{ ...entry, criterionAssessments: assessments }] }, [firstId], new Set(['DSI-002']), fixture.candidatesByJob, fixture.packetsByJob)[0];
  assert.equal(score.experienceFitScore, 100);
  assert.equal(score.mandatoryRequirementAssessments[1].scoreNeutral, true);
  assert.equal(score.qualificationBasis, 'direct');
});

test('v8 binds every cited evidence ID to the claim it establishes', () => {
  const fixture = criterionFixture();
  const entry = fixture.result.standardScores[0];
  const parse = (assessments: unknown[]) => parseStandardResult(
    { standardScores: [{ ...entry, criterionAssessments: assessments }] },
    [firstId],
    new Set(['DSI-002', 'DSI-019']),
    fixture.candidatesByJob,
    fixture.packetsByJob,
  );

  // The v7 shape — a bare ID array plus a prose echo — is no longer accepted.
  const legacyShape = entry.criterionAssessments.map((assessment, index) => index === 0 ? {
    requirementId: assessment.requirementId,
    outcome: 'direct',
    evidenceIds: ['DSI-002'],
    conflictEvidenceIds: [],
    rationale: 'DSI-002 directly establishes this criterion.',
  } : assessment);
  assert.throws(() => parse(legacyShape), /must contain exactly these keys: conflict, outcome, rationale, requirementId, support/);

  // An ID cannot be cited without stating what it establishes.
  const emptyClaim = entry.criterionAssessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    support: [{ evidenceId: 'DSI-002', claim: '   ' }],
  } : assessment);
  assert.throws(() => parse(emptyClaim), /claim/i);

  // A claim may not name an evidence ID the assessment never declared; under v7
  // this scan covered the rationale only, so a claim was an unchecked channel.
  const phantomInClaim = entry.criterionAssessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    support: [{ evidenceId: 'DSI-002', claim: 'Read together with DSI-019 this establishes the criterion.' }],
  } : assessment);
  assert.throws(() => parse(phantomInClaim), /cites DSI-019 outside its evidence fields/);

  // Declaring both IDs properly is accepted, and evidenceIds derive from support.
  const bothDeclared = entry.criterionAssessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    support: [
      { evidenceId: 'DSI-002', claim: 'Establishes distributor partner management scope.' },
      { evidenceId: 'DSI-019', claim: 'Establishes joint business planning with partner leadership.' },
    ],
  } : assessment);
  const score = parse(bothDeclared)[0];
  assert.deepEqual(score.mandatoryRequirementAssessments[0].evidenceIds, ['DSI-002', 'DSI-019']);
  assert.deepEqual(
    score.mandatoryRequirementAssessments[0].support.map((record) => record.evidenceId),
    ['DSI-002', 'DSI-019'],
  );

  // Duplicate IDs inside one array remain rejected.
  const duplicated = entry.criterionAssessments.map((assessment, index) => index === 0 ? {
    ...assessment,
    support: [
      { evidenceId: 'DSI-002', claim: 'Establishes distributor partner management scope.' },
      { evidenceId: 'DSI-002', claim: 'Restates the same record.' },
    ],
  } : assessment);
  assert.throws(() => parse(duplicated), /must not contain duplicates/);
});
