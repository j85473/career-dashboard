import { prisma } from './src/lib/prisma';
async function run() {
  const jobs = await prisma.userPreference.findMany({
    where: { type: { startsWith: 'wildcard_' } }
  });
  console.log(jobs);
}
run();
