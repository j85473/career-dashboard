import { assessJobDescriptionQuality } from './jobDescriptionQuality';
import { identifyAts, isPostingExtractionLabel } from './atsUtils';

/** Reinsert structure only; never replace historical prose with a changed JD. */
export function repairPostingDescriptionFormatting(existing: string, formatted: string): string | null {
  if (existing.includes('\n') || !formatted.includes('\n')
    || !assessJobDescriptionQuality(formatted, { structuredSource: true }).scorable) return null;
  const compact = (value: string) => value.replace(/•|\s/g, '');
  const oldText = compact(existing);
  const recoveredText = compact(formatted);
  if (!oldText.startsWith(recoveredText)) return null;
  // Workday's SEO copy can append an employer introduction that its CXS
  // description omits. Keep that exact saved suffix instead of deleting it.
  let matched = 0;
  let index = 0;
  while (index < existing.length && matched < recoveredText.length) {
    if (!/[•\s]/.test(existing[index])) matched++;
    index++;
  }
  const suffix = existing.slice(index).trim();
  const repaired = suffix ? `${formatted.trim()}\n\n${suffix}` : formatted.trim();
  return compact(repaired) === oldText ? repaired : null;
}

export function repairPostingAtsLabel(job: {
  url: string | null; canonicalUrl: string | null; source: string | null; manualAts: string | null;
}): { manualAts: string | null } | null {
  if (!isPostingExtractionLabel(job.manualAts)) return null;
  let ats = identifyAts({ url: job.url, source: job.source });
  if (ats === 'Unknown') ats = identifyAts({ url: job.canonicalUrl, source: job.source });
  return { manualAts: ats === 'Unknown' ? null : ats };
}
