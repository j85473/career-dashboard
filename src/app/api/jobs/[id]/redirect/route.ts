import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { assertSafeExternalNavigationUrl } from '@/lib/safeExternalFetch';

const AGGREGATOR_DOMAINS = ['adzuna.com', 'indeed.com', 'jsearch.p.rapidapi.com'];

function isAggregator(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();
  return AGGREGATOR_DOMAINS.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
}

function validatedRedirect(value: string | null | undefined): URL | null {
  if (!value) return null;
  try {
    return assertSafeExternalNavigationUrl(value);
  } catch {
    return null;
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  
  const job = await prisma.job.findUnique({
    where: { id }
  });

  if (!job) {
    return new NextResponse('Job not found', { status: 404 });
  }

  // This endpoint is intentionally read-only. Resolving a posting through a
  // paid search API belongs in ingestion, not in a GET that can be triggered by
  // opening a link or by cross-site navigation.
  // The browser resolves the destination. Server DNS failures must not replace
  // an already saved posting URL with a search; no external fetch happens here.
  const canonicalUrl = validatedRedirect(job.canonicalUrl);
  if (canonicalUrl && !isAggregator(canonicalUrl)) {
    return NextResponse.redirect(canonicalUrl);
  }

  if (job.source?.toLowerCase().includes('indeed') && job.sourceId) {
    const indeedUrl = validatedRedirect(`https://www.indeed.com/viewjob?jk=${encodeURIComponent(job.sourceId)}`);
    if (indeedUrl) return NextResponse.redirect(indeedUrl);
  }

  const sourceUrl = validatedRedirect(job.url);
  if (sourceUrl) return NextResponse.redirect(sourceUrl);

  return NextResponse.redirect(
    `https://www.google.com/search?q=${encodeURIComponent(`${job.company} ${job.title} job careers`)}`,
  );
}
