import * as cheerio from 'cheerio';
import { publishedEmployerName } from './publicAtsEmployer';

// Reviewed against the employer's published careers home page, not inferred
// from the tenant spelling. This board includes explicitly named agency brands.
export const SYNEOS_CAREERS_EVIDENCE_URL = 'https://syneoshealthcareers.ttcportals.com/';
// Cirtec's own careers page links directly to cirteccareers.ttcportals.com.
export const CIRTEC_CAREERS_EVIDENCE_URL = 'https://www.cirtecmed.com/careers';

export function isTalemetryPostingUrl(value: string): boolean {
  try {
    const target = new URL(value);
    return target.protocol === 'https:' && !target.username && !target.password && !target.port
      && /^[a-z0-9-]+\.ttcportals\.com$/i.test(target.hostname)
      && /^\/jobs\/\d+(?:-[^/]+)?\/?$/.test(target.pathname);
  } catch { return false; }
}

export function reviewedTalemetryEmployer(url: string, description: string): string {
  try {
    const target = new URL(url);
    if (!isTalemetryPostingUrl(url)) return '';
    if (target.hostname === 'cirteccareers.ttcportals.com') {
      // An authored About-us introduction identifies the employer. Vascotube
      // in the role title is a business unit, not a replacement employer.
      const text = description.replace(/\*+/g, '');
      return /\bAbout us:\s*For over three decades,\s*Cirtec Medical has been a leading outsourcing partner for complex medical devices\./i.test(text)
        ? 'Cirtec Medical' : '';
    }
    if (target.hostname !== 'syneoshealthcareers.ttcportals.com') return '';
  } catch { return ''; }
  // These are the employer's own self-identification clauses. Do not turn a
  // passing reference to a client, product, or parent into the listed company.
  const names = [...new Set([...description.matchAll(/\bAt ([^,\n]{2,100}), we are dedicated to building/gi)]
    .map(match => publishedEmployerName(match[1])).filter(Boolean))];
  if (/Illingworth Research Group provides a range of patient focused clinical services/i.test(description)) {
    const otherBrands = names.filter(name => name !== 'Syneos Health' && name !== 'Illingworth Research Group');
    return otherBrands.length ? '' : 'Illingworth Research Group';
  }
  const specificBrands = names.filter(name => name !== 'Syneos Health');
  if (specificBrands.length > 1) return '';
  return specificBrands[0] || names[0] || 'Syneos Health';
}

/** Public branding fallback after a structured employer label proved unusable. */
export function talemetryPublishedEmployer(html: string, url: string, description: string): string {
  const reviewed = reviewedTalemetryEmployer(url, description);
  if (reviewed) return reviewed;
  // Conflicting agency self-identifications cannot be resolved by the shared
  // parent logo. Keep the posting unresolved instead of flattening the conflict.
  try { if (new URL(url).hostname === 'syneoshealthcareers.ttcportals.com') return ''; } catch { return ''; }
  const $ = cheerio.load(html);
  const site = publishedEmployerName($('meta[property="og:site_name"],meta[name="og:site_name"]').first().attr('content'));
  if (site) return site;
  const names = new Set<string>();
  $('header img[alt],#header img[alt],.header img[alt],.site-header img[alt],a.logo img[alt]').each((_, image) => {
    const name = publishedEmployerName(($(image).attr('alt') || '').replace(/\s+logo$/i, ''));
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : '';
}
