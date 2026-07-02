import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function run() {
  const job = await prisma.job.findUnique({
    where: { id: '9b30080a-059f-4ed5-9633-38148ec72b5d' }
  });

  if (job) {
    console.log(`Testing Jina with URL: ${job.url}`);
    try {
      const res = await fetch(`https://r.jina.ai/${job.url}`);
      console.log(`Status: ${res.status} ${res.statusText}`);
      const text = await res.text();
      console.log(`Length: ${text.length}`);
      console.log(`Snippet: \n${text.substring(0, 1000)}`);
    } catch (e) {
      console.error("Fetch failed:", e);
    }
  } else {
    console.log("Job not found.");
  }
}

run().finally(() => prisma.$disconnect());
