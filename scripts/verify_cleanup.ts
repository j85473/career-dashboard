import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('--- Job Queue Cleanup Verification ---');

  // 1. Count active jobs
  const activeCount = await prisma.job.count({
    where: {
      status: {
        in: ['inbox', 'pending_af']
      }
    }
  });
  console.log(`\n1. Active jobs (inbox or pending_af): ${activeCount}`);

  // 2. Count jobs dismissed for the new reasons
  const newReasons = [
    'IT/Data/Infra role rejected',
    'Design/Creative role rejected',
    'Hardware/R&D role rejected'
  ];

  const dismissedNewReasons = await prisma.job.groupBy({
    by: ['passReason'],
    where: {
      status: 'dismissed',
      passReason: {
        in: newReasons
      }
    },
    _count: {
      id: true
    }
  });

  const totalNewReasonsCount = dismissedNewReasons.reduce((acc, curr) => acc + curr._count.id, 0);

  console.log(`\n2. Jobs dismissed for new reasons (total: ${totalNewReasonsCount}):`);
  dismissedNewReasons.forEach(r => {
    console.log(`   - ${r.passReason}: ${r._count.id}`);
  });
  
  if (dismissedNewReasons.length === 0) {
      console.log('   (No jobs found for these new reasons)');
  }

  // 3. Confirm no jobs are currently dismissed under 'Sales & Marketing role rejected'
  const salesAndMarketingCount = await prisma.job.count({
    where: {
      status: 'dismissed',
      passReason: 'Sales & Marketing role rejected'
    }
  });

  console.log(`\n3. Jobs dismissed under 'Sales & Marketing role rejected': ${salesAndMarketingCount}`);
  if (salesAndMarketingCount === 0) {
    console.log('   ✅ Confirmation successful: 0 jobs found with this reason.');
  } else {
    console.log('   ❌ Warning: Found jobs with this reason!');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
