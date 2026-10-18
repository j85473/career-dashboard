import 'dotenv/config';
import { runBrowserAtsWorker } from '../src/lib/browserAtsWorker';
import { BROWSER_ATS_LAUNCH_BOARDS } from '../src/lib/browserAtsLaunchBoards';
import { browserAtsBoardFromUrl, publicAtsWorkerPlatforms } from '../src/lib/browserAtsBoards';
import { prisma } from '../src/lib/prisma';
async function main() {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--verified-seeds', '--http-only'].includes(arg)) || args.length > 1)
        throw Error('Usage: sweep_public_ats_boards.ts [--verified-seeds | --http-only]');
    // A bounded first production collection uses the same task leases, gates and
    // durable board progress. It never forces a task due or discards other work.
    const options = args.includes('--verified-seeds') ? {
        boards: BROWSER_ATS_LAUNCH_BOARDS.map(([platform, url]) => browserAtsBoardFromUrl(platform, url)!),
        maxProviders: 14, maxJobs: 3, budgetMs: 8 * 60_000,
    } : { platforms: publicAtsWorkerPlatforms(args.includes('--http-only')), browserAllowed: !args.includes('--http-only') };
    await runBrowserAtsWorker(options);
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
