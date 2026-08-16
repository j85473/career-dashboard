import { prisma } from './prisma';
import { getAllResumes } from './resume';
import type { ResumeData } from './resume';
import { identifyAts } from './atsUtils';
import { passesPreFilter } from './jobFiltering';
import { buildSafeJinaReaderUrl, safeExternalFetch } from './safeExternalFetch';
import { getRapidApiKeys, fetchWithKeyRotation } from './apiFallback';
import type { Job, UserPreference } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { search, SafeSearchType } from 'duck-duck-scrape';
import {
  assessJobDescriptionQuality,
  isScorableJobDescription,
} from './jobDescriptionQuality';
import {
  cleanHtmlText,
  fetchGlassdoorJobDescription,
  GLASSDOOR_SOURCE,
} from './jobIngestion';
import { urlMatchesAnyHost } from './urlHost';
import { invalidateActiveJobScores } from './scoreInvalidation';
import { buildTerminalJdRecoveryUpdate } from './jdRecoveryPolicy';

export {
  assessJobDescriptionQuality,
  isScorableJobDescription,
  looksLikeInvalidJobDescription,
} from './jobDescriptionQuality';

export const MIN_JD_LENGTH = 500;
export const MIN_ACCEPTABLE_JD = 400;

type ResolvedDescription = {
  text: string;
  needsReview: boolean;
  canonicalUrl?: string;
  manualAts?: string;
  discoveredTitle?: string;
  discoveredCompany?: string;
};

async function resolveFullDescription(job: Job): Promise<ResolvedDescription> {
  const description = job.description || '';
  const isEllipsis = description.endsWith('...') || description.endsWith('…');
  const isTruncated = isEllipsis || description.length <= MIN_JD_LENGTH || description === 'No description provided.';
  const descriptionQuality = assessJobDescriptionQuality(description);
  
  if (!isTruncated && descriptionQuality.scorable) {
    return { text: description, needsReview: false };
  }

  const rapidApiKeys = getRapidApiKeys();

  let resolvedCanonicalUrl = job.canonicalUrl || undefined;
  let discoveredCanonicalUrl: string | undefined;
  let discoveredAts: string | undefined;

  const result = (text: string, needsReview: boolean, extra?: { title?: string, company?: string }): ResolvedDescription => ({
    text,
    needsReview,
    ...(discoveredCanonicalUrl ? { canonicalUrl: discoveredCanonicalUrl } : {}),
    ...(discoveredAts ? { manualAts: discoveredAts } : {}),
    ...(extra?.title ? { discoveredTitle: extra.title } : {}),
    ...(extra?.company ? { discoveredCompany: extra.company } : {}),
  });

  // Glassdoor's listing page is an anti-bot tracking page, while its paired
  // RapidAPI details endpoint contains the full JD. Never send Glassdoor rows
  // through the canonical-page or Jina fallbacks.
  if (job.source === GLASSDOOR_SOURCE) {
    const glassdoorDescription = await fetchGlassdoorJobDescription(job);
    return glassdoorDescription && isScorableJobDescription(glassdoorDescription)
      ? result(glassdoorDescription, false)
      : result(description, true);
  }

  // Fallback 1: JSearch (RapidAPI)
  if (rapidApiKeys.length > 0) {
    try {
      const jsearchParams = new URLSearchParams({
        query: `${job.company} ${job.title}`,
        page: "1",
        num_pages: "1"
      });
      const jsearchRes = await fetchWithKeyRotation(rapidApiKeys, async (key) => fetch(`https://jsearch.p.rapidapi.com/search-v2?${jsearchParams.toString()}`, {
        headers: {
          'X-RapidAPI-Key': key,
          'X-RapidAPI-Host': 'jsearch.p.rapidapi.com'
        },
        signal: AbortSignal.timeout(10000)
      }));
      if (jsearchRes && jsearchRes.ok) {
        const data = await jsearchRes.json();
        const found = data.data?.[0];
        if (found && found.employer_name?.toLowerCase().includes(job.company.toLowerCase().substring(0, 5))) {
          if (
            found.job_description
            && found.job_description.length > description.length + 100
            && isScorableJobDescription(found.job_description)
          ) {
            return result(found.job_description, false, { title: found.job_title, company: found.employer_name });
          }
        }
      }
    } catch {}
  }

  // Fallback 2: Canonical Webpage Scraping via DuckDuckGo
  try {
    let canonicalUrl = resolvedCanonicalUrl;
    if (!canonicalUrl || urlMatchesAnyHost(canonicalUrl, [
      'adzuna.com',
      'indeed.com',
      'jsearch.p.rapidapi.com',
      'linkedin.com',
    ])) {
      try {
        const ddgQuery = `${job.company} ${job.title} careers`;
        const ddgRes = await search(ddgQuery, { safeSearch: SafeSearchType.STRICT });
        const results = ddgRes.results || [];
        for (const res of results) {
          const url = res.url;
          if (url && !urlMatchesAnyHost(url, ['adzuna.com', 'indeed.com', 'salary.com'])) {
            canonicalUrl = url;
            resolvedCanonicalUrl = canonicalUrl;
            discoveredCanonicalUrl = canonicalUrl;
            break;
          }
        }
      } catch (e) {
        console.error("DuckDuckGo search fallback failed:", e);
      }
    }

    if (canonicalUrl) {
      // First try the specialized ATS API scraper
      const { scrapeAtsApi } = await import('./atsApi');
      const atsResult = await scrapeAtsApi(canonicalUrl);
      if (atsResult && isScorableJobDescription(atsResult.text)) {
        // If we successfully identified the ATS and scraped it, update the job record
        if (atsResult.ats !== 'Unknown') {
          discoveredAts = atsResult.ats;
        }
        return result(atsResult.text, false, { title: atsResult.title, company: atsResult.atsSlug });
      }

      // Fallback to naive fetch
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);
      let bodyText = '';
      try {
        const pageRes = await safeExternalFetch(canonicalUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (pageRes.ok) {
          bodyText = cleanHtmlText(await pageRes.text());
          if (isScorableJobDescription(bodyText)) {
            return result(`Original Truncated Snippet:\n${description}\n\nCanonical Webpage Scraped Text:\n${bodyText.substring(0, 15000)}`, false);
          }
        }
      } catch {
        clearTimeout(timeoutId);
      }

      // Jina Fallback moved below
    }
  } catch {}

  // Fallback 3: Jina AI Scraper (works with or without SerpAPI and JINA_KEY)
  const targetUrl = resolvedCanonicalUrl || job.url;
  if (targetUrl) {
    const JINA_KEY = process.env.JINA_API_KEY;
    try {
      const jinaUrl = await buildSafeJinaReaderUrl(targetUrl);
      const headers: Record<string, string> = { 'X-Return-Format': 'markdown' };
      if (JINA_KEY) headers['Authorization'] = `Bearer ${JINA_KEY}`;
      
      const jinaRes = await fetch(jinaUrl, {
        headers,
        signal: AbortSignal.timeout(15000)
      });
      if (jinaRes.ok) {
        const markdown = await jinaRes.text();
        if (markdown && isScorableJobDescription(markdown)) {
          return result(markdown.substring(0, 20000), false);
        }
      }
    } catch {
      // Ignore jina errors
    }
  }

  // Fallback 4: Human-in-the-loop
  if (!isEllipsis && isScorableJobDescription(description)) {
    return result(description, false);
  }
  
  return result(description, true);
}


const STOP_WORDS = new Set([
  'about', 'after', 'also', 'been', 'being', 'company', 'from', 'have', 'into',
  'more', 'other', 'role', 'that', 'their', 'there', 'these', 'they', 'this',
  'through', 'using', 'what', 'when', 'where', 'which', 'with', 'will', 'work',
  'years', 'your',
]);

function tokenize(value: string): Set<string> {
  return new Set(
    (value.toLowerCase().match(/\b[a-z][a-z0-9+#.-]{2,}\b/g) || [])
      .map((word) => word.replace(/[.+#-]+$/g, ''))
      .filter((word) => word.length >= 3 && !STOP_WORDS.has(word)),
  );
}

type WeightedSignal = {
  label: string;
  pattern: RegExp;
  weight: number;
  maxOccurrences?: number;
};

type SignalSummary = {
  points: number;
  labels: string[];
  distinct: number;
  occurrences: number;
};

const TARGET_TITLE_SIGNALS: WeightedSignal[] = [
  // Channel account management is a supported target function, not a claim
  // that the candidate held that formal title. `bestTitleSignal` takes only the
  // strongest family, so overlapping normalized variants never stack.
  { label: 'channel account management', pattern: /\bchannel accounts?\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+channel accounts?\b/i, weight: 16 },
  { label: 'strategic/enterprise account leadership', pattern: /\b(?:strategic|enterprise|key|national|global)\s+accounts?\s+(?:manager|director)\b/i, weight: 16 },
  { label: 'account management leadership', pattern: /\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:strategic\s+)?account management\b|\b(?:strategic\s+)?account management\s+(?:manager|director|lead)\b/i, weight: 16 },
  { label: 'account director', pattern: /\baccount director\b/i, weight: 14 },
  { label: 'channel/partner sales', pattern: /\b(?:channel sales|channel accounts?|partner accounts?|partner sales)\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:channel sales|channel accounts?|partner accounts?|partner sales)\b/i, weight: 15 },
  { label: 'channel/partner leadership', pattern: /^(?=.*\b(?:manager|director|head|lead)\b)(?=.*\bchannel\b)(?=.*\b(?:partner|sales|account|business)\b).*$/i, weight: 15 },
  { label: 'channel/distributor management', pattern: /\b(?:channel|distributor|distribution partner|reseller|dealer)(?:\s+business)?\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:channels?|distributors?|distribution partners?|resellers?|dealers?)\b/i, weight: 15 },
  { label: 'partner/channel enablement', pattern: /\b(?:partner|channel|distributor|territory|field sales)\s+enablement\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:partner|channel|distributor|territory|field sales)\s+enablement\b|\bsales enablement\s+(?:manager|director|lead)\b.{0,50}\b(?:field|channel|partner|distributor|commercial)\b/i, weight: 14 },
  { label: 'partnerships/alliances', pattern: /\b(?:partnerships?|alliances?|ecosystem)\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:partnerships?|alliances?|ecosystem)\b/i, weight: 14 },
  { label: 'partner management', pattern: /\bpartner (?:manager|director|lead)\b/i, weight: 13 },
  { label: 'partner business management', pattern: /\bpartner business (?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+partner business\b/i, weight: 13 },
  { label: 'partner solutions leadership', pattern: /\b(?:manager|director|head|lead)\b.{0,40}\bpartner solutions?\b|\bpartner solutions?\b.{0,40}\b(?:manager|director|head|lead)\b/i, weight: 12 },
  { label: 'partner development', pattern: /\b(?:partner|channel) development (?:manager|director|lead)\b/i, weight: 13 },
  { label: 'enterprise customer success', pattern: /\benterprise customer success (?:manager|director)\b/i, weight: 15 },
  { label: 'customer success', pattern: /\b(?:customer|client) success (?:manager|director|lead|advisor|consultant|executive|engineer)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:customer|client) success\b/i, weight: 10 },
  { label: 'account management', pattern: /\baccounts? manager\b/i, weight: 10 },
  { label: 'customer sales management', pattern: /\bcustomer sales manager\b/i, weight: 12 },
  { label: 'customer/account portfolio management', pattern: /\b(?:senior\s+)?customer manager\b|\b(?:regional|national|key|strategic) customer manager\b/i, weight: 11 },
  { label: 'distribution sales', pattern: /\bdistribution sales (?:manager|director|lead)\b/i, weight: 13 },
  { label: 'commercial/market growth', pattern: /\b(?:commercial growth|market development|territory development|market expansion)\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:commercial growth|market development|territory development|market expansion)\b/i, weight: 13 },
  { label: 'field business leadership', pattern: /\b(?:area|regional|territory|market)\s+business\s+(?:manager|director|lead)\b|\bcustomer business manager\b/i, weight: 11 },
  { label: 'commercial execution leadership', pattern: /\b(?:market|sales|commercial|retail)\s+execution\s+(?:manager|director|lead)\b/i, weight: 11 },
  { label: 'GTM/route-to-market leadership', pattern: /\b(?:go[\s-]?to[\s-]?market|gtm|route[\s-]?to[\s-]?market)\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:go[\s-]?to[\s-]?market|gtm|route[\s-]?to[\s-]?market)\b/i, weight: 12 },
  { label: 'commercial field operations', pattern: /\b(?:commercial|field sales|go[\s-]?to[\s-]?market|gtm|channel|partner)\s+(?:sales\s+)?operations\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:commercial|field sales|go[\s-]?to[\s-]?market|gtm|channel|partner)\s+(?:sales\s+)?operations\b|\b(?:revenue|sales) operations\s+(?:manager|director|lead)\b.{0,50}\b(?:field|channel|partner|distributor|commercial)\b/i, weight: 10 },
  { label: 'sales effectiveness/excellence', pattern: /\b(?:sales|commercial)\s+(?:effectiveness|excellence)\s+(?:manager|director|lead)\b|\b(?:manager|director|head|lead)(?:\s+of)?\s+(?:sales|commercial)\s+(?:effectiveness|excellence)\b/i, weight: 10 },
  { label: 'omnichannel commercial leadership', pattern: /\bomnichannel\s+(?:sales|account|territory|commercial)\s+(?:manager|director|lead)\b/i, weight: 11 },
  { label: 'client success', pattern: /\b(?:customer|client) success (?:specialist|partner)\b/i, weight: 9 },
  { label: 'client/relationship management', pattern: /\b(?:client|customer) partner\b|\brelationship manager\b|\bclient (?:executive|director)\b/i, weight: 10 },
  { label: 'regional/territory sales', pattern: /\b(?:regional|territory|area|national|enterprise|strategic)\s+sales\s+(?:manager|director|representative|rep)\b/i, weight: 10 },
  { label: 'regional/district/territory management', pattern: /\b(?:regional|district|territory)\s+manager\b/i, weight: 10 },
  { label: 'technical/field sales', pattern: /\b(?:technical sales|field sales|outside sales)(?:\s+(?:manager|representative|rep))?\b/i, weight: 9 },
  { label: 'sales/solutions engineering', pattern: /\b(?:sales|solutions?|value) engineer\b/i, weight: 9 },
  { label: 'consultative/pre-sales', pattern: /\b(?:solutions?|sales) consultant\b|\bpre[\s-]?sales (?:consultant|lead|manager|specialist)\b/i, weight: 8 },
  { label: 'sales director', pattern: /\b(?:sales director|director(?:\s+of)?\s+sales)\b/i, weight: 8 },
  { label: 'sales management', pattern: /\bsales manager\b/i, weight: 6 },
  { label: 'business development management', pattern: /\bbusiness development (?:manager|director|lead|head|executive)\b/i, weight: 10 },
  { label: 'account executive', pattern: /\baccount executive\b/i, weight: 3 },
];

const FARMING_SIGNALS: WeightedSignal[] = [
  { label: 'book of business', pattern: /\bbook of business\b/i, weight: 10, maxOccurrences: 2 },
  { label: 'existing accounts', pattern: /\b(?:existing|current|named)\s+(?:enterprise\s+)?(?:accounts?|customers?|clients?)\b/i, weight: 9, maxOccurrences: 2 },
  { label: 'upsell', pattern: /\bup[\s-]?sell(?:ing|s| opportunities)?\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'cross-sell', pattern: /\bcross[\s-]?sell(?:ing|s| opportunities)?\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'retention', pattern: /\b(?:customer|client|account)?\s*retention\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'renewals', pattern: /\brenewals?\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'channel partners', pattern: /\b(?:channel|strategic|distribution|technology)\s+partners?\b/i, weight: 9, maxOccurrences: 2 },
  { label: 'strategic accounts', pattern: /\bstrategic accounts?\b/i, weight: 9, maxOccurrences: 2 },
  { label: 'key accounts', pattern: /\bkey accounts?\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'relationship management', pattern: /\b(?:client|customer|account|partner)?\s*relationship management\b/i, weight: 7, maxOccurrences: 2 },
  { label: 'field sales', pattern: /\bfield sales\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'territory management', pattern: /\bterritory management\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'account growth', pattern: /\b(?:grow|expand|develop)(?:ing)?\s+(?:a\s+)?(?:portfolio|book|existing|assigned|strategic|key)?\s*(?:of\s+)?accounts?\b/i, weight: 7, maxOccurrences: 2 },
  { label: 'account expansion', pattern: /\b(?:account|customer|client) expansion\b|\bexpand(?:ing)? (?:within|across) (?:assigned|existing|strategic|key)?\s*accounts?\b/i, weight: 7, maxOccurrences: 2 },
  { label: 'installed base', pattern: /\binstalled base\b|\bassigned (?:book|portfolio|accounts?|customers?|clients?)\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'business reviews', pattern: /\b(?:quarterly|executive|strategic) business reviews?\b|\bqbrs?\b/i, weight: 5, maxOccurrences: 2 },
  { label: 'customer adoption/health', pattern: /\b(?:customer|client) (?:adoption|health|lifecycle)\b/i, weight: 5, maxOccurrences: 2 },
  { label: 'trusted advisor', pattern: /\btrusted advisor\b/i, weight: 5, maxOccurrences: 2 },
  { label: 'travel', pattern: /\btravel(?:ing)?\b/i, weight: 2, maxOccurrences: 1 },
];

const COMMERCIAL_GROWTH_SIGNALS: WeightedSignal[] = [
  { label: 'multi-state territory', pattern: /\bmulti[\s-]?state\s+(?:sales\s+)?territor(?:y|ies)\b|\bterritor(?:y|ies)\s+across\s+(?:multiple|several|\d+)\s+states?\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'distributor/dealer network', pattern: /\b(?:distributor|dealer|reseller)\s+(?:network|partners?|relationships?|management|execution)\b|\bmanage(?:d|s|ment|ing)?\s+(?:a\s+)?(?:network\s+of\s+)?(?:distributors?|dealers?|resellers?)\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'GTM/route-to-market execution', pattern: /\b(?:go[\s-]?to[\s-]?market|gtm|route[\s-]?to[\s-]?market)\s+(?:strategy|execution|planning|motion|programs?)\b/i, weight: 7, maxOccurrences: 2 },
  { label: 'partner accountability/enablement', pattern: /\bpartner\s+(?:accountability|enablement|performance|readiness)\b|\b(?:enable|coach|train|mobilize)(?:d|s|ing)?\s+(?:channel\s+|distribution\s+)?partner\s+teams?\b/i, weight: 7, maxOccurrences: 2 },
  { label: 'joint business planning/operating reviews', pattern: /\bjoint business planning\b|\b(?:weekly|monthly|quarterly|executive)\s+(?:business|operating|performance)\s+reviews?\b|\boperating cadence\b/i, weight: 7, maxOccurrences: 2 },
  { label: 'performance analytics/reporting', pattern: /\bperformance\s+(?:analytics|reporting|tracking|management)\b|\bdata[\s-]?driven\s+(?:workflow|reporting|decision)\b/i, weight: 5, maxOccurrences: 2 },
  { label: 'sell-in/co-selling', pattern: /\b(?:sell[\s-]?in|co[\s-]?selling|ride[\s-]?alongs?)\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'market growth/expansion', pattern: /\b(?:market|territory|regional)\s+(?:growth|expansion|development)\b|\byear[\s-]?over[\s-]?year\s+growth\b|\byoy\s+growth\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'product launch/field adoption', pattern: /\bproduct launches?\b|\bfield adoption\b|\bpilot (?:launch|rollout|leadership)\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'revenue/margin protection', pattern: /\b(?:revenue|margin|commission)\s+(?:protection|preservation|risk|growth)\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'commercial pipeline', pattern: /\bcommercial pipeline\b|\bb2b\s+(?:pipeline|sales program)\b/i, weight: 5, maxOccurrences: 2 },
  { label: 'field execution', pattern: /\b(?:field|market|territory)\s+execution\b|\bin[\s-]?market execution\b/i, weight: 5, maxOccurrences: 2 },
  // Channel vocabulary: phrases that only appear in postings written by people
  // who actually run a channel.
  { label: 'sell-through', pattern: /\bsell[\s-]?through\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'two-tier distribution', pattern: /\btwo[\s-]?tier\s+distribution\b|\bindirect channel\b|\bmaster agent\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'market development funds', pattern: /\bmdf\b|\bmarket development funds?\b|\bco[\s-]?op funds?\b/i, weight: 7, maxOccurrences: 2 },
  { label: 'partner program', pattern: /\b(?:channel|partner|reseller)\s+programs?\b|\bpartner tiers?\b/i, weight: 6, maxOccurrences: 2 },
  { label: 'deal registration', pattern: /\bdeal registration\b/i, weight: 8, maxOccurrences: 2 },
  { label: 'authorized reseller', pattern: /\bauthorized\s+(?:reseller|dealer|retailer|partner)s?\b|\bvalue[\s-]?added reseller\b|\bvars?\b/i, weight: 7, maxOccurrences: 2 },
];

const HUNTING_SIGNALS: WeightedSignal[] = [
  { label: 'cold calling', pattern: /\bcold calls?(?:ing)?\b/i, weight: 16, maxOccurrences: 2 },
  { label: 'cold outreach', pattern: /\bcold (?:outreach|emailing|email|prospecting)\b/i, weight: 16, maxOccurrences: 2 },
  { label: 'outbound', pattern: /\boutbound\b/i, weight: 8, maxOccurrences: 3 },
  { label: 'net-new/new-logo acquisition', pattern: /\b(?:net[\s-]?new|new logos?|logo acquisition|new business acquisition|new accounts? acquisition|new customers? acquisition)\b/i, weight: 13, maxOccurrences: 2 },
  { label: 'new business', pattern: /\b(?:win|winning|close|closing|acquire|acquiring|generate|generating|develop|developing|drive|driving)\s+(?:net[\s-]?new\s+)?(?:business|customers?|clients?|accounts?|logos?)\b|\bnew business development\b/i, weight: 13, maxOccurrences: 2 },
  { label: 'hunter', pattern: /\b(?:hunter|hunting)\b/i, weight: 16, maxOccurrences: 2 },
  { label: 'pipeline generation', pattern: /\b(?:pipeline generation|generate (?:a |new )?pipeline|build (?:a |new )?pipeline|create (?:a |new )?pipeline|self[\s-]?source(?:d)? pipeline|source pipeline)\b/i, weight: 11, maxOccurrences: 2 },
  { label: 'prospecting', pattern: /\bprospects?|prospecting\b/i, weight: 8, maxOccurrences: 3 },
  { label: 'lead generation', pattern: /\b(?:lead generation|generate leads?|demand generation|appointment setting)\b/i, weight: 10, maxOccurrences: 2 },
  { label: 'BDR/SDR', pattern: /\b(?:bdr|sdr)s?\b/i, weight: 20, maxOccurrences: 2 },
  { label: 'sales/business development representative', pattern: /\b(?:sales|business) development representatives?\b/i, weight: 25, maxOccurrences: 2 },
];

const OPERATIONS_SIGNALS: WeightedSignal[] = [
  { label: 'RevOps', pattern: /\b(?:revops|revenue operations)\b/i, weight: 16, maxOccurrences: 2 },
  { label: 'SalesOps', pattern: /\b(?:salesops|sales operations)\b/i, weight: 16, maxOccurrences: 2 },
  { label: 'deal desk', pattern: /\bdeal desk\b/i, weight: 18, maxOccurrences: 2 },
  { label: 'enablement administration', pattern: /\b(?:enablement operations|enablement administration|lms administration|content governance)\b/i, weight: 14, maxOccurrences: 2 },
  { label: 'CRM/forecast administration', pattern: /\b(?:crm administration|salesforce administrator|forecast administration|quote[\s-]?to[\s-]?cash)\b/i, weight: 16, maxOccurrences: 2 },
  { label: 'Tier 1 support', pattern: /\btier[\s-]*(?:1|one)\s+support\b/i, weight: 20, maxOccurrences: 2 },
];

function countMatches(value: string, pattern: RegExp): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  return value.match(new RegExp(pattern.source, flags))?.length || 0;
}

function summarizeSignals(value: string, signals: WeightedSignal[]): SignalSummary {
  let points = 0;
  let occurrences = 0;
  const labels: string[] = [];

  for (const signal of signals) {
    const count = countMatches(value, signal.pattern);
    if (count === 0) continue;

    const weightedCount = Math.min(count, signal.maxOccurrences ?? 1);
    points += signal.weight * weightedCount;
    occurrences += count;
    labels.push(signal.label);
  }

  return { points, labels, distinct: labels.length, occurrences };
}

export function normalizeRoleTitle(title: string): string {
  return title
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‐‑‒–—―]/g, '-')
    .replace(/\bpbm\b/g, 'partner business manager')
    .replace(/\bmgr\b/g, 'manager')
    .replace(/\bmanger\b/g, 'manager')
    .replace(/\bcsm\b/g, 'customer success manager')
    .replace(/[^a-z0-9+#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bestTitleSignal(title: string): { points: number; label: string | null } {
  const normalizedTitle = normalizeRoleTitle(title);
  let best = { points: 0, label: null as string | null };
  for (const signal of TARGET_TITLE_SIGNALS) {
    if (signal.pattern.test(normalizedTitle) && signal.weight > best.points) {
      best = { points: signal.weight, label: signal.label };
    }
  }
  return best;
}

type LocalScoringJob = Pick<Job, 'title' | 'company' | 'url' | 'source' | 'manualAts'> & { fullDescription: string };

export function runLocalHeuristic(job: LocalScoringJob, resumes: ResumeData[], preferences: UserPreference[]) {
  const titleLower = job.title.toLowerCase();
  const descLower = job.fullDescription.toLowerCase();
  const combinedText = `${titleLower} ${descLower}`;

  const getPrefs = (type: string) => preferences.filter(p => p.type === type).map(p => p.text.toLowerCase());
  const boosts = getPrefs('boost');
  const softNegatives = getPrefs('soft_negative');

  const jdWords = tokenize(combinedText);
  let bestCoverage = 0;
  let bestResume = resumes[0]?.name || 'Channel Sales';

  if (resumes.length > 0) {
    for (const resume of resumes) {
      const resumeWords = tokenize(resume.text || '');
      let overlap = 0;
      for (const word of jdWords) {
        if (resumeWords.has(word)) overlap++;
      }
      const coverage = overlap / Math.max(1, Math.min(jdWords.size, 200));
      if (coverage > bestCoverage) {
        bestCoverage = coverage;
        bestResume = resume.name;
      }
    }
  }

  // Resume overlap is intentionally capped: adjacent vocabulary alone cannot
  // send a non-target role through the expensive AI evaluation stage.
  const resumePoints = Math.round(Math.min(24, bestCoverage * 100));
  const titleSignal = bestTitleSignal(titleLower);
  const farming = summarizeSignals(combinedText, FARMING_SIGNALS);
  const commercialGrowth = summarizeSignals(combinedText, COMMERCIAL_GROWTH_SIGNALS);
  const hunting = summarizeSignals(combinedText, HUNTING_SIGNALS);
  const operations = summarizeSignals(combinedText, OPERATIONS_SIGNALS);
  const farmingPoints = Math.min(38, farming.points);
  const commercialGrowthPoints = Math.min(24, commercialGrowth.points);
  const huntingPenalty = Math.min(70, hunting.points);
  const operationsPenalty = Math.min(45, operations.points);

  let bestScore = 30
    + resumePoints
    + titleSignal.points
    + farmingPoints
    + commercialGrowthPoints
    - huntingPenalty
    - operationsPenalty;

  // Apply Boosts
  let preferenceAdjustment = 0;
  for (const boost of boosts) {
    if (combinedText.includes(boost)) {
      bestScore += 5;
      preferenceAdjustment += 5;
    }
  }

  // Apply Soft Negatives
  for (const neg of softNegatives) {
    if (combinedText.includes(neg)) {
      bestScore -= 5;
      preferenceAdjustment -= 5;
    }
  }

  // ATS Identification
  const ats = identifyAts({
    url: job.url || undefined,
    source: job.source || undefined,
    manualAts: job.manualAts,
  });

  // ATS identity is informational only. The application platform must never
  // change a job's persona fit score.
  // Saturation caps are applied after all additive scoring so incidental
  // farming language cannot rescue a hunter/ops role.
  const hunterSaturated = hunting.points >= 28 || hunting.distinct >= 3 || hunting.occurrences >= 5;
  const balancedAccountMotion = farming.points >= 16;
  const primaryHunterMotion = /\bprospects?\b.{0,120}\b(?:5x|five times|pipeline)\b/i.test(combinedText)
    || /\bprimary (?:responsibility|focus|objective|measure|motion|duty)\b.{0,100}\b(?:prospect|new business|new logo|cold|outbound)\b/i.test(combinedText)
    || /\bresponsible for\b.{0,80}\b(?:generating|driving|winning)\s+(?:net[- ]?new\s+)?business\b/i.test(combinedText)
    || /\b(?:100%|entirely|exclusively|solely)\s+(?:focused\s+on\s+)?(?:net[- ]?new|new logo|outbound|prospecting|hunting)\b/i.test(combinedText);
  const explicitHunterMotion = /\b(?:hunter|hunting)\s+(?:role|motion|position)\b/i.test(combinedText)
    || /\bdaily\s+(?:cold calls?|cold outreach|outbound prospecting)\b/i.test(combinedText);
  const clearlyPrimaryHunter = primaryHunterMotion
    || (hunterSaturated
      && !balancedAccountMotion
      && (explicitHunterMotion || hunting.points >= 45 || hunting.distinct >= 4));
  const operationsSaturated = operations.points >= 30 || operations.distinct >= 2;
  const isAccountExecutive = /\baccount executive\b/i.test(titleLower);
  let scoreCap = 100;
  let capRationale = '';

  if (clearlyPrimaryHunter) {
    scoreCap = 55;
    capRationale = 'Primary hunter/cold-outbound motion capped the score below triage.';
  }
  if (clearlyPrimaryHunter && isAccountExecutive) {
    scoreCap = 49;
    capRationale = 'Hunter-heavy Account Executive role capped below triage.';
  }
  if (operationsSaturated && scoreCap > 55) {
    scoreCap = 55;
    capRationale = 'Operations/admin saturation capped the score below triage.';
  }
  if (titleSignal.points === 0 && scoreCap > 55) {
    scoreCap = 55;
    capRationale = 'No target sales, account management, partnerships, or customer success title signal; score capped below triage.';
  }

  const finalScore = Math.max(0, Math.min(scoreCap, Math.min(100, Math.round(bestScore))));

  let category = 'low-confidence';
  if (finalScore >= 80) category = 'no-tailoring';
  else if (finalScore >= 60) category = 'minor';

  const signed = (value: number) => value >= 0 ? `+${value}` : `${value}`;
  const components = [
    'base 30',
    `resume ${signed(resumePoints)}`,
    `title ${signed(titleSignal.points)}`,
    `farming ${signed(farmingPoints)}`,
    `commercial growth ${signed(commercialGrowthPoints)}`,
    `hunting -${huntingPenalty}`,
    `operations -${operationsPenalty}`,
  ];
  if (preferenceAdjustment !== 0) components.push(`preferences ${signed(preferenceAdjustment)}`);

  const signalDetails: string[] = [];
  if (titleSignal.label) signalDetails.push(`target title: ${titleSignal.label}`);
  if (farming.labels.length > 0) signalDetails.push(`farming: ${farming.labels.join(', ')}`);
  if (commercialGrowth.labels.length > 0) signalDetails.push(`commercial growth: ${commercialGrowth.labels.join(', ')}`);
  if (hunting.labels.length > 0) signalDetails.push(`hunter: ${hunting.labels.join(', ')}`);
  if (operations.labels.length > 0) signalDetails.push(`operations: ${operations.labels.join(', ')}`);

  let rationale = `Local Scoring Engine (ATS: ${ats}). Weighted fit (${components.join(', ')}).`;
  if (signalDetails.length > 0) rationale += ` Signals: ${signalDetails.join('; ')}.`;
  if (capRationale) rationale += ` ${capRationale}`;
  if (ats === 'SuccessFactors') {
    rationale += ` Note: SAP SuccessFactors has a notoriously strict parser. Use a simple, single-column document without complex layouts or tables to avoid silent errors during extraction.`;
  }

  // This score is discovery metadata only. Aim owns preference hard stops and
  // Experience owns qualification; the heuristic cannot gate either stage.
  const gatePass = true;
  const gateReason = 'discovery metadata only; routed to manual Aim review';

  return { score: finalScore, category, recommendedResume: bestResume, rationale, gatePass, gateReason };
}

/** Recompute only the local heuristic fields for one existing job. */
export async function recomputeLocalScore(jobId: string): Promise<Job | null> {
  const [job, resumes, preferences] = await Promise.all([
    prisma.job.findUnique({ where: { id: jobId } }),
    getAllResumes(),
    prisma.userPreference.findMany(),
  ]);
  if (!job || resumes.length === 0) return job;

  const { score, category, recommendedResume, rationale } = runLocalHeuristic({
    title: job.title,
    company: job.company,
    url: job.url,
    source: job.source,
    manualAts: job.manualAts,
    fullDescription: job.description || '',
  }, resumes, preferences);

  const updated = await prisma.job.updateMany({
    where: { id: job.id },
    data: {
      fitScore: score,
      fitCategory: category,
      fitRationale: rationale,
      recommendedResume,
    },
  });
  if (updated.count === 0) return prisma.job.findUnique({ where: { id: job.id } });
  return prisma.job.findUnique({ where: { id: job.id } });
}

export type ScoreJobsOptions = {
  jobIds?: string[];
  limit?: number;
};

const ACTIVE_SCORING_STATUSES = ['pending_af', 'inbox'];

function claimedJobSnapshot(job: Job, leaseId: string) {
  return {
    id: job.id,
    batchJobId: leaseId,
    scoringStatus: 'scoring',
    status: { in: ACTIVE_SCORING_STATUSES },
    
  };
}

async function releaseLocalScoringLease(jobId: string, leaseId: string) {
  await prisma.$transaction([
    prisma.job.updateMany({
      where: {
        id: jobId,
        batchJobId: leaseId,
        scoringStatus: 'scoring',
        status: { in: ACTIVE_SCORING_STATUSES },
      },
      data: { scoringStatus: 'queued', batchJobId: null },
    }),
    prisma.job.updateMany({
      where: {
        id: jobId,
        batchJobId: leaseId,
        scoringStatus: 'scoring',
        status: { notIn: ACTIVE_SCORING_STATUSES },
      },
      data: { scoringStatus: 'scored', batchJobId: null },
    }),
  ]);
}

export async function scoreJobs(
  onProgress?: (msg: string, job?: Job) => void,
  signal?: AbortSignal,
  options: ScoreJobsOptions = {},
) {
  const requestedIds = options.jobIds ? [...new Set(options.jobIds.filter(Boolean))] : undefined;
  if (requestedIds && requestedIds.length === 0) return 0;
  const limit = Math.max(1, Math.min(options.limit || 200, 200));

  // A queued job holding a lease is unreachable: selection ignores batchJobId,
  // the claim below requires it to be null, and releaseLocalScoringLease only
  // looks at 'scoring' rows. Such a job is picked up and skipped on every pass
  // forever. The claim sets status and lease together, so this pairing never
  // occurs mid-flight — only when a requeue resets the status and leaves the
  // lease behind.
  await prisma.job.updateMany({
    where: {
      scoringStatus: 'queued',
      batchJobId: { not: null },
      status: { in: ACTIVE_SCORING_STATUSES },
    },
    data: { batchJobId: null },
  });

  const queuedJobs = await prisma.job.findMany({
    where: {
      ...(requestedIds ? { id: { in: requestedIds } } : {}),
      scoringStatus: 'queued',
      jdBatchId: null,
      status: { in: ACTIVE_SCORING_STATUSES }
    },
    take: limit,
    orderBy: { createdAt: 'asc' }
  });

  if (queuedJobs.length === 0) {
    if (onProgress) onProgress("No new jobs to score.");
    return 0;
  }

  let resumes: ResumeData[] = [];
  try {
    resumes = await getAllResumes();
    if (resumes.length === 0) {
      console.warn("No resumes found! Aborting scoring to prevent pipeline failure.");
      if (onProgress) onProgress("No resumes found. Aborting scoring.");
      return 0;
    }
  } catch (e) {
    console.error(e);
    if (onProgress) onProgress("Failed to read resumes.");
    return 0;
  }

  const preferences = await prisma.userPreference.findMany();
  let scoredCount = 0;
  
  for (const job of queuedJobs) {
    if (signal?.aborted) break;
    const leaseId = `local:${randomUUID()}`;

    const claimed = await prisma.job.updateMany({
      where: {
        id: job.id,
        scoringStatus: 'queued',
        jdBatchId: null,
        batchJobId: null,
        status: { in: ACTIVE_SCORING_STATUSES },
      },
      data: { scoringStatus: 'scoring', batchJobId: leaseId }
    });
    if (claimed.count === 0) continue;

    let claimedJob: Job | null = null;
    try {
      // Re-read after the atomic claim. This ensures the scorer uses the latest
      // title, description, URL, and ATS selection rather than the stale queue
      // snapshot taken before another request may have edited the job.
      claimedJob = await prisma.job.findUnique({ where: { id: job.id } });
      if (!claimedJob
        || claimedJob.scoringStatus !== 'scoring'
        || claimedJob.batchJobId !== leaseId
        || !ACTIVE_SCORING_STATUSES.includes(claimedJob.status)) {
        await releaseLocalScoringLease(job.id, leaseId);
        continue;
      }

      // The Glassdoor search result has enough stable metadata for the local
      // prefilter. Reject obvious non-target roles before any paid details call.
      if (claimedJob.source === GLASSDOOR_SOURCE) {
        const metadataFilter = passesPreFilter({
          title: claimedJob.title,
          company: claimedJob.company,
          description: '',
          location: claimedJob.location || '',
          url: claimedJob.url || '',
        });
        if (!metadataFilter.passes) {
          const updateResult = await prisma.job.updateMany({
            where: claimedJobSnapshot(claimedJob, leaseId),
            data: {
              scoringStatus: 'skipped',
              status: 'dismissed',
              passReason: metadataFilter.reason,
              batchJobId: null,
              scoreAttempts: 0,
              scoreError: null,
            },
          });
          if (updateResult.count === 0) {
            await releaseLocalScoringLease(job.id, leaseId);
            continue;
          }
          if (onProgress) onProgress(`Locally filtered ${claimedJob.company}: ${metadataFilter.reason}`);
          scoredCount++;
          continue;
        }
      }

      const resolved = await resolveFullDescription(claimedJob);
      const { text: fullDesc, needsReview } = resolved;
      const currentJob = await prisma.job.findUnique({ where: { id: job.id } });
      if (!currentJob
        || currentJob.scoringStatus !== 'scoring'
        || currentJob.batchJobId !== leaseId
        || !ACTIVE_SCORING_STATUSES.includes(currentJob.status)) {
        await releaseLocalScoringLease(job.id, leaseId);
        continue;
      }

      if (needsReview) {
        const nextAttempts = currentJob.scoreAttempts + 1;
        const isDead = nextAttempts >= 3;
        const reviewReason = isDead
          ? 'Failed to fetch JD after 3 attempts. Needs manual review.'
          : 'Job description was severely truncated. Please submit JD Batch or review manually.';

        const updateResult = await prisma.job.updateMany({
          where: claimedJobSnapshot(currentJob, leaseId),
          data: {
            batchJobId: null,
            ...(isDead
              ? buildTerminalJdRecoveryUpdate(reviewReason, reviewReason)
              : {
                  scoringStatus: 'needs_jd',
                  scoreAttempts: nextAttempts,
                  passReason: reviewReason,
                }),
            fitScore: null,
            fitRationale: null,
            fitCategory: 'unscored'
          }
        });
        if (updateResult.count === 0) {
          await releaseLocalScoringLease(job.id, leaseId);
          continue;
        }
        const updated = onProgress ? await prisma.job.findUnique({ where: { id: job.id } }) : null;
        if (onProgress) onProgress(
          isDead ? `Action needed for ${currentJob.company}` : `Needs JD ${currentJob.company}`,
          updated || undefined,
        );
        scoredCount++;
        continue;
      }

      const newTitle = resolved.discoveredTitle || currentJob.title;
      const newCompany = resolved.discoveredCompany || currentJob.company;
      const resolvedInputChanges = [
        newTitle !== currentJob.title ? 'title' : null,
        newCompany !== currentJob.company ? 'company' : null,
        fullDesc !== currentJob.description ? 'description' : null,
      ].filter((field): field is string => field !== null);
      const jobWithFullDesc = {
        ...currentJob,
        title: newTitle,
        company: newCompany,
        fullDescription: fullDesc,
      };
      
      const filterResult = passesPreFilter({
        title: newTitle,
        company: newCompany,
        description: fullDesc,
        location: currentJob.location || '',
        url: currentJob.url || ''
      });

      if (!filterResult.passes) {
        const updateResult = await prisma.$transaction(async (tx) => {
          const result = await tx.job.updateMany({
            where: claimedJobSnapshot(currentJob, leaseId),
            data: {
              title: newTitle,
              company: newCompany,
              description: fullDesc,
              ...(resolved.canonicalUrl ? { canonicalUrl: resolved.canonicalUrl } : {}),
              ...(resolved.manualAts ? { manualAts: resolved.manualAts } : {}),
              scoringStatus: 'skipped',
              status: currentJob.source === 'Manual Import' ? currentJob.status : 'dismissed',
              passReason: filterResult.reason,
              batchJobId: null,
              scoreAttempts: 0,
              scoreError: null,
            }
          });
          if (result.count === 1 && resolvedInputChanges.length > 0) {
            await invalidateActiveJobScores({
              jobId: currentJob.id,
              source: currentJob.source,
              sourceId: currentJob.sourceId,
              changedFields: resolvedInputChanges,
              route: 'local_scoring_resolution',
            }, tx);
          }
          return result;
        });
        if (updateResult.count === 0) {
          await releaseLocalScoringLease(job.id, leaseId);
          continue;
        }
        if (onProgress) onProgress(`Locally filtered ${newCompany}: ${filterResult.reason}`);
        scoredCount++;
        continue;
      }
      
      const { score, category, recommendedResume, rationale } = runLocalHeuristic(jobWithFullDesc, resumes, preferences);
      const deterministicallyRejected = false;
      const passReason = null;

      const updateResult = await prisma.$transaction(async (tx) => {
        const result = await tx.job.updateMany({
          where: claimedJobSnapshot(currentJob, leaseId),
          data: {
            title: newTitle,
            company: newCompany,
            fitScore: score,
            fitCategory: category,
            fitRationale: rationale,
            description: fullDesc,
            ...(resolved.canonicalUrl ? { canonicalUrl: resolved.canonicalUrl } : {}),
            ...(resolved.manualAts ? { manualAts: resolved.manualAts } : {}),
            recommendedResume,
            scoringStatus: deterministicallyRejected ? 'skipped' : 'scored',
            batchJobId: null,
            ...(deterministicallyRejected ? {
              status: currentJob.source === 'Manual Import' ? currentJob.status : 'dismissed',
              passReason,
            } : {}),
            scoreAttempts: 0,
            scoreError: null,
            deepseekScoreAttempts: 0,
            deepseekScoreError: null,
          },
        });
        if (result.count === 1 && resolvedInputChanges.length > 0) {
          await invalidateActiveJobScores({
            jobId: currentJob.id,
            source: currentJob.source,
            sourceId: currentJob.sourceId,
            changedFields: resolvedInputChanges,
            route: 'local_scoring_resolution',
          }, tx);
        }
        return result;
      });
      if (updateResult.count === 0) {
        await releaseLocalScoringLease(job.id, leaseId);
        continue;
      }
      const updated = onProgress ? await prisma.job.findUnique({ where: { id: job.id } }) : null;
      if (onProgress) onProgress(
        deterministicallyRejected
          ? `Locally rejected ${currentJob.company} without an API call`
          : `Locally triaged ${currentJob.company} (${score})`,
        updated || undefined,
      );
      scoredCount++;
    } catch (error: unknown) {
      console.error(`Error scoring:`, error);
      const newAttempts = (claimedJob?.scoreAttempts ?? job.scoreAttempts) + 1;
      const updateResult = await prisma.job.updateMany({
        where: {
          id: job.id,
          batchJobId: leaseId,
          scoringStatus: 'scoring',
          status: { in: ACTIVE_SCORING_STATUSES },
        },
        data: {
          scoreAttempts: newAttempts,
          scoreError: error instanceof Error ? error.message : 'Unknown error',
          scoringStatus: newAttempts >= 3 ? 'failed' : 'queued',
          batchJobId: null,
        }
      });
      if (updateResult.count === 0) {
        await releaseLocalScoringLease(job.id, leaseId);
      }
    }
  }

  return scoredCount;
}
