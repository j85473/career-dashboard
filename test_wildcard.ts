import { prisma } from './src/lib/prisma';
async function run() {
  const prefs = await prisma.userPreference.findMany({
    where: { type: { startsWith: 'wildcard_' } }
  });
  console.log(prefs);
}
run();
