import assert from 'node:assert/strict';
import test from 'node:test';
import { readPublishedAtsPostingEvidence } from '../atsEmployerRecovery';

const readPublishedAtsPostingEmployer = async (...args: Parameters<typeof readPublishedAtsPostingEvidence>) =>
  (await readPublishedAtsPostingEvidence(...args))?.company || '';

const slug = 'customer.fa.us2.oraclecloud.com::old-site';
const url = 'https://customer.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/old-site/job/123/';
const canonical = url.replace('old-site', 'CX');
const job = { url, publicAtsPostingId: '123', title: 'Account Manager', company: '' };
const header = '<script type="text/html" id="custom-header"><a class="brand-logo" href="https://employer.example/">Home</a></script>';
const payload = { items: [{ Id: '123', Title: job.title, ExternalDescriptionStr: '<p>Manage accounts.</p>' }] };
function response(body: string, landed: string, status = 200) {
  const result = new Response(body, { status });
  Object.defineProperty(result, 'url', { value: landed });
  return result;
}

test('saved Oracle alias recovers its employer only through the same exact requisition and published corporate proof', async () => {
  const before = structuredClone(job), calls: string[] = [];
  const name = await readPublishedAtsPostingEmployer('oracle', slug, job, {
    registry: async () => '', fetchPage: async target => {
      calls.push(target);
      if (target === url) return response(header, canonical);
      if (target.includes('recruitingCEJobRequisitionDetails')) {
        assert.equal(new URL(target).searchParams.get('finder'), 'ById;Id="123",siteNumber=CX');
        return response(JSON.stringify(payload), target);
      }
      assert.equal(target, 'https://employer.example/');
      return response('<meta property="og:site_name" content="Example Employer">', target);
    },
  });
  assert.equal(name, 'Example Employer');
  assert.equal(calls.length, 3);
  assert.deepEqual(job, before);
});

test('exact posting recovery retains the verified description and location without editing the saved item', async () => {
  const before = structuredClone(job);
  const evidence = await readPublishedAtsPostingEvidence('oracle', slug, job, {
    registry: async () => '', fetchPage: async target => target === url ? response(header, canonical)
      : response(JSON.stringify({ items: [{ ...payload.items[0], LegalEmployer: 'Example Employer', PrimaryLocation: 'Chicago, IL' }] }), target),
  });
  assert.deepEqual(evidence, { company: 'Example Employer', description: 'Manage accounts.', location: 'Chicago, IL' });
  assert.deepEqual(job, before);
});

test('Oracle exact-posting recovery rejects changed IDs, tenants, error pages, downgrade and wrong detail titles', async () => {
  for (const landed of [canonical.replace('/123/', '/456/'), canonical.replace('customer.', 'other.'),
    canonical.replace('/sites/CX/job/123/', '/errors/404'), canonical.replace('https:', 'http:')]) {
    let calls = 0;
    assert.equal(await readPublishedAtsPostingEmployer('oracle', slug, job, {
      registry: async () => { assert.fail('Unverified redirect must not reach employer rules'); },
      fetchPage: async () => { calls++; return response(header, landed); },
    }), '');
    assert.equal(calls, 1);
  }
  for (const items of [[], [{ ...payload.items[0], Id: '456' }], [{ ...payload.items[0], Title: 'Different job' }]]) {
    assert.equal(await readPublishedAtsPostingEmployer('oracle', slug, job, {
      registry: async () => { assert.fail('Unverified posting must not reach employer rules'); },
      fetchPage: async target => target === url ? response(header, canonical) : response(JSON.stringify({ items }), target),
    }), '');
  }
});

test('Oracle recovery refuses redirected detail API responses and conflicting corporate redirects', async () => {
  for (const redirected of ['api', 'corporate']) {
    assert.equal(await readPublishedAtsPostingEmployer('oracle', slug, job, {
      registry: async () => '', fetchPage: async target => {
        if (target === url) return response(header, canonical);
        if (target.includes('recruitingCEJobRequisitionDetails')) return response(JSON.stringify(payload),
          redirected === 'api' ? target.replace('customer.', 'other.') : target);
        if (target === 'https://employer.example/') return response('<meta property="og:site_name" content="Wrong employer">', 'https://other.example/');
        return response('{}', target);
      },
    }), '');
  }
});

const board = '/TENANT/JobBoard/6ca32cd1-ca64-4d8f-82e7-f65b3aaa0e9b';
const id = '14ce5fe4-5d06-404d-8583-07a8c01f5bdf';
const ukgUrl = `https://recruiting2.ultipro.com${board}/OpportunityDetail?opportunityId=${id}`;
const ukgSlug = `recruiting2.ultipro.com::TENANT::${board.split('/').at(-1)}`;
const ukgJob = { url: ukgUrl, title: job.title, publicAtsPostingId: id, company: '' };
const ukgHtml = `<script>new US.Opportunity.CandidateOpportunityDetail(${JSON.stringify({
  Id: id, Title: job.title, Description: '<p>Join Example Employer, a growing team.</p>',
})});</script><script>var params = ${JSON.stringify({ opportunityTitle: job.title, jobBoardName: 'Example Employer Opportunities' })};
var alias = "OpportunityDetail.Index.PageTitle";</script>`;

test('UKG saved items recover exact posting evidence through a host migration without guessing from tenant IDs', async () => {
  const before = structuredClone(ukgJob);
  assert.equal(await readPublishedAtsPostingEmployer('ukg', ukgSlug, ukgJob, {
    registry: async () => '', fetchPage: async () => response(ukgHtml, ukgUrl.replace('recruiting2.ultipro.com', 'employer.rec.pro.ukg.net')),
  }), 'Example Employer');
  assert.deepEqual(ukgJob, before);
});

test('UKG recovery rejects another board, another opportunity, external hosts and changed titles', async () => {
  for (const landed of [ukgUrl.replace('TENANT', 'OTHER'), ukgUrl.replace(id, '24ce5fe4-5d06-404d-8583-07a8c01f5bdf'),
    ukgUrl.replace('recruiting2.ultipro.com', 'external.example')]) {
    assert.equal(await readPublishedAtsPostingEmployer('ukg', ukgSlug, ukgJob, {
      registry: async () => '', fetchPage: async () => response(ukgHtml, landed),
    }), '');
  }
  assert.equal(await readPublishedAtsPostingEmployer('ukg', ukgSlug, { ...ukgJob, title: 'Different job' }, {
    registry: async () => '', fetchPage: async () => response(ukgHtml, ukgUrl),
  }), '');
});

test('missing or inconsistent saved posting identity cannot initiate recovery requests', async () => {
  for (const invalid of [{ ...job, publicAtsPostingId: '' }, { ...job, publicAtsPostingId: '456' },
    { ...job, title: '' }, { ...job, url: canonical }]) {
    assert.equal(await readPublishedAtsPostingEmployer('oracle', slug, invalid, {
      registry: async () => { assert.fail(); }, fetchPage: async () => { assert.fail(); },
    }), '');
  }
});
