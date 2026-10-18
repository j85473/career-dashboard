import 'dotenv/config';
import { prisma } from '../src/lib/prisma';
import { browserAtsBoardFromUrl, type BrowserAtsPlatform } from '../src/lib/browserAtsBoards';
import { recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';
/** Employer-owned boards verified during the October 17 read-only audit. Athena supplies expansion. */
import { BROWSER_ATS_LAUNCH_BOARDS as seeds } from '../src/lib/browserAtsLaunchBoards';
async function main() {
    if (process.argv.slice(2).some(x => x !== '--apply'))
        throw Error('Usage: seed_browser_ats_boards.ts [--apply]');
    const apply = process.argv.includes('--apply');
    for (const [platform, url] of seeds) {
        const slug = browserAtsBoardFromUrl(platform, url);
        if (!slug)
            throw Error('Invalid verified seed: ' + platform);
        const outcome = apply ? await prisma.$transaction(tx => recordDiscoveredAtsBoard(tx, { slug, platform }, new Date(), { status: 'parked', jobsFound: 0, reactivateExisting: false, browserPending: true })) : 'preview';
        console.log(JSON.stringify({ platform, slug, outcome }));
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
