import { workdayCompanyDisplayName } from './workdayCompany';

/**
 * Reviewed brand names and employing-entity aliases. This catalogue controls
 * presentation/navigation only: never scoring, cooldowns or posting identity.
 * Formatting variants of each entry share the same complete normalized key.
 */
export const COMPANY_DISPLAY_PROFILES = [
  { name: 'Zoetis', aliases: ['110 - Zoetis US LLC', '6J2 - Zoetis Services LLC', 'Zoetis US LLC', 'Zoetis Services LLC'] },
  { name: 'RF-SMART', aliases: [] },
  { name: 'Redwood Materials', aliases: [] },
  { name: 'Power TakeOff', aliases: [] },
  { name: 'Field Nation', aliases: [] },
  { name: 'First Advantage', aliases: [] },
] as const;

function withoutLegalSuffix(value: string): string {
  return value.replace(/(?:[,\s]+(?:incorporated|inc|corporation|corp|llc|ltd|limited|plc|gmbh)\.?)+$/i, '').trim();
}

function nameKey(value: string): string {
  return withoutLegalSuffix(value.replace(/\.wd\d+$/i, ''))
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
}

function profileFor(value: string) {
  const key = nameKey(value);
  return key ? COMPANY_DISPLAY_PROFILES.find(profile => [profile.name, ...profile.aliases]
    .some(alias => nameKey(alias) === key)) : undefined;
}

export function companyDisplayName(company: string | null | undefined, source?: string | null): string {
  const original = String(company || '').trim().replace(/\s+/g, ' ');
  const profile = profileFor(original);
  if (profile) return profile.name;
  // Keep a brand's own casing and wording. An opaque slug cannot tell us how
  // to split a name or which parent brand owns a subsidiary.
  // A company-navigation URL carries the saved name without its source; the
  // exact Workday shard suffix remains enough to render that header cleanly.
  return withoutLegalSuffix(workdayCompanyDisplayName(original, source ?? 'ATS-workday')) || original;
}

export function companyDisplayGroupKey(company: string | null | undefined): string {
  const value = String(company || '').trim().replace(/\s+/g, ' ');
  return nameKey(profileFor(value)?.name || value);
}

export function companyDisplayAliases(company: string): string[] {
  const profile = profileFor(company);
  return [...new Set([company, companyDisplayName(company), ...(profile ? [profile.name, ...profile.aliases] : [])])];
}
