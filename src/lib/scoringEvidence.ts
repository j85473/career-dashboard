import fs from 'node:fs';

import { canonicalJsonSha256, normalizedTextSha256 } from './scoringCanonicalJson';

export const CORE_EVIDENCE_PATH = 'docs/Candidate_Evidence_Inventory_-_Core_v1.md';
export const SCORING_EVIDENCE_SCHEMA_VERSION = 'career-dashboard-evidence-snapshot-v1';

export type ScoringEvidenceRecord = {
  evidenceId: string;
  claimWillingness: string;
  baseline: string;
  employer: string;
  roleTitle: string;
  dateRange: string;
  baselineSection: string;
  evidenceText: string;
  neutralCapabilityTags: string[];
  scopeNotes: string;
  verificationStatus: string;
  notes: string;
};

export type ScoringEvidenceSnapshot = {
  schemaVersion: typeof SCORING_EVIDENCE_SCHEMA_VERSION;
  sourcePath: string;
  sourceHash: string;
  records: ScoringEvidenceRecord[];
  evidenceHash: string;
};

const EXPECTED_HEADERS = [
  'claim_willingness', 'evidence_id', 'baseline', 'employer', 'role_title', 'date_range',
  'baseline_section', 'evidence_text', 'neutral_capability_tags', 'scope_notes',
  'verification_status', 'retired', 'notes',
] as const;

function parseMarkdownRow(line: string): string[] {
  if (!line.startsWith('|') || !line.endsWith('|')) throw new Error('evidence row must be a Markdown table row');
  return line.slice(1, -1).split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

export function parseCoreEvidenceMarkdown(markdown: string, sourcePath = CORE_EVIDENCE_PATH): ScoringEvidenceSnapshot {
  const normalized = markdown.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const headingIndex = lines.findIndex((line) => line.trim() === '## Sheet: Core Evidence');
  if (headingIndex < 0) throw new Error('Core Evidence sheet heading is missing');
  const headerIndex = lines.findIndex((line, index) => index > headingIndex && line.startsWith('| claim_willingness |'));
  if (headerIndex < 0 || headerIndex + 2 >= lines.length) throw new Error('Core Evidence table is missing');
  const headers = parseMarkdownRow(lines[headerIndex]);
  if (headers.length !== EXPECTED_HEADERS.length || headers.some((header, index) => header !== EXPECTED_HEADERS[index])) {
    throw new Error('Core Evidence headers do not match the approved schema');
  }
  if (!/^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[headerIndex + 1])) throw new Error('Core Evidence separator row is invalid');

  const records: ScoringEvidenceRecord[] = [];
  const ids = new Set<string>();
  for (let index = headerIndex + 2; index < lines.length && lines[index].startsWith('|'); index += 1) {
    const cells = parseMarkdownRow(lines[index]);
    if (cells.length !== EXPECTED_HEADERS.length) throw new Error(`Core Evidence row ${index + 1} has the wrong field count`);
    const row = Object.fromEntries(headers.map((header, cellIndex) => [header, cells[cellIndex]]));
    if (!/^(?:True|False)$/i.test(row.retired)) throw new Error(`Core Evidence row ${index + 1} has invalid retired state`);
    if (/^True$/i.test(row.retired)) continue;
    if (!/^[A-Z][A-Z0-9]*-\d{3}$/.test(row.evidence_id)) throw new Error(`invalid evidence ID ${row.evidence_id}`);
    if (ids.has(row.evidence_id)) throw new Error(`duplicate evidence ID ${row.evidence_id}`);
    if (!row.evidence_text || !row.scope_notes || !row.verification_status) throw new Error(`${row.evidence_id} is incomplete`);
    ids.add(row.evidence_id);
    records.push({
      evidenceId: row.evidence_id,
      claimWillingness: row.claim_willingness,
      baseline: row.baseline,
      employer: row.employer,
      roleTitle: row.role_title,
      dateRange: row.date_range,
      baselineSection: row.baseline_section,
      evidenceText: row.evidence_text,
      neutralCapabilityTags: row.neutral_capability_tags.split(';').map((tag) => tag.trim()).filter(Boolean),
      scopeNotes: row.scope_notes,
      verificationStatus: row.verification_status,
      notes: row.notes,
    });
  }
  if (records.length === 0) throw new Error('Core Evidence contains no active records');
  const sourceHash = normalizedTextSha256(normalized);
  const payload = { schemaVersion: SCORING_EVIDENCE_SCHEMA_VERSION, sourcePath, sourceHash, records } as const;
  return { ...payload, evidenceHash: canonicalJsonSha256(payload) };
}

export function loadCoreEvidenceSnapshot(path = CORE_EVIDENCE_PATH): ScoringEvidenceSnapshot {
  return parseCoreEvidenceMarkdown(fs.readFileSync(path, 'utf8'), path);
}
