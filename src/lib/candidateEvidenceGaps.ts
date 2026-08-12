import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { PrismaClient } from '@prisma/client';

export const EVIDENCE_GAP_REPORT_PATH = 'docs/CANDIDATE_EVIDENCE_GAPS.md';
export const EVIDENCE_GAP_ANNOTATIONS_PATH = 'data/candidate_evidence_gap_annotations.json';
export const EVIDENCE_GAP_ANNOTATION_SCHEMA_VERSION = 1;

export type EvidenceGapStatus = 'Open' | 'Answered' | 'Inventory Updated' | 'Not Applicable';
export type EvidenceGapAnnotations = {
  schemaVersion: 1;
  entries: Record<string, { status: EvidenceGapStatus; note?: string; updatedAt?: string }>;
};

export type EvidenceGapSourceRow = {
  jobId: string;
  title: string;
  company: string;
  url: string | null;
  scoreEventId: string;
  createdAt: Date;
  model: string;
  promptVersion: string;
  evidenceHash: string | null;
  assessments: unknown;
};

type GapOccurrence = {
  classification: 'required' | 'preferred';
  criterion: string;
  originalCriterion: string;
  jobId: string;
  title: string;
  company: string;
  url: string | null;
  scoreEventId: string;
  createdAt: Date;
  model: string;
  promptVersion: string;
  evidenceHash: string | null;
};

type GapEntry = {
  conceptKey: string;
  question: string;
  status: EvidenceGapStatus;
  note: string | null;
  occurrences: GapOccurrence[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizedConcept(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/\b(?:required|preferred) verification item\s*:\s*/g, '')
    .replace(/\bproperty\s*(?:&|and)\s*casualty\b|\bp\s*&\s*c\b/g, 'property casualty')
    .replace(/\bcustomer relationship management\b/g, 'crm')
    .replace(/\bbachelor(?:'s|’s)?\b/g, 'bachelor')
    .replace(/\b(?:is|required|preferred|must have|minimum of|at least)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function evidenceGapConceptKey(value: string): string {
  const normalized = normalizedConcept(value);
  const slug = normalized.split(' ').slice(0, 12).join('-') || 'unknown-criterion';
  const digest = createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 10);
  return `${slug}-${digest}`;
}

function evidenceQuestion(value: string): string {
  const cleaned = value.replace(/^(?:Required|Preferred) verification item:\s*/i, '').replace(/[.\s]+$/g, '');
  return `Can verified evidence establish: ${cleaned}?`;
}

export function parseEvidenceGapAnnotations(value: unknown): EvidenceGapAnnotations {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.entries)) {
    throw new Error('evidence-gap annotations must use schemaVersion 1 with an entries object');
  }
  const entries: EvidenceGapAnnotations['entries'] = {};
  for (const [key, raw] of Object.entries(value.entries)) {
    if (!isRecord(raw) || !['Open', 'Answered', 'Inventory Updated', 'Not Applicable'].includes(String(raw.status))) {
      throw new Error(`invalid evidence-gap annotation for ${key}`);
    }
    if (raw.note !== undefined && typeof raw.note !== 'string') throw new Error(`invalid annotation note for ${key}`);
    if (raw.updatedAt !== undefined && typeof raw.updatedAt !== 'string') throw new Error(`invalid annotation updatedAt for ${key}`);
    entries[key] = {
      status: raw.status as EvidenceGapStatus,
      ...(raw.note === undefined ? {} : { note: raw.note }),
      ...(raw.updatedAt === undefined ? {} : { updatedAt: raw.updatedAt }),
    };
  }
  return { schemaVersion: 1, entries };
}

function collectEntries(rows: readonly EvidenceGapSourceRow[], annotations: EvidenceGapAnnotations): GapEntry[] {
  const byConcept = new Map<string, GapEntry>();
  for (const row of rows) {
    if (!isRecord(row.assessments) || !Array.isArray(row.assessments.criteria) || !Array.isArray(row.assessments.outcomes)) continue;
    const outcomesById = new Map(row.assessments.outcomes.filter(isRecord).map((outcome) => [String(outcome.criterionId), outcome]));
    for (const raw of row.assessments.criteria) {
      if (!isRecord(raw) || (raw.classification !== 'required' && raw.classification !== 'preferred')) continue;
      if (raw.category === 'administrative' || raw.category === 'subjective_boilerplate' || raw.category === 'role_defining_credential') continue;
      const outcome = outcomesById.get(String(raw.criterionId));
      if (!outcome || outcome.outcome !== 'cannot_evaluate') continue;
      const criterion = typeof raw.normalizedMeaning === 'string' ? raw.normalizedMeaning.trim() : '';
      const source = isRecord(raw.source) ? raw.source : null;
      const originalCriterion = source && typeof source.exactQuote === 'string' ? source.exactQuote.trim() : criterion;
      if (!criterion) continue;
      const conceptKey = evidenceGapConceptKey(criterion);
      const annotation = annotations.entries[conceptKey];
      if (annotation?.status === 'Not Applicable') continue;
      const entry = byConcept.get(conceptKey) || {
        conceptKey,
        question: evidenceQuestion(criterion),
        status: annotation?.status || 'Open',
        note: annotation?.note || null,
        occurrences: [],
      };
      entry.occurrences.push({
        classification: raw.classification as 'required' | 'preferred',
        criterion,
        originalCriterion,
        jobId: row.jobId,
        title: row.title,
        company: row.company,
        url: row.url,
        scoreEventId: row.scoreEventId,
        createdAt: row.createdAt,
        model: row.model,
        promptVersion: row.promptVersion,
        evidenceHash: row.evidenceHash,
      });
      byConcept.set(conceptKey, entry);
    }
  }
  return [...byConcept.values()].sort((left, right) => left.conceptKey.localeCompare(right.conceptKey));
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function renderEvidenceGapReport(
  rows: readonly EvidenceGapSourceRow[],
  annotations: EvidenceGapAnnotations,
): string {
  const entries = collectEntries(rows, annotations);
  const lines = [
    '# Candidate Evidence Gaps',
    '',
    '> Generated from the latest authoritative current Experience Fit event for each job. This report is not evidence authority.',
    '',
    `Active concepts: ${entries.length}`,
    '',
  ];
  for (const entry of entries) {
    const occurrences = [...entry.occurrences].sort((left, right) => (
      left.createdAt.valueOf() - right.createdAt.valueOf()
      || left.jobId.localeCompare(right.jobId)
      || left.scoreEventId.localeCompare(right.scoreEventId)
    ));
    const requiredCount = occurrences.filter((occurrence) => occurrence.classification === 'required').length;
    const preferredCount = occurrences.length - requiredCount;
    lines.push(
      `## ${entry.question}`,
      '',
      `- Concept key: \`${entry.conceptKey}\``,
      `- Status: ${entry.status}`,
      `- Occurrences: ${occurrences.length} total (${requiredCount} required, ${preferredCount} preferred)`,
      `- First occurrence: ${isoDate(occurrences[0].createdAt)}`,
      `- Latest occurrence: ${isoDate(occurrences.at(-1)!.createdAt)}`,
    );
    if (entry.note) lines.push(`- Annotation: ${entry.note}`);
    lines.push('', '### Provenance', '');
    for (const occurrence of occurrences) {
      const jobLink = occurrence.url ? `[${occurrence.company} — ${occurrence.title}](${occurrence.url})` : `${occurrence.company} — ${occurrence.title}`;
      lines.push(
        `- ${jobLink}`,
        `  - Job ID: \`${occurrence.jobId}\``,
        `  - Classification: ${occurrence.classification}`,
        `  - Exact criterion: ${occurrence.originalCriterion}`,
        `  - Atomic criterion: ${occurrence.criterion}`,
        `  - Score event: \`${occurrence.scoreEventId}\``,
        `  - Provenance: model \`${occurrence.model}\`; prompt \`${occurrence.promptVersion}\`; evidence hash \`${occurrence.evidenceHash || 'unrecorded'}\``,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export async function refreshEvidenceGapReport(
  prisma: PrismaClient,
  options: { reportPath?: string; annotationsPath?: string } = {},
): Promise<{ reportPath: string; conceptCount: number }> {
  const reportPath = options.reportPath || EVIDENCE_GAP_REPORT_PATH;
  const annotationsPath = options.annotationsPath || EVIDENCE_GAP_ANNOTATIONS_PATH;
  const annotations = parseEvidenceGapAnnotations(JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ annotationsPath, 'utf8')));
  const rows = await prisma.$queryRaw<Array<{
    jobId: string; title: string; company: string; url: string | null; scoreEventId: string; createdAt: Date;
    model: string; promptVersion: string; evidenceHash: string | null; assessments: unknown;
  }>>`
    WITH ranked AS (
      SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e."jobId" ORDER BY e."createdAt" DESC, e."id" DESC) AS rank
      FROM "JobScoreEvent" e
      WHERE e."evaluationType" = 'experience_fit' AND e."staleAt" IS NULL
    )
    SELECT r."jobId", j."title", j."company", COALESCE(j."canonicalUrl", j."url") AS url,
      r."id" AS "scoreEventId", r."createdAt", r."model", r."promptVersion", r."evidenceHash",
      r."mandatoryRequirementAssessments" AS assessments
    FROM ranked r
    JOIN "Job" j ON j."id" = r."jobId"
    WHERE r.rank = 1
    ORDER BY r."jobId"
  `;
  const report = renderEvidenceGapReport(rows, annotations);
  const prior = fs.existsSync(/* turbopackIgnore: true */ reportPath) ? fs.readFileSync(/* turbopackIgnore: true */ reportPath, 'utf8') : null;
  if (prior !== report) fs.writeFileSync(/* turbopackIgnore: true */ reportPath, report, 'utf8');
  return { reportPath, conceptCount: (report.match(/^## /gm) || []).length };
}
