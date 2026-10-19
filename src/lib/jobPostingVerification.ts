import { load } from 'cheerio';
import { safeExternalFetch, buildSafeJinaReaderUrl } from './safeExternalFetch';
import { isClosedJobPosting, isScorableJobDescription, isTerminalJobPostingPage } from './jobDescriptionQuality';
import { adpPostingDetailUrl, adpPostingIdentity, parseAdpPosting } from './adpPosting';

export type JobPostingLiveness = 'alive' | 'expired' | 'unavailable' | 'inconclusive';
export type PostingProbe = { url: string; status: number | null; outcome: JobPostingLiveness; reason: string };
export type PostingVerification = { liveness: JobPostingLiveness; probes: PostingProbe[] };

export function isAdpPostingUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && !!adpPostingIdentity(value);
  } catch { return false; }
}

/** ADP keeps requisitions in its JSON API after a career center is unpublished. */
function classifyAdpCandidatePage(status: number, body: string, title: string): JobPostingLiveness {
  const basic = classifyJobPostingLiveness(status, body, title);
  if (basic !== 'inconclusive' || status !== 200) return basic;
  const $ = load(body);
  $('script,style,nav,footer').remove();
  $('br').replaceWith('\n');
  const unavailable = $('sdf-alert,[role="alert"],.recrutiment-career-center-unpublished-message-content')
    .toArray().some(node => /^This page is currently not available\.(?: Sorry for the inconvenience\.)?$/i.test($(node).text().replace(/\s+/g, ' ').trim()));
  // The rendered reader strips DOM attributes but retains this standalone alert.
  const renderedAlert = /^\s*This page is currently not available\.(?: Sorry for the inconvenience\.)?\s*$/im.test($.root().text());
  if (unavailable || renderedAlert) return 'unavailable';
  // ADP's browser title is "Recruitment" even on live openings. Require the
  // exact role heading in rendered markdown as well as a usable description.
  const matchingHeading = body.split('\n').some(line => /^\s*#{1,6}\s/.test(line)
    && words(line.replace(/^\s*#{1,6}\s*/, '')) === words(title));
  return matchingHeading && isScorableJobDescription($.root().text()) ? 'alive' : 'inconclusive';
}

function words(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Successful transport is insufficient: require an actual posting body. */
export function classifyJobPostingLiveness(status: number, body: string, title?: string): JobPostingLiveness {
  if (status === 404 || status === 410) return 'expired';
  if (status !== 200) return 'inconclusive';
  const document = load(body);
  // Jobilize inserts the requested title and city between "job" and "expired".
  // Scope this to its alert, never a similar-job card or arbitrary JD sentence.
  if (document('.alert').toArray().some(element =>
    /^the .{1,240} job in .{1,160} has expired\b/i.test(document(element).text().replace(/\s+/g, ' ').trim()))) return 'expired';
  if (isTerminalJobPostingPage(body)) return 'expired';
  document('script,style,nav,footer').remove();
  document('br').replaceWith(' ');
  document('*').append(' ');
  const visible = document.root().text().replace(/\s+/g, ' ').trim();
  if (!visible || /(?:just a moment|checking (?:your )?browser|verify you are human|enable javascript and cookies)/i.test(visible)) return 'inconclusive';

  // Individual ATS endpoints carry a posting object. Redirect widgets and error
  // objects intentionally have neither a posting title nor its description.
  try {
    const json = JSON.parse(body);
    const posting = json.jobPostingInfo || json;
    const name = posting.title || posting.text || posting.name;
    const description = posting.jobDescription || posting.content || posting.descriptionPlain || posting.description;
    if (typeof name === 'string' && typeof description === 'string'
      && (!title || words(name) === words(title))
      && isScorableJobDescription(description, { structuredSource: true })) return 'alive';
    return 'inconclusive';
  } catch { /* HTML or rendered markdown below. */ }

  if (title) {
    const wanted = words(title);
    const headings = document('h1,h2').toArray().map(element => words(document(element).text()));
    const readerTitle = body.match(/^Title:\s*(.+)$/m)?.[1] || '';
    if (!headings.some(heading => heading.includes(wanted)) && !words(readerTitle).includes(wanted)) return 'inconclusive';
    return isScorableJobDescription(visible) ? 'alive' : 'inconclusive';
  }
  // Retain support for standalone posting text in callers without an identity.
  return /\bresponsibilities (?:include|involve)\b/i.test(visible) || isScorableJobDescription(visible) ? 'alive' : 'inconclusive';
}

export function isWwrPostingLandingPage(requested: string, finalUrl: string, body: string): boolean {
  try {
    const source = new URL(requested);
    if (source.hostname !== 'weworkremotely.com' || !source.pathname.startsWith('/remote-jobs/')) return false;
    const final = new URL(finalUrl || requested);
    if (final.hostname === source.hostname && ['/', '/remote-jobs/search'].includes(final.pathname)
      && final.pathname !== source.pathname) return true;
    // The reader retains URL Source even after WWR redirects to its search.
    return /^Title: We Work Remotely: Advanced Remote Job Search\s*$/m.test(body)
      && /^URL Source: https:\/\/weworkremotely\.com\/remote-jobs\/[^\s]+\s*$/m.test(body);
  } catch { return false; }
}

export async function readRenderedPosting(url: string): Promise<Response> {
  const target = await buildSafeJinaReaderUrl(url);
  const headers: Record<string, string> = { 'X-Return-Format': 'markdown', 'X-No-Cache': 'true', 'X-Timeout': '25' };
  if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  if (/\.(?:myworkdayjobs|myworkdaysite)\.com$/.test(new URL(url).hostname)) {
    headers['X-Wait-For-Selector'] = ':is([data-automation-id="jobPostingDescription"],[data-automation-id="errorMessage"])';
  }
  return safeExternalFetch(target, { headers, signal: AbortSignal.timeout(35_000) });
}

/** Network uncertainty stays inconclusive, including failures from the reader. */
export async function verifyJobPosting(
  job: { url: string; title: string },
  authoritativeUrl: string | null,
  dependencies: { fetchPosting?: typeof safeExternalFetch; readPosting?: typeof readRenderedPosting } = {},
): Promise<PostingVerification> {
  const { fetchPosting = safeExternalFetch, readPosting = readRenderedPosting } = dependencies;
  const adp = isAdpPostingUrl(job.url);
  const adpDetailUrl = adp ? adpPostingDetailUrl(job.url) : null;
  const probes: PostingProbe[] = [];
  const probe = async (url: string, rendered = false): Promise<JobPostingLiveness> => {
    try {
      const response = rendered ? await readPosting(url) : await fetchPosting(url, {
        method: 'GET', headers: { Accept: 'application/json,text/html;q=0.9,*/*;q=0.8', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      // The reader's status warning is provenance, never posting text. A full
      // usable posting served with target-404 remains valid under the shared
      // reader policy; do not feed that warning into generic missing-page text.
      const markdown = body.split(/\nMarkdown Content:\s*\n/)[1];
      const pageBody = rendered && markdown !== undefined
        ? `Title: ${body.match(/^Title:\s*(.+)$/m)?.[1] || ''}\n\n${markdown}` : body;
      const reportedSource = rendered ? body.match(/^URL Source:\s*(\S+)/m)?.[1] : null;
      let outcome: JobPostingLiveness;
      let reason = rendered ? 'rendered_posting' : 'posting_response';
      // A reader HTTP failure belongs to the reader, not the target job.
      if (rendered && (response.status !== 200 || (reportedSource && reportedSource !== url))) outcome = 'inconclusive';
      else if (rendered && isClosedJobPosting(body)) { outcome = 'expired'; reason = 'rendered_closure'; }
      else if (response.status === 200 && isWwrPostingLandingPage(url, rendered ? '' : response.url, body)) {
        outcome = 'expired'; reason = 'wwr_posting_redirected_to_landing';
      } else if (adp && url === adpDetailUrl) {
        let posting = null;
        try { posting = parseAdpPosting(JSON.parse(body), job.url); } catch { /* Error objects are inconclusive. */ }
        outcome = response.url && response.url !== adpDetailUrl ? 'inconclusive'
          : response.status === 404 || response.status === 410 ? 'expired'
          : response.status === 200 && posting && words(posting.title) === words(job.title)
            && isScorableJobDescription(posting.text, { structuredSource: true }) ? 'alive' : 'inconclusive';
        reason = 'adp_requisition_data';
      } else if (adp) {
        // A redirect to a different opening or career center is not evidence
        // about the requested requisition's candidate-facing page.
        const finalIdentity = adpPostingIdentity(rendered ? url : response.url || url);
        const requestedIdentity = adpPostingIdentity(job.url)!;
        outcome = finalIdentity && finalIdentity.cid === requestedIdentity.cid
          && finalIdentity.ccId === requestedIdentity.ccId && finalIdentity.jobId === requestedIdentity.jobId
          ? classifyAdpCandidatePage(response.status, pageBody, job.title) : 'inconclusive';
        if (outcome === 'unavailable') reason = 'adp_application_page_unavailable';
      } else outcome = classifyJobPostingLiveness(response.status, pageBody, job.title);
      probes.push({ url, status: response.status, outcome, reason });
      return outcome;
    } catch {
      probes.push({ url, status: null, outcome: 'inconclusive', reason: rendered ? 'reader_failed' : 'request_failed' });
      return 'inconclusive';
    }
  };
  if (adpDetailUrl) {
    const data = await probe(adpDetailUrl);
    // A retained JD proves identity, not application availability. Even a
    // successful API response must be followed by the actual candidate page.
    if (data === 'expired') return { liveness: data, probes };
  } else if (authoritativeUrl) {
    const authoritative = await probe(authoritativeUrl);
    if (authoritative !== 'inconclusive') return { liveness: authoritative, probes };
  }
  const page = await probe(job.url);
  if (page !== 'inconclusive') return { liveness: page, probes };
  return { liveness: await probe(job.url, true), probes };
}
