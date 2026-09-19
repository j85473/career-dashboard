import crypto from 'node:crypto';

import { companyIdentityKey } from './companyIdentity';
import { generateV4Fingerprint, normalizeJobLocation, normalizeTitle } from './jobIngestion';

export type StoredIdentityRow = {
  id: string;
  title: string;
  company: string;
  location: string | null;
  identityFingerprint: string | null;
};

export type IdentityRepair = { id: string; from: string; to: string };

/** The v4 fingerprint as it was computed before entity codes were stripped. */
export function preCleanupV4Fingerprint(title: string, company: string, location: string): string {
  const raw = `${companyIdentityKey(company, { keepEntityCode: true })}|${normalizeTitle(title)}|${normalizeJobLocation(location)}`;
  return `v4:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

/**
 * Rows whose stored identity is exactly the pre-cleanup hash of their current
 * title, company and location, and whose company key changed. Anything else —
 * no identity, an identity from different labels, or already current — is
 * left alone, so the repair cannot create identity where there was none.
 */
export function planIdentityFingerprintRepairs(rows: readonly StoredIdentityRow[]): IdentityRepair[] {
  const repairs: IdentityRepair[] = [];
  for (const row of rows) {
    if (!row.identityFingerprint) continue;
    const location = row.location || '';
    const current = generateV4Fingerprint(row.title, row.company, location);
    if (current === row.identityFingerprint) continue;
    if (preCleanupV4Fingerprint(row.title, row.company, location) !== row.identityFingerprint) continue;
    repairs.push({ id: row.id, from: row.identityFingerprint, to: current });
  }
  return repairs;
}
