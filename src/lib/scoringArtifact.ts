import { canonicalJsonSha256, codePointLength, normalizeScoringText, normalizedTextSha256, assertExactCodePointQuote } from './scoringCanonicalJson';

export const CLEANED_JD_ARTIFACT_SCHEMA_VERSION = 'career-dashboard-cleaned-jd-v1';

export const REMOVAL_CLASSIFICATIONS = [
  'legal_boilerplate', 'benefits', 'application_instructions', 'privacy_or_cookie',
  'navigation_or_debris', 'employer_marketing', 'duplicate',
] as const;

export type CleanedJdArtifactInput = {
  cleanerVersion: string;
  sourceJdHash: string;
  cleanedText: string;
  cleanedTextHash: string;
  removedSpans: Array<{ startCodePoint: number; endCodePoint: number; exactQuote: string; classification: typeof REMOVAL_CLASSIFICATIONS[number] }>;
  coverageAudit: { complete: boolean; findings: string[] };
  repairHistory: string[];
};

export function validateCleanedJdArtifact(sourceJd: string, artifact: CleanedJdArtifactInput): { normalizedSource: string; contentHash: string } {
  const normalizedSource = normalizeScoringText(sourceJd);
  const cleanedText = normalizeScoringText(artifact.cleanedText);
  if (normalizedTextSha256(normalizedSource) !== artifact.sourceJdHash) throw new Error('cleaned artifact source JD hash mismatch');
  if (normalizedTextSha256(cleanedText) !== artifact.cleanedTextHash) throw new Error('cleaned artifact text hash mismatch');
  if (!cleanedText || codePointLength(cleanedText) > codePointLength(normalizedSource)) throw new Error('cleaned JD length is invalid');
  if (!artifact.coverageAudit.complete || artifact.coverageAudit.findings.length > 0) throw new Error('cleaned artifact has unresolved coverage findings');
  if (artifact.repairHistory.length > 2) throw new Error('cleaned artifact exceeds the repair bound');
  if (artifact.removedSpans.length > 1024) throw new Error('cleaned artifact has too many removed spans');
  const sourceCodePoints = [...normalizedSource];
  const retained: string[] = [];
  let priorEnd = 0;
  for (const span of artifact.removedSpans) {
    if (!REMOVAL_CLASSIFICATIONS.includes(span.classification)) throw new Error('cleaned artifact has unknown removal classification');
    if (span.startCodePoint < priorEnd || span.endCodePoint <= span.startCodePoint) throw new Error('cleaned artifact removed spans must be ordered, non-overlapping, and non-empty');
    assertExactCodePointQuote(normalizedSource, span, span.exactQuote);
    retained.push(sourceCodePoints.slice(priorEnd, span.startCodePoint).join(''));
    priorEnd = span.endCodePoint;
  }
  retained.push(sourceCodePoints.slice(priorEnd).join(''));
  if (retained.join('') !== cleanedText) throw new Error('cleaned artifact text is not exactly the source minus declared spans');
  const contentHash = canonicalJsonSha256({
    schemaVersion: CLEANED_JD_ARTIFACT_SCHEMA_VERSION,
    cleanerVersion: artifact.cleanerVersion,
    sourceJdHash: artifact.sourceJdHash,
    cleanedText,
    cleanedTextHash: artifact.cleanedTextHash,
    removedSpans: artifact.removedSpans,
    coverageAudit: artifact.coverageAudit,
    repairHistory: artifact.repairHistory,
  });
  return { normalizedSource, contentHash };
}
