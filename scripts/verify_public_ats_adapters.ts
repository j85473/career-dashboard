import { PUBLIC_ATS_LAUNCH_BOARDS } from '../src/lib/publicAtsLaunchBoards';
/** Read-only live smoke test. It imports no records and spends no production leases. */
import { writeFile } from 'node:fs/promises';
import { isPublicAtsPlatform, publicAtsBoardUrl, buildPublicAtsBoardRequest, parsePublicAtsConfig,
  parsePublicAtsListing, publicAtsPageSize, teamtailorHasMore, type PublicAtsConfig } from '../src/lib/publicAtsBoards';
import { safeExternalFetch } from '../src/lib/safeExternalFetch';
import { enrichAtsListingJob, readAtsJobEnrichmentMarker } from '../src/lib/atsJobEnrichment';

const boards = [...PUBLIC_ATS_LAUNCH_BOARDS, { platform: 'teamtailor', slug: 'morrisgroupsite' }];
const read = async (url: string, init: RequestInit = {}) => {
  const response = await safeExternalFetch(url, { ...init, signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Public feed HTTP ${response.status}`);
  return response;
};

async function main() {
  const results = [];
  for (const board of boards) {
    let config: PublicAtsConfig | undefined;
    if (isPublicAtsPlatform(board.platform) && ['oracle', 'comeet', 'successfactors'].includes(board.platform)) {
      config = parsePublicAtsConfig(board.platform, board.slug, await (await read(publicAtsBoardUrl(board.platform, board.slug))).text());
    }
    let offset = 0, pages = 0, reportedTotal: number | null = null;
    const jobs: Record<string, unknown>[] = [];
    while (pages < 100) {
      const request = isPublicAtsPlatform(board.platform)
        ? buildPublicAtsBoardRequest(board.platform, board.slug, offset, config)
        : { url: `https://${board.slug}.teamtailor.com/jobs.json?page=${offset / 100 + 1}&per_page=100`, init: {} };
      const response = await read(request.url, request.init);
      const parsed = board.platform === 'successfactors' ? await response.text() : await response.json();
      const feed = isPublicAtsPlatform(board.platform)
        ? parsePublicAtsListing(board.platform, board.slug, board.platform === 'successfactors' ? {} : parsed,
          board.platform === 'successfactors' ? String(parsed) : null, config)
        : { jobs: parsed.items as Record<string, unknown>[], total: null, metadata: {} };
      jobs.push(...feed.jobs); offset += feed.jobs.length; pages++;
      reportedTotal = feed.total;
      const pageSize = board.platform === 'teamtailor' ? 100 : publicAtsPageSize(board.platform);
      if (board.platform === 'teamtailor') {
        if (!teamtailorHasMore(parsed, request.url)) break;
        if (feed.jobs.length !== 100) throw new Error('Teamtailor returned an incomplete continuation page');
      } else {
        if (pageSize === null || offset === feed.total) break;
        if (feed.jobs.length < pageSize) throw new Error('Public feed ended before its reported total');
      }
    }
    if (pages === 100) throw new Error('Public listing did not reach completion');
    const ids = jobs.map(job => String(job.id));
    if ((board.platform === 'teamtailor' || publicAtsPageSize(board.platform) !== null) && new Set(ids).size !== ids.length) throw new Error(`${board.platform} repeated posting IDs across pages`);
    let sample = jobs.find(job => /(?:channel|account|sales|business).*manager/i.test(String(job.title || job.name))) || jobs[0];
    if (!sample) throw new Error('Expected a live sample posting');
    if (board.platform === 'oracle' || board.platform === 'ukg') {
      const enriched = await enrichAtsListingJob({ ...board, job: sample, requestTimeoutMs: 15000 }, {
        fetch: (input, init) => read(String(input), init), safeExternalFetch: (input, init) => read(String(input), init),
        fetchPlatformResponse: async (_platform, _signal, request, options) => {
          const response = await request(); await options?.onResponse?.(response); return response;
        },
        reserveProviderBudgetForSource: async () => ({ allowed: true }), recordProviderSuccess: async () => {},
        recordProviderFailure: async () => null, passesPreFilter: () => ({ passes: true, reason: '' }),
      });
      const detail = readAtsJobEnrichmentMarker(enriched);
      if (detail?.status !== 'enriched' || !detail.description || !detail.company) throw new Error('Full detail metadata was not recovered');
      sample = { ...sample, description: detail.description, company: detail.company, location: detail.location };
    }
    const result = { ...board, jobs: jobs.length, distinctPostingViews: new Set(ids).size, pages, reportedTotal, sample: {
      title: sample.title, company: sample.company, location: sample.location,
      descriptionCharacters: String(sample.description || sample.content_html || '').length,
    } };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice('--output='.length);
  if (output) await writeFile(output, JSON.stringify({ verifiedAt: new Date().toISOString(), results }, null, 2) + '\n');
}
main().catch(error => {
  const reason = error instanceof Error ? error.message.replace(/https?:\/\/\S+/g, '[request URL omitted]') : 'Unknown verification error';
  console.error(`Public ATS verification failed: ${reason}. No records were written.`); process.exitCode = 1;
});
