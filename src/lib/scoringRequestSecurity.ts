import { MAX_SCORING_EXCHANGE_BYTES } from './scoringExchange';

export class ScoringRequestSecurityError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ScoringRequestSecurityError';
  }
}

function firstForwardedValue(value: string | null): string | null {
  return value?.split(',')[0]?.trim() || null;
}

function expectedOrigin(request: Request): string {
  const requestUrl = new URL(request.url);
  const host = firstForwardedValue(request.headers.get('x-forwarded-host'))
    || request.headers.get('host')
    || requestUrl.host;
  const protocol = firstForwardedValue(request.headers.get('x-forwarded-proto'))
    || requestUrl.protocol.replace(/:$/, '');
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    throw new ScoringRequestSecurityError('trusted request host is invalid', 400);
  }
}

function sizeError(maximumBytes: number): string {
  return maximumBytes === MAX_SCORING_EXCHANGE_BYTES
    ? 'scoring request exceeds 32 MiB'
    : `scoring request exceeds ${maximumBytes} bytes`;
}

export function assertScoringMutationRequest(request: Request, maximumBytes = MAX_SCORING_EXCHANGE_BYTES): void {
  const origin = request.headers.get('origin');
  if (!origin) throw new ScoringRequestSecurityError('Origin header is required', 403);
  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new ScoringRequestSecurityError('Origin header is invalid', 403);
  }
  if (normalizedOrigin !== expectedOrigin(request)) throw new ScoringRequestSecurityError('cross-origin scoring mutation rejected', 403);

  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase();
  if (fetchSite === 'cross-site') throw new ScoringRequestSecurityError('cross-site scoring mutation rejected', 403);

  const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') throw new ScoringRequestSecurityError('Content-Type must be application/json', 415);

  const contentLength = request.headers.get('content-length');
  if (contentLength !== null) {
    const bytes = Number(contentLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new ScoringRequestSecurityError('Content-Length is invalid', 400);
    if (bytes > maximumBytes) throw new ScoringRequestSecurityError(sizeError(maximumBytes), 413);
  }
}

export async function readScoringMutationJson(
  request: Request,
  maximumBytes = MAX_SCORING_EXCHANGE_BYTES,
): Promise<unknown> {
  assertScoringMutationRequest(request, maximumBytes);
  if (!request.body) throw new ScoringRequestSecurityError('JSON request body is required', 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > maximumBytes) {
      await reader.cancel();
      throw new ScoringRequestSecurityError(sizeError(maximumBytes), 413);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw new ScoringRequestSecurityError('request body is not valid UTF-8 JSON', 400);
  }
}

export function scoringSecurityErrorResponse(error: unknown): Response | null {
  if (!(error instanceof ScoringRequestSecurityError)) return null;
  return Response.json({ error: error.message }, { status: error.status });
}
