import * as cheerio from 'cheerio';
import { browserAtsBoardFromUrl } from './browserAtsBoards';

const clean = (value: string) => value.replace(/\s+/g, ' ').trim();
const unique = (values: string[]) => [...new Set(values.map(clean).filter(value => value
  && !/^(?:unknown(?: location)?|not specified|not provided|n\/a|-)$/i.test(value)))];
function fieldKind(label: string): 'location' | 'city' | 'state' | 'country' | null {
  const name = clean(label).replace(/\s*:\s*$/, '').toLowerCase();
  if (/^(?:locations?(?:\(s\))?|advertised location|physical location|locatie|ort|gebiet|ubicaciones)$/.test(name)) return 'location';
  if (/^(?:city|job city|ville|ciudad|lugar)$/.test(name)) return 'city';
  if (/^(?:state|province|state\s*\/\s*province|estado)$/.test(name)) return 'state';
  if (/^(?:country|country\s*\/\s*region|pays|país)$/.test(name)) return 'country';
  return null;
}

/** Read authored location fields; never reconstruct geography from title/URL tokens. */
export function avaturePublishedLocation(html: string): string {
  const $ = cheerio.load(html);
  $('script,style,noscript,nav,footer').remove();
  $('br').replaceWith('\n');
  const published: string[] = [];
  const groups = new Map<object, { city: string[]; state: string[]; country: string[] }>();
  const add = (label: string, value: string, group: object) => {
    const kind = fieldKind(label);
    const values = unique([value]);
    if (!kind || !values.length) return;
    if (kind === 'location') { published.push(...values); return; }
    const parts = groups.get(group) || { city: [], state: [], country: [] };
    parts[kind].push(...values);
    groups.set(group, parts);
  };
  $('.article__content__view__field').each((_, node) => {
    const field = $(node);
    if (field.hasClass('field--locations')) return;
    const group = field.closest('.article__content__view').get(0) || $.root().get(0)!;
    add(field.children('.article__content__view__field__label').text(),
      field.children('.article__content__view__field__value').text(), group);
  });
  // Avature's newer detail layout publishes the same labels in adjacent spans.
  $('.article--details p.paragraph').each((_, node) => {
    const spans = $(node).children('span');
    if (spans.length !== 2) return;
    const group = $(node).closest('.fluid-cols').get(0) || $(node).closest('.article--details').get(0)!;
    add(spans.eq(0).text(), spans.eq(1).text(), group);
  });
  // Some employers author the label directly inside the field's rich text.
  $('.article__content__view__field__value > font > strong').each((_, node) => {
    if (!/^Physical Location\s*:\s*$/i.test(clean($(node).text()))) return;
    const value = $(node).parent().clone();
    value.children('strong').first().remove();
    add('Physical Location', value.text(), node);
  });
  $('.tf_getLocationFromCR').each((_, node) => { published.push($(node).text().replace(/^\s*Locations?(?:\(s\))?\s*:?\s*/i, '')); });
  // Keep separately grouped places separate, including the primary location
  // before the additional-location dataset. Never zip unrelated city/state lists.
  $('.field--locations').each((_, node) => {
    const value = $(node).find('.article__content__view__field__value').first().clone();
    value.find('.MultipleDataSetFields').remove();
    value.children('strong').first().remove();
    published.push(value.text().replace(/^\s*:\s*/, ''));
    $(node).find('.MultipleDataSetFields').each((_, record) => {
      const parts = { city: [] as string[], state: [] as string[], country: [] as string[] };
      $(record).find('.MultipleDataSetField').each((_, field) => {
        const kind = fieldKind($(field).find('.MultipleDataSetFieldLabel').text());
        if (kind && kind !== 'location') parts[kind].push($(field).find('.MultipleDataSetFieldValue').text());
      });
      published.push(unique([...parts.city, ...parts.state, ...parts.country]).join(', '));
    });
  });
  if (unique(published).length) return unique(published).join('; ');
  return unique([...groups.values()].map(parts => {
    const city = unique(parts.city), state = unique(parts.state), country = unique(parts.country);
    return unique([...city, ...state, ...country]).join(city.length > 1 || state.length > 1 || country.length > 1 ? '; ' : ', ');
  })).join('; ');
}

export function avaturePostingIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const board = browserAtsBoardFromUrl('avature', value);
    const id = /\/(?:JobDetail|FolderDetail)\/(?:[^/]+\/)*(\d+)\/?$/i.exec(url.pathname)?.[1];
    return board && id ? `${board}:${id}` : null;
  } catch { return null; }
}

/** Require the same employer portal and opening in both transport and page evidence. */
export function recoverableAvatureLocation(html: string, requestedUrl: string, responseUrl: string): string {
  const identity = avaturePostingIdentity(requestedUrl);
  if (!identity || avaturePostingIdentity(responseUrl) !== identity) return '';
  const $ = cheerio.load(html);
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) {
    try { if (avaturePostingIdentity(new URL(canonical, responseUrl).href) !== identity) return ''; }
    catch { return ''; }
  }
  const hasApplyLink = $('a[href]').toArray().some(node => {
    try {
      const apply = new URL($(node).attr('href')!, responseUrl);
      const id = apply.searchParams.get('jobId');
      if (!id || !/\/(?:ApplicationMethods|InviteToApply|Apply)\/?$/i.test(apply.pathname)) return false;
      apply.pathname = apply.pathname.replace(/\/(?:ApplicationMethods|InviteToApply|Apply)\/?$/i, `/JobDetail/${id}`);
      return avaturePostingIdentity(apply.href) === identity;
    } catch { return false; }
  });
  return canonical || hasApplyLink ? avaturePublishedLocation(html) : '';
}
