// @ts-nocheck
import Database from 'better-sqlite3';
import { prisma } from '../src/lib/prisma';
import fs from 'fs';
import * as crypto from 'crypto';

// The databases the user identified
const dbPaths = [
  '/Users/JosephLamb/job-dashboard-local/jobs.db',
  '/Users/JosephLamb/job-dashboard-ag-src1/jobs.db',
  '/Users/JosephLamb/antigravity/Job-Cockpit/jobs.db',
];

function normalizeUrl(urlStr: string) {
  if (!urlStr) return "";
  try {
    const u = new URL(urlStr);
    u.search = "";
    u.hash = "";
    let str = u.toString().replace(/\/$/, "");
    if (str.includes("jsearch.p.rapidapi.com")) return "";
    return str;
  } catch (e) {
    return "";
  }
}

async function migrate() {
  console.log("Starting Migration from old databases...");
  let migratedCount = 0;

  for (const dbPath of dbPaths) {
    if (!fs.existsSync(dbPath)) {
      console.log(`Skipping ${dbPath}, file not found.`);
      continue;
    }

    try {
      const db = new Database(dbPath, { readonly: true });
      
      // Attempt to query jobs table
      let rows: any[] = [];
      try {
        // First try standard status column
        rows = db.prepare(`SELECT * FROM jobs WHERE status IN ('Passed', 'Applied', 'applied', 'passed', 'dismissed', 'Dismissed')`).all();
      } catch (e) {
        try {
          // Fallback to Job-Cockpit schema
          rows = db.prepare(`SELECT * FROM jobs WHERE applicationStatus IN ('Ready to Apply', 'Applied')`).all();
        } catch (err) {
          console.log(`No jobs table or status column in ${dbPath}.`);
        }
      }

      for (const row of rows) {
        const title = row.title || row.jobTitle || 'Unknown Title';
        const company = row.company || row.companyName || 'Unknown Company';
        const location = row.location || 'Unknown Location';
        const description = row.description || row.fullDescription || row.raw_description || '';
        const url = row.url || row.directLink || '';
        
        // Normalize status
        let status = 'inbox';
        let fitCategory = 'unscored';
        const rawStatus = (row.status || '').toLowerCase();
        const appStatus = (row.applicationStatus || '').toLowerCase();
        
        if (rawStatus === 'applied' || appStatus === 'applied') {
          status = 'applied';
          fitCategory = 'minor';
        } else if (rawStatus === 'passed') {
          status = 'passed';
          fitCategory = 'minor';
        } else if (rawStatus === 'dismissed' || appStatus === 'ready to apply') {
          status = 'dismissed';
          fitCategory = 'rejected';
        }

        
        const rationale = row.pass_tags || row.user_feedback || row.why_fits || null;

        const canonicalUrl = normalizeUrl(url);
        const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, "");
        const compNorm = company.toLowerCase().replace(/[^a-z0-9]/g, "");
        const locNorm = location.toLowerCase().replace(/[^a-z0-9]/g, "");
        const fingerprintStr = `${titleNorm}|${compNorm}|${locNorm}`;
        const fingerprint = crypto.createHash("sha256").update(fingerprintStr).digest("hex");

        // Dedupe check
        let existingJob = null;
        if (canonicalUrl) {
          existingJob = await prisma.job.findFirst({ where: { canonicalUrl } });
        }
        if (!existingJob) {
          existingJob = await prisma.job.findFirst({ where: { fingerprint } });
        }
        if (!existingJob && url) {
          existingJob = await prisma.job.findFirst({ where: { url } });
        }

        if (!existingJob) {
          await prisma.job.create({
            data: {
              title,
              company,
              location,
              description,
              url,
              canonicalUrl,
              fingerprint,
              status,
              fitCategory,
              fitRationale: rationale,
              postedAt: row.created_at ? new Date(row.created_at) : new Date(),
              scoringStatus: 'skipped'
            }
          });
          migratedCount++;
          console.log(`Migrated: ${title} at ${company} (Status: ${status})`);
        }
      }
      db.close();
    } catch (err: any) {
      console.log(`Error reading ${dbPath}: ${err.message}`);
    }
  }

  console.log(`Migration Complete. Migrated ${migratedCount} jobs into the Context DB pool.`);
}

migrate()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
