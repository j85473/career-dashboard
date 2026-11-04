import assert from 'node:assert/strict';
import test from 'node:test';
import { parseBrowserPosting } from '../../src/lib/browserAtsPosting';
import { isPlaceholderEmployerName } from '../../src/lib/companyIdentity';
import { reviewedTalemetryEmployer, talemetryPublishedEmployer } from '../../src/lib/talemetryEmployer';
import { parsePostingReaderMetadata } from '../../src/lib/postingMetadata';
import { readManualImportPage } from '../../src/lib/manualImportPage';

const url = 'https://syneoshealthcareers.ttcportals.com/jobs/18283663-urology-specialty-account-manager';
const description = 'Support appropriate product adoption across targeted accounts. '.repeat(8);
function posting(company: string | undefined, branding = '', target = url, body = description) {
  const html = `<title>Urology Specialty Account Manager</title>${branding}<script type="application/ld+json">${JSON.stringify({
    '@type': 'JobPosting', url: target, title: 'Urology Specialty Account Manager',
    ...(company ? { hiringOrganization: { name: company } } : {}), description: body,
  })}</script>`;
  return parseBrowserPosting('talemetry', new URL('/search/jobs', target).href,
    { id: /\/jobs\/(\d+)/.exec(target)![1], url: target, title: 'Urology Specialty Account Manager' }, [{ url: target, html, text: body }]);
}

test('generic company labels cannot establish employer identity while real Company names survive', () => {
  for (const name of ['Company', ' COMPANY ', 'Company name', 'Company logo', 'Employer', 'Employer name', 'Organization', 'Organisation name']) {
    assert.equal(isPlaceholderEmployerName(name), true, name);
  }
  for (const name of ['The Boring Company', 'The Company', 'CompanyCam', 'Syneos Health']) {
    assert.equal(isPlaceholderEmployerName(name), false, name);
  }
});

test('the affected Syneos posting recovers its employer from both failing extraction paths', () => {
  assert.equal(posting('Company')?.company, 'Syneos Health');
  assert.equal(posting(undefined, '<header><img alt="Company logo"></header>')?.company, 'Syneos Health');
});

const commercial = 'https://syneos-spain-commercialcareers-dev.ttcportals.com/jobs/17499675-territory-business-manager';
const alfasigma = 'Alfasigma is a privately held global healthcare company founded over 75 years ago in Italy. As we continue to grow, we are seeking a Territory Business Manager to join our USA Biopharmaceuticals Sales organization.';
const arrowhead = 'Arrowhead Pharmaceuticals, Inc. (Nasdaq: ARWR) is a clinical stage biopharmaceutical company that develops medicines. Arrowhead’s corporate headquarters is in Pasadena, CA.';
const curevo = 'Curevo offers its employees a generous range of compensation and benefits. About Curevo Vaccine\nCurevo Vaccine is a clinical-stage biotech company pioneering the development of vaccines.';
const syneos = 'Join Syneos Health, in partnership with Luye Pharma USA Ltd., as a Psychiatric Account Manager. At\u00a0Syneos\u00a0Health, we are dedicated to building a diverse, inclusive and authentic workplace.';

test('the separate Syneos commercial board recovers posting employers rather than flattening client vacancies', () => {
  for (const [body, employer] of [[alfasigma, 'Alfasigma'], [arrowhead, 'Arrowhead Pharmaceuticals'], [curevo, 'Curevo Vaccine'], [syneos, 'Syneos Health']]) {
    assert.equal(reviewedTalemetryEmployer(commercial, 'Description \n '+body), employer);
    assert.equal(posting('Company', '', commercial, body+description)?.company, employer);
    const reader = `URL Source: ${commercial}\nMarkdown Content:\n# Territory Business Manager\n**Description**\n${body}`;
    assert.equal(parsePostingReaderMetadata(reader, commercial).company, employer);
  }
  assert.equal(posting('Explicit employer', '', commercial, alfasigma+description)?.company, 'Explicit employer');
  for (const organization of ['US Biopharmaceuticals Sales', 'USA Biopharmaceuticals Market Access']) {
    assert.equal(reviewedTalemetryEmployer(commercial, alfasigma.replace('USA Biopharmaceuticals Sales', organization)), 'Alfasigma');
  }
});

test('the live commercial template without JSON-LD recovers the authored client ahead of the shared logo', () => {
  const html = `<title>Territory Business Manager in Affton, MO - Syneos Health</title>
    <div class="header__logo"><a href="/"><img alt="Syneos Health logo"></a></div>
    <h1>Territory Business Manager</h1><div class="job-details__content-description">Description <p>${alfasigma}</p><p>${description}</p></div>`;
  const parsed = parseBrowserPosting('talemetry', new URL('/search/jobs', commercial).href,
    { id: '17499675', url: commercial, title: 'Territory Business Manager' }, [{ url: commercial, html, text: alfasigma+description }]);
  assert.equal(parsed?.company, 'Alfasigma');
  assert.match(parsed!.description, /Alfasigma/);
});

test('commercial recovery requires exact reviewed hosting and corroborated employer language', () => {
  for (const target of [commercial.replace('https:', 'http:'), commercial.replace('.com/', '.com.evil.example/'), commercial.replace('/jobs/', '/other/'), commercial.replace('https://', 'https://user:pass@'), commercial.replace('syneos-spain', 'syneos-other')]) {
    assert.equal(reviewedTalemetryEmployer(target, alfasigma), '', target);
  }
  for (const body of [description, 'Our client is Alfasigma. '+alfasigma, arrowhead.split(' Arrowhead’s')[0], 'TSP is engaged in a direct-hire opportunity with a mid-sized pharmaceutical company.', alfasigma+' At Syneos Health, we are dedicated to building a team.']) {
    assert.equal(reviewedTalemetryEmployer(commercial, body), '', body);
    assert.equal(talemetryPublishedEmployer('<div class="header__logo"><img alt="Syneos Health logo"></div>', commercial, body), '', body);
  }
  assert.equal(talemetryPublishedEmployer('<div class="header__logo"><img alt="Example Inc logo"></div>', url.replace('syneoshealthcareers', 'unrelated'), description), 'Example Inc');
});

test('an unreviewed Talemetry board retains unnamed postings and needs real branding to supply a name', () => {
  const other = url.replace('syneoshealthcareers', 'unrelated');
  const unresolved = posting('Company', '<header><img alt="Company logo"></header>', other);
  assert.equal(unresolved?.company, 'Unknown Company');
  assert.equal(unresolved?.description, description.trim());
  assert.equal(posting('Company', '<meta property="og:site_name" content="Example Inc">', other)?.company, 'Example Inc');
  assert.equal(posting(undefined, '<header><img alt="Company logo"><img alt="Example Inc logo"></header>', other)?.company, 'Example Inc');
  assert.equal(posting(undefined, '<main><img alt="Unrelated sponsor logo"></main>', other)?.company, 'Unknown Company');
});

test('recovery keeps explicit agency and subsidiary self-identification rather than flattening the board', () => {
  assert.equal(reviewedTalemetryEmployer(url, 'Illingworth Research Group provides a range of patient focused clinical services.'), 'Illingworth Research Group');
  for (const name of ['GSW', 'Cadent', 'CCA', 'GENICOS', 'Spherico', 'Biosector 2', 'Syneos Health Communications']) {
    const text = `At ${name}, we are dedicated to building a diverse, inclusive and authentic workplace.`;
    assert.equal(reviewedTalemetryEmployer(url, text), name);
    assert.equal(posting('Company', '', url, description + text)?.company, name);
  }
  assert.equal(posting('Cadent')?.company, 'Cadent');
  assert.equal(reviewedTalemetryEmployer(url, 'Our client is Acme. We work alongside Acme.'), 'Syneos Health');
  assert.equal(reviewedTalemetryEmployer(url, 'At GSW, we are dedicated to building a team. At Syneos Health, we are dedicated to building a team.'), 'GSW');
  assert.equal(reviewedTalemetryEmployer(url, 'At Acme, we are dedicated to building a team. At Other, we are dedicated to building a team.'), '');
});

test('reviewed source evidence is limited to the exact HTTPS employer board and posting path', () => {
  for (const target of [url.replace('https:', 'http:'), url.replace('.com/', '.com.evil.example/'), url.replace('/jobs/', '/other/'), url.replace('https://', 'https://user:pass@')]) {
    assert.equal(reviewedTalemetryEmployer(target, description), '', target);
  }
  assert.equal(talemetryPublishedEmployer('<header><img alt="Acme logo"><img alt="Other logo"></header>', url.replace('syneoshealthcareers', 'unrelated'), description), '');
});

const cirtec = 'https://cirteccareers.ttcportals.com/jobs/18360749-business-development-manager-vascotube?__jvst=Job+Board&__jvsd=LinkedIn';
const introduction = 'For over three decades, Cirtec Medical has been a leading outsourcing partner for complex medical devices.';
const reader = `Title: Business Development Manager (Vascotube) in Brooklyn Park, MN, United States
URL Source: ${cirtec}
Markdown Content:
# Business Development Manager (Vascotube)
Location: Brooklyn Park, MN, United States
**Description**
**About us:**
${introduction}
Develop relationships for the Cirtec Medical Vascotube tubing business.`;

test('the Cirtec reader fallback recovers the named employer without changing the authored location', () => {
  const metadata = parsePostingReaderMetadata(reader, cirtec);
  assert.equal(metadata.company, 'Cirtec Medical');
  assert.equal(metadata.location, 'Brooklyn Park, MN, United States');
  assert.equal(parsePostingReaderMetadata(reader.replace('URL Source: '+cirtec, 'URL Source: https://other.example/jobs/18360749'), cirtec).company, undefined);
  for (const target of [cirtec.replace('cirteccareers', 'unrelated'), cirtec.replace('.com/', '.com.evil.example/'), cirtec.replace('https:', 'http:'), cirtec.replace('/jobs/', '/other/')]) {
    assert.equal(reviewedTalemetryEmployer(target, reader), '');
  }
  for (const text of ['Our client is Cirtec Medical.', 'About us: Vascotube develops medical tubing. Our parent is Cirtec Medical.', introduction]) {
    assert.equal(reviewedTalemetryEmployer(cirtec, text), '');
  }
});

test('manual Talemetry imports reuse published employer branding before a model or follow-up refresh', async () => {
  const html = '<title>Business Development Manager (Vascotube) in Brooklyn Park, MN, United States</title><meta property="og:site_name" content="Cirtec Medical Careers"><header><a href="https://www.cirtecmed.com"><svg class="c-logo"></svg></a></header><h1>Business Development Manager (Vascotube)</h1><main>About us: '+introduction+'</main>';
  const imported = await readManualImportPage({ html, url: cirtec, title: 'Business Development Manager Vascotube' }, async () => assert.fail('Employer branding is already explicit'));
  assert.equal(imported.company, 'Cirtec Medical');
  assert.equal(imported.title, 'Business Development Manager Vascotube');
  const supplied = await readManualImportPage({ html, url: cirtec, title: 'Reviewed role', company: 'Reviewed subsidiary' }, async () => assert.fail());
  assert.equal(supplied.company, 'Reviewed subsidiary');
});
