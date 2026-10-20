import type { AtsScrapeResult } from './atsApi';
import { coreAtsPostingPageUrl, greenhousePostingUrl } from './coreAtsPostingUrl';
import { generateV4Fingerprint } from './jobIngestion';
import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { isGenericManualImportCompany, isGenericManualImportTitle, MANUAL_IMPORT_SOURCE } from './manualImportPolicy';

/** Explicit metadata repair only; the caller preserves every decision and score. */
export function planGreenhouseImportRepair(before: {
  title: string; company: string; employer: string | null; location: string | null;
  url: string | null; source: string | null;
}, recovered: AtsScrapeResult | null) {
  const identity = before.url ? greenhousePostingUrl(before.url) : null;
  if (before.source !== MANUAL_IMPORT_SOURCE || !identity) throw new Error('Card is not an identified Greenhouse manual import');
  if (!recovered || recovered.ats !== 'Greenhouse' || recovered.atsSlug !== identity.board
    || !recovered.title || isGenericManualImportTitle(recovered.title) || !recovered.company || !recovered.location
    || !assessJobDescriptionQuality(recovered.text, { structuredSource: true }).scorable) {
    throw new Error('The exact Greenhouse posting and employer could not be verified');
  }
  const companyMatches = (name: string | null) => isGenericManualImportCompany(name, before.url)
    || name?.toLowerCase() === recovered.company!.toLowerCase();
  if ((!isGenericManualImportTitle(before.title) && before.title.toLowerCase() !== recovered.title.toLowerCase())
    || !companyMatches(before.company) || !companyMatches(before.employer)) {
    throw new Error('Recovered posting conflicts with the saved title or employer');
  }
  const url = coreAtsPostingPageUrl(before.url!);
  return { title: recovered.title, company: recovered.company, employer: recovered.company,
    location: recovered.location, description: recovered.text, manualAts: 'Greenhouse', url, canonicalUrl: url,
    identityFingerprint: generateV4Fingerprint(recovered.title, recovered.company, recovered.location) };
}
