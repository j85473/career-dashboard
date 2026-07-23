import { scoreJobs } from './src/lib/jobScoring';
async function run() {
  const processed = await scoreJobs((msg) => console.log(msg));
  console.log("Processed:", processed);
}
run();
