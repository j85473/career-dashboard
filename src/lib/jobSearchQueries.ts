// Title queries, ordered by expected yield against the canonical field/channel
// positioning. Channel and partner titles lead; territory, regional, and field
// titles are the secondary motion. The durable scheduler records query family,
// geography lane, window, and provider budget for every execution.
export const PRIMARY_JOB_SEARCH_QUERIES = [
  'channel account manager',
  'channel partner manager',
  'channel business manager',
  'channel development manager',
  'partner account manager',
  'partner business manager',
  'partner development manager',
  'partner sales manager',
  'partner growth manager',
  'partner growth sales manager',
  'partner activation manager',
  'partner success manager',
  'regional channel manager',
  'channel manager',
  'distribution account manager',
  'distribution sales manager',
  'dealer development manager',
  'dealer performance manager',
  'territory performance manager',
  'market performance manager',
  'regional performance manager',
  'retail performance manager',
  'franchise performance manager',
  'network performance manager',
  'territory sales manager',
  'regional sales manager',
  'field sales manager',
  'key account manager',
  'national account manager',
  'strategic account manager',
  // Low-yield, kept at the tail rather than dropped.
  'strategic territory manager',
  'customer sales manager',
] as const;

// CareerForce is a browser-backed, Minnesota-specific source that launches one
// scraper run per title every 12 hours. Keep its proven pre-expansion portfolio
// bounded instead of fanning every paid-provider discovery title through it.
export const CAREERFORCE_JOB_SEARCH_QUERIES = [
  'channel account manager',
  'channel partner manager',
  'partner account manager',
  'partner development manager',
  'regional channel manager',
  'channel manager',
  'distribution account manager',
  'distribution sales manager',
  'territory sales manager',
  'regional sales manager',
  'field sales manager',
  'key account manager',
  'national account manager',
  'strategic account manager',
  'strategic territory manager',
  'customer sales manager',
] as const;

// Body-text phrases that only appear in postings written by people who
// actually run a channel, so they surface roles the title set misses.
//
// These are safe to search as free text: of the ingestion providers, BioSpace
// (`keywords`), Remotive (`search`), Adzuna (`what`), USAJOBS (`Keyword`),
// SerpApi Google Jobs (`q`), JSearch (`query`), Indeed (`query`), and
// Glassdoor (`query`) all match against title *and* description. The one
// exception is the LinkedIn RapidAPI source, which binds the query to `title:`
// and would return near-nothing for these phrases.
//
export const DESCRIPTION_LANGUAGE_QUERIES = [
  'two-tier distribution',
  'sell-through',
  'distributor management',
  'authorized reseller',
  'channel partner program',
  'partner enablement',
  'indirect channel',
  'master agent',
  'MDF',
] as const;

// Small, high-signal discovery lane for jobs whose titles are ordinary but the
// work itself is travel-heavy. These run only on body-aware providers and the
// title-only LinkedIn source is explicitly skipped. Durable provider budgets
// remain the hard cap; this list is intentionally bounded.
export const TRAVEL_LANGUAGE_QUERIES = [
  '"50% travel" channel sales',
  '"extensive travel" partner sales',
  '"up to 75% travel" territory',
] as const;

export const PAID_TITLE_SEARCH_SOURCES = [
  'SerpApi',
  'JSearch',
  'Indeed',
  'LinkedIn',
  'Glassdoor (RapidAPI)',
] as const;

export const BODY_AWARE_SEARCH_SOURCES = PAID_TITLE_SEARCH_SOURCES.filter(
  (source) => source !== 'LinkedIn',
);
