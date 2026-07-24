import { verifyInboxJobsAlive } from './src/lib/verifyJobsAlive';

async function main() {
  await verifyInboxJobsAlive(console.log);
}
main().catch(console.error);
