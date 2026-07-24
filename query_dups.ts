import { prisma } from "./src/lib/prisma";

async function main() {
  const job1 = await prisma.job.findUnique({ where: { id: "ce634c30-4aa6-42ab-b78b-a6dc3cec105a" } });
  const job2 = await prisma.job.findUnique({ where: { id: "bbe0a4ac-fd1a-457c-9d48-7a37eb6f8099" } });
  
  console.log("Job 1:", JSON.stringify({ title: job1?.title, company: job1?.company, location: job1?.location, url: job1?.url, fingerprint: job1?.fingerprint, canonicalUrl: job1?.canonicalUrl, source: job1?.source }, null, 2));
  console.log("Job 2:", JSON.stringify({ title: job2?.title, company: job2?.company, location: job2?.location, url: job2?.url, fingerprint: job2?.fingerprint, canonicalUrl: job2?.canonicalUrl, source: job2?.source }, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
