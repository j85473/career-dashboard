import { scoreJobs } from '../src/lib/jobScoring';

async function main() {
  console.log("Starting scoreJobs...");
  const count = await scoreJobs((msg) => {
    console.log(msg);
  });
  console.log("Done. Scored:", count);
}
main().catch(console.error);
