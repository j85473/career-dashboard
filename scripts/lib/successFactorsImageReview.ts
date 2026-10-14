import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { normalizedSuccessFactorsTitle, parseSuccessFactorsPostingHtml, successFactorsPostingIdentity } from '../../src/lib/successFactorsPosting';

export type SuccessFactorsImageReview = {
  postingUrl: string; title: string; imageSha256: string; company: string;
  location?: string; reviewedAt: string; companyEvidence: string; locationEvidence?: string;
};

/** Operator-reviewed poster fields are bound to the exact embedded source image.
 * OCR output alone is never permission to fill a field. This narrow repair path
 * accepts the visually reviewed UNIMINUTO board, not arbitrary tenant aliases. */
export function reviewedSuccessFactorsImageMetadata(html: string, url: string, review: SuccessFactorsImageReview) {
  const primary = parseSuccessFactorsPostingHtml(html, url);
  if (!primary || successFactorsPostingIdentity(url)?.tenant !== 'corporac04' || review.postingUrl !== url
    || normalizedSuccessFactorsTitle(primary.title) !== normalizedSuccessFactorsTitle(review.title)
    || review.company !== 'UNIMINUTO (Corporación Universitaria Minuto de Dios)'
    || !review.reviewedAt || !review.companyEvidence || (review.location && !review.locationEvidence)) {
    throw new Error('Image review does not identify this posting and its reviewed fields');
  }
  const $ = cheerio.load(html);
  const imageHashes = $('.joqReqDescription .externalPosting img[src]').toArray().flatMap(node => {
    const match = /^data:image\/(?:png|jpeg);base64,([a-z0-9+/=\s]+)$/i.exec($(node).attr('src') || '');
    return match ? [createHash('sha256').update(Buffer.from(match[1], 'base64')).digest('hex')] : [];
  });
  if (!/^[a-f0-9]{64}$/.test(review.imageSha256) || !imageHashes.includes(review.imageSha256)) {
    throw new Error('Reviewed poster is absent or its source image changed');
  }
  return { title: primary.title, company: review.company, location: review.location || primary.location };
}
