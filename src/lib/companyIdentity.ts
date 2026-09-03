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

function normalizedWords(value: string): string[] {
  return (value || '')
    .trim()
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
export function companyIdentityKey(value: string | null | undefined): string {
  const words = normalizedWords(String(value || ''));
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
