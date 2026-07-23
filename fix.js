const fs = require('fs');

const apifyFile = '/Users/JosephLamb/.gemini/antigravity/brain/d79250c8-b15c-49da-8f20-833c71491da4/.system_generated/worktrees/subagent-Ingestion-Auditor-ingestion-auditor-f390f156/src/app/api/pipeline/apify/route.ts';
let apifyContent = fs.readFileSync(apifyFile, 'utf8');

const target1 = `      // Validate essential fields
      if (!item.jobTitle || !item.companyName || !item.jobUrl) {
        continue;
      }

      // Check if job already exists to avoid duplicates
      const location = item.location || 'Remote';
      const description = cleanHtmlText(item.jobDescription || '');
      const canonicalUrl = normalizeUrl(item.jobUrl);
      const source = 'LinkedIn (Apify)';
      const sourceId = String(item.id || canonicalUrl);
      const fingerprint = generateFingerprint(item.jobTitle, item.companyName);

      const existingObservation = await prisma.jobSourceObservation.findUnique({`;

const repl1 = `      // Validate essential fields
      const title = item.jobTitle || item.title || item.job_title;
      const company = item.companyName || item.company_name || item.company;
      const url = item.jobUrl || item.url || item.job_url;

      if (!title || !company || !url) {
        console.warn('Apify job missing essential fields, skipping:', JSON.stringify(item).substring(0, 200));
        continue;
      }

      // Check if job already exists to avoid duplicates
      const location = item.location || item.jobLocation || 'Remote';
      const description = cleanHtmlText(item.jobDescription || item.description || '');
      const canonicalUrl = normalizeUrl(url);
      const source = 'LinkedIn (Apify)';
      const sourceId = String(item.id || canonicalUrl);
      const fingerprint = generateFingerprint(title, company);

      const existingObservation = await prisma.jobSourceObservation.findUnique({`;

const target2 = `      const existingJob = candidates.find((candidate) => isLikelyDuplicatePosting(candidate, {
        title: item.jobTitle,
        company: item.companyName,
        location,
        description,
        url: item.jobUrl,
        canonicalUrl,
        source,
        sourceId,
      }));

      if (!existingJob) {
        const filter = passesPreFilter({
          title: item.jobTitle,
          company: item.companyName,
          description,
          location,
          url: canonicalUrl,
        });
        await prisma.job.create({
          data: {
            title: item.jobTitle,
            company: item.companyName,
            location,
            description,
            url: item.jobUrl,
            canonicalUrl,
            source,
            sourceId,
            status: filter.passes ? 'pending_af' : 'archived',
            passReason: filter.passes ? null : filter.reason,
            scoringStatus: filter.passes ? (description.length >= 400 ? 'queued' : 'needs_jd') : 'skipped',
            luckyStatus: filter.passes ? 'pending' : 'none',
            fingerprint,
            postedAt: item.publishedAt ? new Date(item.publishedAt) : new Date(),
            observations: {
              create: { source, sourceId, url: item.jobUrl },
            },
          }
        });
        insertedCount++;
      } else {
        await prisma.jobSourceObservation.upsert({
          where: { source_sourceId: { source, sourceId } },
          update: { url: item.jobUrl },
          create: { jobId: existingJob.id, source, sourceId, url: item.jobUrl },
        });
      }`;

const repl2 = `      const existingJob = candidates.find((candidate) => isLikelyDuplicatePosting(candidate, {
        title,
        company,
        location,
        description,
        url,
        canonicalUrl,
        source,
        sourceId,
      }));

      if (!existingJob) {
        const filter = passesPreFilter({
          title,
          company,
          description,
          location,
          url: canonicalUrl,
        });
        await prisma.job.create({
          data: {
            title,
            company,
            location,
            description,
            url,
            canonicalUrl,
            source,
            sourceId,
            status: filter.passes ? 'pending_af' : 'archived',
            passReason: filter.passes ? null : filter.reason,
            scoringStatus: filter.passes ? (description.length >= 400 ? 'queued' : 'needs_jd') : 'skipped',
            luckyStatus: filter.passes ? 'pending' : 'none',
            fingerprint,
            postedAt: item.publishedAt || item.date ? new Date(item.publishedAt || item.date) : new Date(),
            observations: {
              create: { source, sourceId, url },
            },
          }
        });
        insertedCount++;
      } else {
        await prisma.jobSourceObservation.upsert({
          where: { source_sourceId: { source, sourceId } },
          update: { url },
          create: { jobId: existingJob.id, source, sourceId, url },
        });
      }`;

apifyContent = apifyContent.replace(target1, repl1);
apifyContent = apifyContent.replace(target2, repl2);

fs.writeFileSync(apifyFile, apifyContent);

const profilesFile = '/Users/JosephLamb/.gemini/antigravity/brain/d79250c8-b15c-49da-8f20-833c71491da4/.system_generated/worktrees/subagent-Ingestion-Auditor-ingestion-auditor-f390f156/src/app/api/pipeline/apify-profiles/route.ts';
let profilesContent = fs.readFileSync(profilesFile, 'utf8');

const ptarget1 = `      const url = item.url || item.linkedinUrl || item.publicIdentifier;
      const firstName = item.firstName;
      const lastName = item.lastName;
      
      // Skip invalid items
      if (!url || !firstName || !lastName) {
        continue;
      }`;

const prepl1 = `      const url = item.url || item.linkedinUrl || item.publicIdentifier;
      const firstName = item.firstName || item.first_name;
      const lastName = item.lastName || item.last_name;
      
      // Skip invalid items
      if (!url || !firstName || !lastName) {
        console.warn('Apify profile missing essential fields, skipping:', JSON.stringify(item).substring(0, 200));
        continue;
      }`;

profilesContent = profilesContent.replace(ptarget1, prepl1);
fs.writeFileSync(profilesFile, profilesContent);

console.log("Files updated successfully");
