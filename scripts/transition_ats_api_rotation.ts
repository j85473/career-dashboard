import 'dotenv/config';
import { writeFile, readFile } from 'node:fs/promises';
import { prisma } from '../src/lib/prisma';
import { applyApiRotationTransition, readApiRotationTransition } from '../src/lib/atsApiRotationTransition';

async function main() {
  const [mode, file, ...extra] = process.argv.slice(2);
  if (!file || extra.length || !['--preview', '--apply'].includes(mode)) {
    throw new Error('Usage: transition_ats_api_rotation.ts --preview plan.json | --apply plan.json');
  }
  if (mode === '--preview') {
    const plan = await readApiRotationTransition(prisma);
    await writeFile(file, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ mode: 'preview', file, selected: plan.selected,
      selectionHash: plan.selectionHash, writesPerformed: 0 }));
  } else {
    const plan = JSON.parse(await readFile(file, 'utf8')) as Awaited<ReturnType<typeof readApiRotationTransition>>;
    console.log(JSON.stringify({ mode: 'apply', ...await applyApiRotationTransition(prisma, plan) }));
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
