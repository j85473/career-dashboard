// Search these field roles explicitly across paid and source-feed providers.
// Discovery admits the title; local motion checks and Aim/Experience still
// judge the actual work. Provider budgets remain the cap on paid requests.
export const TERRITORY_FIELD_JOB_SEARCH_QUERIES = [
  'territory manager',
  'territory sales manager',
  'territory sales representative',
  'territory sales executive',
  'regional sales manager',
  'field sales manager',
  'field sales representative',
  'field sales executive',
  'outside sales representative',
  'outside sales manager',
] as const;

export const RETAIL_DISTRIBUTOR_JOB_SEARCH_QUERIES = [
  'territory account manager',
  'distributor account manager',
  'distributor business manager',
  'wholesale account manager',
  'retail account manager',
  'retail business manager',
  'manufacturer sales representative',
  'dealer account manager',
] as const;

// Membership controls coverage; weighted due-task scheduling, rather than
// array order, allocates extra turns to territory/distributor/retail searches.
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
  ...TERRITORY_FIELD_JOB_SEARCH_QUERIES,
  ...RETAIL_DISTRIBUTOR_JOB_SEARCH_QUERIES,
  'key account manager',
  'national account manager',
  'strategic account manager',
  // Low-yield, kept at the tail rather than dropped.
  'strategic territory manager',
  'customer sales manager',
] as const;

// Paid providers multiply every title across four sources and four geography
// lanes. Cover channel/partner networks and explicit territory/field sales
// titles; the broader reach still shares the existing provider request budgets.
// Broader titles remain available to free/source-feed discovery through the
// primary portfolio above, and body-aware paid searches still cover the
// high-signal channel language below.
export const PAID_JOB_SEARCH_QUERIES = [
  'channel account manager',
  'channel partner manager',
  'channel business manager',
  'channel development manager',
  'partner account manager',
  'partner business manager',
  'partner development manager',
  'partner sales manager',
  'partner growth manager',
  'partner activation manager',
  'partner success manager',
  'regional channel manager',
  'channel manager',
  'distribution account manager',
  'distribution sales manager',
  'dealer development manager',
  'dealer performance manager',
  'territory performance manager',
  ...TERRITORY_FIELD_JOB_SEARCH_QUERIES,
  ...RETAIL_DISTRIBUTOR_JOB_SEARCH_QUERIES,
] as const;

// CareerForce is a browser-backed, Minnesota-specific source that launches one
// scraper run per title every 12 hours. Add the explicit field-sales portfolio
// without fanning every channel/performance variant through this provider.
export const CAREERFORCE_JOB_SEARCH_QUERIES = [
  'channel account manager',
  'channel partner manager',
  'partner account manager',
  'partner development manager',
  'regional channel manager',
  'channel manager',
  'distribution account manager',
  'distribution sales manager',
  ...TERRITORY_FIELD_JOB_SEARCH_QUERIES,
  ...RETAIL_DISTRIBUTOR_JOB_SEARCH_QUERIES,
  'key account manager',
  'national account manager',
  'strategic account manager',
  'strategic territory manager',
  'customer sales manager',
] as const;

// Description phrases for territory, retail, and channel work that ordinary
// job titles can miss.
//
// These are safe to search as free text: of the ingestion providers, BioSpace
// (`keywords`), Remotive (`search`), Adzuna (`what`), USAJOBS (`Keyword`),
// SerpApi Google Jobs (`q`), JSearch (`query`), and Glassdoor (`query`) all
// match against title *and* description. The one exception is the LinkedIn
// RapidAPI source, which binds the query to `title:` and would return
// near-nothing for these phrases.
//
export const RETAIL_DISTRIBUTOR_DESCRIPTION_QUERIES = [
  '"assigned accounts" "territory"',
  '"retail partners" "sales"',
  '"independent retailers"',
  '"distributor relationships"',
  '"product training" "dealers"',
  '"territory growth" "existing accounts"',
] as const;

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
  ...RETAIL_DISTRIBUTOR_DESCRIPTION_QUERIES,
] as const;

// Exact query families only: generic channel/partner searches remain in the
// broader portfolio. No industry, job score, or existing job state is inferred.
const TERRITORY_RETAIL_QUERY_FAMILIES = new Set<string>([
  ...TERRITORY_FIELD_JOB_SEARCH_QUERIES,
  ...RETAIL_DISTRIBUTOR_JOB_SEARCH_QUERIES,
  'distribution account manager',
  'distribution sales manager',
  'dealer development manager',
  'dealer performance manager',
  'territory performance manager',
  'retail performance manager',
  ...['sell-through', 'distributor management', ...RETAIL_DISTRIBUTOR_DESCRIPTION_QUERIES]
    .map((query) => `description ${query}`),
].map((query) => query.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')));

export function isTerritoryRetailSearchFamily(queryFamily: string | null): boolean {
  return queryFamily !== null && TERRITORY_RETAIL_QUERY_FAMILIES.has(queryFamily);
}

// Small, high-signal discovery lane for jobs whose titles are ordinary but the
// work itself is travel-heavy. These run only on body-aware providers and the
// title-only LinkedIn source is explicitly skipped. Durable provider budgets
// remain the hard cap; this list is intentionally bounded.
export const TRAVEL_LANGUAGE_QUERIES = [
  '"50% travel" channel sales',
  '"extensive travel" partner sales',
  '"up to 75% travel" territory',
] as const;

// JSearch already covers Indeed alongside other public job sites and returns
// the full description in its search response. Do not schedule the dedicated
// Indeed12 source here: its 13-request daily plan returns fifteen metadata-only
// rows per search and then charges a second request for every description, so
// ordinary search tasks consume the allowance before those rows can be made
// scorable. The Indeed parser and detail resolver remain available for stored
// records and controlled recovery; only new dedicated searches are retired.
export const PAID_TITLE_SEARCH_SOURCES = [
  'SerpApi',
  'JSearch',
  'LinkedIn',
  'Glassdoor (RapidAPI)',
] as const;

export const BODY_AWARE_SEARCH_SOURCES = PAID_TITLE_SEARCH_SOURCES.filter(
  (source) => source !== 'LinkedIn',
);
