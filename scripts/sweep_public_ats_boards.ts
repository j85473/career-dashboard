import 'dotenv/config';
import { runBrowserAtsWorker } from '../src/lib/browserAtsWorker';
import { prisma } from '../src/lib/prisma';
runBrowserAtsWorker().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
