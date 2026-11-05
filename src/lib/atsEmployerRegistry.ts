import { publishedEmployerName } from './publicAtsEmployer';
import { prisma } from './prisma';
import { canonicalJsonSha256 } from './scoringCanonicalJson';
export const VERIFIED_ATS_EMPLOYER_RULE = 'ats_board_employer';
export const VERIFIED_ATS_EMPLOYER_ORIGIN = 'verified_ats_source';
export const VERIFIED_ATS_POSTING_EMPLOYER_RULE = 'ats_posting_employer';
export function atsPostingEmployerKey(platform: string, slug: string, job: Record<string, unknown>): string {
  return canonicalJsonSha256([platform, slug, job.publicAtsPostingId, job.title, job.url]);
}
/** Exact posting proof collected by the explicit retained-work repair. It is
 * never promoted into a board-wide employer or a global company alias. */
export async function verifiedAtsPostingEvidence(platform: string, slug: string, job: Record<string, unknown>) {
  if (!['oracle', 'ukg'].includes(platform) || !job.publicAtsPostingId || !job.title || !job.url) return null;
  const rule = await prisma.companyNameRule.findUnique({ where: { matchType_matchKey: {
    matchType: VERIFIED_ATS_POSTING_EMPLOYER_RULE, matchKey: atsPostingEmployerKey(platform, slug, job),
  } } });
  if (rule?.origin !== VERIFIED_ATS_EMPLOYER_ORIGIN) return null;
  const company = rule.standardName === 'Oracle' ? 'Oracle' : publishedEmployerName(rule.standardName);
  const evidence = rule.evidence as Record<string, unknown> | null;
  if (!company || !evidence || evidence.postingKey !== atsPostingEmployerKey(platform, slug, job)) return null;
  return { company, description: typeof evidence.description === 'string' ? evidence.description : null,
    location: typeof evidence.location === 'string' ? evidence.location : null };
}
const cache = new Map<string, { name: string; expiresAt: number }>();
/** Board-scoped source evidence; never a global Unknown Company alias. */
export async function verifiedAtsBoardEmployer(platform: string, slug: string): Promise<string> {
  if (!['oracle', 'ukg', 'zohorecruit'].includes(platform)) return '';
  const key = `${platform}:${slug}`;
  const prior = cache.get(key);
  if (prior && prior.expiresAt > Date.now()) return prior.name;
  const rule = await prisma.companyNameRule.findUnique({ where: { matchType_matchKey: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey: key } } });
  const candidate = rule?.origin === VERIFIED_ATS_EMPLOYER_ORIGIN ? rule.standardName : '';
  const name = candidate === 'Oracle' ? candidate : publishedEmployerName(candidate);
  cache.set(key, { name, expiresAt: Date.now() + 60000 });
  return name;
}
