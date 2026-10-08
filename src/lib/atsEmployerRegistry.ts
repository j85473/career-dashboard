import { publishedEmployerName } from './publicAtsEmployer';
import { prisma } from './prisma';
export const VERIFIED_ATS_EMPLOYER_RULE = 'ats_board_employer';
export const VERIFIED_ATS_EMPLOYER_ORIGIN = 'verified_ats_source';
const cache = new Map<string, { name: string; expiresAt: number }>();
/** Board-scoped source evidence; never a global Unknown Company alias. */
export async function verifiedAtsBoardEmployer(platform: string, slug: string): Promise<string> {
  if (!['oracle', 'ukg'].includes(platform)) return '';
  const key = `${platform}:${slug}`;
  const prior = cache.get(key);
  if (prior && prior.expiresAt > Date.now()) return prior.name;
  const rule = await prisma.companyNameRule.findUnique({ where: { matchType_matchKey: { matchType: VERIFIED_ATS_EMPLOYER_RULE, matchKey: key } } });
  const candidate = rule?.origin === VERIFIED_ATS_EMPLOYER_ORIGIN ? rule.standardName : '';
  const name = candidate === 'Oracle' ? candidate : publishedEmployerName(candidate);
  cache.set(key, { name, expiresAt: Date.now() + 60000 });
  return name;
}
