// Title queries, ordered by expected yield against the v3 channel-sales
// positioning. Channel and partner titles lead; territory, regional, and field
// titles are the secondary motion. Every ingestion provider runs once per
// query, so additions here cost paid-API quota.
export const PRIMARY_JOB_SEARCH_QUERIES = [
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
  // Low-yield, kept at the tail rather than dropped.
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
// NOT yet wired into the ingestion loop — doing so is a change to
// `src/app/api/pipeline/run/route.ts` (pipeline orchestration).
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
