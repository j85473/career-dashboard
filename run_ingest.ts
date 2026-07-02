import { ingestJobs } from "./src/lib/jobIngestion";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Starting ATS ingest test...");
  // Pass an abort signal and an onProgress callback so we see output
  const count = await ingestJobs((msg) => console.log(msg));
  console.log(`Ingest complete. ${count} jobs added.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
