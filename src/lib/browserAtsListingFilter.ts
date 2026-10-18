import { passesTitlePreFilter } from './jobFiltering';

export type BrowserAtsListingTitleTrust = 'usable' | 'missing' | 'generic_anchor' | 'incomplete';
export type BrowserAtsListingTitlePreview = {
  mode: 'preview';
  /** Preview never authorizes the worker to skip a detail or an archived record. */
  shouldSkip: false;
  wouldSkip: boolean;
  titleTrust: BrowserAtsListingTitleTrust;
  reason: string | null;
};

const GENERIC_ANCHOR = /^(?:apply(?:\s+(?:now|today|here))?|view(?:\s+(?:job|details?|position|opening))?|learn more|read more|click here|details?|job details?|show more|see\s+(?:job|details?|more)|submit(?:\s+application)?|email|share|open(?:\s+(?:job|position))?|title|unknown(?: title)?|job|position|opening|job posting|loading(?: jobs?)?)[\s.!:>»›…-]*$/i;
const ACTION_LABEL = /^(?:apply|view|read|learn|click|show|see)\b|\b(?:apply now|view details?|read more|learn more)\s*$/i;

function titleTrust(value: string | null | undefined, complete: boolean | undefined): BrowserAtsListingTitleTrust {
  if (!value?.trim()) return 'missing';
  const title = value.replace(/\s+/g, ' ').trim();
  if (GENERIC_ANCHOR.test(title) || ACTION_LABEL.test(title)) return 'generic_anchor';
  // An anchor can be clipped or can contain a whole results card. Its text is
  // not a substitute for the complete title on the exact posting page.
  if (complete !== true || title.length > 300 || /\.{2,}|…|\uFFFD/.test(title)
    || /[|,:;&/+-]\s*$/.test(title) || /\b(?:and|or|of|for|with|in|to)\s*$/i.test(title)
  ) return 'incomplete';
  const pairs: readonly [string, string][] = [['(', ')'], ['[', ']'], ['{', '}']];
  for (const [open, close] of pairs) {
    let depth = 0;
    for (const character of title) {
      if (character === open) depth++;
      if (character === close && --depth < 0) return 'incomplete';
    }
    if (depth !== 0) return 'incomplete';
  }
  return 'usable';
}

/**
 * Measures existing title exclusions without changing what the crawler saves.
 * Generic, incomplete, or unverified anchors fail open. This evaluates no employer,
 * geography, description, or inferred language evidence, and creates no job
 * disposition. Enabling actual skips requires a separate collection policy.
 */
export function previewBrowserAtsListingTitle(input: {
  title?: string | null;
  /** Set only from provider evidence that the full published title is present. */
  titleComplete?: boolean;
}): BrowserAtsListingTitlePreview {
  const trust = titleTrust(input.title, input.titleComplete);
  if (trust !== 'usable') {
    return { mode: 'preview', shouldSkip: false, wouldSkip: false, titleTrust: trust, reason: null };
  }
  const verdict = passesTitlePreFilter(input.title!.replace(/\s+/g, ' ').trim());
  return {
    mode: 'preview', shouldSkip: false, wouldSkip: !verdict.passes,
    titleTrust: trust, reason: verdict.passes ? null : verdict.reason,
  };
}
