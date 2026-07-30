const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync('my_found_jobs.json', 'utf8'));
jobs.forEach(job => {
  fs.writeFileSync(`job_${job.id}.txt`, job.description || "");
});
