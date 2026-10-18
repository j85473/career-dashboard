import { recordJobPipelineEvent } from './ingestionControl';
import type { BrowserPostingLink } from './browserAtsPosting';
import type { Prisma } from './prismaClient';

export const BROWSER_LISTING_TITLE_POLICY = 'existing-title-rules-v1';
type EvidenceClient = Pick<Prisma.TransactionClient, 'jobPipelineEvent'>;

/** Persist the source evidence before the caller marks a rejected listing processed. */
export async function recordBrowserListingRejection(input: {
  taskId: string;
  source: string;
  sourceId: string;
  board: string;
  platform: string;
  link: BrowserPostingLink;
  reason: string;
}, client?: EvidenceClient) {
  if (!input.reason.trim() || !input.link.id.trim() || !input.link.title.trim() || !input.link.url.trim()) {
    throw new Error('A rejected browser listing requires its published identity, title, URL, and reason');
  }
  const event = await recordJobPipelineEvent({
    eventType: 'crawl_listing_rejected',
    taskId: input.taskId,
    stage: 'listing',
    source: input.source,
    sourceId: input.sourceId,
    details: {
      id: input.link.id,
      title: input.link.title,
      url: input.link.url,
      board: input.board,
      platform: input.platform,
      reason: input.reason,
      policy: BROWSER_LISTING_TITLE_POLICY,
    },
    // Dates and turn numbers are deliberately absent: retrying unchanged
    // evidence must return the same immutable event rather than append a copy.
    identityParts: [input.link.title, input.reason, BROWSER_LISTING_TITLE_POLICY],
  }, client);
  if (!event) throw new Error('Browser listing rejection evidence was not saved; retaining the unprocessed listing');
  return event;
}
