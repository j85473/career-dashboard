import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BROWSER_ATS_PLATFORMS, publicAtsWorkerPlatforms } from '../../src/lib/browserAtsBoards';
import { postingLinksFromDocuments } from '../../src/lib/browserAtsReader';
import { previewBrowserAtsListingTitle } from '../../src/lib/browserAtsListingFilter';
import { runBrowserAtsWorker } from '../../src/lib/browserAtsWorker';

test('ADP remains HTTP only while Paylocity, iCIMS and Paycom have a licensed fallback owner', () => {
  const http = publicAtsWorkerPlatforms(true), browser = publicAtsWorkerPlatforms();
  assert.deepEqual(http, ['adp', 'icims', 'paycom', 'paylocity']);
  assert.deepEqual(http.filter(platform => browser.includes(platform)), ['icims', 'paycom', 'paylocity']);
  assert.equal(browser.includes('adp'), false);
  assert.deepEqual([...new Set([...http, ...browser])].sort(), [...BROWSER_ATS_PLATFORMS].sort());
  http.pop();
  assert.deepEqual(publicAtsWorkerPlatforms(true), ['adp', 'icims', 'paycom', 'paylocity']);
});

test('HTTP-only collection refuses browser providers before claiming tasks or installing signal handlers', async () => {
  const before = process.listenerCount('SIGTERM');
  await assert.rejects(runBrowserAtsWorker({ platforms: ['taleo'], browserAllowed: false }), /cannot claim/);
  assert.equal(process.listenerCount('SIGTERM'), before);
});

test('Jobvite dedicated titles survive later Apply anchors and authorize only existing exclusions', () => {
  const board = 'https://jobs.jobvite.com/example/jobs';
  const links = postingLinksFromDocuments('jobvite', board, [{ url: board, text: '', html: `
    <table><tr><td class="jv-job-list-name"><a href="/example/job/nurse42">Registered Nurse</a></td></tr></table>
    <a href="/example/job/nurse42">Apply now</a>
    <a href="/example/job/unknown42">Apply now</a>
    <table><tr><td class="jv-job-list-name"><a href="/example/job/sales42">Regional Sales Manager</a></td></tr></table>` }]);
  const nurse = links.find(link => link.id === 'nurse42')!;
  assert.equal(nurse.title, 'Registered Nurse');
  assert.equal(nurse.titleVerified, true);
  assert.equal(previewBrowserAtsListingTitle({ title: nurse.title, titleComplete: nurse.titleVerified }).wouldSkip, true);
  for (const id of ['unknown42', 'sales42']) {
    const link = links.find(link => link.id === id)!;
    assert.equal(previewBrowserAtsListingTitle({ title: link.title, titleComplete: link.titleVerified }).wouldSkip, false);
  }
});

test('the HTTP timer does not require a browser seat and deployment preserves or removes its ownership', () => {
  const service = readFileSync('scripts/deployment/m70/career-dashboard-public-http.service', 'utf8');
  const activation = readFileSync('scripts/deployment/activate-m70.sh', 'utf8');
  assert.match(service, /sweep_public_ats_boards\.ts --http-only/);
  assert.doesNotMatch(service, /cloakbrowser-license\.lock|xvfb-run|cloakbrowser\.env/);
  assert.match(activation, /PUBLIC_HTTP == 0.*systemctl start career-dashboard-public-http\.timer/);
  assert.match(activation, /MODE != maintenance.*PUBLIC_HTTP=0/);
  assert.match(activation, /PUBLIC_HTTP_NEW == 1 && \(PUBLIC_BOARDS == 1 \|\| PUBLIC_BOARDS_NEW == 1\)/);
  assert.match(activation, /stop career-dashboard-public-http\.timer career-dashboard-public-http\.service/);
  assert.match(activation, /rm -f \/etc\/systemd\/system\/career-dashboard-public-http\.timer/);
});
