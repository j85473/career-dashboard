import {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
  StartQueryExecutionCommand,
} from '@aws-sdk/client-athena';

export type AthenaDiscoveryConfig = {
  region: string;
  workGroup: string;
  database: string;
  table: string;
};

export type AthenaQueryState = {
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';
  reason: string | null;
  resultsExpired?: boolean;
};

export type AthenaResultPage = {
  urls: string[];
  nextToken: string | null;
};

/**
 * Athena is opt-in at the environment boundary so development and recovery
 * hosts never silently require AWS credentials. Production sets this after the
 * restricted worker credential and workgroup are present.
 */
export function athenaDiscoveryConfig(environment: Record<string, string | undefined> = process.env): AthenaDiscoveryConfig | null {
  if (environment.ATS_DISCOVERY_SOURCE !== 'athena') return null;

  const region = environment.ATS_DISCOVERY_ATHENA_REGION;
  const workGroup = environment.ATS_DISCOVERY_ATHENA_WORKGROUP;
  const database = environment.ATS_DISCOVERY_ATHENA_DATABASE;
  const table = environment.ATS_DISCOVERY_ATHENA_TABLE;
  if (!region || !workGroup || !database || !table) {
    throw new Error('Athena discovery is enabled but its region, workgroup, database, or table is missing.');
  }
  return { region, workGroup, database, table };
}

/** Common Crawl's Parquet partition omits the CDX API's -index suffix. */
export function athenaSupportsIndex(indexId: string): boolean {
  // The URL index covers main crawls from 2013 onward. The catalog also
  // contains older CDX-only collections such as CC-MAIN-2008-2009 and 2012.
  const match = /^CC-MAIN-(\d{4})-\d{2}-index$/.exec(indexId);
  return match !== null && Number(match[1]) >= 2013;
}

export function athenaCrawlPartition(indexId: string): string {
  if (!athenaSupportsIndex(indexId)) {
    throw new Error(`Unsupported Common Crawl index id for Athena: ${indexId}`);
  }
  return indexId.slice(0, -'-index'.length);
}

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function globLikeLiteral(pattern: string): string {
  // Escape literal LIKE metacharacters in each fragment, then restore only the
  // configured '*' positions as SQL wildcards.
  return sqlLiteral(pattern.split('*').map((fragment) => (
    fragment.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  )).join('%'));
}

/**
 * Maps the same configured host/path glob used by the legacy CDX API to the
 * URL-index columns. The patterns are repository-owned constants, but the
 * conversion remains deliberately literal so a future pattern cannot turn
 * into arbitrary SQL.
 */
export function athenaCommonCrawlQuery(indexId: string, pattern: string, config: Pick<AthenaDiscoveryConfig, 'database' | 'table'>): string {
  const match = /^([^/]+)(\/.*)$/.exec(pattern);
  if (!match) throw new Error(`Unsupported Common Crawl discovery pattern: ${pattern}`);

  const [, hostPattern, pathPattern] = match;
  const hostCondition = hostPattern.startsWith('*.')
    ? `url_host_name LIKE ${globLikeLiteral(hostPattern)} ESCAPE '\\'`
    : `url_host_name = ${sqlLiteral(hostPattern)}`;
  const pathCondition = pathPattern === '/*'
    ? null
    : `url_path LIKE ${globLikeLiteral(pathPattern)} ESCAPE '\\'`;

  const crawl = athenaCrawlPartition(indexId);
  return [
    'SELECT url',
    `FROM ${config.database}.${config.table}`,
    `WHERE crawl = ${sqlLiteral(crawl)}`,
    "  AND subset = 'warc'",
    `  AND ${hostCondition}`,
    ...(pathCondition ? [`  AND ${pathCondition}`] : []),
  ].join('\n');
}

export class AthenaCommonCrawlReader {
  private readonly client: AthenaClient;

  constructor(private readonly config: AthenaDiscoveryConfig, client?: AthenaClient) {
    this.client = client || new AthenaClient({ region: config.region });
  }

  async start(indexId: string, pattern: string, requestToken: string): Promise<string> {
    const result = await this.client.send(new StartQueryExecutionCommand({
      QueryString: athenaCommonCrawlQuery(indexId, pattern, this.config),
      QueryExecutionContext: { Database: this.config.database },
      WorkGroup: this.config.workGroup,
      ClientRequestToken: requestToken,
    }));
    if (!result.QueryExecutionId) throw new Error('Athena accepted the discovery query without returning an execution id.');
    return result.QueryExecutionId;
  }

  async state(executionId: string): Promise<AthenaQueryState> {
    const result = await this.client.send(new GetQueryExecutionCommand({ QueryExecutionId: executionId }));
    const status = result.QueryExecution?.Status;
    const state = status?.State;
    if (state === 'QUEUED' || state === 'RUNNING' || state === 'SUCCEEDED' || state === 'FAILED' || state === 'CANCELLED') {
      // Managed results are deleted after 24 hours. Expiry is established by
      // execution metadata, never inferred from a transport/permission error.
      const completedAt = status?.CompletionDateTime?.getTime();
      const resultsExpired = state === 'SUCCEEDED'
        && result.QueryExecution?.ManagedQueryResultsConfiguration?.Enabled === true
        && completedAt !== undefined
        && Date.now() - completedAt >= 24 * 60 * 60 * 1000;
      return { state, reason: status?.StateChangeReason || null, resultsExpired };
    }
    return { state: 'UNKNOWN', reason: status?.StateChangeReason || 'Athena returned no query state.' };
  }

  async results(executionId: string, nextToken: string | null): Promise<AthenaResultPage> {
    const result = await this.client.send(new GetQueryResultsCommand({
      QueryExecutionId: executionId,
      ...(nextToken ? { NextToken: nextToken } : {}),
      MaxResults: 1000,
    }));
    const rows = result.ResultSet?.Rows || [];
    // Athena includes the column heading only in the first response.
    const dataRows = nextToken ? rows : rows.slice(1);
    const urls = dataRows.flatMap((row) => {
      const url = row.Data?.[0]?.VarCharValue;
      return typeof url === 'string' ? [url] : [];
    });
    return { urls, nextToken: result.NextToken || null };
  }
}
