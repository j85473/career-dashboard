import { cleanHtmlText } from '@/lib/jobIngestion';
import { assertSafeExternalUrl, safeExternalFetch } from '@/lib/safeExternalFetch';

function isDomain(hostname: string, domain: string) {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

export async function scrapeAtsApi(url: string): Promise<{ text: string, ats: string, atsSlug?: string, platform?: string, title?: string } | null> {
  try {
    const parsed = await assertSafeExternalUrl(url);
    const host = parsed.hostname.toLowerCase();
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    // Greenhouse
    // https://boards.greenhouse.io/{company}/jobs/{jobId}
    if (isDomain(host, 'greenhouse.io') && pathParts.length >= 3 && pathParts[1] === 'jobs') {
      const company = pathParts[0];
      const jobId = pathParts[2];
      const res = await fetch(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company)}/jobs/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        let cleanTitle = data.title;
        if (cleanTitle) {
           cleanTitle = cleanTitle.replace(/^Job Application for /i, '');
           cleanTitle = cleanTitle.replace(/ at .*$/i, '');
           cleanTitle = cleanTitle.trim();
        }
        return { text: cleanHtmlText(data.content || ''), ats: 'Greenhouse', atsSlug: company, platform: 'greenhouse', title: cleanTitle };
      }
    }

    // Lever
    // https://jobs.lever.co/{company}/{jobId}
    if (isDomain(host, 'lever.co') && pathParts.length >= 2) {
      const company = pathParts[0];
      const jobId = pathParts[1];
      const res = await fetch(`https://api.lever.co/v0/postings/${encodeURIComponent(company)}/${encodeURIComponent(jobId)}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        
        let rawDescription = data.descriptionPlain || data.description || '';
        if (data.lists && Array.isArray(data.lists)) {
          data.lists.forEach((list: { text?: string; content?: string }) => {
            if (list.text) rawDescription += `\n\n${list.text}`;
            if (list.content) rawDescription += `\n${list.content}`;
          });
        }
        if (data.additional) {
          rawDescription += `\n\n${data.additional}`;
        } else if (data.additionalPlain) {
          rawDescription += `\n\n${data.additionalPlain}`;
        }
        
        return { text: cleanHtmlText(rawDescription), ats: 'Lever', atsSlug: company, platform: 'lever', title: data.text };
      }
    }

    // Ashby
    // https://jobs.ashbyhq.com/{company}/{jobId}
    if (isDomain(host, 'ashbyhq.com') && pathParts.length >= 2) {
      const company = decodeURIComponent(pathParts[0]);
      const jobId = pathParts[1];
      const res = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(company)}`, { signal: AbortSignal.timeout(10000) });
      if (res.ok) {
        const data = await res.json();
        const job = data.jobs?.find((candidate: {
          id?: string;
          descriptionHtml?: string;
          descriptionPlain?: string;
          title?: string;
        }) => candidate.id === jobId);
        if (job) {
          return { text: cleanHtmlText(job.descriptionHtml || job.descriptionPlain || ''), ats: 'Ashby', atsSlug: company, platform: 'ashby', title: job.title };
        }
      }
    }
    
    // Workday (Basic heuristic)
    if (isDomain(host, 'myworkdayjobs.com')) {
      const jobIndex = pathParts.indexOf('job');
      if (jobIndex >= 1 && pathParts.length > jobIndex + 1) {
        const tenantMatch = host.match(/([a-zA-Z0-9-]+)\.myworkdayjobs\.com/i);
        const tenant = tenantMatch ? tenantMatch[1] : host.split('.')[0];
        const companySite = pathParts[jobIndex - 1];
        const jobPath = pathParts.slice(jobIndex + 1).join('/'); // Includes the whole path after /job/
        
        const encodedJobPath = jobPath.split('/').map(encodeURIComponent).join('/');
        const apiUrl = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(companySite)}/job/${encodedJobPath}`;
        const res = await safeExternalFetch(apiUrl, {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
          },
          signal: AbortSignal.timeout(10000)
        });
        if (res.ok) {
          const data = await res.json();
          if (data.jobPostingInfo?.jobDescription) {
            return { text: cleanHtmlText(data.jobPostingInfo.jobDescription), ats: 'Workday', atsSlug: `${tenant}::${companySite}`, platform: 'workday', title: data.jobPostingInfo.title };
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
