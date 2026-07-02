import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.job.findMany({
    where: { title: { contains: 'Sales Representative - Uncapped Commission' } }
  });
  console.log(JSON.stringify(jobs.map(j => ({ id: j.id, title: j.title, company: j.company, location: j.location, url: j.url, canonicalUrl: j.canonicalUrl, fingerprint: j.fingerprint })), null, 2));
}
main().catch(console.error).finally(() => prisma.$disconnect());
