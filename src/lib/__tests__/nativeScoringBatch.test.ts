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
  parseContextResult,
  parseStandardResult,
  STANDARD_PROMPT_VERSION,
} from '../nativeScoringBatch';
import { extractMandatoryRequirementCandidates } from '../mandatoryRequirements';

const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-07-29T12:00:00.000Z';
const digest = 'a'.repeat(64);
const firstRequirementId = `req-${'1'.repeat(24)}`;
const secondRequirementId = `req-${'2'.repeat(24)}`;
const scorableDescription = [
  'In this role you will own relationships with an assigned portfolio of channel partners across a multi-state territory.',
  'Responsibilities include developing joint business plans, leading quarterly performance reviews, growing sell-through, coordinating product launches, and traveling to distributor offices.',
  'You will partner with sales, marketing, operations, and executive stakeholders to identify account-growth opportunities and resolve performance gaps.',
  'Required qualifications include at least five years of channel sales or partner account management experience, excellent written and verbal communication, and experience managing a regional territory.',
  'A bachelor degree is preferred, along with familiarity with CRM reporting and distributor enablement programs.',
].join(' ');

test('requirement scope classification is deterministic and evidence-specific', () => {
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
});

function validManifest(): NativeScoringManifest {
  const unsigned: Omit<NativeScoringManifest, 'manifestHash'> = {
    schemaVersion: NATIVE_SCORING_SCHEMA_VERSION,
    batchId: 'native_test_standard',
    createdAt: timestamp,
    chunkSize: 5,
    model: {
      surface: 'antigravity-native-subagent',
      tier: 'pro',
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

function validStandardResult(): Record<string, unknown> {
  return {
    standardScores: [
      {
        id: firstId,
        aimFitScore: 90,
        experienceFitScore: 80,
        aimFitReason: 'Strong target role and compatible location.',
        experienceFitReason: 'Territory experience is supported by DSI-002.',
        travelScore: 50,
        compensation: '$100k–$150k base + commission',
        evidenceIds: ['DSI-002'],
        qualificationBasis: 'direct',
        mandatoryRequirementAssessments: [{
          requirementId: firstRequirementId,
          requirement: 'Five years of channel sales experience.',
          support: 'direct',
          evidenceIds: ['DSI-002'],
          explanation: 'DSI-002 directly supports multi-state channel sales tenure.',
        }],
        mandatoryRequirementsMet: true,
        unmetMandatoryRequirements: [],
        requiredDomain: 'channel sales',
        candidateDomain: 'channel sales',
        domainMatch: true,
        requiredYearsInDomain: 5,
        candidateYearsInDomain: 6.5,
      },
      {
        id: secondId,
        aimFitScore: 10,
        experienceFitScore: 0,
        aimFitReason: 'Wrong function.',
        experienceFitReason: 'No supporting evidence.',
        travelScore: 0,
        compensation: null,
        evidenceIds: [],
        qualificationBasis: 'unsupported',
        mandatoryRequirementAssessments: [{
          requirementId: secondRequirementId,
          requirement: 'Software engineering experience is required.',
          support: 'unsupported',
          evidenceIds: [],
          explanation: 'No verified professional software engineering evidence.',
        }],
        mandatoryRequirementsMet: false,
        unmetMandatoryRequirements: ['Software engineering experience is required.'],
        requiredDomain: 'software engineering',
        candidateDomain: null,
        domainMatch: false,
        requiredYearsInDomain: null,
        candidateYearsInDomain: null,
      },
    ],
  };
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
    /must bind standard-job-evaluator-v6\.10\.0/,
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
      description: scorableDescription,
      mandatoryRequirementCandidates: extractMandatoryRequirementCandidates(scorableDescription, 'Channel Manager'),
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
          description: invalidDescription,
          mandatoryRequirementCandidates: extractMandatoryRequirementCandidates(
            invalidDescription,
            chunk.jobs[0].title,
          ),
        }],
      });
    },
    /description is not scorable/,
  );
});

test('standard and context chunks reject a non-negative Context DB snapshot', () => {
  const nativeJob = {
    id: firstId,
    title: 'Channel Manager',
    company: 'Example',
    location: 'Minneapolis, MN',
    description: scorableDescription,
    mandatoryRequirementCandidates: extractMandatoryRequirementCandidates(scorableDescription, 'Channel Manager'),
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

test('standard result parser enforces exact envelope, keys, integers, evidence, and ordered completeness', () => {
  const allowedEvidenceIds = new Set(['DSI-002', 'DSI-021']);
  const valid = validStandardResult();
  assert.equal(
    parseStandardResult(valid, [firstId, secondId], allowedEvidenceIds).length,
    2,
  );
  assert.equal(
    parseStandardResult(valid, [firstId, secondId], allowedEvidenceIds)[0].compensation,
    '$100k–$150k base + commission',
  );

  assert.throws(
    () => parseStandardResult((valid.standardScores as unknown[]), [firstId, secondId], allowedEvidenceIds),
    /must be an object/,
  );
  assert.throws(
    () => parseStandardResult(
      { ...valid, hallucinatedEnvelopeKey: true },
      [firstId, secondId],
      allowedEvidenceIds,
    ),
    /exactly these keys/,
  );

  const first = (valid.standardScores as Array<Record<string, unknown>>)[0];
  const second = (valid.standardScores as Array<Record<string, unknown>>)[1];
  const withoutCompensation = { ...first };
  Reflect.deleteProperty(withoutCompensation, 'compensation');
  assert.throws(
    () => parseStandardResult({
      standardScores: [withoutCompensation, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /exactly these keys/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{ ...first, compensation: '' }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /compensation must be a non-empty string/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{ ...first, experienceFitScore: 80.5 }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /integer/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{ ...first, experienceFitScoreLegacy: 80 }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /exactly these keys/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{ ...first, evidenceIds: ['FAKE-999'] }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /known evidence ID/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [second, first],
    }, [firstId, secondId], allowedEvidenceIds),
    /input order/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementsMet: true,
        unmetMandatoryRequirements: ['A mandatory requirement is missing.'],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /true exactly when unmetMandatoryRequirements is empty/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementsMet: true,
        requiredYearsInDomain: 8,
        candidateYearsInDomain: null,
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /required domain tenure is unsupported/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        requiredDomain: 'enterprise software',
        candidateDomain: null,
        domainMatch: true,
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /candidateDomain is required/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        requiredDomain: null,
        candidateDomain: null,
        domainMatch: false,
        requiredYearsInDomain: null,
        candidateYearsInDomain: null,
        mandatoryRequirementsMet: false,
        unmetMandatoryRequirements: ['No domain was actually required.'],
        qualificationBasis: 'unsupported',
        mandatoryRequirementAssessments: [{
          requirementId: firstRequirementId,
          requirement: 'No domain was actually required.',
          support: 'unsupported',
          evidenceIds: [],
          explanation: 'Test fixture for incoherent domain metadata.',
        }],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /domainMatch must be true when requiredDomain is null/,
  );
  assert.doesNotThrow(() => parseStandardResult({
    standardScores: [{
      ...first,
      requiredYearsInDomain: null,
      candidateYearsInDomain: 6.5,
    }, second],
  }, [firstId, secondId], allowedEvidenceIds));
  assert.doesNotThrow(() => parseStandardResult({
    standardScores: [{
      ...first,
      experienceFitScore: 79,
      qualificationBasis: 'adjacent',
      mandatoryRequirementAssessments: [{
        requirementId: firstRequirementId,
        requirement: 'Three years of B2B SaaS customer-success experience.',
        support: 'adjacent',
        evidenceIds: ['DSI-002'],
        explanation: 'DSI-002 supports adjacent multi-account channel experience.',
      }],
      requiredDomain: 'B2B SaaS customer success',
      candidateDomain: 'Adjacent: channel account management and platform enablement',
      domainMatch: true,
      requiredYearsInDomain: 3,
      candidateYearsInDomain: 6.5,
    }, second],
  }, [firstId, secondId], allowedEvidenceIds));
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        qualificationBasis: 'adjacent',
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /does not match the mandatory requirement assessments/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementAssessments: [],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /must contain 1 through 32 items/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        experienceFitReason: 'The candidate held the formal Channel Account Manager title for six years, supported by DSI-002.',
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /misstates Channel Account Manager as a held title/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementAssessments: [{
          requirementId: firstRequirementId,
          requirement: 'Own the division P&L and annual operating budget.',
          support: 'direct',
          evidenceIds: ['DSI-002'],
          explanation: 'DSI-002 territory performance establishes direct budget authority.',
        }],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /cannot mark P&L, financial accountability, or budget authority as direct/,
  );

  assert.doesNotThrow(() => parseStandardResult({
    standardScores: [{
      ...first,
      experienceFitReason: 'Partner certification-program design is directly supported by DSI-021.',
      evidenceIds: ['DSI-021'],
      mandatoryRequirementAssessments: [{
        requirementId: firstRequirementId,
        requirement: 'Experience designing partner certification programs.',
        support: 'direct',
        evidenceIds: ['DSI-021'],
        explanation: 'DSI-021 directly establishes partner certification-program design.',
      }],
    }, second],
  }, [firstId, secondId], allowedEvidenceIds));

  for (const requirement of [
    'Supervise and coach a team of ten sales representatives.',
    'Carry full financial accountability and allocate departmental spend.',
    'Serve as the primary relationship owner for named Fortune 500 clients.',
  ]) {
    assert.throws(
      () => parseStandardResult({
        standardScores: [{
          ...first,
          mandatoryRequirementAssessments: [{
            requirementId: firstRequirementId,
            requirement,
            support: 'direct',
            evidenceIds: ['DSI-002'],
            explanation: `DSI-002 is claimed as direct support for: ${requirement}`,
          }],
        }, second],
      }, [firstId, secondId], allowedEvidenceIds),
      /people-leadership|financial accountability|enterprise\/national-account ownership/,
      requirement,
    );
  }

  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementAssessments: [{
          requirementId: firstRequirementId,
          requirement: 'Five years of channel sales experience.',
          support: 'direct',
          evidenceIds: ['DSI-002'],
          explanation: 'Direct multi-state channel sales tenure.',
        }],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /explanation must cite DSI-002/,
  );
  assert.throws(
    () => parseStandardResult({
      standardScores: [{
        ...first,
        mandatoryRequirementAssessments: [{
          requirementId: firstRequirementId,
          requirement: 'Five years of channel sales experience.',
          support: 'direct',
          evidenceIds: ['DSI-002'],
          explanation: 'DSI-002 and DSI-021 both establish direct channel tenure.',
        }],
      }, second],
    }, [firstId, secondId], allowedEvidenceIds),
    /explanation cites DSI-021 outside its evidenceIds/,
  );

  const thirteenAssessments = Array.from({ length: 13 }, (_, index) => ({
    requirementId: `req-${String(index + 1).padStart(24, '0')}`,
    requirement: `Channel sales responsibility ${index + 1}.`,
    support: 'direct',
    evidenceIds: ['DSI-002'],
    explanation: `DSI-002 directly supports channel sales responsibility ${index + 1}.`,
  }));
  assert.doesNotThrow(() => parseStandardResult({
    standardScores: [{
      ...first,
      mandatoryRequirementAssessments: thirteenAssessments,
    }, second],
  }, [firstId, secondId], allowedEvidenceIds));
});

test('standard result requires exact ordered coverage of every bound JD requirement candidate', () => {
  const allowedEvidenceIds = new Set(['DSI-002']);
  const first = (validStandardResult().standardScores as Array<Record<string, unknown>>)[0];
  const candidates = [
    {
      requirementId: `req-${'a'.repeat(24)}`,
      text: 'Comfort engaging at all levels of a partner organization.',
      source: 'explicit_section' as const,
      sourceSpan: { start: 100, end: 160 },
      mandatoryByText: true,
    },
    {
      requirementId: `req-${'b'.repeat(24)}`,
      text: 'Ability to work independently and prioritize competing demands.',
      source: 'explicit_section' as const,
      sourceSpan: { start: 161, end: 225 },
      mandatoryByText: true,
    },
  ];
  const assessments = candidates.map((candidate) => ({
    requirementId: candidate.requirementId,
    requirement: candidate.text,
    support: 'direct',
    evidenceIds: ['DSI-002'],
    explanation: `DSI-002 directly supports ${candidate.text}`,
  }));
  const expected = new Map([[firstId, candidates]]);
  assert.doesNotThrow(() => parseStandardResult({
    standardScores: [{ ...first, mandatoryRequirementAssessments: assessments }],
  }, [firstId], allowedEvidenceIds, expected));
  assert.throws(() => parseStandardResult({
    standardScores: [{ ...first, mandatoryRequirementAssessments: assessments.slice(0, 1) }],
  }, [firstId], allowedEvidenceIds, expected), /cover every assigned requirement candidate/);
  assert.throws(() => parseStandardResult({
    standardScores: [{
      ...first,
      mandatoryRequirementAssessments: [
        { ...assessments[0], requirementId: `req-${'c'.repeat(24)}` },
        assessments[1],
      ],
    }],
  }, [firstId], allowedEvidenceIds, expected), /exact ordered requirement IDs and text/);
});
