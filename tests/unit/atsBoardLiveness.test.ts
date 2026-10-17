import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  LIVENESS_MAX_INCONCLUSIVE_SHARE,
  checkLivenessBrakes,
  classifyLivenessOutcome,
  interleaveByPlatform,
  probeBoardLiveness,
  applyLivenessRetirement,
  type Candidate,
} from '../../scripts/refresh_ats_board_liveness';

const liveness = readFileSync(path.resolve('scripts/refresh_ats_board_liveness.ts'), 'utf8');

function candidate(platform: string, slug: string): Candidate {
  return { platform, slug, boardStatus: 'parked', historicalNotFound: 0, historicalOffHostRedirect: 0,
    everResponded2xx: false, everYieldedJobs: false, jobsInserted: 0, liveStatus: null,
    liveRedirectedOffHost: false, outcome: 'unprobed', postings: null };
}

test('a provider refusal defers its remaining probes while another provider completes', async () => {
  const boards = [candidate('greenhouse','first'), candidate('greenhouse','second'), candidate('lever','other')];
  let calls = 0;
  await probeBoardLiveness(boards, 16, { fetch: async url => {
    calls++;
    return String(url).includes('greenhouse') ? new Response('', {status:429}) : new Response('[]', {headers:{'content-type':'application/json'}});
  }});
  assert.equal(calls, 2);
  assert.equal(boards[0].outcome, 'rate_limited');
  assert.equal(boards[1].outcome, 'provider_backoff');
  assert.equal(boards[1].liveStatus, null);
  assert.equal(boards[2].outcome, 'alive');
});

test('bounded liveness leaves uncontacted boards inconclusive and cannot mark them absent', async () => {
  const boards = [candidate('greenhouse','first'),candidate('lever','other')];
  let clock = 0, calls = 0;
  await probeBoardLiveness(boards, 1, { now: () => clock, budgetMs: 10, fetch: async () => {
    calls++; clock=11; return new Response('', {status:404});
  }});
  assert.equal(calls, 1);
  assert.equal(boards[1].outcome, 'sweep_budget');
  assert.equal(boards[1].liveStatus, null);
});

test('JazzHR XML is recognized as live and parsed with the exact board identity', async () => {
  const board = candidate('jazzhr','example');
  await probeBoardLiveness([board],1,{fetch:async()=>new Response('<jobs><company>Example Inc</company><job><id>123</id><title>Channel Manager</title><description>Enable partners.</description><url>https://example.applytojob.com/apply/abc/channel-manager</url></job></jobs>',{headers:{'content-type':'application/xml'}})});
  assert.equal(board.outcome,'alive');
  assert.equal(board.postings,1);
});

test('Manatal liveness fetches verified configuration before parsing its public page', async () => {
  const board = candidate('manatal','example');
  const urls:string[]=[];
  await probeBoardLiveness([board],1,{fetch:async url=>{
    urls.push(String(url));
    return String(url).includes('/api/') ? new Response(JSON.stringify({count:1,next:null,results:[{hash:'abc',position_name:'Channel Manager',description:'Enable partners.'}]}),{headers:{'content-type':'application/json'}})
      :new Response('<title>Example Inc | Career Page</title>');
  }});
  assert.equal(board.outcome,'alive');
  assert.equal(board.postings,1);
  assert.equal(urls.length,2);
});

test('JobScore liveness respects its hourly feed interval before making contact', async () => {
  const board=candidate('jobscore','example'); let calls=0;
  await probeBoardLiveness([board],1,{reserveJobScore:async()=>false,fetch:async()=>{calls++;return new Response('{}');}});
  assert.equal(calls,0);
  assert.equal(board.outcome,'provider_backoff');
});

test('JobScore renamed boards reserve their canonical feed before liveness downloads it', async () => {
  const board = candidate('jobscore', 'old');
  const reserved: string[] = [], urls: string[] = [];
  await probeBoardLiveness([board], 1, { reserveJobScore: async slug => { reserved.push(slug); return slug !== 'current'; },
    fetch: async url => {
      urls.push(String(url));
      return new Response('<link rel="canonical" href="https://careers.jobscore.com/careers/current"><title>Example Jobs &amp; Careers | Open Positions</title>');
    } });
  assert.deepEqual(reserved, ['old', 'current']);
  assert.equal(urls.length, 1);
  assert.equal(board.outcome, 'provider_backoff');
});

test('retirement rechecks recovered status, new ledger history and its capability before writes',async()=>{
  const writes:string[]=[];
  const tx={atsCompany:{findUnique:async()=>({status:'active'}),updateMany:async()=>{writes.push('board');return{count:1};}},
    atsIngestionBatch:{findFirst:async()=>null,updateMany:async()=>{writes.push('batches');return{count:1};}},
    atsBoardCheckAttempt:{findFirst:async()=>null},$executeRaw:async()=>{writes.push('capability');}};
  const typed=tx as unknown as Parameters<typeof applyLivenessRetirement>[0];
  const board={platform:'greenhouse',slug:'example'};
  assert.equal(await applyLivenessRetirement(typed,board,'absence'),null);
  assert.deepEqual(writes,[]);
  tx.atsCompany.findUnique=async()=>({status:'parked'});
  Object.assign(tx.atsIngestionBatch,{findFirst:async()=>({id:'newly-observed-work'})});
  assert.equal(await applyLivenessRetirement(typed,board,'absence'),null);
  assert.deepEqual(writes,[]);
  tx.atsIngestionBatch.findFirst=async()=>null;
  assert.equal(await applyLivenessRetirement(typed,board,'absence'),1);
  assert.deepEqual(writes,['capability','board','batches']);
});
const review = readFileSync(path.resolve('scripts/review_ats_board_pruning.ts'), 'utf8');
const unit = readFileSync(
  path.resolve('scripts/deployment/m70/career-dashboard-board-pruning.service'),
  'utf8',
);

test('a live board is judged by its own platform payload, not by JSON alone', () => {
  const probe = (platform: string, contentType: string, status = 200, finalHost?: string) =>
    classifyLivenessOutcome({
      platform,
      requestedUrl: `https://acme.${platform}.example/list`,
      finalUrl: `https://${finalHost || `acme.${platform}.example`}/list`,
      status,
      contentType,
    });

  // Personio serves XML. A JSON-only test called 925 healthy Personio boards
  // walled on 2026-09-02, one approval away from retiring them.
  assert.equal(probe('personio', 'text/xml'), 'alive');
  assert.equal(probe('greenhouse', 'application/json'), 'alive');
  assert.equal(probe('personio', 'application/json'), 'wall_own_host');
  assert.equal(probe('greenhouse', 'text/html'), 'wall_own_host');

  // Absence is leaving your own address, or being told there is no such board.
  assert.equal(probe('bamboohr', 'text/html', 200, 'www.bamboohr.com'), 'gone_offhost');
  assert.equal(probe('greenhouse', 'application/json', 404), 'not_found');
  assert.equal(probe('greenhouse', 'application/json', 410), 'not_found');
  // Ours to blame, not the board's.
  assert.equal(probe('greenhouse', 'application/json', 429), 'rate_limited');
  assert.equal(probe('greenhouse', 'application/json', 503), 'server_error');
});

test('one platform dominating the retirements stops the run', () => {
  // The shape of the Personio incident: ~11% of the population, 93% of the
  // bucket. A flat count cap would have waved this through on a large run.
  const blocked = checkLivenessBrakes({
    sweptByPlatform: { personio: 1100, greenhouse: 4450, lever: 4450 },
    retiringByPlatform: { personio: 930, greenhouse: 35, lever: 35 },
    swept: 10000,
    inconclusive: 0,
  });
  assert.equal(blocked.blocked, true);
  assert.match(blocked.blocked ? blocked.reason : '', /personio/);

  // Retirements spread in proportion to the population are ordinary.
  const allowed = checkLivenessBrakes({
    sweptByPlatform: { personio: 1100, greenhouse: 4450, lever: 4450 },
    retiringByPlatform: { personio: 110, greenhouse: 445, lever: 445 },
    swept: 10000,
    inconclusive: 0,
  });
  assert.equal(allowed.blocked, false);
});

test('a throttled sweep retires nothing', () => {
  const share = LIVENESS_MAX_INCONCLUSIVE_SHARE;
  const throttled = checkLivenessBrakes({
    sweptByPlatform: { greenhouse: 10000 },
    retiringByPlatform: { greenhouse: 100 },
    swept: 10000,
    inconclusive: Math.ceil(10000 * share) + 1,
  });
  assert.equal(throttled.blocked, true);
  assert.match(throttled.blocked ? throttled.reason : '', /inconclusive/);

  const clean = checkLivenessBrakes({
    sweptByPlatform: { greenhouse: 10000 },
    retiringByPlatform: { greenhouse: 100 },
    swept: 10000,
    inconclusive: Math.floor(10000 * share) - 1,
  });
  assert.equal(clean.blocked, false);

  // A sweep that found nothing to retire is not a reason to raise an alarm.
  assert.equal(checkLivenessBrakes({
    sweptByPlatform: { greenhouse: 10 },
    retiringByPlatform: {},
    swept: 10,
    inconclusive: 0,
  }).blocked, false);
});

test('platforms are interleaved so no provider sees a contiguous burst', () => {
  const rows = [
    ...Array.from({ length: 3 }, (_, i) => ({ platform: 'a', slug: `a${i}` })),
    ...Array.from({ length: 2 }, (_, i) => ({ platform: 'b', slug: `b${i}` })),
  ];
  assert.deepEqual(
    interleaveByPlatform(rows).map((row) => row.slug),
    ['a0', 'b0', 'a1', 'b1', 'a2'],
  );
  assert.equal(interleaveByPlatform([]).length, 0);
});

test('the weekly probe stays outside the acquisition path', () => {
  // The failure this prevents is the one that cost a night: a sweep taking
  // provider reservations trips a circuit, and one open circuit stops board
  // coverage everywhere behind it.
  assert.match(liveness, /buildAtsBoardRequest/);
  assert.doesNotMatch(liveness, /reserveAtsRequest|recordProviderFailure/);
  assert.match(liveness, /recordPlatformFailures: false, recordThrottle: async \(\) => \{\}/);
  assert.match(liveness, /evaluateProviderAvailability/);
  // And the batch writes must declare the capability, or the board write rolls
  // back with them and the board silently stays in rotation.
  assert.match(liveness, /set_config\('career_dashboard\.ats_v2_writer', '2', true\)/);
  const transaction = liveness.slice(liveness.indexOf('export async function applyLivenessRetirement'));
  assert.ok(
    transaction.indexOf('ats_v2_writer') < transaction.indexOf('atsIngestionBatch.updateMany'),
    'the writer capability must be declared before the batch write it protects',
  );
  // A timer run has nobody reading stderr.
  assert.match(liveness, /if \(failures\.length > 0\) process\.exitCode = 1;/);
});

test('the liveness arm is the only one the weekly run applies by itself', () => {
  assert.match(review, /key: 'board_liveness'/);
  assert.match(review, /autoApply: true/);
  assert.equal(review.match(/autoApply: true/g)?.length, 1);
  // The auto arm must not also print a command, or someone runs it twice.
  assert.match(review, /approvalCommand: !arm\.autoApply/);
  assert.match(review, /\.\.\.\(arm\.autoApply \? \['--auto'\] : \[\]\)/);
  // Weekly, on the rotation's own period, and catching up a missed run.
  assert.match(unit, /refresh_ats_board_liveness|review_ats_board_pruning/);
});

test('an hour-long arm reports its progress instead of running silently', () => {
  // The liveness sweep takes about an hour. Buffering its stderr made the unit
  // print nothing at all until it finished, which is the same shape as the
  // deployment that looked hung on 2026-09-03 and got cancelled mid-flight.
  assert.match(review, /child\.child\.stderr\?\.on\('data'/);
  assert.match(review, /process\.stderr\.write\(`\[\$\{arm\.key\}\]/);
});


test('browser-owned boards never request or fail a nonexistent API liveness endpoint', async()=>{
 const boards=[candidate('icims','https://careers-example.icims.com/jobs/search?in_iframe=1'),candidate('paycom','https://www.paycomonline.net/v4/ats/web.php/portal/E499C93DD23D9EBD99DB3FD65752B720/career-page')];
 let calls=0;
 await probeBoardLiveness(boards,2,{fetch:async()=>{calls++;throw Error('Browser-owned board reached API probe');}});
 assert.equal(calls,0);
 for(const board of boards){assert.equal(board.outcome,'provider_backoff');assert.equal(board.liveStatus,null);}
});
