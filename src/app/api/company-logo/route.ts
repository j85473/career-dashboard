import { prisma } from '@/lib/prisma';
import { after } from 'next/server';
import { companyLogoCache, CompanyLogoBusyError } from '@/lib/companyLogoCache';
import { reviewedCompanyWebsite } from '@/lib/companyLogo';

export const runtime = 'nodejs';

/** Resolve only saved job evidence; never accept an arbitrary fetch URL. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const jobId = params.get('jobId');
  const company = params.get('company');
  if ((!jobId && !company) || (jobId?.length || 0) > 100 || (company?.length || 0) > 300) {
    return new Response(null, { status: 400 });
  }
  try {
    const jobs = await prisma.job.findMany({
      where: jobId ? { id: jobId } : { OR: [{ employer: company! }, { employer: null, company: company! }] },
      select: { company: true, employer: true, url: true, canonicalUrl: true },
      orderBy: { createdAt: 'desc' },
      take: jobId ? 1 : 3,
    });
    const subjects = jobs.map(job => ({ ...job, company: job.employer || job.company }));
    // Outreach can name a reviewed employer before it has a saved job.
    if (!jobId && !subjects.length && company && reviewedCompanyWebsite(company)) {
      subjects.push({ company, employer: company, url: '', canonicalUrl: null });
    }
    for (const subject of subjects) {
      const image = await companyLogoCache.get(subject);
      if (!image) continue;
      if (companyLogoCache.needsRefresh(image)) after(() => companyLogoCache.refresh(subject).catch(() => {}));
      return new Response(new Uint8Array(image.png), { headers: {
        'Content-Type': 'image/png', 'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      } });
    }
    // A temporary miss must not become a browser-cached blank logo.
    return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return new Response(null, { status: error instanceof CompanyLogoBusyError ? 503 : 500,
      headers: { 'Cache-Control': 'no-store', 'Retry-After': '1' } });
  }
}
