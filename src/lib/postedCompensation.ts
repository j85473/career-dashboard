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

/** An explicit statement that the range is annual, which outranks the floor below. */
const ANNUAL_CONTEXT = /\bper\s+(?:year|annum)\b|\bannual(?:ly|ized)?\b|\/\s*(?:yr|year)\b/i;

/**
 * A posting can name a pay period this extractor does not recognise, or omit
 * one entirely. Those slipped through as absurd "base salary" figures: a
 * Student Ambassador at "$1,075–$1,750", contractor rates read as annual pay.
 *
 * Below this floor an unlabelled range is not credibly a yearly salary, so it
 * fails closed — unless the posting says outright that it is annual, which is
 * exactly the case for a genuine low-cost-of-living role (one real posting
 * states "$10,400 – $13,000 USD per year" for a remote India position, and
 * that figure is correct and must survive).
 */
const IMPLAUSIBLE_ANNUAL_FLOOR = 15_000;

/**
 * A base band for one role does not span an order of magnitude. Northrop
 * Grumman posts "$16,900.00 - $253,600.00" and its own next sentence calls it
 * "a general guideline" covering every level — technically stated, but not
 * this role's pay, so displaying it would mislead.
 */
const MAX_RANGE_RATIO = 10;

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
      const local = window.slice(Math.max(0, rangeIndex - 20), rangeEnd + 40);
      if (NON_ANNUAL_CONTEXT.test(local)) continue;

      // An annual marker usually prefixes the label ("Annual base salary
      // range: $X"), while a non-annual period trails the number ("$X per
      // month"). The backward reach is wider for that reason, and the marker
      // that opened this window counts too.
      const annualLocal = markerText.includes('annual')
        || ANNUAL_CONTEXT.test(window.slice(Math.max(0, rangeIndex - 90), rangeEnd + 40));

      const low = formatAmount(range[1]);
      const high = formatAmount(range[2]);
      if (!low || !high) continue;

      const lowValue = Number(low.replaceAll(',', ''));
      const highValue = Number(high.replaceAll(',', ''));
      if (lowValue > highValue) continue;
      if (lowValue <= 0 || highValue / lowValue > MAX_RANGE_RATIO) continue;
      // The floor only applies to a range the posting never called annual.
      if (lowValue < IMPLAUSIBLE_ANNUAL_FLOOR && !annualLocal) continue;

      candidates.add(`$${low}–$${high} base`);
    }
  }

  return candidates.size === 1 ? [...candidates][0] : null;
}
