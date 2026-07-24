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
  console.log('Fetching all jobs to deduplicate and hash...');
  
  // We need to do this in chunks if the DB is large
  let skip = 0;
  const batchSize = 5000;
  let hasMore = true;

  // Track the first ID seen for each hash to keep it
  const hashToKeepId = new Map<string, string>();
  const idsToDelete = new Set<string>();
  const jobsToUpdate = new Map<string, string>(); // id -> new hash

  let totalProcessed = 0;

  while (hasMore) {
    const jobs = await prisma.job.findMany({
      skip,
      take: batchSize,
      orderBy: { createdAt: 'asc' }, // keep the oldest one
      select: { id: true, title: true, company: true, location: true },
    });

    if (jobs.length === 0) {
      hasMore = false;
      break;
    }

    for (const job of jobs) {
      const hash = generateV4Fingerprint(job.title, job.company, job.location || '');
      
      if (hashToKeepId.has(hash)) {
        // This is a duplicate!
        idsToDelete.add(job.id);
      } else {
        hashToKeepId.set(hash, job.id);
        jobsToUpdate.set(job.id, hash);
      }
    }

    totalProcessed += jobs.length;
    skip += batchSize;
    console.log(`Processed ${totalProcessed} jobs...`);
  }

  console.log(`Found ${idsToDelete.size} duplicates to delete.`);
  console.log(`Found ${jobsToUpdate.size} jobs to update with new v4 hashes.`);

  if (idsToDelete.size > 0) {
    console.log('Deleting duplicates...');
    const deleteArray = Array.from(idsToDelete);
    // Delete in chunks of 1000
    for (let i = 0; i < deleteArray.length; i += 1000) {
      const chunk = deleteArray.slice(i, i + 1000);
      await prisma.job.deleteMany({
        where: { id: { in: chunk } }
      });
      console.log(`Deleted ${i + chunk.length} / ${deleteArray.length}`);
    }
  }

  console.log('Updating hashes for remaining jobs...');
  let updateCount = 0;
  const updatesArray = Array.from(jobsToUpdate.entries()).filter(([id]) => !idsToDelete.has(id));

  // Connect via pg directly for massive speedup
  const { Client } = require('pg');
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    for (let i = 0; i < updatesArray.length; i += 5000) {
      const chunk = updatesArray.slice(i, i + 5000);
      const query = chunk.map(([id, hash]) => 
        `UPDATE "Job" SET fingerprint = '${hash}' WHERE id = '${id}';`
      ).join('\n');
      await client.query(query);
      updateCount += chunk.length;
      console.log(`Updated ${updateCount} / ${updatesArray.length}`);
    }
  } finally {
    await client.end();
  }

  console.log(`Finished updating ${updateCount} jobs.`);
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
