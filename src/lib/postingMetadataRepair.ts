import { createHash } from 'node:crypto';
import { isGenericManualImportCompany, isGenericManualImportTitle } from './manualImportPolicy';
import { locationTriageVerdict } from './localTriage';
import { hasIncompleteLocations, separateCommaLocations } from './postingLocation';
import { isGeneralRemoteOption, hasExplicitUnitedStatesReference } from './jobLocationPolicy';

export const POSTING_METADATA_REPAIR_VERSION = 'posting-metadata-location-v1';
export const automaticGeographyReason = (reason: string | null) => /^(?:Locally triaged out: Location outside the searched geographies|International location rejected|Outstate MN location rejected|Location rejected\s*\()/i.test(reason || '');
export const repairHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function canonicalRepairedLocation(location: string): string {
  if (isGeneralRemoteOption(location) && hasExplicitUnitedStatesReference(location)) return 'Remote - United States';
  return separateCommaLocations(location).trim();
}
export type MetadataRepairEvidence = {
  title?: string; company?: string; location: string; source: string;
  identityVerified: boolean; completeLocations: boolean;
};
export type MetadataRepairJob = {
  title: string; company: string; location: string | null; url: string | null;
  status: string; passReason: string | null; source: string | null;
  scoringStatus: string; tailoringStaged: boolean;
};
export function planPostingMetadataRepair(job: MetadataRepairJob, evidence: MetadataRepairEvidence,
  guard: { hasScores: boolean; hasHumanDecision: boolean; reviewedRestore?: boolean }) {
  if (!evidence.identityVerified || !evidence.location.trim()) return null;
  const sameTitle = (a: string, b: string) => a.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim() === b.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  if (evidence.title && !sameTitle(evidence.title,job.title) && !isGenericManualImportTitle(job.title)) return null;
  const location = canonicalRepairedLocation(evidence.location);
  // A country-only page fragment must not erase a known city/work-base. It
  // can be an additional option, but alone it is not proof of expanded scope.
  if (/^(?:US|USA|United States(?: of America)?|Canada|MN|Minnesota)$/i.test(location)
    && job.location && !/^(?:unknown(?: location)?|n\/a|not specified|\d+ locations?)$/i.test(job.location)
    && !/^(?:US|USA|United States(?: of America)?|Canada|MN|Minnesota)$/i.test(job.location)) return null;
  const metadata: { title?: string; company?: string; employer?: string; location?: string } = {};
  if (evidence.title && isGenericManualImportTitle(job.title) && evidence.title !== job.title) metadata.title = evidence.title;
  if (evidence.company && isGenericManualImportCompany(job.company,job.url) && evidence.company !== job.company) {
    metadata.company = evidence.company; metadata.employer = evidence.company;
  }
  if (location !== job.location) metadata.location = location;
  const geoRejected = automaticGeographyReason(job.passReason);
  const canRestore = evidence.completeLocations && !hasIncompleteLocations(location)
    && locationTriageVerdict(location).pass && ['archived','dismissed','passed'].includes(job.status)
    && (geoRejected || (guard.reviewedRestore && job.passReason === 'Location mismatch'))
    && (!guard.hasHumanDecision || guard.reviewedRestore)
    && (!guard.hasScores || guard.reviewedRestore) && (!job.tailoringStaged || guard.reviewedRestore);
  if (!Object.keys(metadata).length && !canRestore) return null;
  return { action: canRestore ? 'restore_for_review' as const : 'metadata_only' as const, metadata,
    ...(canRestore ? { lifecycle: { status: guard.reviewedRestore ? 'inbox' : 'pending_af',
      // Preserve every score and its authority. Existing scored/manual decisions
      // need explicit reviewed restoration; they are never sent for a rescore.
      scoringStatus: guard.reviewedRestore ? job.scoringStatus : 'queued', passReason: null } } : {}) };
}
