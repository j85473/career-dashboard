import * as cheerio from 'cheerio';

import {
  boardIdentityFromUrl,
  selectDirectAtsMatch,
  type BoardIdentity,
  type BoardPosting,
} from './atsDirectMatch';
import { fetchEmployerBoardPostings } from './employerBoardPostings';
import { safeExternalFetch } from './safeExternalFetch';

const CAREER_LINK = /(?:career|jobs?|join[-_ ]?(?:us|our[-_ ]team)|opportunit|work[-_ ]?with)/i;
const MAX_EMPLOYER_PAGES = 8;

export type EmployerDiscoveryJob = {
  title: string;
  location?: string | null;
  description?: string | null;
  source?: string | null;
};

export type EmployerBoardDiscovery = {
  board: BoardIdentity;
  evidenceUrl: string;
  postings: BoardPosting[];
  matchCount: number;
};

export type EmployerPageLinks = {
  boards: Array<{ board: BoardIdentity; evidenceUrl: string }>;
  careerPages: string[];
};

function httpUrl(value: string, base: string): URL | null {
  try {
    const parsed = new URL(value, base);
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    parsed.hash = '';
    return parsed;
  } catch {
    return null;
  }
}

function sameEmployerHost(left: string, right: string): boolean {
  const a = left.toLowerCase().replace(/^www\./, '');
  const b = right.toLowerCase().replace(/^www\./, '');
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/** Pure HTML routing used by the network crawler and its deterministic tests. */
export function employerPageLinks(html: string, pageUrl: string): EmployerPageLinks {
  const $ = cheerio.load(html);
  const boards = new Map<string, { board: BoardIdentity; evidenceUrl: string }>();
  const careerPages = new Set<string>();
  const pageHost = httpUrl(pageUrl, pageUrl)?.hostname || '';
  const careerPage = CAREER_LINK.test(new URL(pageUrl).pathname);

  const consider = (raw: string, label = '', widget = false) => {
    const url = httpUrl(raw, pageUrl);
    if (!url) return;
    const board = boardIdentityFromUrl(url.toString());
    if (board) {
      if (careerPage || widget || CAREER_LINK.test(label)) {
        boards.set(`${board.platform}:${board.slug.toLowerCase()}`, { board, evidenceUrl: pageUrl });
      }
      return;
    }
    if (sameEmployerHost(url.hostname, pageHost) && CAREER_LINK.test(`${label} ${url.pathname}`)) {
      careerPages.add(url.toString());
    }
  };

  $('a[href]').each((_index, element) => consider($(element).attr('href') || '', $(element).text()));
  $('iframe[src], form[action]').each((_index, element) => {
    consider($(element).attr('src') || $(element).attr('action') || '', '', true);
  });

  // Some career widgets put their destination in JSON configuration rather
  // than a clickable element. Only supported ATS URLs survive this scan.
  for (const match of html.matchAll(/https?:\\?\/\\?\/[^\s"'<>]+/g)) {
    if (careerPage) consider(match[0].replaceAll('\\/', '/'));
  }

  return { boards: [...boards.values()], careerPages: [...careerPages] };
}

function fixedCareerPages(website: string): string[] {
  try {
    const root = new URL(website);
    return ['/careers', '/jobs', '/about/careers'].map((pathname) => new URL(pathname, root).toString());
  } catch {
    return [];
  }
}

async function readEmployerPage(
  url: string,
  fetcher: typeof safeExternalFetch,
  timeoutMs: number,
  parentSignal: AbortSignal,
): Promise<{ finalUrl: string; html: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetcher(url, {
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'User-Agent': 'CareerDashboardEmployerResolver/1.0',
      },
      signal: AbortSignal.any([controller.signal, parentSignal]),
    });
    if (!response.ok || !/html|text/i.test(response.headers.get('content-type') || '')) return null;
    return { finalUrl: response.url || url, html: await response.text() };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Follow an employer-owned careers path, identify public ATS destinations, and
 * require at least one unique live posting match before returning a board.
 */
export async function discoverEmployerBoards(input: {
  website: string;
  jobs: readonly EmployerDiscoveryJob[];
  fetcher?: typeof safeExternalFetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
}): Promise<EmployerBoardDiscovery[]> {
  const fetcher = input.fetcher || safeExternalFetch;
  const timeoutMs = input.timeoutMs ?? 12_000;
  const signal = AbortSignal.timeout(input.totalTimeoutMs ?? 60_000);
  let initial: URL;
  try {
    initial = new URL(input.website);
  } catch {
    return [];
  }
  if (!['http:', 'https:'].includes(initial.protocol)) return [];

  const allowedHosts = new Set([initial.hostname]);
  const queue = [initial.toString(), ...fixedCareerPages(initial.toString())];
  const visited = new Set<string>();
  const candidates = new Map<string, { board: BoardIdentity; evidenceUrl: string }>();

  while (queue.length > 0 && visited.size < MAX_EMPLOYER_PAGES) {
    if (signal.aborted) return [];
    const next = queue.shift()!;
    if (visited.has(next)) continue;
    visited.add(next);
    const directBoard = boardIdentityFromUrl(next);
    if (directBoard) {
      candidates.set(`${directBoard.platform}:${directBoard.slug.toLowerCase()}`, { board: directBoard, evidenceUrl: next });
      continue;
    }
    const parsed = httpUrl(next, initial.toString());
    if (!parsed || ![...allowedHosts].some((host) => sameEmployerHost(parsed.hostname, host))) continue;
    const page = await readEmployerPage(next, fetcher, timeoutMs, signal);
    if (!page) continue;
    const final = httpUrl(page.finalUrl, next);
    const redirectedBoard = boardIdentityFromUrl(page.finalUrl);
    if (redirectedBoard) {
      candidates.set(`${redirectedBoard.platform}:${redirectedBoard.slug.toLowerCase()}`, {
        board: redirectedBoard,
        evidenceUrl: next,
      });
      continue;
    }
    // A redirect to an unrelated marketing/recruiting site is not proof that
    // every ATS link embedded there belongs to this employer.
    if (!final || ![...allowedHosts].some((host) => sameEmployerHost(final.hostname, host))) continue;
    const links = employerPageLinks(page.html, page.finalUrl);
    for (const candidate of links.boards) {
      candidates.set(`${candidate.board.platform}:${candidate.board.slug.toLowerCase()}`, candidate);
    }
    for (const careerPage of links.careerPages) if (!visited.has(careerPage)) queue.push(careerPage);
  }

  const catalogues: EmployerBoardDiscovery[] = [];
  for (const candidate of candidates.values()) {
    if (signal.aborted) return [];
    const postings = await fetchEmployerBoardPostings(candidate.board, fetcher, timeoutMs, signal);
    // An unreadable or unsupported linked board may carry another matching
    // requisition. Defer the employer instead of guessing from partial proof.
    if (postings === null) return [];
    catalogues.push({ ...candidate, postings, matchCount: 0 });
  }
  const allPostings = catalogues.flatMap((catalogue) => catalogue.postings);
  for (const job of input.jobs) {
    const match = selectDirectAtsMatch(job, allPostings);
    if (!match) continue;
    const catalogue = catalogues.find((item) => item.postings.some((posting) => posting.url === match.url));
    if (catalogue) catalogue.matchCount += 1;
  }
  // Keep competing catalogues in the proof, including boards with zero unique
  // hits. Removing one could turn an ambiguous job into a false unique match.
  return catalogues.some((catalogue) => catalogue.matchCount > 0) ? catalogues : [];
}
