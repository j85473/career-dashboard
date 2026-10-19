import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fetchUmantisPosting, parseUmantisPostingHtml, parseUmantisApplicationEmployer, umantisPostingIdentity, UmantisPostingUnavailableError } from '../../src/lib/umantisPosting';
import { readManualImportPage } from '../../src/lib/manualImportPage';
import { isGenericManualImportTitle } from '../../src/lib/manualImportPolicy';
import { planPostingMetadataRepair } from '../../src/lib/postingMetadataRepair';
import { identifyAts, ATS_OPTIONS } from '../../src/lib/atsUtils';

const url = 'https://recruitingapp-60151.umantis.com/Vacancies/2078/Description/2';
const applicationUrl = 'https://recruitingapp-60151.umantis.com/Vacancies/2078/Application/New/2';
const html = readFileSync(new URL('../fixtures/umantis/sales-manager-minnesota.html', import.meta.url), 'utf8');
const form = readFileSync(new URL('../fixtures/umantis/sales-manager-application.html', import.meta.url), 'utf8');

test('Umantis public application URLs resolve to the exact vacancy, tenant and locale', () => {
  for (const input of [url, applicationUrl, applicationUrl.replace('/New/', '/CheckLogin/'), applicationUrl.replace('/New/', '/Login/')]) {
    assert.deepEqual(umantisPostingIdentity(input), { id: '2078', language: '2', descriptionUrl: url, applicationUrl });
  }
  for (const input of [url.replace('https:', 'http:'), url.replace('.com/', '.com.evil.example/'), url.replace('https://', 'https://user@'), url.replace('.com/', '.com:8443/'), url + '?ShowDocument=6', 'https://recruitingapp-60151.umantis.com/Vacancies']) assert.equal(umantisPostingIdentity(input), null);
  assert.equal(identifyAts({ url }), 'Umantis');
  assert(ATS_OPTIONS.includes('Umantis'));
});

test('actual Umantis detail template yields the authored title and mandatory work base', () => {
  const posting = parseUmantisPostingHtml(html, url)!;
  assert.equal(posting.title, 'Sales Manager - Minnesota');
  assert.equal(posting.location, 'Minneapolis, MN (residency required)');
  assert.match(posting.text, /North Dakota, South Dakota and part of Wisconsin/);
  assert.match(posting.text, /5\+ years of experience/);
  assert.match(posting.text, /travel up to 75%/);
  assert.equal(posting.company, undefined);
  assert.doesNotMatch(posting.text, /Employment History|Apply now|Tweet|ga\(/);
  assert.match(parseUmantisPostingHtml(html.replace('Wacker Neuson full line', '<a href="https://example.com/equipment">Wacker Neuson</a> full line'), url)!.text, /Wacker Neuson full line/);
  assert.equal(parseUmantisPostingHtml(html.replace('The Sales Manager must live within Minneapolis, MN area.', 'Travel includes Minneapolis, MN and other sales markets.'), url)?.location, undefined);
});

test('form title proves the employer only for the same vacancy heading and action', () => {
  assert.equal(parseUmantisApplicationEmployer(form, applicationUrl, 'Sales Manager - Minnesota'), 'Wacker Neuson Group');
  assert.equal(parseUmantisApplicationEmployer(form, applicationUrl, 'Other Role'), undefined);
  assert.equal(parseUmantisApplicationEmployer(form.replace('/2078/', '/9999/'), applicationUrl, 'Sales Manager - Minnesota'), undefined);
  assert.equal(parseUmantisApplicationEmployer(form.replace('Wacker Neuson Group eRecruiting', 'Umantis eRecruiting'), applicationUrl, 'Sales Manager - Minnesota'), undefined);
});

test('Umantis always fetches the description before optional employer branding', async () => {
  const requests: string[] = [];
  const posting = await fetchUmantisPosting(applicationUrl, async target => {
    requests.push(String(target));
    return new Response(String(target) === url ? html : form);
  });
  assert.deepEqual(requests, [url, applicationUrl]);
  assert.equal(posting?.title, 'Sales Manager - Minnesota');
  assert.equal(posting?.company, 'Wacker Neuson Group');
  assert.equal(posting?.location, 'Minneapolis, MN (residency required)');
  const partial = await fetchUmantisPosting(url, async target => {
    if (String(target) === applicationUrl) throw new Error('branding timeout');
    return new Response(html);
  });
  assert.equal(partial?.title, 'Sales Manager - Minnesota');
  assert.equal(partial?.company, undefined);
});

test('a different vacancy, tenant, language, or application response cannot verify the requested JD', async () => {
  for (const finalUrl of [url.replace('2078', '9999'), url.replace('60151', '60152'), url.replace(/\/2$/, '/1'), applicationUrl]) {
    const posting = await fetchUmantisPosting(url, async () => {
      const response = new Response(html);
      Object.defineProperty(response, 'url', { value: finalUrl });
      return response;
    });
    assert.equal(posting, null, finalUrl);
  }
  assert.equal(parseUmantisPostingHtml(html.replaceAll('/2078/Application/', '/9999/Application/'), url), null);
  assert.equal(parseUmantisPostingHtml(html.replace('<h1>Sales Manager - Minnesota</h1>', '<h1>Employment History (Start Date):</h1>'), url), null);
  assert.equal(parseUmantisPostingHtml(html.replaceAll('Sales Manager - Minnesota', 'X'.repeat(201)), url), null);
  assert.equal(parseUmantisPostingHtml(form, applicationUrl), null);
  assert.equal(await fetchUmantisPosting(url, async () => new Response('Gone', { status: 404 })), null);
});

test('manual fallback cannot infer job metadata from the Umantis application form', async () => {
  await assert.rejects(() => readManualImportPage({ html: form, url: applicationUrl }, async () => assert.fail('Form fields must not become a model prompt')), UmantisPostingUnavailableError);
  const posting = await readManualImportPage({ html, url }, async () => assert.fail('The provider heading already proves the title'));
  assert.equal(posting.title, 'Sales Manager - Minnesota');
  assert.equal(posting.location, 'Minneapolis, MN (residency required)');
  assert.equal(posting.company, 'Unknown Company');
  assert.equal((await readManualImportPage({ html, url, title: 'Employment History (Start Date):' }, async () => ({}))).title, 'Sales Manager - Minnesota');
});

test('application-field labels are unresolved titles and allow metadata-only saved-card repair', () => {
  for (const title of ['Employment History (Start Date):', 'Employment History (Leave Date):', 'Personal Information']) assert.equal(isGenericManualImportTitle(title), true);
  assert.equal(isGenericManualImportTitle('Employment History Analyst'), false);
  const repair = planPostingMetadataRepair({ title: 'Employment History (Start Date):', company: 'Unknown Company',
    location: null, url, status: 'inbox', passReason: null, source: 'Manual Import', scoringStatus: 'scored', tailoringStaged: true },
  { title: 'Sales Manager - Minnesota', company: 'Wacker Neuson Group', location: 'Minneapolis, MN (residency required)',
    source: 'umantis', identityVerified: true, completeLocations: true }, { hasScores: true, hasHumanDecision: true });
  assert.equal(repair?.action, 'metadata_only');
  assert.equal(repair?.metadata.title, 'Sales Manager - Minnesota');
  assert.equal(repair?.metadata.company, 'Wacker Neuson Group');
  assert.equal('lifecycle' in repair!, false);
});

test('manual imports canonicalize Umantis forms before duplicate lookup and reject unverified forms before card creation', () => {
  const source = readFileSync('src/app/api/jobs/manual-import/route.ts', 'utf8');
  assert(source.indexOf('url = umantisPage.descriptionUrl') < source.indexOf('const existingByUrl = await findSurvivingCardForLink'));
  assert(source.indexOf('if (umantisPage && (!directPosting?.title') < source.indexOf('newJob = await prisma.job.create'));
  assert.match(source, /!readyPosting && !umantisPage/);
  assert.match(source, /error instanceof UmantisPostingUnavailableError/);
  assert.match(source, /umantisPostingIdentity\(value\)\?\.descriptionUrl === umantis\.descriptionUrl/);
});
