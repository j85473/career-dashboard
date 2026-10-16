import { prisma } from '@/lib/prisma';
import { cachedCompanyLogo, workdayLogoImage } from '@/lib/companyLogoRecovery';

export const runtime = 'nodejs';

/** Resolve only saved job evidence; never accept an arbitrary fetch URL. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const jobId = params.get('jobId');
  const company = params.get('company');
  const websiteOnly = params.get('fallback') === 'website';
  if ((!jobId && !company) || (jobId?.length || 0) > 100 || (company?.length || 0) > 300) {
    return new Response(null, { status: 400 });
  }
  const jobs = await prisma.job.findMany({
    where: jobId ? { id: jobId } : { OR: [{ employer: company! }, { employer: null, company: company! }] },
    select: { company: true, employer: true, url: true, canonicalUrl: true },
    orderBy: { createdAt: 'desc' },
    take: jobId ? 1 : 3,
  });
  for (const job of jobs) {
    const logo = await cachedCompanyLogo({ ...job, company: job.employer || job.company }, websiteOnly);
    if (logo && /\.myworkdayjobs\.com$/.test(new URL(logo).hostname)) {
      const image = await workdayLogoImage(logo);
      if (image) return new Response(image.bytes, { headers: {
        'Content-Type': image.type, 'Cache-Control': 'private, max-age=86400',
        'X-Content-Type-Options': 'nosniff',
      } });
      continue;
    }
    if (logo) return new Response(null, { status: 307, headers: {
      Location: logo, 'Cache-Control': 'private, max-age=86400',
    } });
  }
  return new Response(null, { status: 404, headers: { 'Cache-Control': 'private, max-age=300' } });
}
