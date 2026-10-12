import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublishedAtsBoardEmployer } from '../atsEmployerRecovery';
import { oracleEmployerWebsiteUrl } from '../publicAtsEmployer';

const slug = 'customer.fa.us2.oraclecloud.com::CX_2001';
const url = 'https://customer.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_2001/';
const header = '<script type="text/html" id="custom-header"><div class="site-logo"><a href="https://employer.example/" title="Untrusted label"><svg></svg></a></div></script>';

test('Oracle employer lookup uses only one inert primary-logo home link', () => {
  assert.equal(oracleEmployerWebsiteUrl(header, url), 'https://employer.example/');
  for (const unsafe of [header + header, header.replace('https://employer.example/', 'https://linkedin.com/company/example'),
    header.replace('https://employer.example/', 'https://employer.example/other'), header.replace('text/html', 'text/javascript'),
    header.replace('</div>', '<a href="https://other.example/"></a></div>')]) {
    assert.equal(oracleEmployerWebsiteUrl(unsafe, url), '');
  }
});

test('Oracle customer recovery verifies the linked employer metadata without executing its template', async () => {
  const calls: string[] = [];
  const result = await readPublishedAtsBoardEmployer('oracle', slug, {
    registry: async () => '',
    fetchPage: async target => {
      calls.push(target);
      return new Response(target === url ? header : '<meta property="og:site_name" content="Example Employer">');
    },
  });
  assert.equal(result, 'Example Employer');
  assert.deepEqual(calls, [url, 'https://employer.example/']);
});

test('employer recovery rejects a board redirect and a corporate redirect to an unrelated host', async () => {
  let calls = 0;
  assert.equal(await readPublishedAtsBoardEmployer('oracle', slug, {
    registry: async () => '', fetchPage: async () => {
      calls++; const response = new Response('<meta property="og:site_name" content="Wrong Employer">');
      Object.defineProperty(response, 'url', { value: url.replace('CX_2001', 'CX_OTHER') }); return response;
    },
  }), '');
  assert.equal(calls, 1);
  assert.equal(await readPublishedAtsBoardEmployer('oracle', slug, {
    registry: async () => '', fetchPage: async target => {
      if (target === url) return new Response(header);
      if (target === 'https://employer.example/') {
        const response = new Response('<meta property="og:site_name" content="Wrong Employer">');
        Object.defineProperty(response, 'url', { value: 'https://unrelated.example/' }); return response;
      }
      return new Response('{}');
    },
  }), '');
});

test('Oracle own-site branding survives generic vendor rejection only for its verified tenant', async () => {
  const html = '<meta property="og:site_name" content="Oracle"><meta property="og:image" content="https://www.oracle.com/a/logo.png">';
  assert.equal(await readPublishedAtsBoardEmployer('oracle', 'eeho.fa.us2.oraclecloud.com::CX', {
    registry: async () => '', fetchPage: async () => new Response(html),
  }), 'Oracle');
  assert.equal(await readPublishedAtsBoardEmployer('oracle', slug, {
    registry: async () => '', fetchPage: async target => new Response(target.includes('hcmUI') ? html : '{}'),
  }), '');
});

test('Zoho recovery binds its exact career page and respects hidden organization names', async () => {
  const zoho = 'example.zohorecruit.com::Careers';
  const body = (hide: boolean) => `<input id="meta" value='${JSON.stringify({ page_name: 'Careers',
    list_url: 'https://example.zohorecruit.com/jobs/Careers', org_info: {company_name:'Example Inc',hide_company_name:hide} })}'>`;
  assert.equal(await readPublishedAtsBoardEmployer('zohorecruit', zoho, { registry: async () => '', fetchPage: async () => new Response(body(false)) }), 'Example Inc');
  await assert.rejects(readPublishedAtsBoardEmployer('zohorecruit', zoho, { registry: async () => '', fetchPage: async () => new Response(body(true)) }), /no employer/);
});

test('Oracle own CX alias requires the exact jobsearch destination and corporate logo', async () => {
  for (const [html, expected] of [
    ['<meta property="og:site_name" content="Oracle"><meta property="og:image" content="https://www.oracle.com/a/logo.png">', 'Oracle'],
    ['<meta property="og:site_name" content="Unrelated Organization">', ''],
  ]) {
    const name = await readPublishedAtsBoardEmployer('oracle','eeho.fa.us2.oraclecloud.com::CX',{
      registry:async()=>'',fetchPage:async()=>{
        const response=new Response(html);
        Object.defineProperty(response,'url',{value:'https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch'});
        return response;
      },
    });
    assert.equal(name,expected);
  }
});

test('Oracle named site metadata uses its published resource number and verifies the alias', async () => {
  const aliasSlug = 'customer.fa.us2.oraclecloud.com::Careers';
  const aliasUrl = url.replace('CX_2001', 'Careers');
  const html = '<link rel="icon" href="/hcmRestApi/CandidateExperience/siteFavicon/favicon-16x16.png?siteNumber=CX_2001&amp;size=16x16">';
  for (const [alias, expected] of [['Careers', 'Example Employer'], ['OtherSite', '']]) {
    const calls: string[] = [];
    const name = await readPublishedAtsBoardEmployer('oracle', aliasSlug, {
      registry: async () => '', fetchPage: async target => {
        calls.push(target);
        return new Response(target === aliasUrl ? html : JSON.stringify({
          SiteNumber: 'CX_2001', SiteURLName: alias, SeoOrganizationName: 'Example Employer',
        }));
      },
    });
    assert.equal(name, expected);
    assert.equal(calls[1], 'https://customer.fa.us2.oraclecloud.com/hcmRestApi/resources/latest/recruitingCESites/CX_2001?onlyData=true');
  }
});

test('Oracle brand-logo primary home link supplies the same bounded corporate lookup', async () => {
  const html = '<script id="custom-header" type="text/html"><header><a class="brand-logo" href="https://employer.example/"><img alt="Untrusted label"></a></header></script>';
  assert.equal(oracleEmployerWebsiteUrl(html, url), 'https://employer.example/');
  assert.equal(await readPublishedAtsBoardEmployer('oracle', slug, {
    registry: async () => '', fetchPage: async target => new Response(target === url ? html : '<meta property="og:site_name" content="Example Employer">'),
  }), 'Example Employer');
  assert.equal(oracleEmployerWebsiteUrl(html.replace('https://employer.example/', 'https://facebook.com/'), url), '');
  assert.equal(oracleEmployerWebsiteUrl(html + html, url), '');
});
