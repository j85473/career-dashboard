import { prisma } from "./src/lib/prisma";

async function main() {
  const manualJobId = "bbe0a4ac-fd1a-457c-9d48-7a37eb6f8099";
  
  // First, find the job to ensure it exists
  const job = await prisma.job.findUnique({ where: { id: manualJobId } });
  if (!job) {
    console.log("Job already deleted or not found.");
    return;
  }
  
  console.log(`Deleting job: ${job.title} from ${job.company}`);
  
  // Delete associated observations (if cascading isn't automatic in schema)
  await prisma.jobSourceObservation.deleteMany({ where: { jobId: manualJobId } });
  
  // Delete the job
  await prisma.job.delete({ where: { id: manualJobId } });
  
  console.log("Job successfully deleted.");
}

main().catch(console.error).finally(() => prisma.$disconnect());
