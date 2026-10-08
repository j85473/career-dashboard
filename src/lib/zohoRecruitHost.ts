import { hostnameMatches } from './urlHost';

const ZOHO_RECRUIT_DOMAINS = [
  'zohorecruit.com', 'zohorecruit.eu', 'zohorecruit.in',
  'zohorecruit.com.au', 'zohorecruit.com.cn', 'zohorecruit.jp',
];

export function isZohoRecruitHost(hostname: string): boolean {
  return ZOHO_RECRUIT_DOMAINS.some(domain => hostnameMatches(hostname, domain));
}
