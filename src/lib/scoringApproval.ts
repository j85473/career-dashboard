import { createHmac, timingSafeEqual } from 'node:crypto';

import { canonicalJson, canonicalJsonSha256 } from './scoringCanonicalJson';

export const SCORING_APPROVAL_TTL_MS = 15 * 60 * 1000;

export type ScoringApprovalClaims = {
  version: 1;
  batchId: string;
  resultHash: string;
  previewHash: string;
  issuedAt: string;
  expiresAt: string;
};

function approvalSecret(explicit?: string): string {
  const secret = explicit || process.env.SCORING_APPROVAL_SECRET || '';
  if (Buffer.byteLength(secret, 'utf8') < 32) throw new Error('SCORING_APPROVAL_SECRET must contain at least 32 UTF-8 bytes');
  return secret;
}

function sign(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload, 'utf8').digest('base64url');
}

export function createScoringApprovalToken(
  input: { batchId: string; resultHash: string; preview: unknown },
  options: { now?: Date; ttlMs?: number; secret?: string } = {},
): { token: string; claims: ScoringApprovalClaims } {
  const now = options.now || new Date();
  const ttlMs = options.ttlMs ?? SCORING_APPROVAL_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 60 * 60 * 1000) throw new Error('approval TTL is invalid');
  const claims: ScoringApprovalClaims = {
    version: 1,
    batchId: input.batchId,
    resultHash: input.resultHash,
    previewHash: canonicalJsonSha256(input.preview),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.valueOf() + ttlMs).toISOString(),
  };
  const encoded = Buffer.from(canonicalJson(claims), 'utf8').toString('base64url');
  return { token: `${encoded}.${sign(encoded, approvalSecret(options.secret))}`, claims };
}

export function verifyScoringApprovalToken(
  token: string,
  expected: { batchId: string; resultHash: string; preview: unknown },
  options: { now?: Date; secret?: string } = {},
): ScoringApprovalClaims {
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra !== undefined) throw new Error('approval token is malformed');
  const expectedSignature = sign(encoded, approvalSecret(options.secret));
  const left = Buffer.from(signature, 'utf8');
  const right = Buffer.from(expectedSignature, 'utf8');
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw new Error('approval token signature is invalid');
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { throw new Error('approval token payload is invalid'); }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('approval token claims are invalid');
  const record = claims as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'batchId,expiresAt,issuedAt,previewHash,resultHash,version') throw new Error('approval token contains unknown claims');
  if (record.version !== 1 || record.batchId !== expected.batchId || record.resultHash !== expected.resultHash) throw new Error('approval token does not bind this batch and result');
  if (record.previewHash !== canonicalJsonSha256(expected.preview)) throw new Error('approval token does not bind this preview');
  if (typeof record.expiresAt !== 'string' || new Date(record.expiresAt).valueOf() <= (options.now || new Date()).valueOf()) throw new Error('approval token has expired');
  return record as ScoringApprovalClaims;
}
