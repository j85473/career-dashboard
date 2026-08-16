/**
 * Extract an explicitly posted base-pay range from an employer's JD.
 *
 * This is intentionally narrower than Aim's compensation assessment: it is a
 * factual display field, not a fit input. The extractor only accepts a range
 * that the posting calls base pay/base salary, or a plainly labelled salary or
 * pay range without total-compensation, OTE, commission, or hourly context.
 */
const BASE_RANGE_MARKER = /\b(?:base\s+(?:pay|salary|compensation)(?:\s+range)?|(?:annual\s+)?(?:salary|pay)\s+range)\b/gi;
const PAY_RANGE = /\$\s*((?:\d{1,3}(?:,\d{3})+|\d{4,6})(?:\.\d{1,2})?)\s*(?:USD)?\s*(?:-|–|—|\bto\b)\s*\$\s*((?:\d{1,3}(?:,\d{3})+|\d{4,6})(?:\.\d{1,2})?)\s*(?:USD)?/gi;
const GENERIC_RANGE_EXCLUSIONS = /\b(?:ote|on[-\s]?target(?:\s+earnings)?|total\s+(?:cash|compensation|rewards?)|commission|bonus|incentive)\b/i;
/**
 * Any pay period other than a year. Rejecting only hourly was not enough: a
 * real posting read "$6,000-$12,500 per month (Gross in USD)" under a plain
 * "salary range" marker and was rendered as "$6,000–$12,500 base", which
 * understates a $72k–$150k role by an order of magnitude. Rescaling it would
 * be inference, so a non-annual period fails closed instead.
 */
const NON_ANNUAL_CONTEXT = /\b(?:hourly|monthly|weekly|daily|biweekly|bi-weekly|semi-?monthly)\b|\bper\s+(?:hour|month|week|day|fortnight)\b|\ban?\s+(?:hour|month|week|day)\b|\/\s*(?:hr|hour|mo|month|wk|week|day)\b/i;

function formatAmount(raw: string): string | null {
  const amount = Number(raw.replaceAll(',', ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const decimals = raw.includes('.') ? raw.split('.')[1]?.length || 0 : 0;
  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(amount);
}

/**
 * Returns a normalized label such as `$79,800–$99,800 base`, or null when the
 * posting does not state one unambiguously. Multiple distinct ranges fail
 * closed because they often represent location-specific bands.
 */
export function extractPostedBaseCompensation(description: string | null | undefined): string | null {
  const text = description?.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const candidates = new Set<string>();
  for (const marker of text.matchAll(BASE_RANGE_MARKER)) {
    const markerText = marker[0].toLowerCase();
    const markerIndex = marker.index || 0;
    const windowStart = Math.max(0, markerIndex - 80);
    const windowEnd = Math.min(text.length, markerIndex + markerText.length + 180);
    const window = text.slice(windowStart, windowEnd);
    const directBaseMarker = markerText.startsWith('base ');

    // A generic "salary range" is accepted only when its own local context
    // makes clear that it is not an OTE, total, or variable-pay statement.
    if (!directBaseMarker && GENERIC_RANGE_EXCLUSIONS.test(window)) continue;

    for (const range of window.matchAll(PAY_RANGE)) {
      const rangeIndex = range.index || 0;
      const rangeEnd = rangeIndex + range[0].length;
      if (NON_ANNUAL_CONTEXT.test(window.slice(Math.max(0, rangeIndex - 20), rangeEnd + 40))) continue;

      const low = formatAmount(range[1]);
      const high = formatAmount(range[2]);
      if (!low || !high || Number(low.replaceAll(',', '')) > Number(high.replaceAll(',', ''))) continue;
      candidates.add(`$${low}–$${high} base`);
    }
  }

  return candidates.size === 1 ? [...candidates][0] : null;
}
