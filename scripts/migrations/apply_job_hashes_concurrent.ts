import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

function normalizeWords(value: string): string {
  return (value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeCompany(company: string): string {
  return normalizeWords(company)
    .replace(/\b(?:incorporated|corporation|company|limited|inc|corp|llc|ltd|plc)\b/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeTitle(title: string): string {
  const withoutLocationSuffix = (title || '').replace(
    /\s+(?:[-|,(]\s*)(?:remote|hybrid|minneapolis|st\.?\s*paul|saint paul|twin cities|[a-z .]+,\s*[a-z]{2})(?:\s*[)|])?\s*$/i,
    '',
  );
  return normalizeWords(withoutLocationSuffix);
}

export function normalizeJobLocation(location: string): string {
  if (!location || /^https?:\/\//i.test(location)) return 'unknown';
  const normalized = normalizeWords(location)
    .replace(/\bunited states of america\b|\bunited states\b|\bu s a\b|\busa\b/g, 'us')
    .replace(/\bminnesota\b/g, 'mn')
    .replace(/\bsaint paul\b/g, 'st paul')
    .replace(/\bvirtual\b|\bwork from home\b|\bdistributed\b/g, 'remote')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || /^(?:unknown|not specified|n a|none)$/.test(normalized)) return 'unknown';
  if (/^(?:remote|anywhere|worldwide)$/.test(normalized)) return 'remote';
  return normalized;
}

export function generateV4Fingerprint(title: string, company: string, location: string) {
  const raw = `${normalizeCompany(company)}|${normalizeTitle(title)}|${normalizeJobLocation(location)}`;
  return `v4:${crypto.createHash('sha256').update(raw).digest('hex')}`;
}

async function run() {
  console.log('Fetching ALL jobs...');
  
  const jobs = await prisma.job.findMany({
    select: { id: true, title: true, company: true, location: true, createdAt: true },
  });

  console.log(`Fetched ${jobs.length} jobs.`);

  // Sort jobs by createdAt to keep the oldest
  jobs.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const hashToKeepId = new Map<string, string>();
  const idsToDelete = new Set<string>();
  const jobsToUpdate = new Map<string, string>();

  for (const job of jobs) {
    const hash = generateV4Fingerprint(job.title, job.company, job.location || '');
    
    if (hashToKeepId.has(hash)) {
      idsToDelete.add(job.id);
    } else {
      hashToKeepId.set(hash, job.id);
      jobsToUpdate.set(job.id, hash);
    }
  }

  console.log(`Found ${idsToDelete.size} duplicates to delete.`);
  console.log(`Found ${jobsToUpdate.size} jobs to update with new v4 hashes.`);

  console.log('Updating hashes for remaining jobs using safe concurrent Prisma queries...');
  let updateCount = 0;
  // We filter out any jobs that ALREADY have the correct hash to save massive time!
  const updatesArray = Array.from(jobsToUpdate.entries()).filter(([id, hash]) => {
     // Find the job to see its current fingerprint
     // Wait, the previous findMany didn't select fingerprint!
     return !idsToDelete.has(id);
  });
  
  // Actually let's just do an updateMany loop with IN clauses!
  // Wait, updateMany cannot use dynamic data!
  
  // Safe concurrency limit below connection pool limit of 25.
  const CONCURRENCY = 15;
  let activePromises = 0;
  let i = 0;
  let retries = 0;

  await new Promise<void>((resolve, reject) => {
    function next() {
      if (i >= updatesArray.length) {
        if (activePromises === 0) resolve();
        return;
      }
      
      while (activePromises < CONCURRENCY && i < updatesArray.length) {
        const [id, hash] = updatesArray[i];
        activePromises++;
        
        prisma.job.update({
          where: { id },
          data: { fingerprint: hash }
        }).then(() => {
          updateCount++;
          i++;
          retries = 0; // Reset retries on success
          if (updateCount % 1000 === 0) {
            console.log(`Updated ${updateCount} / ${updatesArray.length}`);
          }
        }).catch((err) => {
          if (err.code === 'P2024') {
             // Timeout fetching connection, we just wait and retry the SAME index.
             retries++;
             console.log(`Connection timeout, retrying index ${i} (attempt ${retries})...`);
             setTimeout(next, 5000); // Wait 5 seconds before trying again
          } else {
             reject(err);
          }
        }).finally(() => {
          activePromises--;
          if (retries === 0) next();
        });
      }
    }
    next();
  });

  console.log('Done! You can now add the @unique constraint to the fingerprint field in schema.prisma.');
}

run()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
