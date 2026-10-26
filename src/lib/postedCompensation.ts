/** Extract explicitly stated annual base pay for the job card, independently of scoring. */
const PAY_MARKER = /\b(?:base\s+(?:pay|salary|compensation)(?:\s+range)?|base(?=\s*(?::|=|\bis\b|\$))|(?:annual(?:ized)?\s+)?salary(?:\s+range)?|(?:annual(?:ized)?\s+)?pay\s+range)\b/gi;
const AMOUNT = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?:[ \t]*[kK])?`;
const AMOUNT_END = String.raw`(?![\dkK]|[,\.]\d)`;
const ANNUAL_SUFFIX = String.raw`(?:\s*(?:/\s*(?:yr|year)|per\s+(?:year|annum)|annually))?`;
const PAY_RANGE = new RegExp(String.raw`\$\s*(${AMOUNT})\s*(?:USD)?${ANNUAL_SUFFIX}\s*(?:-|–|—|\bto\b|\band\b)\s*(?:USD\s*)?\$?\s*(${AMOUNT})${AMOUNT_END}`, 'g');
const PAY_AMOUNT = new RegExp(String.raw`\$\s*(${AMOUNT})${AMOUNT_END}`, 'g');
const VARIABLE_PAY = /\b(?:ote|ttc|on[-\s]?target(?:[-\s]+earnings)?|total\s+(?:target\s+)?(?:cash|compensation|rewards?|earnings)|commission|bonus|incentive|variable)\b/i;
const ADDITIONAL_PAY = /\+|\bplus\b|\bin\s+addition\b|\b(?:and\s+)?may\s+(?:also\s+)?include\b/;
const NEXT_PAY_LABEL = /\b(?:variable\s+(?:compensation|pay)|ote|on[-\s]target\s+earnings|total\s+(?:target\s+)?(?:cash|compensation)(?:\s+range)?)\s*(?::|\bis\b|\bof\b)/i;
const FOREIGN_CURRENCY = /\b(?:CAD|AUD|NZD|SGD|HKD|EUR|GBP|INR|CA|AU|NZ|C|A)\s*$/i;
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

interface PayCandidate {
  index: number;
  end: number;
  low: string;
  high?: string;
}

function parseAmount(raw: string): number {
  return Number(raw.replace(/[kK,\s]/g, '')) * (/[kK]/.test(raw) ? 1_000 : 1);
}

/** Keep the written cents while expanding an employer's explicit K shorthand. */
function displayAmount(raw: string, value: number): string | null {
  return formatAmount(/[kK]/.test(raw) || parseAmount(raw) !== value ? String(value) : raw.trim());
}

/**
 * Associate each amount with its own pay label. The previous window scan could
 * attach an adjacent OTE/bonus range to a base-pay label, and required two
 * dollar signs even when the employer wrote "$70,000-100,000".
 *
 * Fixed salaries and ranges are both literal posting facts. Conflicting bands
 * still fail closed; no OTE split or annualization is calculated here.
 */
export function extractPostedBaseCompensation(description: string | null | undefined): string | null {
  const text = description
    ?.replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'")
    .replace(/&(?:mdash|#8212|#x2014);/gi, '—')
    .replace(/&(?:ndash|#8211|#x2013);/gi, '–')
    .replace(/&(?:nbsp|#160|#xa0);/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\\([-.])/g, '$1')
    .replace(/[^\S\n]+/g, ' ').trim();
  if (!text) return null;

  const amounts: PayCandidate[] = [];
  for (const range of text.matchAll(PAY_RANGE)) {
    amounts.push({ index: range.index, end: range.index + range[0].length, low: range[1], high: range[2] });
  }
  for (const amount of text.matchAll(PAY_AMOUNT)) {
    if (amounts.some((range) => amount.index >= range.index && amount.index < range.end)) continue;
    amounts.push({ index: amount.index, end: amount.index + amount[0].length, low: amount[1] });
  }

  const markers = [...text.matchAll(PAY_MARKER)];
  const candidates = new Map<string, boolean>();
  const variableValues = new Set<string>();
  const genericKeys = new Map<string, string>();
  const amountKey = (amount: PayCandidate) => `${parseAmount(amount.low)}:${amount.high ? parseAmount(amount.high) : ''}`;
  for (const amount of amounts) {
    const before = text.slice(Math.max(0, amount.index - 180), amount.index);
    const after = text.slice(amount.end, amount.end + 180);
    // A dollar sign alone does not distinguish USD from CAD/AUD/etc.
    if (FOREIGN_CURRENCY.test(before) || /^\s*(?:CAD|AUD|NZD|SGD|HKD)\b/i.test(after)) continue;

    const ownPrefix = before.slice(before.lastIndexOf('$') + 1).split(/\n|\.\s/).at(-1)!;
    if (VARIABLE_PAY.test(ownPrefix)) variableValues.add(amountKey(amount));

    const marker = markers.findLast((entry) => entry.index < amount.index && entry.index >= amount.index - 180);
    const suffix = after.match(/^\s*(?:USD\s*)?(?:(?:annual|annualized)\s+)?(base(?:\s+(?:salary|pay|compensation))?|salary)\b/i);
    if (!marker && !suffix) continue;
    const bridge = marker ? text.slice(marker.index + marker[0].length, amount.index) : '';
    // A later table row can inherit its salary heading. Counting its band
    // prevents choosing the first city/level when the posting lists several.
    // Fixed amounts cannot inherit across another value, and no amount can
    // inherit across a variable-pay label.
    if (!suffix && ((amount.high === undefined && /\$/.test(bridge)) || VARIABLE_PAY.test(bridge))) continue;

    const directBase = suffix ? /\bbase\b/i.test(suffix[0]) : /^base\b/i.test(marker![0]);
    const lead = marker ? text.slice(Math.max(0, marker.index - 80), marker.index).split(/\n|\.\s/).at(-1)! : '';
    if (!directBase && VARIABLE_PAY.test(lead)) continue;
    // "Plus bonus" describes additional pay; "including bonus" describes a
    // combined figure. Only the former may be labelled as base salary.
    const ownTail = after.split(NEXT_PAY_LABEL)[0].split(/\n|\.\s|\$|,\s*(?:with\s+(?:an?\s+)?)?(?:ote|on[-\s]target\s+earnings)\b/i)[0].split(ADDITIONAL_PAY)[0];
    if (VARIABLE_PAY.test(ownTail)) continue;

    const periodContext = `${bridge.slice(-90)} ${ownTail.slice(0, 40)}`;
    if (NON_ANNUAL_CONTEXT.test(periodContext)) continue;
    const annual = ANNUAL_CONTEXT.test(`${lead} ${marker?.[0] || ''} ${periodContext}`);

    let low = parseAmount(amount.low);
    const high = amount.high === undefined ? undefined : parseAmount(amount.high);
    // Shared suffixes are explicit formatting: "$80-85K" or "$70-80,000".
    if (high !== undefined && low < 1_000 && high >= 1_000 && !/[kK,]/.test(amount.low)) low *= 1_000;
    if (!Number.isFinite(low) || low <= 0 || (low < IMPLAUSIBLE_ANNUAL_FLOOR && !annual)) continue;
    if (high !== undefined && (!Number.isFinite(high) || high < low || high / low > MAX_RANGE_RATIO)) continue;
    // Do not turn a floor/ceiling or an incompletely parsed band into a fixed salary.
    if (high === undefined && (/\b(?:up to|at least|minimum|maximum|approximately|around|about)\b/i.test(ownPrefix)
      || /\b(?:up to|at least|from|minimum|maximum|approximately|around|about|between)\b/i.test(bridge)
      || /^\s*(?:[-–—]|to\b|and\s+\$|or\s+\$|\+(?!\s*(?:variable|commission|bonus|incentive)\b))/i.test(after))) continue;

    const lowLabel = displayAmount(amount.low, low);
    const highLabel = high === undefined ? null : displayAmount(amount.high!, high);
    if (!lowLabel || (high !== undefined && !highLabel)) continue;
    const label = high === undefined ? `$${lowLabel} base` : `$${lowLabel}–$${highLabel} base`;
    candidates.set(label, (candidates.get(label) || false) || directBase);
    // Remember a duplicated generic "Salary Range" that the same posting
    // explicitly identifies as OTE elsewhere, so it cannot override base pay.
    if (!directBase) genericKeys.set(label, amountKey(amount));
  }
  for (const [label, key] of genericKeys) {
    if (!candidates.get(label) && variableValues.has(key)) candidates.delete(label);
  }
  return candidates.size === 1 ? [...candidates.keys()][0] : null;
}

export interface StructuredPayRange {
  currency?: string;
  frequency?: string;
  rangeStart?: number;
  rangeEnd?: number;
}

/**
 * Same shape as the posting itself for platforms that publish pay as
 * structured fields (Rippling's `payRangeDetails`) rather than prose. Applies
 * the same acceptance rules as `extractPostedBaseCompensation` above —
 * positive, ordered, within `MAX_RANGE_RATIO`, and only when there is exactly
 * one distinct range — but skips `IMPLAUSIBLE_ANNUAL_FLOOR` entirely: that
 * floor exists only to guess at postings that never say whether a range is
 * annual, and an explicit `frequency: "YEAR"` is the same "outright says
 * annual" case the prose extractor already exempts from it.
 */
export function extractStructuredBaseCompensation(
  ranges: readonly StructuredPayRange[] | null | undefined,
): string | null {
  if (!ranges || ranges.length === 0) return null;

  const candidates = new Set<string>();
  for (const range of ranges) {
    if (range.currency !== 'USD' || range.frequency !== 'YEAR') continue;
    if (typeof range.rangeStart !== 'number' || typeof range.rangeEnd !== 'number') continue;

    const low = formatAmount(String(range.rangeStart));
    const high = formatAmount(String(range.rangeEnd));
    if (!low || !high) continue;

    const lowValue = Number(low.replaceAll(',', ''));
    const highValue = Number(high.replaceAll(',', ''));
    if (lowValue > highValue) continue;
    if (lowValue <= 0 || highValue / lowValue > MAX_RANGE_RATIO) continue;

    candidates.add(`$${low}–$${high} base`);
  }

  return candidates.size === 1 ? [...candidates][0] : null;
}
