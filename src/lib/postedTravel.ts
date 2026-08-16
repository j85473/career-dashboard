/**
 * Extract an explicitly posted travel expectation from an employer's JD.
 *
 * Companion to `postedCompensation`, and deliberately the same shape: this is a
 * factual display field, not a scoring input. It reports what the posting
 * literally says and nothing else. There is no inference here — a JD that only
 * implies travel ("supporting customers across the region") yields null, not a
 * guess.
 *
 * Aim v2 folded travel judgement into the Aim score itself and stopped writing
 * `Job.travelScore`, which is why the old numeric column reads null everywhere.
 * This restores the *stated* figure without reintroducing a derived one.
 */

/** How far from the word "travel" a percentage can sit and still describe it. */
const PROXIMITY = 60;

const QUALIFIER = /(up\s+to|as\s+much\s+as|approximately|approx\.?|about|around)\s*$/i;

/**
 * A range must be tried before a bare percentage. "25-30%" only carries one
 * percent sign, so a single-value pattern would match the 30 and silently
 * report the top of the band as if it were the whole expectation.
 */
const RANGE = /(?<!\d)(\d{1,3})\s*%?\s*(?:-|–|—|\s+to\s+)\s*(\d{1,3})\s*%/;
const SINGLE = /(?<!\d)(\d{1,3})\s*%/;

/**
 * Qualitative statements are only accepted when the posting is unambiguous.
 * "Some travel" and "travel may be required" are not commitments and are
 * rejected; "no travel required" and "travel is not required" are.
 */
const NO_TRAVEL = /\b(?:no|zero|without\s+any)\s+(?:overnight\s+|business\s+|domestic\s+)?travel\b|\btravel\s+is\s+not\s+(?:required|expected|anticipated)\b/i;
const MINIMAL_TRAVEL = /\b(?:minimal|negligible|rare|infrequent|occasional)\s+(?:overnight\s+|business\s+|domestic\s+)?travel\b|\btravel\s+is\s+(?:minimal|rare|infrequent|occasional)\b/i;

/** Contexts where a percentage near "travel" does not describe the role's travel load. */
const DISQUALIFYING_CONTEXT = /\b(?:reimburs\w*|discount\w*|expenses?|per\s?diem|mileage|stipend|allowance|bonus|equity|match(?:ing|es|ed)?|401k|savings)\b/i;

function normalizePercent(raw: string): number | null {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 100) return null;
  return value;
}

function normalizeQualifier(raw: string | undefined): string | null {
  if (!raw) return null;
  const qualifier = raw.trim().toLowerCase().replace(/\s+/g, ' ');
  if (qualifier === 'as much as' || qualifier === 'up to') return 'up to';
  if (qualifier === 'approx' || qualifier === 'approx.') return 'approximately';
  return qualifier;
}

/**
 * Reads the travel figure out of one window of text surrounding the word
 * "travel". Returns undefined when there is no percentage here, and null when
 * there is one but it is not usable — the caller must treat those differently,
 * because a malformed range ("60-40%") has to suppress the window rather than
 * fall through and report its second number.
 */
function readWindow(window: string): string | null | undefined {
  const range = RANGE.exec(window);
  if (range) {
    const low = normalizePercent(range[1]);
    const high = normalizePercent(range[2]);
    if (low === null || high === null || high < low) return null;
    return low === high ? `${low}%` : `${low}–${high}%`;
  }

  const single = SINGLE.exec(window);
  if (!single) return undefined;
  const value = normalizePercent(single[1]);
  if (value === null) return null;

  const qualifier = normalizeQualifier(QUALIFIER.exec(window.slice(0, single.index))?.[1]);
  return qualifier ? `${qualifier} ${value}%` : `${value}%`;
}

/**
 * Returns a normalized label such as `up to 50%`, `25–30%`, `none stated`, or
 * `minimal` — or null when the posting does not state a travel expectation
 * unambiguously.
 *
 * Two conflicting percentages fail closed for the same reason
 * `postedCompensation` does: they usually describe different territories or
 * variants of the role, and picking one would be inference.
 */
export function extractPostedTravel(description: string | null | undefined): string | null {
  const text = description?.replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const candidates = new Set<string>();

  // Sentence-scoped so a benefits clause elsewhere in the JD (a travel
  // *reimbursement* policy, say) cannot suppress a legitimate statement.
  for (const sentence of text.split(/(?<=[.;!?])\s+/)) {
    if (!/travel/i.test(sentence)) continue;
    if (DISQUALIFYING_CONTEXT.test(sentence)) continue;

    let quantified = false;
    let poisoned = false;
    for (const mention of sentence.matchAll(/travel/gi)) {
      const index = mention.index || 0;
      const window = sentence.slice(
        Math.max(0, index - PROXIMITY),
        Math.min(sentence.length, index + mention[0].length + PROXIMITY),
      );
      const reading = readWindow(window);
      if (reading === undefined) continue;
      if (reading === null) { poisoned = true; continue; }
      candidates.add(reading);
      quantified = true;
    }

    // A stated-but-unusable figure means the sentence did try to quantify
    // travel, so falling back to a vaguer qualitative read would overstate
    // what the posting actually committed to.
    if (quantified || poisoned) continue;
    if (NO_TRAVEL.test(sentence)) candidates.add('none stated');
    else if (MINIMAL_TRAVEL.test(sentence)) candidates.add('minimal');
  }

  if (candidates.size === 0) return null;
  if (candidates.size === 1) return [...candidates][0];

  // A quantified figure alongside a qualitative one is not a conflict — the
  // number is strictly more informative, so prefer it. Two different numbers
  // are a real conflict and fail closed.
  const quantified = [...candidates].filter((candidate) => candidate.includes('%'));
  return quantified.length === 1 ? quantified[0] : null;
}
