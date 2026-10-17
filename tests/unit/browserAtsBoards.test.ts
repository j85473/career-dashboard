import { auditIndexOrder } from '../../scripts/audit_ats_common_crawl';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BROWSER_ATS_PLATFORMS, browserAtsBoardFromUrl, BROWSER_ATS_PATTERNS } from '../../src/lib/browserAtsBoards';
import { isAtsBoardEnabledForIngestion } from '../../src/lib/atsRotation';
const urls: Record<string,string> = {
 adp:'https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=87997030-820d-4515-bec9-cf549d124af7&jobId=739758',
 avature:'https://koch.avature.net/en_US/careers/JobDetail/United-States-Pricing-Analyst/196285',
 brassring:'https://sjobs.brassring.com/TGnewUI/Search/home/HomeWithPreLoad?partnerid=26350&siteid=6930&jobid=1437380',
 dzconnex:'https://ir-jobs.dzconnex.com/job-details/regional-sales-manager-vacuum-sales-in-sales-jobs-1761611',
 icims:'https://careers-frontdoor.icims.com/jobs/4209/account-manager---las-vegas/job?in_iframe=1',
 paycom:'https://www.paycomonline.net/v4/ats/web.php/portal/E499C93DD23D9EBD99DB3FD65752B720/jobs/207050',
 paylocity:'https://recruiting.paylocity.com/recruiting/jobs/All/e1e0b11b-1e4a-4390-8ed5-be5ffdff3a33/Bectran-INC',
 phenom:'https://jobs.thecignagroup.com/us/en/job/26009190/Vice-President',
 sagehr:'https://talent.sage.hr/d3cc260d-663b-4a01-9960-14c6c709776c/vacancies',
 talemetry:'https://parkercareers.ttcportals.com/jobs/18370468-quality-inspector-cvd',
 taleo:'https://careerglobalhc.taleo.net/careersection/hca/jobdetail.ftl?job=260000SE',
 jobvite:'https://jobs.jobvite.com/carfax/job/oLAXAfwC',
 freshteam:'https://locale.freshteam.com/jobs/cp_cK0btpkn9/founding-account-executive-us',
 cats:'https://mtg.catsone.com/careers/61316-General/jobs/16830637-Regional-Account-Manager-Audio-Visual/',
};
for (const platform of BROWSER_ATS_PLATFORMS) test(`${platform} discovers one stable board and stays out of API acquisition`,()=>{
 const board=browserAtsBoardFromUrl(platform,urls[platform]);
 assert.ok(board);assert.equal(browserAtsBoardFromUrl(platform,board),board);
 assert.equal(isAtsBoardEnabledForIngestion({platform,slug:board}),false);
 assert.ok(BROWSER_ATS_PATTERNS[platform].length);
 assert.equal(browserAtsBoardFromUrl(platform,'https://127.0.0.1/jobs'),null);
 assert.equal(browserAtsBoardFromUrl(platform,'https://jobs.example.com/jobs'),null);
});
test('Reject tenant ambiguity, marketing hosts, disguised hosts and missing public identifiers',()=>{
 for(const [platform,url] of [
 ['icims','https://www.icims.com/jobs/search'], ['avature','https://qakoch.avature.net/careers/SearchJobs'],
 ['icims','https://careers-frontdoor.icims.com.evil.example/jobs/search'],
 ['paylocity','https://recruiting.paylocity.com/Recruiting/Jobs/Details/4588001'],
 ['sagehr','https://talent.sage.hr/jobs/2fed5924-a25e-4664-b1e2-9031913cbf93'],
 ['adp','https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?jobId=739758'],
 ['jobvite','https://jobs.jobvite.com/__assets__/scripts/public.js'],
 ['cats','https://www.catsone.com/careers/61316/'],
 ['adp','https://user:pass@workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html'],
 ])assert.equal(browserAtsBoardFromUrl(platform,url),null,`${platform}: ${url}`);
});

test('new board discovery starts at the newest crawl without changing legacy ordering',()=>{
 const indices=['old-index','new-index'];
 for(const platform of BROWSER_ATS_PLATFORMS) assert.deepEqual(auditIndexOrder(platform,indices),['new-index','old-index']);
 assert.deepEqual(auditIndexOrder('workday',indices),indices);
});
