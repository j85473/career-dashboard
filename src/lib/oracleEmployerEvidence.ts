import { parseOraclePostingDetail, oraclePostingDetailUrl } from './oraclePosting';

function requestedPosting(payload: unknown, url: string): Record<string, unknown> | null {
  if (!oraclePostingDetailUrl(url) || !payload || typeof payload !== 'object') return null;
  const id = new URL(url).pathname.split('/').filter(Boolean).at(-1);
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? items.find(item => item && typeof item === 'object' && String(item.Id) === id) || null : null;
}

/** A missing label can use another verified posting for the same legal entity,
 * only within the same tenant. The numeric entity ID alone supplies no name. */
export function corroboratedOracleEmployer(payload: unknown, url: string,
  witness: { payload: unknown; url: string; pageHtml?: string }): string {
  const posting = requestedPosting(payload, url), other = requestedPosting(witness.payload, witness.url);
  if (!posting || !other || new URL(url).hostname !== new URL(witness.url).hostname) return '';
  const legalId = String(posting.LegalEmployerId || '');
  if (!/^\d+$/.test(legalId) || legalId !== String(other.LegalEmployerId || '')) return '';
  return parseOraclePostingDetail(witness.payload, witness.url, witness.pageHtml)?.company || '';
}
