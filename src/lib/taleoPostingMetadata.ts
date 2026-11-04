import * as cheerio from 'cheerio';
import { isPlaceholderEmployerName } from './companyIdentity';

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const unique = (values: string[]) => [...new Set(values.map(clean).filter(Boolean))];

/** Classic Taleo fields use generated IDs, so bind their labels and values
 * within the same requisition row. Never read organization/location mentions
 * from arbitrary page text or derive them from a tenant name. */
export function taleoPostingMetadata(html: string, description: string): { company: string | null; location: string } {
  const $ = cheerio.load(html);
  const organizations: string[] = [], locations: string[] = [], arrangements: string[] = [];
  $('.contentlinepanel[id^="requisitionDescriptionInterface."]').each((_, node) => {
    const row = $(node);
    const label = clean(row.find('.subtitle').first().text()).replace(/\s*:\s*$/, '');
    const values = row.children('.text').toArray().map(value => clean($(value).text())).filter(Boolean);
    if (/^Organi[sz]ation$/i.test(label)) organizations.push(...values);
    if (/^(?:Primary Location|Other Locations|Work Locations)$/i.test(label)) locations.push(...values);
    if (/^Worker Location$/i.test(label)) arrangements.push(...values.filter(value => /^(?:Hybrid|Remote|On[- ]?site)$/i.test(value)));
  });
  // Some themes omit the Primary Location label. Its country-region-city
  // value is the immediate header row after the exact title/requisition row.
  const title = $('[id="requisitionDescriptionInterface.reqTitleLinkAction.row1"]');
  const headerLocation = title.closest('.contentlinepanel').next('.contentlinepanel');
  if (!headerLocation.find('.subtitle').length) {
    for (const node of headerLocation.children('.text').toArray()) {
      const value = clean($(node).text());
      if (/^[A-Z]{2}-[A-Z0-9]{2,3}-[^\n;]{2,100}$/.test(value)) locations.push(value);
    }
  }
  // Organization can name a department. Require explicit employer language
  // in this exact posting before allowing that field to supply a company.
  const names = unique(organizations);
  const candidate = names.length === 1 ? names[0] : '';
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const employerStatement = new RegExp(`(?:^|[\\s.!?])${escaped}\\s+is\\s+(?:proud to be\\s+)?(?:an?\\s+)?(?:equal opportunity|inclusive workplace)\\b`, 'i');
  const company = candidate && !isPlaceholderEmployerName(candidate) && candidate.length < 200
    && !/^(?:Oracle|Taleo)$/i.test(candidate) && employerStatement.test(clean(description)) ? candidate : null;
  return { company, location: unique([...locations, ...arrangements]).join('; ') };
}
