const LEGAL_SUFFIXES = new Set([
  'company',
  'corp',
  'corporation',
  'inc',
  'incorporated',
  'limited',
  'llc',
  'ltd',
  'plc',
]);

const JOINED_LEGAL_SUFFIXES = [
  'incorporated',
  'corporation',
  'operatingllc',
  'company',
  'limited',
  'corp',
  'llc',
  'ltd',
  'plc',
  'inc',
] as const;

// Words that cannot identify an employer by themselves. When removing an
// entity code would leave only these ("RETAIL STORES LLC", "U.K. LIMITED",
// "Corporate Office"), the code was carrying the identity and stays.
export const GENERIC_EMPLOYER_WORDS: ReadonlySet<string> = new Set([
  'a', 'agency', 'america', 'americas', 'and', 'b', 'bv', 'branch', 'co', 'companies', 'company', 'corp',
  'corporate', 'corporation', 'de', 'default', 'division', 'enterprises', 'entity', 'for', 'gmbh', 'global',
  'group', 'groups', 'health', 'holding', 'holdings', 'hospital', 'inc', 'incorporated', 'international',
  'k', 'legal', 'limited', 'llc', 'llp', 'lp', 'ltd', 'management', 'networks', 'of', 'office', 'operations',
  'partners', 'partnership', 'plc', 'pte', 'pvt', 'retail', 'sa', 'sas', 'service', 'services', 'solutions',
  'store', 'stores', 'systems', 'technologies', 'the', 'trucking', 'u', 'uk', 'us', 'usa',
  // Codes followed only by a place or a trade ("2200 Germany", "K44
  // Consulting") name a payroll unit, not an employer.
  'australia', 'china', 'coalition', 'consulting', 'engineering', 'france', 'germany', 'hamburg', 'india',
  'japan', 'kenya', 'kingdom', 'korea', 'national', 'netherlands', 'power', 'shanghai', 'tech', 'united',
]);

function lettersOf(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
}

function nameWords(value: string): string[] {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/&/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
}

function isDistinctiveName(value: string): boolean {
  const words = nameWords(value);
  // "Default Company for India" names a payroll bucket, not an employer.
  if (words[0] === 'default' && words[1] === 'company') return false;
  return /^[\p{L}(]/u.test(value)
    && words.some(word => word.length >= 2 && /[a-z]/.test(word) && !GENERIC_EMPLOYER_WORDS.has(word));
}

/**
 * Whether a lettered entity code visibly refers to the name after it:
 * "NILIN" / "Nilfisk" share a stem, "GBA" / "Gogo Business Aviation" is an
 * acronym. Without that, the code may itself be the brand ("USA-PVH").
 */
function codeNamesRemainder(code: string, remainder: string): boolean {
  const words = nameWords(remainder).filter(word => /[a-z]/.test(word));
  const initials = words.filter(word => !['and', 'of', 'the', 'de', 'do', 'du'].includes(word))
    .map(word => word[0]).join('');
  return code.split('-').map(lettersOf).filter(part => part.length >= 3).some(part =>
    words.some(word => word.startsWith(part.slice(0, 3)))
    || initials.startsWith(part));
}

// A numeric code, or a short uppercase code ending in digits (LE001, CO39,
// 6J2, B10), then a space or " - ". Two-character tokens such as C3 or H2 are
// often the brand itself and are left alone.
const LEADING_CODE = /^(?:\d{1,6}|(?=[A-Z0-9]*[A-Z])[A-Z0-9]{2,7}\d)(?:\s+-\s+|\s+)(?=\S)/;
// "6014-Janssen Biotech, Inc. Legal Entity": a 3+ digit code joined by a hyphen.
const JOINED_NUMERIC_CODE = /^\d{3,6}-(?=\p{L})/u;
// A US employer identification number: "94-1687665 Bank of America".
const LEADING_EIN = /^\d{2}-\d{7}\s+(?=\S)/;
// "USA-NILIN Nilfisk, Inc.", "CO-06 Patient First", "LE001-ASXOPS ASX Operations".
const LEADING_HYPHENATED_CODE = /^([A-Z][A-Z0-9]{1,5}-[A-Z0-9]{2,10})(?:\s+-\s+|\s+)(?=\S)/;

function withoutTrailingLegalEntity(value: string): string {
  const suffix = 'legal entity';
  const suffixStart = value.length - suffix.length;
  if (suffixStart <= 0 || value.slice(suffixStart).toLowerCase() !== suffix) return value;
  if (value[suffixStart - 1].trim() !== '') return value;

  let end = suffixStart;
  while (end > 0 && value[end - 1].trim() === '') end -= 1;
  return value.slice(0, end);
}

/**
 * Removes the internal legal-entity code some ATS tenants (overwhelmingly
 * Workday) put around the employer name: "94-1687665 Bank of America, National
 * Association", "LE001 Northwest Bank", "USA-NILIN Nilfisk, Inc.",
 * "6014-Janssen Biotech, Inc. Legal Entity".
 *
 * The failure mode is no change: when the remainder would not identify an
 * employer on its own, the original text is returned.
 */
export function withoutEntityCode(value: string | null | undefined): string {
  const original = String(value || '').trim().replace(/\s+/g, ' ');
  let name = original;
  const hyphenated = name.match(LEADING_HYPHENATED_CODE);
  if (hyphenated) {
    const code = hyphenated[1];
    const rest = name.slice(hyphenated[0].length);
    const [, second] = code.split('-');
    if (/^\d+$/.test(second) || codeNamesRemainder(code, rest)) name = rest;
  } else {
    name = name.replace(LEADING_EIN, '').replace(JOINED_NUMERIC_CODE, '').replace(LEADING_CODE, '');
  }
  if (name !== original) name = name.replace(/^\([^)]*\)\s*/, '');
  name = withoutTrailingLegalEntity(name).trim();
  return name !== original && isDistinctiveName(name) ? name : original;
}

function normalizedWords(value: string, keepEntityCode = false): string[] {
  return (keepEntityCode ? String(value || '').trim() : withoutEntityCode(value || ''))
    .replace(/\.wd\d+$/i, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function stripJoinedLegalSuffix(token: string): string {
  for (const suffix of JOINED_LEGAL_SUFFIXES) {
    if (!token.endsWith(suffix)) continue;
    const stem = token.slice(0, -suffix.length);
    // Requiring a meaningful stem keeps ordinary words such as "zinc" from
    // being interpreted as a company name followed by "Inc".
    if (stem.length >= 4) return stem;
  }
  return token;
}

/**
 * Stable employer identity for lifecycle policy and prospective dedupe.
 *
 * Job boards frequently emit the same employer as a display name, a legal
 * name, or a compact board slug (for example, SharkNinja, SharkNinja
 * Operating LLC, and sharkninjaoperatingllc). This deliberately normalizes
 * only presentation and trailing legal-form differences; it is not fuzzy
 * company matching and cannot merge merely similar names.
 */
export function companyIdentityKey(
  value: string | null | undefined,
  // Only for recognizing fingerprints stored before entity codes were
  // stripped (2026-09-18); every live comparison uses the default.
  options: { keepEntityCode?: boolean } = {},
): string {
  const words = normalizedWords(String(value || ''), options.keepEntityCode);
  while (words.length > 1 && LEGAL_SUFFIXES.has(words.at(-1)!)) words.pop();
  if (words.length > 1 && words.at(-1) === 'operating') words.pop();

  if (words.length === 1) {
    const stripped = stripJoinedLegalSuffix(words[0]);
    if (stripped !== words[0]) words[0] = stripped.endsWith('operating')
      && stripped.length - 'operating'.length >= 4
      ? stripped.slice(0, -'operating'.length)
      : stripped;
  }
  return words.join(' ');
}

export function sameCompanyIdentity(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const leftKey = companyIdentityKey(left);
  const rightKey = companyIdentityKey(right);
  // Some feeds remove the spaces from a display name altogether ("Patch My
  // PC" versus "Patchmypc"). That is formatting, not a fuzzy similarity
  // match: the complete normalized names must still be identical once spaces
  // are removed.
  return leftKey.length > 0 && (
    leftKey === rightKey
    || leftKey.replace(/\s/g, '') === rightKey.replace(/\s/g, '')
  );
}
