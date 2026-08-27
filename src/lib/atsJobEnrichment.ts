import { passesPreFilter } from './jobFiltering';
import { extractStructuredBaseCompensation } from './postedCompensation';
import { safeExternalFetch } from './safeExternalFetch';
import { workdayHiringOrganizationName } from './workdayCompany';
import { workdayDetailLocation } from './workdayLocation';

export const ATS_JOB_ENRICHMENT_KEY = '__careerDashboardAtsEnrichment';
export const ATS_JOB_ENRICHMENT_VERSION = 1 as const;

export type AtsJobEnrichmentStatus = 'enriched' | 'not_needed' | 'unavailable';

export type AtsJobEnrichmentMarker = {
  version: typeof ATS_JOB_ENRICHMENT_VERSION;
  status: AtsJobEnrichmentStatus;
  platform: string;
  detailSource: string;
  attempted: boolean;
  completedAt: string;
  description: string | null;
  company: string | null;
  location: string | null;
  compensation: string | null;
  reason?: string;
  httpStatus?: number;
  error?: string;
};

export type EnrichAtsListingJobInput = {
  platform: string;
  slug: string;
  job: Record<string, unknown>;
  signal?: AbortSignal;
  requestTimeoutMs: number;
  onRequestStarted?: () => Promise<void> | void;
  onResponseReceived?: (input: { status: number; respondedAt: Date }) => Promise<void> | void;
};

type ProviderBudgetDecision = {
  allowed: boolean;
  reason?: string;
  retryAt?: Date;
};

type FetchPlatformResponse = (
  platform: string,
  signal: AbortSignal | undefined,
  request: () => Promise<Response>,
  options?: {
    onResponse?: (response: Response) => Promise<void>;
    recordPlatformFailures?: boolean;
  },
) => Promise<Response>;

type ParsedJsonLdPage = {
  found: boolean;
  descriptionIsString: boolean;
  description: string | null;
  company: string | null;
  location: string | null;
};

export type AtsJobEnrichmentDependencies = {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  safeExternalFetch: (input: string | URL, init?: RequestInit) => Promise<Response>;
  fetchPlatformResponse: FetchPlatformResponse;
  reserveProviderBudgetForSource: (source: string) => Promise<ProviderBudgetDecision>;
  recordProviderSuccess: (provider: string, now?: Date) => Promise<void>;
  recordProviderFailure: (input: {
    provider: string;
    error: unknown;
    now?: Date;
  }) => Promise<unknown>;
  createDeferredError: (platform: string, retryAt?: Date) => Error | Promise<Error>;
  parseJsonLdPage: (html: string) => ParsedJsonLdPage | Promise<ParsedJsonLdPage>;
  jsonLdFetchUserAgent: string;
  passesPreFilter: typeof passesPreFilter;
  now: () => Date;
};

type EnrichmentFields = Pick<
  AtsJobEnrichmentMarker,
  'description' | 'company' | 'location' | 'compensation'
>;

type DetailPlan = {
  url: string;
  transport: 'fetch' | 'safe_fetch';
  fields: EnrichmentFields;
  parse: (response: Response, dependencies: AtsJobEnrichmentDependencies) => Promise<EnrichmentFields>;
};

class AtsDetailHttpError extends Error {
  constructor(readonly status: number) {
    super(`ATS detail endpoint returned HTTP ${status}`);
    this.name = 'AtsDetailHttpError';
  }
}

class AtsDetailProviderBlockedError extends Error {
  constructor(
    readonly reason: string,
    readonly retryAt?: Date,
  ) {
    super(`ATS detail request blocked by ${reason}`);
    this.name = 'AtsDetailProviderBlockedError';
  }
}

function isJobScopedDetailAvailability(error: unknown): boolean {
  return error instanceof AtsDetailHttpError
    && (error.status === 403 || error.status === 404);
}

class AtsEnrichmentControlError extends Error {
  constructor(readonly controlError: unknown) {
    // fetchAtsPlatformResponse classifies errors thrown by its response hook.
    // Keep this message on the explicit internal-persistence path so a schema-
    // worded database error cannot be mistaken for provider response drift.
    super('ATS enrichment provider control persistence failed');
    this.name = 'AtsEnrichmentControlError';
    this.cause = controlError;
  }
}

const EMPTY_FIELDS: EnrichmentFields = Object.freeze({
  description: null,
  company: null,
  location: null,
  compensation: null,
});

// Keep this local so loading the enrichment seam cannot eagerly load atsApi,
// which currently imports a text helper from jobIngestion. The default parser
// below still delegates to atsApi after jobIngestion has finished evaluating.
const DEFAULT_JSON_LD_FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let jobIngestionModulePromise: Promise<typeof import('./jobIngestion')> | null = null;
let ingestionControlModulePromise: Promise<typeof import('./ingestionControl')> | null = null;
let atsApiModulePromise: Promise<typeof import('./atsApi')> | null = null;

function loadJobIngestionModule() {
  jobIngestionModulePromise ||= import('./jobIngestion');
  return jobIngestionModulePromise;
}

function loadIngestionControlModule() {
  ingestionControlModulePromise ||= import('./ingestionControl');
  return ingestionControlModulePromise;
}

function loadAtsApiModule() {
  atsApiModulePromise ||= import('./atsApi');
  return atsApiModulePromise;
}

const DEFAULT_DEPENDENCIES: AtsJobEnrichmentDependencies = {
  fetch: (input, init) => fetch(input, init),
  safeExternalFetch: (input, init) => safeExternalFetch(input, init),
  fetchPlatformResponse: async (platform, signal, request, options) => {
    const { fetchAtsPlatformResponse } = await loadJobIngestionModule();
    return fetchAtsPlatformResponse(platform, signal, request, options);
  },
  reserveProviderBudgetForSource: async (source) => {
    const { reserveProviderBudgetForSource } = await loadIngestionControlModule();
    return reserveProviderBudgetForSource(source);
  },
  recordProviderSuccess: async (provider, now) => {
    const { recordProviderSuccess } = await loadIngestionControlModule();
    return recordProviderSuccess(provider, now);
  },
  recordProviderFailure: async (input) => {
    const { recordProviderFailure } = await loadIngestionControlModule();
    return recordProviderFailure(input);
  },
  createDeferredError: async (platform, retryAt) => {
    const { AtsPlatformDeferredError } = await loadJobIngestionModule();
    return new AtsPlatformDeferredError(platform, retryAt);
  },
  parseJsonLdPage: async (html) => {
    const {
      extractJsonLdJobPosting,
      jsonLdCompanyName,
      jsonLdLocationString,
    } = await loadAtsApiModule();
    const posting = extractJsonLdJobPosting(html);
    return {
      found: Boolean(posting),
      descriptionIsString: typeof posting?.description === 'string',
      description: typeof posting?.description === 'string' ? posting.description : null,
      company: posting ? jsonLdCompanyName(posting.hiringOrganization) : null,
      location: posting ? jsonLdLocationString(posting.jobLocation) : null,
    };
  },
  jsonLdFetchUserAgent: DEFAULT_JSON_LD_FETCH_USER_AGENT,
  passesPreFilter,
  now: () => new Date(),
};

function enrichmentDependencies(
  overrides: Partial<AtsJobEnrichmentDependencies> | undefined,
): AtsJobEnrichmentDependencies {
  return { ...DEFAULT_DEPENDENCIES, ...overrides };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

export function isAtsJobEnrichmentMarker(value: unknown): value is AtsJobEnrichmentMarker {
  if (!isRecord(value)) return false;
  if (value.version !== ATS_JOB_ENRICHMENT_VERSION) return false;
  if (
    typeof value.status !== 'string'
    || !['enriched', 'not_needed', 'unavailable'].includes(value.status)
  ) return false;
  if (typeof value.platform !== 'string' || !value.platform.trim()) return false;
  if (value.detailSource !== `ATS-${value.platform} Details`) return false;
  if (typeof value.attempted !== 'boolean') return false;
  if (value.status === 'enriched' && !value.attempted) return false;
  if (value.status === 'not_needed' && value.attempted) return false;
  if (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt))) return false;
  if (!isNullableString(value.description)) return false;
  if (!isNullableString(value.company)) return false;
  if (!isNullableString(value.location)) return false;
  if (!isNullableString(value.compensation)) return false;
  if (!isOptionalString(value.reason) || !isOptionalString(value.error)) return false;
  if (
    value.httpStatus !== undefined
    && (!Number.isInteger(value.httpStatus) || Number(value.httpStatus) < 100 || Number(value.httpStatus) > 599)
  ) return false;
  return true;
}

export function readAtsJobEnrichmentMarker(job: unknown): AtsJobEnrichmentMarker | null {
  if (!isRecord(job)) return null;
  const marker = job[ATS_JOB_ENRICHMENT_KEY];
  return isAtsJobEnrichmentMarker(marker) ? marker : null;
}

function cloneWithMarker(
  job: Record<string, unknown>,
  marker: AtsJobEnrichmentMarker,
): Record<string, unknown> {
  const clone = structuredClone(job);
  return { ...clone, [ATS_JOB_ENRICHMENT_KEY]: marker };
}

function titleCaseSlug(slug: string): string {
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    // Preserve the provider-owned token if a board contains malformed escapes.
  }
  return decoded
    .split(/[-_ ]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function identifier(value: unknown): string | null {
  if (!value) return null;
  const normalized = String(value);
  return normalized ? normalized : null;
}

function hasRawDescription(job: Record<string, unknown>): boolean {
  const joinedDescription = [job.description, job.requirements]
    .filter(Boolean)
    .join('\n\n');
  return Boolean(
    job.content
    || job.description
    || job.descriptionPlain
    || job.content_html
    || joinedDescription,
  );
}

function parseBreezySalaryRange(salary: unknown): string | null {
  if (typeof salary !== 'string' || !salary) return null;
  const match = salary.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[-–—]\s*\$?\s*([\d,]+(?:\.\d+)?)/);
  if (!match) return null;
  if (!/\/\s*(?:yr|year)\b|\bper\s+year\b|\bannual/i.test(salary)) return null;

  const rangeStart = Number(match[1].replaceAll(',', ''));
  const rangeEnd = Number(match[2].replaceAll(',', ''));
  if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) return null;

  return extractStructuredBaseCompensation([{
    currency: 'USD',
    frequency: 'YEAR',
    rangeStart,
    rangeEnd,
  }]);
}

function parseRipplingDetail(value: unknown): EnrichmentFields {
  if (!isRecord(value)) return { ...EMPTY_FIELDS };
  const description = value.description;
  let rawDescription = '';
  if (isRecord(description)) {
    rawDescription = [description.company, description.role].filter(Boolean).join('\n\n');
  } else if (typeof description === 'string') {
    rawDescription = description;
  }

  const company = typeof value.companyName === 'string' && value.companyName.trim()
    ? value.companyName.trim()
    : null;
  const location = Array.isArray(value.workLocations) && value.workLocations.length > 0
    ? value.workLocations.filter(Boolean).join('; ')
    : null;
  const payRangeDetails = Array.isArray(value.payRangeDetails)
    ? value.payRangeDetails.filter(isRecord).map((range) => ({
        currency: typeof range.currency === 'string' ? range.currency : undefined,
        frequency: typeof range.frequency === 'string' ? range.frequency : undefined,
        rangeStart: typeof range.rangeStart === 'number' ? range.rangeStart : undefined,
        rangeEnd: typeof range.rangeEnd === 'number' ? range.rangeEnd : undefined,
      }))
    : null;

  return {
    description: rawDescription || null,
    company,
    location,
    compensation: extractStructuredBaseCompensation(payRangeDetails),
  };
}

function jsonResponsePlan(
  url: string,
  fields: EnrichmentFields,
  parsePayload: (payload: unknown) => EnrichmentFields,
): DetailPlan {
  return {
    url,
    transport: 'fetch',
    fields,
    parse: async (response) => parsePayload(await response.json() as unknown),
  };
}

function htmlResponsePlan(
  url: string,
  fields: EnrichmentFields,
  selectFields: (parsed: ParsedJsonLdPage) => EnrichmentFields,
): DetailPlan {
  return {
    url,
    transport: 'safe_fetch',
    fields,
    parse: async (response, dependencies) => {
      const parsed = await dependencies.parseJsonLdPage(await response.text());
      return selectFields(parsed);
    },
  };
}

function preparedDetailPlan(input: {
  platform: string;
  slug: string;
  job: Record<string, unknown>;
  dependencies: AtsJobEnrichmentDependencies;
}): { plan: DetailPlan | null; reason: string; fields: EnrichmentFields } {
  const { platform, slug, job, dependencies } = input;
  const rawDescriptionPresent = hasRawDescription(job);
  const fields: EnrichmentFields = {
    ...EMPTY_FIELDS,
    compensation: platform === 'breezy' ? parseBreezySalaryRange(job.salary) : null,
  };

  if (platform === 'workday') {
    const externalPath = identifier(job.externalPath);
    if (!externalPath || !slug) return { plan: null, reason: 'missing_detail_identity', fields };
    const titlePasses = dependencies.passesPreFilter({
      title: stringValue(job.text || job.title || job.name || job.jobOpeningName),
      company: titleCaseSlug(slug),
      location: '',
      description: '',
      url: '',
    }).passes;
    if (!titlePasses) return { plan: null, reason: 'title_gate_rejected', fields };
    const [company, tenant] = slug.split('::');
    if (!company || !tenant) return { plan: null, reason: 'missing_detail_identity', fields };
    const companyWithoutWd = company.split('.')[0];
    return {
      plan: jsonResponsePlan(
        `https://${company}.myworkdayjobs.com/wday/cxs/${companyWithoutWd}/${tenant}${externalPath}`,
        fields,
        (payload) => {
          if (!isRecord(payload)) return { ...fields };
          const jobPostingInfo = isRecord(payload.jobPostingInfo) ? payload.jobPostingInfo : null;
          const description = jobPostingInfo && typeof jobPostingInfo.jobDescription === 'string'
            && jobPostingInfo.jobDescription
            ? jobPostingInfo.jobDescription
            : null;
          return {
            description,
            company: workdayHiringOrganizationName(payload.hiringOrganization),
            location: workdayDetailLocation(jobPostingInfo),
            compensation: null,
          };
        },
      ),
      reason: '',
      fields,
    };
  }

  if (platform === 'smartrecruiters') {
    if (rawDescriptionPresent) return { plan: null, reason: 'description_already_present', fields };
    const jobId = identifier(job.id);
    if (!jobId || !slug) return { plan: null, reason: 'missing_detail_identity', fields };
    return {
      plan: jsonResponsePlan(
        `https://api.smartrecruiters.com/v1/companies/${slug}/postings/${jobId}`,
        fields,
        (payload) => {
          const jobAd = isRecord(payload) && isRecord(payload.jobAd) ? payload.jobAd : null;
          const sections = jobAd && isRecord(jobAd.sections) ? jobAd.sections : null;
          const sectionText = (name: string) => {
            const section = sections && isRecord(sections[name]) ? sections[name] : null;
            return section && typeof section.text === 'string' ? section.text : '';
          };
          return {
            ...fields,
            description: [
              sectionText('jobDescription'),
              sectionText('qualifications'),
              sectionText('additionalInformation'),
            ].filter(Boolean).join('\n\n') || null,
          };
        },
      ),
      reason: '',
      fields,
    };
  }

  if (platform === 'workable') {
    if (rawDescriptionPresent) return { plan: null, reason: 'description_already_present', fields };
    const shortcode = identifier(job.shortcode);
    if (!shortcode || !slug) return { plan: null, reason: 'missing_detail_identity', fields };
    return {
      plan: jsonResponsePlan(
        `https://apply.workable.com/api/v1/accounts/${slug}/jobs/${shortcode}`,
        fields,
        (payload) => {
          const detail = isRecord(payload) ? payload : {};
          return {
            ...fields,
            description: [detail.description, detail.requirements, detail.benefits]
              .filter((value): value is string => typeof value === 'string' && Boolean(value))
              .join('\n\n') || null,
          };
        },
      ),
      reason: '',
      fields,
    };
  }

  if (platform === 'bamboohr') {
    if (rawDescriptionPresent) return { plan: null, reason: 'description_already_present', fields };
    const jobId = identifier(job.id);
    if (!jobId || !slug) return { plan: null, reason: 'missing_detail_identity', fields };
    return {
      plan: jsonResponsePlan(
        `https://${slug}.bamboohr.com/careers/${jobId}/detail`,
        fields,
        (payload) => {
          const result = isRecord(payload) && isRecord(payload.result) ? payload.result : null;
          const jobOpening = result && isRecord(result.jobOpening) ? result.jobOpening : null;
          const openingDescription = jobOpening && typeof jobOpening.description === 'string'
            ? jobOpening.description
            : null;
          const fallbackDescription = result && typeof result.description === 'string'
            ? result.description
            : null;
          const description = openingDescription || fallbackDescription;
          return { ...fields, description: description || null };
        },
      ),
      reason: '',
      fields,
    };
  }

  if (platform === 'breezy') {
    if (rawDescriptionPresent) return { plan: null, reason: 'description_already_present', fields };
    const detailUrl = typeof job.url === 'string' && job.url
      ? job.url
      : identifier(job.friendly_id) && slug
        ? `https://${slug}.breezy.hr/p/${identifier(job.friendly_id)}`
        : null;
    if (!detailUrl) return { plan: null, reason: 'missing_detail_identity', fields };
    return {
      plan: htmlResponsePlan(detailUrl, fields, (parsed) => {
        if (!parsed.found || !parsed.descriptionIsString) return { ...fields };
        return {
          description: parsed.description,
          company: parsed.company,
          location: parsed.location,
          compensation: fields.compensation,
        };
      }),
      reason: '',
      fields,
    };
  }

  if (platform === 'teamtailor') {
    const detailUrl = typeof job.url === 'string' && job.url ? job.url : null;
    if (!detailUrl) return { plan: null, reason: 'missing_detail_identity', fields };
    const titlePasses = dependencies.passesPreFilter({
      title: stringValue(job.title),
      company: titleCaseSlug(slug),
      location: '',
      description: '',
      url: '',
    }).passes;
    if (!titlePasses) return { plan: null, reason: 'title_gate_rejected', fields };
    return {
      plan: htmlResponsePlan(detailUrl, fields, (parsed) => ({
        ...fields,
        location: parsed.found ? parsed.location : null,
      })),
      reason: '',
      fields,
    };
  }

  if (platform === 'rippling') {
    if (rawDescriptionPresent) return { plan: null, reason: 'description_already_present', fields };
    const uuid = identifier(job.uuid);
    if (!uuid || !slug) return { plan: null, reason: 'missing_detail_identity', fields };
    return {
      plan: jsonResponsePlan(
        `https://ats.rippling.com/api/v1/board/${slug}/jobs/${uuid}`,
        fields,
        parseRipplingDetail,
      ),
      reason: '',
      fields,
    };
  }

  return { plan: null, reason: 'unsupported_platform', fields };
}

function marker(
  input: {
    status: AtsJobEnrichmentStatus;
    platform: string;
    attempted: boolean;
    fields: EnrichmentFields;
    reason?: string;
    httpStatus?: number;
    error?: string;
  },
  dependencies: AtsJobEnrichmentDependencies,
): AtsJobEnrichmentMarker {
  return {
    version: ATS_JOB_ENRICHMENT_VERSION,
    status: input.status,
    platform: input.platform,
    detailSource: `ATS-${input.platform} Details`,
    attempted: input.attempted,
    completedAt: dependencies.now().toISOString(),
    ...input.fields,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.httpStatus ? { httpStatus: input.httpStatus } : {}),
    ...(input.error ? { error: input.error.slice(0, 500) } : {}),
  };
}

function hasUsableDetailEnrichment(
  fields: EnrichmentFields,
  listingFields: EnrichmentFields,
): boolean {
  return (Object.keys(fields) as Array<keyof EnrichmentFields>).some((field) => {
    const value = fields[field];
    return typeof value === 'string'
      && Boolean(value.trim())
      && value !== listingFields[field];
  });
}

function isDeferredError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AtsPlatformDeferredError';
}

function isAbortError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === 'AbortError' || error.name === 'TimeoutError';
}

function retryAtFrom429(response: Response, now: Date): Date | undefined {
  const retryAfter = response.headers.get('retry-after')?.trim();
  const seconds = Number.parseInt(retryAfter || '', 10);
  const pauseMs = Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds * 1000, 15 * 60_000)
    : 60_000;
  return new Date(now.getTime() + pauseMs);
}

function logTelemetryPersistenceFailure(
  action: 'success' | 'failure',
  provider: string,
  error: unknown,
): void {
  const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  console.error(`ATS enrichment ${action} telemetry failed for ${provider}: ${message}`);
}

async function deferredError(
  dependencies: AtsJobEnrichmentDependencies,
  platform: string,
  retryAt?: Date,
): Promise<Error> {
  return dependencies.createDeferredError(`ATS-${platform}`, retryAt);
}

/**
 * Enrich one raw ATS listing while keeping all derived fields under a reserved
 * marker. A durable marker is written only for terminal item outcomes. Base
 * platform cooldowns, 429s and interruption/timeout aborts throw so the caller
 * can retain and retry the unprocessed enrichment suffix.
 */
export async function enrichAtsListingJob(
  input: EnrichAtsListingJobInput,
  dependencyOverrides: Partial<AtsJobEnrichmentDependencies> = {},
): Promise<Record<string, unknown>> {
  if (!input.job || typeof input.job !== 'object' || Array.isArray(input.job)) {
    throw new TypeError('ATS listing enrichment requires a raw job object.');
  }
  const platform = input.platform.trim().toLowerCase();
  if (!platform) throw new TypeError('ATS listing enrichment requires a platform.');
  if (!Number.isFinite(input.requestTimeoutMs) || input.requestTimeoutMs <= 0) {
    throw new RangeError('ATS listing enrichment requestTimeoutMs must be positive.');
  }

  const dependencies = enrichmentDependencies(dependencyOverrides);
  const prepared = preparedDetailPlan({ platform, slug: input.slug, job: input.job, dependencies });
  if (!prepared.plan) {
    return cloneWithMarker(input.job, marker({
      status: 'not_needed',
      platform,
      attempted: false,
      fields: prepared.fields,
      reason: prepared.reason,
    }, dependencies));
  }

  if (input.signal?.aborted) {
    throw await deferredError(dependencies, platform);
  }

  const timeoutSignal = AbortSignal.timeout(Math.min(120_000, Math.max(1, Math.trunc(input.requestTimeoutMs))));
  const requestSignal = input.signal
    ? AbortSignal.any([input.signal, timeoutSignal])
    : timeoutSignal;
  const baseSource = `ATS-${platform}`;
  const detailSource = `${baseSource} Details`;
  let attempted = false;
  let responseStatus: number | undefined;
  let respondedAt: Date | undefined;
  let parsedFields: EnrichmentFields | null = null;
  let responseInspected = false;

  const inspectResponse = async (response: Response) => {
    if (responseInspected) return;
    responseInspected = true;
    responseStatus = response.status;
    respondedAt = dependencies.now();
    try {
      await input.onResponseReceived?.({ status: response.status, respondedAt });
    } catch (error) {
      throw new AtsEnrichmentControlError(error);
    }
    if (response.status === 429) {
      throw await deferredError(dependencies, platform, retryAtFrom429(response, respondedAt));
    }
    if (!response.ok) throw new AtsDetailHttpError(response.status);
    parsedFields = await prepared.plan!.parse(response.clone(), dependencies);
  };

  try {
    const response = await dependencies.fetchPlatformResponse(platform, requestSignal, async () => {
      let baseDecision: ProviderBudgetDecision;
      let detailDecision: ProviderBudgetDecision;
      try {
        baseDecision = await dependencies.reserveProviderBudgetForSource(baseSource);
      } catch (error) {
        throw new AtsEnrichmentControlError(error);
      }
      if (!baseDecision.allowed) {
        throw await deferredError(dependencies, platform, baseDecision.retryAt);
      }
      try {
        detailDecision = await dependencies.reserveProviderBudgetForSource(detailSource);
      } catch (error) {
        throw new AtsEnrichmentControlError(error);
      }
      if (!detailDecision.allowed) {
        throw new AtsDetailProviderBlockedError(
          detailDecision.reason || 'provider_control',
          detailDecision.retryAt,
        );
      }
      if (requestSignal.aborted) throw requestSignal.reason;
      try {
        await input.onRequestStarted?.();
      } catch (error) {
        throw new AtsEnrichmentControlError(error);
      }
      if (requestSignal.aborted) throw requestSignal.reason;
      attempted = true;
      const requestInit: RequestInit = prepared.plan!.transport === 'fetch'
        ? { headers: { Accept: 'application/json' }, signal: requestSignal }
        : {
            headers: { 'User-Agent': dependencies.jsonLdFetchUserAgent },
            signal: requestSignal,
          };
      return prepared.plan!.transport === 'fetch'
        ? dependencies.fetch(prepared.plan!.url, requestInit)
        : dependencies.safeExternalFetch(prepared.plan!.url, requestInit);
    }, {
      onResponse: inspectResponse,
      // The detail source owns detail health. A single removed or protected job
      // must never open the listing circuit for every board on the platform.
      recordPlatformFailures: false,
    });

    // The production scheduler invokes onResponse under Workable's durable
    // fence. This fallback keeps injected schedulers honest without changing
    // the production boundary.
    if (!responseInspected) await inspectResponse(response);
    if (requestSignal.aborted) throw requestSignal.reason;
    const fields = parsedFields || prepared.fields;
    const detailWasUsable = hasUsableDetailEnrichment(fields, prepared.fields);
    await dependencies.recordProviderSuccess(detailSource, respondedAt).catch((error) => {
      logTelemetryPersistenceFailure('success', detailSource, error);
    });
    return cloneWithMarker(input.job, marker({
      status: detailWasUsable ? 'enriched' : 'unavailable',
      platform,
      attempted,
      fields,
      reason: detailWasUsable ? undefined : 'no_usable_detail',
      httpStatus: responseStatus,
    }, dependencies));
  } catch (error) {
    if (isDeferredError(error)) throw error;
    if (error instanceof AtsEnrichmentControlError) throw error.controlError;
    if (input.signal?.aborted || requestSignal.aborted || isAbortError(error)) {
      throw await deferredError(dependencies, platform);
    }
    if (error instanceof AtsDetailProviderBlockedError) {
      const retryAt = error.retryAt
        || new Date(dependencies.now().getTime() + 15 * 60_000);
      throw await deferredError(dependencies, platform, retryAt);
    }

    if (!isJobScopedDetailAvailability(error)) {
      await dependencies.recordProviderFailure({
        provider: detailSource,
        error,
        now: dependencies.now(),
      }).catch((telemetryError) => {
        logTelemetryPersistenceFailure('failure', detailSource, telemetryError);
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return cloneWithMarker(input.job, marker({
      status: 'unavailable',
      platform,
      attempted,
      fields: prepared.fields,
      reason: error instanceof AtsDetailHttpError ? 'http_error' : 'endpoint_error',
      httpStatus: responseStatus,
      error: message,
    }, dependencies));
  }
}
