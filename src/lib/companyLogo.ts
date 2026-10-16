import { employerAliasKey } from './employerIdentity';

/**
 * Branding evidence only. These entries never rename an employer or change
 * scoring, grouping, cooldowns, or posting identity. Keep the source website
 * beside each correction so adding another brand is reviewable.
 */
export const VERIFIED_COMPANY_WEBSITES = [
  {
    names: ['LexisNexis Risk Solutions', 'LexisNexis Risk Solutions FL Inc. Company'],
    website: 'https://risk.lexisnexis.com/',
  },
  {
    names: ['LexisNexis', 'LexisNexis Legal & Professional'],
    website: 'https://www.lexisnexis.com/global/careers.page',
  },
  {
    names: ['Catchafire'],
    website: 'https://www.catchafire.org/',
  },
  // Corporate-site evidence reviewed independently of recruiting-page uptime.
  { names: ['Acosta'], website: 'https://www.acosta.com/' },
  { names: ['Acosta Group'], website: 'https://www.acosta.group/' },
  { names: ['Honeywell'], website: 'https://www.honeywell.com/us/en' },
  { names: ['US Foods'], website: 'https://www.usfoods.com/' },
  { names: ['Gartner'], website: 'https://www.gartner.com/en/about' },
  { names: ['FIS'], website: 'https://www.fisglobal.com/' },
  { names: ['DoiT International', 'DoiT'], website: 'https://www.doit.com/' },
  // quantumhealth.com is a different company selling supplements.
  { names: ['Quantum Health'], website: 'https://quantum-health.com/' },
  { names: ['Revalize'], website: 'https://revalizesoftware.com/about-revalize/' },
  { names: ['One Eighty Collective'], website: 'https://www.oneeightyco.com/about-us/join-us/' },
  { names: ['Singapore Post', 'SingPost'], website: 'https://www.singpost.com/' },
  { names: ['J. J. Keller & Associates'], website: 'https://www.jjkeller.com/' },
  { names: ['Mammoth Equipment & Exhausts'], website: 'https://www.mammothequip.com/' },
  { names: ['Valvoline'], website: 'https://www.valvoline.com/' },
  { names: ['CyberPower Systems'], website: 'https://www.cyberpowersystems.com/products/' },
  { names: ['Balto'], website: 'https://www.balto.ai/about-us/' },
  { names: ['Marmon Holdings'], website: 'https://www.marmon.com/' },
  { names: ['The Hershey Company'], website: 'https://www.thehersheycompany.com/' },
  { names: ['HOYA Group'], website: 'https://www.hoya.com/' },
  { names: ['Data Verify', 'DataVerify'], website: 'https://info.dataverify.com/' },
  { names: ['Republic Services'], website: 'https://www.republicservices.com/' },
  { names: ["Arc'teryx"], website: 'https://arcteryx.com/' },
  { names: ['Statusphere'], website: 'https://www.joinstatus.com/' },
  { names: ['Winland Foods'], website: 'https://www.winlandfoods.com/' },
  { names: ['Tommy Car Wash Systems'], website: 'https://tommycarwash.com/' },
  { names: ['Infinite Electronics'], website: 'https://www.infiniteelectronics.com/' },
  { names: ['FUJIFILM Biotechnologies'], website: 'https://fujifilmbiotechnologies.fujifilm.com/' },
  { names: ['SMC Corporation of America', 'SMC Corporation of America - US SMC Pneumatics, Inc - CAN'], website: 'https://www.smcusa.com/' },
  // lpwgroup.com is an unrelated UK fleet-services company.
  { names: ['LPW Group'], website: 'https://www.lpw-group.com/our-products/' },
  { names: ['CenterPoint Marketing'], website: 'https://centpoint.com/about/' },
  { names: ['Virtuos Career Site'], website: 'https://www.virtuosgames.com/' },
  { names: ['Medstra'], website: 'https://www.medstra.co/' },
  { names: ['Road Machinery and Supplies Co..', 'Road Machinery & Supplies Co.'], website: 'https://rmsequipment.com/contact/savage-mn/' },
  { names: ['Stanley Access Technologies'], website: 'https://www.stanleyaccess.com/' },
] as const;

const reviewedDomains = new Map(VERIFIED_COMPANY_WEBSITES.flatMap(({ names, website }) =>
  names.map(name => [employerAliasKey(name), new URL(website).hostname.replace(/^www\./, '')] as const)));

export type LogoSubject = {
  /** The resolved employer shown to the user, falling back to the source name. */
  company: string | null | undefined;
  url?: string | null;
  canonicalUrl?: string | null;
};

/**
 * Accept a domain actually present on the posting, only when its brand label
 * exactly matches this employer. Strip known careers prefixes, never arbitrary
 * subdomains: acme.evil.com and acme.myworkdayjobs.com are not acme's website.
 * Unusual domains need a reviewed entry instead of a name-to-website guess.
 */
export function postingDomain(value: string | null | undefined, employerKey: string): string | null {
  if (!value || !employerKey) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    const domain = hostname.replace(/^(?:(?:www|careers|jobs|job|apply|recruiting)\.)+/, '');
    const parts = domain.split('.');
    const suffix = parts.slice(1).join('.');
    const ordinarySuffix = parts.length === 2 && /^[a-z]{2,63}$/.test(suffix);
    const countrySuffix = parts.length === 3 && /^(?:co|com|org|net|ac)\.[a-z]{2}$/.test(suffix);
    if ((!ordinarySuffix && !countrySuffix) || !/^[a-z0-9-]+$/.test(parts[0])) return null;
    // Compare the literal domain brand, without stripping legal suffixes or
    // tenant digits from it. A company called Zinc must not match zincinc.com.
    if (parts[0].replace(/-/g, '') !== employerKey) return null;
    return domain;
  } catch {
    return null;
  }
}

export function companyLogoDomain(subject: LogoSubject): string | null {
  const key = employerAliasKey(subject.company);
  const reviewed = reviewedDomains.get(key);
  if (reviewed) return reviewed;
  const domains = [...new Set([subject.canonicalUrl, subject.url]
    .map(value => postingDomain(value, key)).filter((value): value is string => value !== null))];
  // Conflicting source domains do not establish a single brand website.
  return domains.length === 1 ? domains[0] : null;
}

export function companyLogoUrl(subject: LogoSubject): string | null {
  const domain = companyLogoDomain(subject);
  return domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=128` : null;
}

export function companyLogoInitials(company: string | null | undefined): string {
  return String(company || '').trim().split(/\s+/).slice(0, 2)
    .map(word => Array.from(word)[0] || '').join('').toUpperCase() || '?';
}
