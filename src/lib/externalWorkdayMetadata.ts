import { scrapeWorkdayPostingDetail, workdayPostingDetailUrl, type AtsScrapeResult } from './atsApi';
import { isGeneralRemoteOption, isUnknownOrBroadUSOption, splitLocationOptions } from './jobLocationPolicy';

/** Resolve broad aggregator metadata from the exact employer posting, including all sites. */
export async function recoverExternalWorkdayMetadata(
  posting: { url: string; location: string },
  readDetail: (url: string) => Promise<AtsScrapeResult | null> = scrapeWorkdayPostingDetail,
): Promise<AtsScrapeResult | null> {
  if (!workdayPostingDetailUrl(posting.url)) return null;
  const options = splitLocationOptions(posting.location);
  if (options.length > 0 && !options.every(option => isGeneralRemoteOption(option) || isUnknownOrBroadUSOption(option))) {
    return null;
  }
  try {
    return await readDetail(posting.url);
  } catch {
    // A failed metadata read leaves the source evidence available for JD recovery.
    return null;
  }
}
