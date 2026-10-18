/** Read-only live acceptance smoke: no tasks, board updates, source runs or job writes. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { launchPersistentContext } from 'cloakbrowser';
import { BROWSER_ATS_LAUNCH_BOARDS } from '../src/lib/browserAtsLaunchBoards';
import { browserAtsBoardFromUrl } from '../src/lib/browserAtsBoards';
import { BrowserAtsReader, adpListing, adpDetail } from '../src/lib/browserAtsReader';
async function main() {
    const args = process.argv.slice(2);
    if (args.some(a => !/^--(?:platform=[a-z]+|output=.+)$/.test(a)))
        throw Error('Usage: verify_browser_ats_collectors.ts [--platform=key] [--output=file]');
    const platform = args.find(a => a.startsWith('--platform='))?.split('=')[1], output = args.find(a => a.startsWith('--output='))?.slice(9);
    const profile = await mkdtemp(path.join(tmpdir(), 'public-ats-verification-'));
    const context = await launchPersistentContext({ userDataDir: profile, headless: process.env.BROWSER_ATS_HEADLESS === '1', locale: 'en-US', timezone: 'America/Chicago' });
    const receipts: unknown[] = [];
    const done = new Set<string>();
    try {
        for (const [key, url] of BROWSER_ATS_LAUNCH_BOARDS) {
            if (done.has(key) || platform && platform !== key)
                continue;
            done.add(key);
            const board = browserAtsBoardFromUrl(key, url)!;
            const reader = new BrowserAtsReader(context, async () => { });
            let receipt: Record<string, unknown> = { platform: key, board, checkedAt: new Date().toISOString() };
            try {
                const list = key === 'adp' ? await adpListing(board, 1) : await reader.page(key, board, 1);
                if (!list.links.length)
                    throw Error('Verified launch board currently has no job links');
                const detail = key === 'adp' ? await adpDetail(board, list.links[0]) : await reader.detail(key, board, list.links[0]);
                if (!detail)
                    throw Error('First published posting is unavailable');
                receipt = { ...receipt, links: list.links.length, total: list.total, title: detail.title, company: detail.company, location: detail.location, descriptionCharacters: detail.description.length };
                if (list.links.length > 1) {
                    const secondDetail = key === 'adp' ? await adpDetail(board,list.links[1]) : await reader.detail(key,board,list.links[1]);
                    if (!secondDetail || secondDetail.id !== list.links[1].id) throw Error('Second posting did not retain its identity in the reused detail tab');
                    receipt = { ...receipt, secondDetailMatched: true };
                }
                if (list.next) {
                    const next = key === 'adp' ? await adpListing(board, 2) : await reader.page(key, board, 2, list.next.kind === 'url' ? list.next.url : undefined);
                    const newIds = next.links.filter(b => !list.links.some(a => a.id === b.id)).length;
                    if (!newIds)
                        throw Error('Next page made no posting-identity progress');
                    receipt.secondPageNewIds = newIds;
                }
                receipt.ok = true;
            }
            catch (error) {
                receipt.error = error instanceof Error ? error.message : String(error);
                receipt.ok = false;
                process.exitCode = 1;
            }
            finally {
                await reader.close();
                receipts.push(receipt);
                console.log(JSON.stringify(receipt));
                if (output)
                    await writeFile(output, JSON.stringify(receipts, null, 2));
            }
        }
    }
    finally {
        await context.close();
        await rm(profile, { recursive: true, force: true });
    }
    if (platform && !done.size)
        throw Error('Unknown browser ATS platform');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
