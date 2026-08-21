import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  parseComeetPostingHtml,
  parseComeetPostingUrl,
} from '../../src/lib/atsApi';
import { assessJobDescriptionQuality } from '../../src/lib/jobDescriptionQuality';

const DESCRIPTION = `
  <p><strong>WHO WE ARE</strong></p>
  <p>Acme protects enterprise data and helps security teams adopt new technology safely. Our channel
  organization works with distributors, resellers, alliances, and field sellers to build repeatable
  routes to market for customers throughout the central United States.</p>
  <p><strong>THE OPPORTUNITY</strong></p>
  <p>The Channel Account Director will develop partner strategy, recruit and onboard new partners,
  create joint account plans, and own execution with sales and marketing leaders.</p>
  <p><strong>RESPONSIBILITIES</strong></p>
  <ul>
    <li>Build durable relationships with reseller and distributor executives.</li>
    <li>Train partners on solutions, positioning, and opportunity qualification.</li>
    <li>Forecast partner pipeline and report performance to senior leadership.</li>
    <li>Coordinate joint campaigns, events, and field engagement.</li>
  </ul>`;

const REQUIREMENTS = `
  <p><strong>REQUIRED QUALIFICATIONS</strong></p>
  <ul>
    <li>Seven years of channel sales or partner-management experience.</li>
    <li>Demonstrated success developing a high-performing partner network.</li>
    <li>Strong written communication, analytical, and relationship-building skills.</li>
    <li>Ability to travel to partner meetings and industry events.</li>
  </ul>`;

function comeetFixture(options: { companyUid?: string; positionUid?: string; includeDetails?: boolean } = {}) {
  const companyUid = options.companyUid ?? '17.008';
  const positionUid = options.positionUid ?? '9D.253-A3.50D';
  const details = options.includeDetails === false ? [] : [
    { name: 'Requirements', value: REQUIREMENTS, order: 2 },
    { name: 'Description', value: DESCRIPTION, order: 1 },
  ];
  return `<!doctype html><html><head><script>
    var COMPANY_DATA;
    var POSITION_DATA;
    COMPANY_DATA = ${JSON.stringify({ name: 'Cyera', company_uid: companyUid, token: 'not-read-by-parser' })};
    POSITION_DATA = ${JSON.stringify({
      name: 'Channel Account Director - TOLA',
      uid: positionUid,
      company_name: 'Cyera',
      custom_fields: { details, categories: [] },
      location: { name: 'Houston', city: 'Houston', state: 'TX', is_remote: true },
    })};
  </script></head><body>
    <div>{{position.name}}</div>
    <div>Apply for this job</div>
    <script>QUESTIONNAIRES_DATA = [{"title":"What is your legal name?"}];</script>
  </body></html>`;
}

test('parseComeetPostingUrl extracts stable company and position identities', () => {
  assert.deepEqual(
    parseComeetPostingUrl('https://www.comeet.com/jobs/cyera/17.008/channel-account-director---tola/9D.253-A3.50D?source=himalayas.app'),
    { companySlug: 'cyera', companyUid: '17.008', positionUid: '9D.253-A3.50D' },
  );
  assert.deepEqual(
    parseComeetPostingUrl('https://www.comeet.co/jobs/cyera/17.008/careers/EB.541-E0.406'),
    { companySlug: 'cyera', companyUid: '17.008', positionUid: 'EB.541-E0.406' },
  );
});

test('parseComeetPostingUrl rejects company boards and deceptive hosts', () => {
  assert.equal(parseComeetPostingUrl('https://www.comeet.com/jobs/cyera/17.008'), null);
  assert.equal(parseComeetPostingUrl('https://comeet.com.evil.example/jobs/cyera/17.008/role/9D.253'), null);
  assert.equal(parseComeetPostingUrl('javascript:alert(1)'), null);
});

test('parseComeetPostingHtml extracts the labeled JD and grounded metadata', () => {
  const result = parseComeetPostingHtml(comeetFixture(), {
    companyUid: '17.008',
    positionUid: '9D.253-A3.50D',
  });
  assert.ok(result);
  assert.equal(result!.ats, 'Comeet');
  assert.equal(result!.platform, 'comeet');
  assert.equal(result!.atsSlug, '17.008');
  assert.equal(result!.title, 'Channel Account Director - TOLA');
  assert.equal(result!.company, 'Cyera');
  assert.equal(result!.location, 'Houston, TX');
  assert.match(result!.text, /^Description\n/);
  assert.match(result!.text, /Requirements\n/);
  assert.ok(result!.text.indexOf('Description\n') < result!.text.indexOf('Requirements\n'));
  assert.equal(result!.text.includes('Apply for this job'), false);
  assert.equal(result!.text.includes('What is your legal name?'), false);
  const quality = assessJobDescriptionQuality(result!.text, { structuredSource: true });
  assert.equal(quality.scorable, true, quality.reason ?? '');
});

test('parseComeetPostingHtml fails closed on identity mismatch and empty portal data', () => {
  assert.equal(parseComeetPostingHtml(comeetFixture({ positionUid: 'OTHER' }), {
    companyUid: '17.008',
    positionUid: '9D.253-A3.50D',
  }), null);
  assert.equal(parseComeetPostingHtml(comeetFixture({ companyUid: '99.999' }), {
    companyUid: '17.008',
    positionUid: '9D.253-A3.50D',
  }), null);
  assert.equal(parseComeetPostingHtml(comeetFixture({ includeDetails: false })), null);
  assert.equal(parseComeetPostingHtml('<html><body>{{position.name}}</body></html>'), null);
});

test('scrapeAtsApi routes Comeet hosts through the dedicated extractor before JSON-LD', () => {
  const source = readFileSync(new URL('../../src/lib/atsApi.ts', import.meta.url), 'utf8');
  assert.match(source, /if \(isDomain\(host, 'comeet\.com'\) \|\| isDomain\(host, 'comeet\.co'\)\) \{\s+const detail = await scrapeComeetPosting\(url\);/);
  assert.ok(source.indexOf("isDomain(host, 'comeet.com')") < source.indexOf('return await scrapeJsonLdJobPosting(url)'));
});
