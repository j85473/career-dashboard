const { ingestJobs } = require('./src/lib/jobIngestion');
const { prisma } = require('./src/lib/prisma');

async function run() {
  const num = await ingestJobs((msg) => console.log(msg), undefined, undefined, 'Founder in Residence', 'pending_lucky', true);
  console.log('Ingested:', num);
}

run().catch(console.error).finally(() => prisma.$disconnect());
