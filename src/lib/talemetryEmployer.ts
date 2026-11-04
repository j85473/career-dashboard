import * as cheerio from 'cheerio';
import { publishedEmployerName } from './publicAtsEmployer';

// Reviewed against the employer's published careers home page, not inferred
// from the tenant spelling. This board includes explicitly named agency brands.
export const SYNEOS_CAREERS_EVIDENCE_URL = 'https://syneoshealthcareers.ttcportals.com/';
// This separately published commercial board uses Syneos branding, but also
// carries client-authored vacancies. Its host alone cannot name their employer.
export const SYNEOS_COMMERCIAL_CAREERS_EVIDENCE_URL = 'https://syneos-spain-commercialcareers-dev.ttcportals.com/';
const SYNEOS_HOSTS = new Set([new URL(SYNEOS_CAREERS_EVIDENCE_URL).hostname,
  new URL(SYNEOS_COMMERCIAL_CAREERS_EVIDENCE_URL).hostname]);
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
  let commercial = false;
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
    if (!SYNEOS_HOSTS.has(target.hostname)) return '';
    commercial = target.hostname === new URL(SYNEOS_COMMERCIAL_CAREERS_EVIDENCE_URL).hostname;
  } catch { return ''; }
  description = description.replace(/\u00a0/g, ' ').replace(/\*+/g, '');
  if (commercial) {
    // Reviewed authored introductions plus hiring/benefits language establish
    // the client employer. A passing client reference or the shared logo does
    // not. Keep conflicting evidence unresolved.
    const introduction = description.replace(/^[\s\S]*?(?:^|\n)\s*Description\b\s*/i, '').trim();
    const clients = [
      /^Alfasigma is a privately held global healthcare company\b/i.test(introduction)
        && /join our USA? Biopharmaceuticals (?:Sales|Market Access) organization/i.test(description) ? 'Alfasigma' : '',
      /^(?:About Arrowhead Pharmaceuticals:\s*)?Arrowhead Pharmaceuticals, Inc\. \(Nasdaq: ARWR\) is a clinical stage biopharmaceutical company\b/i.test(introduction)
        && /Arrowhead[’']s corporate headquarters is in Pasadena/i.test(description) ? 'Arrowhead Pharmaceuticals' : '',
      /About Curevo Vaccine\s+Curevo Vaccine is a clinical-stage biotech company/i.test(description)
        && /Curevo offers its employees a generous range of compensation and benefits/i.test(description) ? 'Curevo Vaccine' : '',
    ].filter(Boolean);
    if (clients.length) {
      const other = [...description.matchAll(/\bAt ([^,\n]{2,100}), we are dedicated to building/gi)]
        .map(match => publishedEmployerName(match[1])).filter(Boolean);
      return clients.length === 1 && other.every(name => name === clients[0]) ? clients[0] : '';
    }
  }
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
  // Unlike the main board, the commercial board contains unnamed direct-hire
  // clients and test content. Require posting-level evidence there.
  return specificBrands[0] || names[0] || (commercial ? '' : 'Syneos Health');
}

/** Public branding fallback after a structured employer label proved unusable. */
export function talemetryPublishedEmployer(html: string, url: string, description: string): string {
  const reviewed = reviewedTalemetryEmployer(url, description);
  if (reviewed) return reviewed;
  // Conflicting agency self-identifications cannot be resolved by the shared
  // parent logo. Keep the posting unresolved instead of flattening the conflict.
  try { if (SYNEOS_HOSTS.has(new URL(url).hostname)) return ''; } catch { return ''; }
  const $ = cheerio.load(html);
  const site = publishedEmployerName($('meta[property="og:site_name"],meta[name="og:site_name"]').first().attr('content'));
  if (site) return site;
  const names = new Set<string>();
  $('header img[alt],#header img[alt],.header img[alt],.site-header img[alt],.header__logo img[alt],a.logo img[alt]').each((_, image) => {
    const name = publishedEmployerName(($(image).attr('alt') || '').replace(/\s+logo$/i, ''));
    if (name) names.add(name);
  });
  return names.size === 1 ? [...names][0] : '';
}
