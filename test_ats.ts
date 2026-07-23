import { prisma } from './src/lib/prisma';
async function run() {
  const ats = await prisma.atsCompany.findMany({ where: { slug: 'Adzuna' } });
  console.log(ats);
}
run();
