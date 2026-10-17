/** Read-only deterministic browser fixture; no database or vendor requests. */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import { BrowserAtsReader } from '../src/lib/browserAtsReader';

async function main() {
    const board = 'https://www.paycomonline.net/v4/ats/web.php/portal/74B8425BF3D1B3ACB19CC1353DC5FA0E/career-page';
    const profile = await mkdtemp(path.join(tmpdir(), 'ats-replay-fixture-'));
    const context = await launchPersistentContext({ userDataDir: profile, headless: true });
    const reader = new BrowserAtsReader(context, async () => {});
    const html = `<!doctype html><html><body><p>3 Results</p>
      <div id="jobs"><a href="${board.replace('/career-page', '/jobs/1')}">Account Manager 1</a></div>
      <button id="two" hidden onclick="move(2)">2</button>
      <button id="three" hidden onclick="move(3)">3</button>
      <script>
        setTimeout(()=>document.getElementById('two').hidden=false,3000);
        function move(page){
          document.getElementById('two').hidden=true;
          document.getElementById('three').hidden=true;
          setTimeout(()=>{
            document.getElementById('jobs').innerHTML='<a href="${board.replace('/career-page', '/jobs/')}'+page+'">Account Manager '+page+'</a>';
            if(page===2)setTimeout(()=>document.getElementById('three').hidden=false,2500);
          },1600);
        }
      </script></body></html>`;
    await context.route('**/*', route => route.request().url() === board
        ? route.fulfill({ status: 200, contentType: 'text/html', body: html })
        : route.abort());
    try {
        const second = await reader.page('paycom', board, 2);
        assert.deepEqual(second.links.map(link => link.id), ['2']);
        assert.ok(second.next, 'The delayed third-page control must be retained');
        const third = await reader.page('paycom', board, 3);
        assert.deepEqual(third.links.map(link => link.id), ['3']);
        assert.equal(third.next, null);
        console.log(JSON.stringify({ fixture: 'delayed controls and delayed posting identities', checkedAt: new Date(), controlDelayMs: 3000, pageTransitionDelayMs: 1600, subsequentControlDelayMs: 2500, page2: second.links.map(link => link.id), page3: third.links.map(link => link.id), ok: true }));
    } finally {
        await reader.close();
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
