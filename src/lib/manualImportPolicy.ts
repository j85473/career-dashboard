import type { Prisma } from '@prisma/client';

export const MANUAL_IMPORT_SOURCE = 'Manual Import';

export const MANUAL_IMPORT_INITIAL_LIFECYCLE = {
  status: 'inbox',
  tailoringStaged: true,
} as const;

export type ManualImportMetadata = {
  source: string | null | undefined;
  title: string | null | undefined;
  company: string | null | undefined;
  location: string | null | undefined;
  description: string | null | undefined;
  url?: string | null | undefined;
};

export type ManualImportNormalization = {
  title: string;
  company: string;
  location: string | null;
  changedFields: Array<'title' | 'company' | 'location'>;
  readyForScoring: boolean;
  evidence: 'authoritative_metadata' | 'anchored_jd' | 'unresolved';
};

export function isManualImportSource(source: string | null | undefined): boolean {
  return source === MANUAL_IMPORT_SOURCE;
}

/**
 * Manual Imports are user-selected work. Automated scoring may add
 * informational evidence, but only the user may change their lifecycle.
 */
export function automatedLifecycleIsProtected(job: {
  source?: string | null;
}): boolean {
  return isManualImportSource(job.source);
}

/**
 * Prisma's `{ not: value }` maps to SQL `<>` and does not match NULL. Keep the
 * exact Manual Import exclusion in an OR object that callers can place inside
 * `AND`, so it cannot overwrite a route's existing OR clauses.
 */
export function nonManualImportSourceWhere(): Prisma.JobWhereInput {
  return {
    OR: [
      { source: null },
      { source: { not: MANUAL_IMPORT_SOURCE } },
    ],
  };
}

/**
 * Automated terminal signals remain useful evidence for a Manual Import, but
 * they are never allowed to become a lifecycle decision or a skipped score.
 */
export function manualImportInformationalScoringUpdate(reason: string) {
  return {
    scoringStatus: 'scored' as const,
    batchJobId: null,
    jdBatchId: null,
    scoreAttempts: 0,
    scoreError: null,
    fitScore: null,
    fitCategory: 'manual',
    fitRationale: `Manual Import protection: ${reason}`,
    passReason: null,
  };
}

export function isGenericManualImportTitle(value: string | null | undefined): boolean {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) return true;
  if (/^manual job import$/i.test(title)) return true;
  return /^(?:.*\bopportunit(?:y|ies)\b.*\bjoin us\b|join us|careers?|general interest(?: submission)?|join (?:our|the) talent community)$/i.test(title);
}

export function isGenericManualImportCompany(
  value: string | null | undefined,
  url?: string | null | undefined,
): boolean {
  const company = String(value || '').replace(/\s+/g, ' ').trim();
  if (!company || /^manual import$/i.test(company)) return true;
  let hostname = '';
  try {
    hostname = url ? new URL(url).hostname.replace(/^www\./i, '') : '';
  } catch {}
  if (hostname && company.toLowerCase() === hostname.toLowerCase()) return true;
  return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(company);
}

function isGenericLocation(value: string | null | undefined): boolean {
  const location = String(value || '').replace(/\s+/g, ' ').trim();
  return !location || /^(?:unknown(?: location)?|remote location|\d+ locations?)$/i.test(location);
}

function cleanedMetadata(value: string): string {
  return value
    .replace(/^[\s:;,.-]+|[\s:;,.-]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function anchoredJdMetadata(description: string): {
  title: string;
  company: string;
  location: string | null;
} | null {
  const lines = description
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const opportunityLine = lines.find((line) => /\bhas\s+an?\s+(?:exciting\s+)?opportunity\s+for\s+an?\s+/i.test(line));
  if (!opportunityLine) return null;

  const opportunity = opportunityLine.match(
    /^(.{2,80}?)\s+has\s+an?\s+(?:exciting\s+)?opportunity\s+for\s+an?\s+(.{3,120}?)\s+to\s+join\b/i,
  );
  if (!opportunity) return null;
  const company = cleanedMetadata(opportunity[1]);
  const title = cleanedMetadata(opportunity[2]);
  if (!company || !title || isGenericManualImportCompany(company) || isGenericManualImportTitle(title)) {
    return null;
  }

  const reportingLine = lines.find((line) => /\bposition\s+reports\s+to\b/i.test(line));
  const remoteReporting = reportingLine?.match(
    /\bthis\s+(?:remote|\S*emote)\s+position\s+reports\s+to\s+(.{3,80}?)(?:[.]|$)/i,
  );
  const location = remoteReporting
    ? `Remote / ${cleanedMetadata(remoteReporting[1])}`
    : null;

  return { title, company, location };
}

/**
 * Prefer supplied/ATS metadata. Only fill demonstrably generic or missing
 * fields from a high-confidence, anchored sentence in the stored JD. If the
 * anchor is absent, preserve the input instead of guessing.
 */
export function normalizeManualImportMetadata(input: ManualImportMetadata): ManualImportNormalization {
  const current = {
    title: String(input.title || '').replace(/\s+/g, ' ').trim(),
    company: String(input.company || '').replace(/\s+/g, ' ').trim(),
    location: String(input.location || '').replace(/\s+/g, ' ').trim() || null,
  };
  if (!isManualImportSource(input.source)) {
    return {
      ...current,
      changedFields: [],
      readyForScoring: Boolean(current.title && current.company),
      evidence: 'authoritative_metadata',
    };
  }

  const genericTitle = isGenericManualImportTitle(current.title);
  const genericCompany = isGenericManualImportCompany(current.company, input.url);
  const genericLocation = isGenericLocation(current.location);
  if (!genericTitle && !genericCompany && !genericLocation) {
    return {
      ...current,
      changedFields: [],
      readyForScoring: true,
      evidence: 'authoritative_metadata',
    };
  }

  const anchored = anchoredJdMetadata(String(input.description || ''));
  if (!anchored) {
    return {
      ...current,
      changedFields: [],
      readyForScoring: !genericTitle && !genericCompany,
      evidence: 'unresolved',
    };
  }

  const normalized = {
    title: genericTitle ? anchored.title : current.title,
    company: genericCompany ? anchored.company : current.company,
    location: genericLocation && anchored.location ? anchored.location : current.location,
  };
  const changedFields: ManualImportNormalization['changedFields'] = [];
  if (normalized.title !== current.title) changedFields.push('title');
  if (normalized.company !== current.company) changedFields.push('company');
  if (normalized.location !== current.location) changedFields.push('location');

  return {
    ...normalized,
    changedFields,
    readyForScoring: !isGenericManualImportTitle(normalized.title)
      && !isGenericManualImportCompany(normalized.company, input.url),
    evidence: 'anchored_jd',
  };
}
