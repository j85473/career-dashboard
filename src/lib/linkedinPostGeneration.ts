export interface LinkedInArticle {
  lane: string;
  title: string;
  url: string;
  snippet: string;
}

export interface LinkedInDraftOption {
  title: string;
  postText: string;
  url: string;
}

const LANE_COPY: Record<string, { hook: string; perspective: string; takeaway: string }> = {
  'SaaS Channel & Partnerships': {
    hook: 'Channel growth is operational before it is strategic.',
    perspective: 'The useful question is not whether partnerships matter. It is whether the operating model gives partners a clear path from launch to repeatable production.',
    takeaway: 'That is the difference between having a partner list and building a channel.',
  },
  'B2B GTM Strategy': {
    hook: 'A go-to-market plan is only as strong as the route to revenue it can actually run.',
    perspective: 'The real test is whether ownership, economics, enablement, and field execution line up around the same buyer motion.',
    takeaway: 'Distribution is not a substitute for a go-to-market system; it exposes whether one exists.',
  },
  'Partner Operations': {
    hook: 'Partner performance problems usually surface in operations before they show up in revenue.',
    perspective: 'Incentives get attention, but consistent execution comes from clear ownership, usable data, and a repeatable cadence.',
    takeaway: 'Before adding another tool or program, fix the operating friction partners face every day.',
  },
};

function cleanText(value: string): string {
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function conciseSourceDetail(article: LinkedInArticle): string {
  const cleaned = cleanText(article.snippet);
  if (!cleaned) return `The headline frames the issue plainly: “${cleanText(article.title)}.”`;

  const firstSentence = cleaned.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() || cleaned;
  if (firstSentence.length <= 280) return firstSentence;

  const shortened = firstSentence.slice(0, 277);
  const lastSpace = shortened.lastIndexOf(' ');
  return `${shortened.slice(0, lastSpace > 180 ? lastSpace : 277).trim()}…`;
}

export function buildSourceBackedDraft(article: LinkedInArticle): LinkedInDraftOption {
  const copy = LANE_COPY[article.lane] || {
    hook: 'Execution is where a market idea becomes a business result.',
    perspective: 'The practical question is what this changes about ownership, decisions, and day-to-day execution.',
    takeaway: 'A useful strategy should make the next operating decision clearer.',
  };

  const headline = cleanText(article.title) || article.lane;
  const sourceDetail = conciseSourceDetail(article);

  return {
    title: `${article.lane}: ${headline}`,
    postText: `${copy.hook}\n\nA recent article, “${headline},” adds a useful signal: ${sourceDetail}\n\n${copy.perspective}\n\n${copy.takeaway}`,
    url: article.url,
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseGeneratedDrafts(
  rawText: string,
  verifiedUrls: string[],
): LinkedInDraftOption[] {
  const parsed: unknown = JSON.parse(rawText.replace(/```json/gi, '').replace(/```/g, '').trim());
  const candidate = typeof parsed === 'object' && parsed !== null && 'posts' in parsed
    ? (parsed as { posts?: unknown }).posts
    : null;

  if (!Array.isArray(candidate) || candidate.length !== verifiedUrls.length) {
    throw new Error('The provider did not return one draft for every article.');
  }

  const allowedUrls = new Set(verifiedUrls);
  const seenUrls = new Set<string>();
  const drafts = candidate.map((value): LinkedInDraftOption => {
    if (typeof value !== 'object' || value === null) {
      throw new Error('The provider returned an invalid draft.');
    }

    const { title, postText, url } = value as Record<string, unknown>;
    if (!isNonEmptyString(title) || !isNonEmptyString(postText) || !isNonEmptyString(url)) {
      throw new Error('The provider returned an incomplete draft.');
    }
    if (!allowedUrls.has(url) || seenUrls.has(url)) {
      throw new Error('The provider returned an unverified or repeated article URL.');
    }

    seenUrls.add(url);
    return { title: title.trim(), postText: postText.trim(), url };
  });

  if (seenUrls.size !== allowedUrls.size) {
    throw new Error('The provider omitted one or more verified article URLs.');
  }

  return drafts;
}
