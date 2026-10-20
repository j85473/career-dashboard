import { createHash } from 'node:crypto';

export type JdRecoveryAttempt = {
  url: string | null;
  transport: 'ats_api' | 'reader' | 'provider_api' | 'none';
  responseStatus?: number;
  body?: string;
  structuredSource?: boolean;
};

/** A reader's 404/403/429 belongs to that service, not to the employer URL.
 * Target status warnings inside a successful response remain posting evidence. */
export async function readJdRecoveryResponse(response: Response): Promise<string> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`JD reader request failed: HTTP ${response.status}`);
  }
  return response.text();
}

/** Preserve rejected responses separately from the saved/scored description.
 * Never store request headers, credentials, or unbounded page/configuration data. */
export function jdRecoveryAttemptEvidence(attempt: JdRecoveryAttempt, outcome: string, reason: string | null) {
  const body = attempt.body || '';
  return {
    outcome, reason, url: attempt.url, transport: attempt.transport,
    responseStatus: attempt.responseStatus ?? null,
    structuredSource: attempt.structuredSource ?? false,
    bodyLength: body.length,
    bodySha256: createHash('sha256').update(body).digest('hex'),
    bodyExcerpt: body.slice(0, 20_000),
    bodyExcerptTruncated: body.length > 20_000,
  };
}
