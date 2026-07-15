import { PrismaClient } from '@prisma/client';
import "dotenv/config";

const prisma = new PrismaClient();

const GITHUB_TOKEN = process.env.GITHUB_API_TOKEN;

const PLATFORMS = {
  greenhouse: {
    extract_slug: (url: string) => {
      const match = url.match(/boards\.greenhouse\.io\/([^/?]+)/);
      return match ? match[1] : null;
    }
  },
  lever: {
    extract_slug: (url: string) => {
      const match = url.match(/jobs\.lever\.co\/([^/?]+)/);
      return match ? match[1] : null;
    }
  },
  ashby: {
    extract_slug: (url: string) => {
      const match = url.match(/jobs\.ashbyhq\.com\/([^/?]+)/);
      return match ? match[1] : null;
    }
  },
  workday: {
    extract_slug: (url: string) => {
      const match = url.match(/https?:\/\/([^.]+?(?:\.wd\d+)?)\.myworkdayjobs\.com\/(?:[a-zA-Z]{2}-[a-zA-Z]{2}\/)?([^/?]+)/);
      return match ? `${match[1]}::${match[2]}` : null;
    }
  },
  workable: {
    extract_slug: (url: string) => {
      const match = url.match(/apply\.workable\.com\/([^/?]+)/);
      return match ? match[1] : null;
    }
  },
  bamboohr: {
    extract_slug: (url: string) => {
      const match = url.match(/https?:\/\/([^.]+)\.bamboohr\.com/);
      return match ? match[1] : null;
    }
  },
  smartrecruiters: {
    extract_slug: (url: string) => {
      const match = url.match(/careers\.smartrecruiters\.com\/([^/?]+)/);
      return match ? match[1] : null;
    }
  }
};

async function runImport() {
  if (!GITHUB_TOKEN) {
    console.warn("⚠️ No GITHUB_API_TOKEN found in .env. Falling back to unauthenticated requests (may be rate limited).");
  }

  const platforms = Object.keys(PLATFORMS) as (keyof typeof PLATFORMS)[];

  for (const platform of platforms) {
    console.log(`\n=== Processing ${platform.toUpperCase()} ===`);
    const rawUrl = `https://raw.githubusercontent.com/kalil0321/ats-scrapers/main/ats-companies/${platform}.csv`;
    
    try {
      const headers: Record<string, string> = {};
      if (GITHUB_TOKEN) {
        headers['Authorization'] = `token ${GITHUB_TOKEN}`;
      }

      const res = await fetch(rawUrl, { headers });
      if (!res.ok) {
        console.error(`Failed to fetch ${platform}.csv: ${res.statusText}`);
        continue;
      }

      const csvText = await res.text();
      const lines = csvText.split('\n').map(l => l.trim()).filter(l => l !== '');
      
      // Skip header
      if (lines.length > 0 && lines[0].toLowerCase().includes('slug')) {
        lines.shift();
      }

      const imported = 0;
      const slugsToUpsert = new Set<string>();

      for (const line of lines) {
        const parts = line.split(',');
        if (parts.length < 3) continue;
        
        const url = parts.pop()!.replace(/"/g, '').trim();
        const rawSlug = parts.pop()!.replace(/"/g, '').trim();
        
        let finalSlug = PLATFORMS[platform].extract_slug(url);
        
        if (!finalSlug) {
          if (platform === 'workday') {
            // Try to extract from rawSlug if url regex failed
            // Workday rawSlug format: company/tenant
            const wdParts = rawSlug.split('/');
            if (wdParts.length === 2) {
              finalSlug = `${wdParts[0]}::${wdParts[1]}`;
            } else {
              continue;
            }
          } else {
            finalSlug = rawSlug;
          }
        }

        if (finalSlug) {
          slugsToUpsert.add(finalSlug);
        }
      }

      console.log(`Extracted ${slugsToUpsert.size} unique slugs. Upserting to database...`);
      
      let newCount = 0;
      let existingCount = 0;

      // Upsert in batches to avoid overwhelming DB connections
      const slugArray = Array.from(slugsToUpsert);
      const batchSize = 100;
      
      for (let i = 0; i < slugArray.length; i += batchSize) {
        const batch = slugArray.slice(i, i + batchSize);
        
        await Promise.all(batch.map(async (slug) => {
          try {
            const existing = await prisma.atsCompany.findUnique({
              where: { slug_platform: { slug, platform } }
            });

            if (!existing) {
              await prisma.atsCompany.create({
                data: {
                  slug,
                  platform,
                  status: 'active',
                  failCount: 0,
                  jobsFound: 0
                }
              });
              newCount++;
            } else {
              // If it exists but is parked/blacklisted, maybe we leave it alone.
              existingCount++;
            }
          } catch (e: any) {
            console.error(`Error upserting ${slug}: ${e.message}`);
          }
        }));
      }

      console.log(`✅ ${platform.toUpperCase()}: Added ${newCount} new companies (Skipped ${existingCount} already in DB).`);

    } catch (err: any) {
      console.error(`Error processing ${platform}:`, err.message);
    }
  }

  console.log("\n=== GitHub Import Complete ===");
  const activeCount = await prisma.atsCompany.count({ where: { status: 'active' } });
  console.log(`Total Active Verified Boards in Prisma: ${activeCount}`);
}

const isMain = typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module;
if (isMain || (process.argv[1] && process.argv[1].includes('importGitHubSlugs.ts'))) {
  runImport()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}
