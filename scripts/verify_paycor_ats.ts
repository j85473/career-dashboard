/** Live verification; --apply registers only verified Paycor launch boards. */
import { prisma } from '../src/lib/prisma';
import { BrowserAtsHttpReader } from '../src/lib/browserAtsHttp';
import { BROWSER_ATS_LAUNCH_BOARDS } from '../src/lib/browserAtsLaunchBoards';
import { browserAtsBoardFromUrl } from '../src/lib/browserAtsBoards';
import { recordDiscoveredAtsBoard } from '../src/lib/atsBoardDiscovery';

async function main() {
    if (process.argv.slice(2).some(arg => arg !== '--apply')) throw Error('Usage: verify_paycor_ats.ts [--apply]');
    const apply = process.argv.includes('--apply');
    for (const [platform, url] of BROWSER_ATS_LAUNCH_BOARDS.filter(([platform]) => platform === 'paycor')) {
        const board = browserAtsBoardFromUrl(platform, url)!;
        const reader = new BrowserAtsHttpReader();
        const listing = await reader.page(platform, board, 1);
        if (!listing || !listing.links.length) throw Error('Paycor launch board did not expose current public postings');
        const posting = await reader.detail(platform, board, listing.links[0]);
        if (!posting) throw Error('Paycor launch posting did not verify');
        const outcome = apply ? await prisma.$transaction(tx => recordDiscoveredAtsBoard(tx, { platform, slug: board }, new Date(), {
            status: 'parked', jobsFound: listing.total || 0, browserPending: true, reactivateExisting: false,
        })) : 'preview';
        console.log(JSON.stringify({ platform, board, jobs: listing.links.length, title: posting.title, company: posting.company,
            location: posting.location, descriptionCharacters: posting.description.length, outcome }));
    }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());
