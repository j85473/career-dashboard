import { canonicalJsonSha256 } from '../../src/lib/scoringCanonicalJson';
import { oraclePostingDetailUrl } from '../../src/lib/oraclePosting';
import type { RetainedEmployerBoard } from '../../src/lib/retainedAtsEmployerRepair';

export function employerProofFixture(posting = false): RetainedEmployerBoard {
  const boardUrl = 'https://fixture.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX/';
  const corporate = 'https://fixture-employer.example/';
  const job = { publicAtsPostingId: '1000', title: 'Account Manager', company: '', url: `${boardUrl}job/1000/` };
  const responses = posting ? [
    { requestedUrl: job.url, responseUrl: job.url, status: 200, body: '<html>Job posting</html>' },
    { requestedUrl: oraclePostingDetailUrl(job.url)!.href, responseUrl: oraclePostingDetailUrl(job.url)!.href, status: 200,
      body: JSON.stringify({ items: [{ Id: '1000', Title: job.title, LegalEmployer: 'Verified Employer',
        ExternalDescriptionStr: '<p>Manage accounts.</p>' }] }) },
  ] : [
    { requestedUrl: boardUrl, responseUrl: boardUrl, status: 200,
      body: `<script type="text/html" id="custom-header"><a class="brand-logo" href="${corporate}">Home</a></script>` },
    { requestedUrl: corporate, responseUrl: corporate, status: 200,
      body: '<meta property="og:site_name" content="Verified Employer">' },
  ];
  return { platform: 'oracle', slug: 'fixture.fa.us2.oraclecloud.com::CX', company: 'Verified Employer',
    checkedAt: new Date().toISOString(), error: null, segments: [],
    ...(posting ? { job, evidence: { company: 'Verified Employer', description: 'Manage accounts.', location: null } } : {}),
    sources: responses.map(source => ({ ...source, hash: canonicalJsonSha256(source.body) })) };
}
