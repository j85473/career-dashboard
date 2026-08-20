/**
 * Reads Workday's authoritative top-level `hiringOrganization.name` value.
 *
 * The CXS detail response uses this field for the actual employing entity. It
 * may be a parent brand, a regional legal entity, or a subsidiary, so preserve
 * the provider's text verbatim apart from surrounding whitespace.
 */
export function workdayHiringOrganizationName(hiringOrganization: unknown): string | null {
  if (!hiringOrganization || typeof hiringOrganization !== 'object' || Array.isArray(hiringOrganization)) {
    return null;
  }
  const name = (hiringOrganization as { name?: unknown }).name;
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || !/\p{L}/u.test(trimmed)) return null;
  if (/^(?:unknown|n\/?a|none|company|organization)$/i.test(trimmed)) return null;
  return trimmed;
}

function decodeBoardToken(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function displayToken(value: string): string {
  // Numeric-leading brands such as `3m` are normally acronym-like. Keeping
  // the digit while uppercasing the letters produces `3M`, not `3m`.
  if (/^\d+[a-z]+$/i.test(value)) return value.toUpperCase();
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Bounded fallback for a Workday board identifier such as
 * `graco.wd501::Graco_Careers`.
 *
 * `.wd501` identifies Workday infrastructure, never the employer. When the
 * detail response omits `hiringOrganization.name`, remove only that known
 * shard and make the remaining provider-owned tenant readable. This is still
 * a fallback rather than an authoritative brand expansion: opaque tenants
 * such as `bdx` remain `Bdx` instead of being guessed into a company name.
 */
export function workdayBoardCompanyFallback(boardSlug: string): string {
  const hostnameToken = decodeBoardToken(String(boardSlug || '').split('::')[0].trim());
  const tenant = hostnameToken.replace(/\.wd\d+$/i, '');
  const readable = tenant
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map(displayToken)
    .join(' ');
  return readable || 'Unknown Company';
}

/**
 * Presentation-only compatibility for historical rows created before the
 * Workday company fix. Keep the stored value untouched because company is a
 * scoring input, but never show an infrastructure hostname as the employer.
 */
export function workdayCompanyDisplayName(
  company: string | null | undefined,
  source: string | null | undefined,
): string {
  const value = String(company || '').trim();
  if (source?.toLowerCase() === 'ats-workday' && /\.wd\d+$/i.test(value)) {
    return workdayBoardCompanyFallback(value);
  }
  return value;
}
