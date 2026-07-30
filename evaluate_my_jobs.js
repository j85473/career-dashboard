const fs = require('fs');

const jobIds = [
  "c274d254-ac1d-4150-b782-8cfb259acf14",
  "c37fcbe4-3e4d-4a66-bc11-d2574efa33f5",
  "c4b0cdb0-136b-44aa-91c1-98a9ef5b7df6",
  "c611bc0b-151b-46f4-9b4f-f8c6ada8de79",
  "c680fc4c-2d9b-4632-afcf-cc292348e16d"
];

const data = JSON.parse(fs.readFileSync('context_queue_jobs.json', 'utf8'));
const foundJobs = data.filter(job => jobIds.includes(job.id));
fs.writeFileSync('my_found_jobs.json', JSON.stringify(foundJobs, null, 2));
console.log("Found", foundJobs.length, "jobs.");
