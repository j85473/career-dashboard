import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log("Analyzing the last 500 jobs where at least one score is < 75...");

  // Querying JobScoreEvent to get the exact evaluations
  const events = await prisma.jobScoreEvent.findMany({
    where: {
      aimFitScore: { not: null },
      experienceFitScore: { not: null },
      OR: [
        { aimFitScore: { lt: 75 } },
        { experienceFitScore: { lt: 75 } }
      ]
    },
    take: 500,
    orderBy: { createdAt: 'desc' },
    select: {
      aimFitScore: true,
      experienceFitScore: true,
      jobId: true
    }
  });

  let aimFail = 0;
  let expFail = 0;
  let bothFail = 0;
  const total = events.length;

  for (const ev of events) {
    const aim = ev.aimFitScore!;
    const exp = ev.experienceFitScore!;
    
    if (aim < 75 && exp < 75) {
      bothFail++;
    } else if (aim < 75) {
      aimFail++;
    } else if (exp < 75) {
      expFail++;
    }
  }

  const totalAimFailures = aimFail + bothFail;
  const totalExpFailures = expFail + bothFail;

  console.log(`\n--- Results for the last ${total} rejected jobs ---`);
  console.log(`Failed ONLY due to Aim Fit:         ${aimFail}`);
  console.log(`Failed ONLY due to Experience Fit:  ${expFail}`);
  console.log(`Failed BOTH:                        ${bothFail}`);
  console.log(`\n--- Cumulative Failures ---`);
  console.log(`Total that failed Aim Fit:          ${totalAimFailures} (${((totalAimFailures/total)*100).toFixed(1)}%)`);
  console.log(`Total that failed Experience Fit:   ${totalExpFailures} (${((totalExpFailures/total)*100).toFixed(1)}%)`);

  console.log(`\n--- Sequential Evaluation Simulation ---`);
  console.log(`If Aim Fit is First Pass:`);
  console.log(`- 1st Pass Evaluations: ${total}`);
  console.log(`- Jobs Passed to 2nd Pass: ${total - totalAimFailures}`);
  console.log(`- Total Evaluations: ${total + (total - totalAimFailures)}`);

  console.log(`\nIf Experience Fit is First Pass:`);
  console.log(`- 1st Pass Evaluations: ${total}`);
  console.log(`- Jobs Passed to 2nd Pass: ${total - totalExpFailures}`);
  console.log(`- Total Evaluations: ${total + (total - totalExpFailures)}`);

  console.log(`\n--- Recommendation ---`);
  if (totalAimFailures > totalExpFailures) {
    console.log(`Run Aim Fit FIRST. It fails more jobs overall, so it will filter out the most jobs early and save API tokens.`);
  } else if (totalExpFailures > totalAimFailures) {
    console.log(`Run Experience Fit FIRST. It fails more jobs overall, so it will filter out the most jobs early and save API tokens.`);
  } else {
    console.log(`Both metrics fail the exact same number of jobs. You can run either one first with the same token efficiency.`);
  }
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
