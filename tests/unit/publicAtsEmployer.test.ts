import assert from 'node:assert/strict';
import test from 'node:test';
import { oracleBrandedEmployer, ukgBoardBranding, employerWebsiteName, resolveUkgBoardEmployer } from '../../src/lib/publicAtsEmployer';
import { parseOraclePostingDetail } from '../../src/lib/oraclePosting';
import { parsePublicAtsConfig } from '../../src/lib/publicAtsBoards';
const oracleUrl = 'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/337000';
const oracleHtml = '<meta property="og:site_name" content="Oracle"><meta property="og:image" content="https://www.oracle.com/a/ocom/img/logo-950x500.png">';
const board = '/BUC1007BUCC/JobBoard/7bae581a-2d4c-4084-95b1-d533dea8a3b1';
const url = `https://recruiting2.ultipro.com${board}/OpportunityDetail?opportunityId=830a7788-77ee-4da9-9965-ce87f0f279ef`;
const header = (path = board) => `<script>var navHeader = React.createElement(RecNavHeader, {
 logoHref: 'https://www.buckle.com/', largeLogoSrc: "${path}/Styles/GetLargeHeaderLogo?brandId=brand\\u0026m=123",
 jobBoardLink: "${path}", profileItems: [] });</script>`;

test('Oracle own branded careers site survives the vendor-name exclusion without labeling customer tenants Oracle', () => {
  assert.equal(oracleBrandedEmployer(oracleHtml, oracleUrl), 'Oracle');
  assert.equal(oracleBrandedEmployer(oracleHtml, oracleUrl.replace('eeho', 'customer')), '');
  assert.equal(oracleBrandedEmployer(oracleHtml.replace('www.oracle.com', 'other.example'), oracleUrl), '');
  assert.equal(parsePublicAtsConfig('oracle', 'eeho.fa.us2.oraclecloud.com::jobsearch', oracleHtml).company, 'Oracle');
  const payload = { items: [{ Id: '337000', Title: 'Regional Manager', LegalEmployer: null,
    CorporateDescriptionStr: '<p>Oracle is an Equal Employment Opportunity Employer.</p>' }] };
  assert.equal(parseOraclePostingDetail(payload, oracleUrl)?.company, 'Oracle');
  assert.equal(parseOraclePostingDetail(payload, oracleUrl.replace('eeho', 'customer'))?.company, undefined);
  assert.equal(parseOraclePostingDetail(payload, oracleUrl.replace('337000', '337001')), null);
});

test('UKG modern React header binds its corporate link to the requested board without executing scripts', () => {
  assert.deepEqual(ukgBoardBranding(header(), url), { company: '', employerUrl: 'https://www.buckle.com/' });
  for (const html of [header('/other/JobBoard/7bae581a-2d4c-4084-95b1-d533dea8a3b1'),
    header().replace("'https://www.buckle.com/'", 'runUntrustedCode()'), header() + header(),
    header().replace('https://www.buckle.com/', 'https://recruiting2.ultipro.com/')]) {
    assert.deepEqual(ukgBoardBranding(html, url), { company: '', employerUrl: '' });
  }
});

test('UKG linked employer names require explicit own-site metadata and reject unrelated redirects', async () => {
  const own = '<meta name="og:site_name" content="Buckle">';
  assert.equal(employerWebsiteName(own, 'https://www.buckle.com/'), 'Buckle');
  assert.equal(employerWebsiteName(own, 'https://www.buckle.com/', 'https://unrelated.example/'), '');
  assert.equal(employerWebsiteName('<title>Cloudflare challenge</title>', 'https://www.buckle.com/'), '');
  assert.equal(employerWebsiteName('<script type="application/ld+json">{"@type":"Organization","name":"Buckle","url":"https://www.buckle.com/"}</script>', 'https://www.buckle.com/'), 'Buckle');
  assert.equal(await resolveUkgBoardEmployer(header(), url, async target => {
    assert.equal(target, 'https://www.buckle.com/'); return new Response(own);
  }), 'Buckle');
});

test('Oracle customer equality statement retains the legal employer instead of its retail-group parent', () => {
  const customerUrl = oracleUrl.replace('eeho.fa.us2', 'egjl.fa.us6');
  const payload = { items: [{ Id: '337000', LegalEmployer: null,
    ShortDescriptionStr: '“En JORSA DE LA SELVA S.A.C. estamos comprometidos con promover la equidad, la diversidad y la inclusión en nuestros equipos.' }] };
  assert.equal(parseOraclePostingDetail(payload, customerUrl)?.company, 'JORSA DE LA SELVA S.A.C.');
  assert.equal(parseOraclePostingDetail(payload, oracleUrl)?.company, undefined);
});

test('Oracle career-site organization metadata must match the requested site and contain a real employer', async () => {
  const { oracleCareerSiteEmployer, publishedEmployerName } = await import('../../src/lib/publicAtsEmployer');
  const customer = oracleUrl.replace('eeho', 'customer');
  assert.equal(oracleCareerSiteEmployer({ SiteNumber: 'jobsearch', SiteName: 'Masimo' }, customer), 'Masimo');
  assert.equal(oracleCareerSiteEmployer({ SiteNumber: 'other', SiteName: 'Masimo' }, customer), '');
  for (const name of ['Career Site', 'Candidate Experience site', 'Sitio de Carrera Intercorp Retail', 'Oracle']) {
    assert.equal(oracleCareerSiteEmployer({ SiteNumber: 'jobsearch', SiteName: name }, customer), '');
  }
  assert.equal(publishedEmployerName('Careers at Marriott'), 'Marriott');
  assert.equal(publishedEmployerName('Al Moosa Career Portal'), 'Al Moosa');
});

test('Oracle first-person retail introductions identify the hiring business and reject client mentions', () => {
  const customer = oracleUrl.replace('eeho.fa.us2', 'egjl.fa.us6');
  const result = (short: string) => parseOraclePostingDetail({ items: [{ Id: '337000', ShortDescriptionStr: short }] }, customer)?.company;
  assert.equal(result('En Oechsle, empresa del Grupo Intercorp, estamos en búsqueda del mejor talento.'), 'Oechsle');
  assert.equal(result('Somos Super Food Holding, el equipo que está al servicio de las marcas. Formamos parte del grupo Intercorp.'), 'Super Food Holding');
  assert.equal(result('Nuestros clientes incluyen Oechsle, empresa del Grupo Intercorp.'), undefined);
});

test('UKG ignores internal logo-template labels and retains the exact logo corporate link', async () => {
  const { publishedEmployerName } = await import('../../src/lib/publicAtsEmployer');
  for (const label of ['Default Brand', 'Ada Brand', 'Recruiting - L148 Template', 'US - LLC Recruiting']) {
    const html = `<a href="https://amys.com/"><img data-automation="navbar-large-logo" src="${board}/Styles/GetLargeHeaderLogo" alt="${label}"></a>`;
    assert.deepEqual(ukgBoardBranding(html, url), { company: '', employerUrl: 'https://amys.com/' });
    if (label !== 'Ada Brand') assert.equal(publishedEmployerName(label), '');
  }
  const wrong = `<a href="https://amys.com/"><img data-automation="navbar-large-logo" src="/other/Styles/GetLargeHeaderLogo" alt="Amy's Kitchen"></a>`;
  assert.deepEqual(ukgBoardBranding(wrong, url), { company: '', employerUrl: '' });
});

test('corporate home-link logo names do not accept product or partner images', () => {
  assert.equal(employerWebsiteName('<header><a href="/"><img src="/assets/logo.svg" alt="BNC Bank Logo"></a></header>', 'https://www.bnc.bank/'), 'BNC Bank');
  assert.equal(employerWebsiteName('<header><a href="https://partner.example/"><img src="/logo.svg" alt="Other employer"></a></header>', 'https://www.bnc.bank/'), '');
  assert.equal(employerWebsiteName('<a href="/products"><img src="/logo.svg" alt="Product name"></a>', 'https://www.bnc.bank/'), '');
});


test('UKG branding variants and corporate color-logo labels cannot become employers', () => {
  for (const label of ['OCO Default Branding', 'Mustang Extreme Default Branding', 'AdaBrand', 'EMSA Branding', 'New Logo', 'Stephens Default', 'Topographic_Logo_New_Black_web']) {
    const html = `<img src="${board}/Styles/GetLargeHeaderLogo" alt="${label}" data-automation="navbar-large-logo">`;
    assert.equal(ukgBoardBranding(html, url).company, '');
  }
  assert.equal(employerWebsiteName('<header><a href="/"><img class="logo" alt="camp white logo" src="/logo.png"></a></header>', 'https://www.campsystems.com/'), '');
});
