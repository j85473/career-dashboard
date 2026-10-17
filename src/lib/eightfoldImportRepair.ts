import type { AtsScrapeResult } from './atsApi';
import { generateV4Fingerprint } from './jobIngestion';
import { assessJobDescriptionQuality, looksLikeSiteConfiguration } from './jobDescriptionQuality';
import { isGenericManualImportCompany, MANUAL_IMPORT_SOURCE } from './manualImportPolicy';

/** Only repair identified manual-import corruption; never schedule or replace scores. */
export function planEightfoldImportRepair(before: {
  title: string; company: string; employer: string | null; location: string | null;
  url: string | null; source: string | null; description: string | null;
}, recovered: AtsScrapeResult | null) {
  if (before.source !== MANUAL_IMPORT_SOURCE || !before.url || !looksLikeSiteConfiguration(before.description || '')) {
    throw new Error('Card does not contain the manual-import configuration corruption this repair handles');
  }
  if (!recovered || recovered.ats !== 'Eightfold' || !recovered.title || !recovered.company || !recovered.location
    || !assessJobDescriptionQuality(recovered.text, { structuredSource: true }).scorable) {
    throw new Error('The exact Eightfold posting and employer could not be verified');
  }
  // The legacy importer cut the browser title at exactly 50 characters.
  // Permit that known corruption, not arbitrary similar job titles.
  const titleMatches = recovered.title.toLowerCase() === before.title.toLowerCase()
    || (before.title.length === 50 && recovered.title.toLowerCase().startsWith(before.title.toLowerCase()));
  const companyMatches = (name: string | null) => isGenericManualImportCompany(name, before.url)
    || name?.toLowerCase() === recovered.company!.toLowerCase();
  if (!titleMatches || !companyMatches(before.company) || !companyMatches(before.employer)) {
    throw new Error('Recovered posting conflicts with the saved title or employer');
  }
  return {
    title: recovered.title, company: recovered.company, employer: recovered.company,
    location: recovered.location, description: recovered.text, manualAts: 'Eightfold',
    identityFingerprint: generateV4Fingerprint(recovered.title, recovered.company, recovered.location),
  };
}
