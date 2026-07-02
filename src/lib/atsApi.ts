import { cleanHtmlText } from '@/lib/jobIngestion';

export async function scrapeAtsApi(url: string): Promise<{ text: string, ats: string, atsSlug?: string, platform?: string } | null> {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // Greenhouse
    // https://boards.greenhouse.io/{company}/jobs/{jobId}
    if (host.includes('greenhouse.io') && pathParts.length >= 3 && pathParts[1] === 'jobs') {
      const company = pathParts[0];
      const jobId = pathParts[2];
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${company}/jobs/${jobId}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        return { text: cleanHtmlText(data.content || ''), ats: 'Greenhouse', atsSlug: company, platform: 'greenhouse' };
      }
    }

    // Lever
    // https://jobs.lever.co/{company}/{jobId}
    if (host.includes('lever.co') && pathParts.length >= 2) {
      const company = pathParts[0];
      const jobId = pathParts[1];
      const res = await fetch(`https://api.lever.co/v0/postings/${company}/${jobId}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        
        let rawDescription = data.descriptionPlain || data.description || '';
        if (data.lists && Array.isArray(data.lists)) {
          data.lists.forEach((list: any) => {
            if (list.text) rawDescription += `\n\n${list.text}`;
            if (list.content) rawDescription += `\n${list.content}`;
          });
        }
        if (data.additional) {
          rawDescription += `\n\n${data.additional}`;
        } else if (data.additionalPlain) {
          rawDescription += `\n\n${data.additionalPlain}`;
        }
        
        return { text: cleanHtmlText(rawDescription), ats: 'Lever', atsSlug: company, platform: 'lever' };
      }
    }

    // Ashby
    // https://jobs.ashbyhq.com/{company}/{jobId}
    if (host.includes('ashbyhq.com') && pathParts.length >= 2) {
      const company = decodeURIComponent(pathParts[0]);
      const jobId = pathParts[1];
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${company}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        const job = data.jobs?.find((j: any) => j.id === jobId);
        if (job) {
          return { text: cleanHtmlText(job.descriptionHtml || job.descriptionPlain || ''), ats: 'Ashby', atsSlug: company, platform: 'ashby' };
        }
      }
    }
    
    // Workday (Basic heuristic)
    if (host.includes('myworkdayjobs.com')) {
      const jobIndex = pathParts.indexOf('job');
      if (jobIndex >= 1 && pathParts.length > jobIndex + 1) {
        const tenant = host.split('.')[0];
        const companySite = pathParts[jobIndex - 1];
        const jobPath = pathParts.slice(jobIndex + 1).join('/'); // Includes the whole path after /job/
        
        const apiUrl = `https://${host}/wday/cxs/${tenant}/${companySite}/job/${jobPath}`;
        const res = await fetch(apiUrl, {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.jobPostingInfo?.jobDescription) {
            return { text: cleanHtmlText(data.jobPostingInfo.jobDescription), ats: 'Workday', atsSlug: `${tenant}::${companySite}`, platform: 'workday' };
          }
        }
      }
    }

    return null;
  } catch (e) {
    console.error("ATS API Scraping error:", e);
    return null;
  }
}
