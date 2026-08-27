import {
  BODY_AWARE_SEARCH_SOURCES,
  CAREERFORCE_JOB_SEARCH_QUERIES,
  DESCRIPTION_LANGUAGE_QUERIES,
  PAID_JOB_SEARCH_QUERIES,
  PAID_TITLE_SEARCH_SOURCES,
  PRIMARY_JOB_SEARCH_QUERIES,
  TRAVEL_LANGUAGE_QUERIES,
} from './jobSearchQueries';
import {
  GEO_LANES,
  normalizeQueryFamily,
  type IngestionTaskSpec,
} from './ingestionControl';

export type IngestionTaskDefinition = {
  spec: IngestionTaskSpec;
  intervalMs: number;
};

export function boundedCatalogInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const boundedFallback = Math.min(maximum, Math.max(minimum, Math.trunc(fallback)));
  const normalized = value?.trim();
  if (!normalized || !/^[+-]?\d+$/.test(normalized)) return boundedFallback;
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed)) return boundedFallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

export const ATS_BOARD_BATCH_SIZE = boundedCatalogInteger(
  process.env.ATS_BOARD_BATCH_SIZE, 25, 1, 100,
);
/** Kill switch for the durable direct-ATS acquisition/persistence split. */
export const ATS_SPLIT_INGESTION_ENABLED = process.env.ATS_SPLIT_INGESTION_ENABLED !== 'false';
/**
 * Wall clock for one ATS turn.
 *
 * At ten minutes a turn was completing about nineteen of its five hundred
 * boards before being cut off, so the limit — not the board budget — was what
 * capped throughput at roughly 2,700 boards a day against a 6,209 target.
 */
export const ATS_BATCH_WALL_CLOCK_MS = boundedCatalogInteger(
  process.env.ATS_BATCH_WALL_CLOCK_MS, 1_800_000, 1_800_000, 6 * 60 * 60_000,
);

/** Boards swept in parallel within a turn, bounded by the shared data pool. */
export const ATS_BOARD_CONCURRENCY = boundedCatalogInteger(
  process.env.ATS_BOARD_CONCURRENCY, 4, 1, 4,
);
/** One platform turn prevents per-platform board pools from multiplying. */
export const ATS_PLATFORM_CONCURRENCY = boundedCatalogInteger(
  process.env.ATS_PLATFORM_CONCURRENCY, 1, 1, 1,
);
export const ATS_CONTINUATION_DELAY_MS = boundedCatalogInteger(
  process.env.ATS_CONTINUATION_DELAY_MS, 60_000, 1_000, 15 * 60_000,
);
export const ATS_ACTIVE_LOOP_DELAY_MS = boundedCatalogInteger(
  process.env.ATS_ACTIVE_LOOP_DELAY_MS, 5_000, 250, 60_000,
);
export const ATS_IDLE_LOOP_DELAY_MS = boundedCatalogInteger(
  process.env.ATS_IDLE_LOOP_DELAY_MS, 30_000, 1_000, 15 * 60_000,
);
export const WORKDAY_NEEDS_JD_BACKLOG_LIMIT = boundedCatalogInteger(
  process.env.WORKDAY_NEEDS_JD_BACKLOG_LIMIT, 500, 0, 100_000,
);

export function planAtsPlatformBatches(
  dueCounts: Readonly<Record<string, number>>,
  orderedPlatforms: readonly string[],
  batchSize = ATS_BOARD_BATCH_SIZE,
): Array<{ platform: string; selectedCount: number; remainingDueCount: number }> {
  return orderedPlatforms.flatMap((platform) => {
    const due = Math.max(0, dueCounts[platform] || 0);
    if (!due) return [];
    const selectedCount = Math.min(due, Math.max(1, batchSize));
    return [{ platform, selectedCount, remainingDueCount: due - selectedCount }];
  });
}

export type CanonicalIngestionTaskCatalogOptions = {
  includeCareerOneStop?: boolean;
  includeAdzuna?: boolean;
  includeUsaJobs?: boolean;
  atsPlatforms?: readonly string[];
};

export function configuredIngestionTaskCatalogOptions(
  environment: Record<string, string | undefined>,
  atsPlatforms: readonly string[] = [],
): CanonicalIngestionTaskCatalogOptions {
  return {
    includeCareerOneStop: Boolean(environment.CAREERONESTOP_USER_ID && environment.CAREERONESTOP_API_TOKEN),
    includeAdzuna: Boolean(environment.ADZUNA_APP_ID && environment.ADZUNA_APP_KEY),
    includeUsaJobs: Boolean(environment.USAJOBS_API_KEY && environment.USAJOBS_USER_AGENT),
    atsPlatforms,
  };
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const ROUTE_SOURCE_TASK_DEFINITIONS: readonly IngestionTaskDefinition[] = [
  {
    spec: { source: 'LinkedIn (Apify)', queryFamily: 'sales', searchQuery: 'sales', geoLane: 'source_feed', ingestionMode: 'route-source' },
    intervalMs: DAY_MS,
  },
  {
    spec: { source: 'Dice (Apify)', queryFamily: 'sales', searchQuery: 'sales', geoLane: 'msp_metro', ingestionMode: 'route-source' },
    intervalMs: DAY_MS,
  },
  {
    spec: { source: 'Reddit hiring posts', queryFamily: 'all', searchQuery: null, geoLane: 'source_feed', ingestionMode: 'route-source-disabled' },
    intervalMs: DAY_MS,
  },
  {
    spec: { source: 'Hacker News hiring thread', queryFamily: 'all', searchQuery: null, geoLane: 'source_feed', ingestionMode: 'route-source-disabled' },
    intervalMs: DAY_MS,
  },
  {
    spec: { source: 'GitHub hiring issues', queryFamily: 'all', searchQuery: null, geoLane: 'source_feed', ingestionMode: 'route-source-disabled' },
    intervalMs: DAY_MS,
  },
];

export function careerForceTaskDefinitions(): IngestionTaskDefinition[] {
  return CAREERFORCE_JOB_SEARCH_QUERIES.map((query) => ({
    spec: {
      source: 'CareerForce',
      queryFamily: normalizeQueryFamily(query),
      searchQuery: query,
      geoLane: 'minnesota',
      ingestionMode: 'careerforce',
    },
    intervalMs: 12 * HOUR_MS,
  }));
}

export type PaidTaskDefinition = IngestionTaskDefinition & {
  provider: string;
  query: string;
  familyPrefix: '' | 'description_' | 'travel_';
};

export function paidTaskDefinitions(): PaidTaskDefinition[] {
  const definitions: PaidTaskDefinition[] = [];
  const addPortfolio = (
    providers: readonly string[],
    queries: readonly string[],
    familyPrefix: PaidTaskDefinition['familyPrefix'],
  ) => {
    for (const provider of providers) {
      for (const lane of GEO_LANES) {
        for (const query of queries) {
          definitions.push({
            provider,
            query,
            familyPrefix,
            intervalMs: DAY_MS,
            spec: {
              source: provider,
              queryFamily: `${familyPrefix}${normalizeQueryFamily(query)}`,
              searchQuery: query,
              geoLane: lane.id,
              ingestionMode: familyPrefix === 'travel_'
                ? 'paid-travel'
                : familyPrefix === 'description_' ? 'paid-description' : 'paid-title',
            },
          });
        }
      }
    }
  };
  addPortfolio(BODY_AWARE_SEARCH_SOURCES, TRAVEL_LANGUAGE_QUERIES, 'travel_');
  addPortfolio(PAID_TITLE_SEARCH_SOURCES, PAID_JOB_SEARCH_QUERIES, '');
  addPortfolio(BODY_AWARE_SEARCH_SOURCES, DESCRIPTION_LANGUAGE_QUERIES, 'description_');
  return definitions;
}

export function standardProviderTaskDefinitions(input: {
  provider: string;
  queries: readonly string[];
  lanes: readonly { id: string }[];
  intervalMs: number;
  queryIndependent?: boolean;
}): IngestionTaskDefinition[] {
  const definitions: IngestionTaskDefinition[] = [];
  for (const lane of input.lanes) {
    for (const query of input.queries) {
      definitions.push({
        intervalMs: input.intervalMs,
        spec: {
          source: input.provider,
          queryFamily: input.queryIndependent ? 'all' : normalizeQueryFamily(query),
          searchQuery: query,
          geoLane: lane.id,
          ingestionMode: input.queryIndependent ? 'source-feed' : 'standard',
        },
      });
    }
  }
  return definitions;
}

export const USAJOBS_TRAVEL_TASK_DEFINITION: IngestionTaskDefinition = {
  spec: {
    source: 'USAJOBS',
    queryFamily: 'travel_76_percent_or_greater',
    searchQuery: 'channel sales',
    geoLane: 'minnesota',
    ingestionMode: 'standard-travel',
  },
  intervalMs: DAY_MS,
};

export function atsPlatformTaskDefinition(platform: string): IngestionTaskDefinition {
  return {
    spec: {
      source: `ATS-${platform}`,
      queryFamily: 'all',
      searchQuery: 'sales',
      geoLane: 'source_posted_location',
      ingestionMode: 'ats',
    },
    intervalMs: DAY_MS,
  };
}

/** One lease supervises the board-level acquisition queue, not one platform. */
export const ATS_ACQUISITION_TASK_DEFINITION: IngestionTaskDefinition = {
  spec: {
    source: 'Direct ATS acquisition',
    queryFamily: 'all',
    searchQuery: null,
    geoLane: 'source_posted_location',
    ingestionMode: 'ats-acquisition',
  },
  intervalMs: 30_000,
};

/**
 * Complete no-execution task inventory for the configured deployment. This
 * describes scheduler rows only; building it never claims a lease or invokes a
 * source. Optional providers are included only when their required credentials
 * are configured, matching the pipeline route.
 */
export function canonicalIngestionTaskDefinitions(
  options: CanonicalIngestionTaskCatalogOptions = {},
): IngestionTaskDefinition[] {
  const sourceFeedLane = [{ id: 'source_feed' }] as const;
  const remoteLane = GEO_LANES.filter((lane) => lane.id === 'us_remote');
  const mspLane = GEO_LANES.filter((lane) => lane.id === 'msp_metro');
  const definitions: IngestionTaskDefinition[] = [
    ...ROUTE_SOURCE_TASK_DEFINITIONS,
    ...careerForceTaskDefinitions(),
    ...paidTaskDefinitions(),
    ...standardProviderTaskDefinitions({ provider: 'TheMuse', queries: ['sales'], lanes: sourceFeedLane, intervalMs: DAY_MS, queryIndependent: true }),
    ...standardProviderTaskDefinitions({ provider: 'Arbeitnow', queries: ['sales'], lanes: sourceFeedLane, intervalMs: DAY_MS, queryIndependent: true }),
    // Free, keyless remote feeds. Yield is modest next to the ATS lane, but the
    // whole feed costs one request per interval.
    ...standardProviderTaskDefinitions({ provider: 'RemoteOK', queries: ['sales'], lanes: remoteLane, intervalMs: 12 * HOUR_MS, queryIndependent: true }),
    ...standardProviderTaskDefinitions({ provider: 'Jobicy', queries: ['sales'], lanes: remoteLane, intervalMs: 12 * HOUR_MS, queryIndependent: true }),
    ...standardProviderTaskDefinitions({ provider: 'WeWorkRemotely', queries: ['sales'], lanes: remoteLane, intervalMs: DAY_MS, queryIndependent: true }),
    ...standardProviderTaskDefinitions({ provider: 'Himalayas', queries: PRIMARY_JOB_SEARCH_QUERIES, lanes: remoteLane, intervalMs: DAY_MS }),
    ...standardProviderTaskDefinitions({ provider: 'Remotive', queries: PRIMARY_JOB_SEARCH_QUERIES, lanes: remoteLane, intervalMs: DAY_MS }),
    ...standardProviderTaskDefinitions({ provider: 'BioSpace', queries: PRIMARY_JOB_SEARCH_QUERIES, lanes: sourceFeedLane, intervalMs: 8 * HOUR_MS }),
    ...standardProviderTaskDefinitions({ provider: 'Dejobs', queries: PRIMARY_JOB_SEARCH_QUERIES, lanes: sourceFeedLane, intervalMs: 12 * HOUR_MS }),
  ];
  if (ATS_SPLIT_INGESTION_ENABLED) definitions.push(ATS_ACQUISITION_TASK_DEFINITION);

  if (options.includeCareerOneStop) {
    definitions.push(...standardProviderTaskDefinitions({
      provider: 'CareerOneStop', queries: ['channel sales'], lanes: mspLane, intervalMs: DAY_MS,
    }));
  }
  if (options.includeAdzuna) {
    definitions.push(...standardProviderTaskDefinitions({
      provider: 'Adzuna', queries: PRIMARY_JOB_SEARCH_QUERIES, lanes: GEO_LANES, intervalMs: DAY_MS,
    }));
  }
  if (options.includeUsaJobs) {
    definitions.push(USAJOBS_TRAVEL_TASK_DEFINITION);
    definitions.push(...standardProviderTaskDefinitions({
      provider: 'USAJOBS', queries: PRIMARY_JOB_SEARCH_QUERIES, lanes: GEO_LANES, intervalMs: DAY_MS,
    }));
  }
  if (!ATS_SPLIT_INGESTION_ENABLED) {
    for (const platform of [...new Set(options.atsPlatforms || [])].sort()) {
      if (platform.trim()) definitions.push(atsPlatformTaskDefinition(platform));
    }
  }
  return definitions;
}
