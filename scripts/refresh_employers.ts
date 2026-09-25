import 'dotenv/config';

import { assignEmployers, learnEmployerRules } from '../src/lib/employerLearning';
import { prisma } from '../src/lib/prisma';

/**
 * One employer-name pass (src/lib/employerLearning.ts). Without --apply nothing
 * is written: the report lists the spelling groups learned from evidence, the
 * links that were refused, and how many cards would change name. The pipeline
 * runs the same pass every few minutes; this is for review.
 *
 *   npx tsx scripts/refresh_employers.ts [--apply]
 */
async function main() {
  const apply = process.argv.includes('--apply');
  const learned = await learnEmployerRules({ apply });
  const joined = learned.groups.filter((group) => new Set(group.labels.map((label) => label.toLowerCase())).size > 1);
  console.log(`${apply ? 'Learned' : 'Would learn'} ${learned.rules.length} rule(s): ${joined.length} group(s) of spellings.`);
  for (const group of joined.slice(0, 60)) console.log(`  ${group.pinned ? '[yours] ' : ''}${group.name}  <=  ${group.labels.join(' | ')}`);
  const refused = learned.refused.filter((refusal) => refusal.postings > 0 || refusal.reason !== 'names_unrelated');
  console.log(`\nRefused ${refused.length} link(s) with evidence:`);
  for (const refusal of refused.slice(0, 40)) console.log(`  ${refusal.left}  ~  ${refusal.right}  (${refusal.reason}; site ${refusal.site}, postings ${refusal.postings})`);
  const assigned = await assignEmployers({ apply });
  console.log(`\n${apply ? 'Renamed' : 'Would rename'} ${assigned.changed.length} of ${assigned.checked} card(s).`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
