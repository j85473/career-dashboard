const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync('context_queue_jobs.json', 'utf8'));
if (!fs.existsSync('queue_chunks')) fs.mkdirSync('queue_chunks');
let chunkIndex = 0;
for (let i = 0; i < jobs.length; i += 5) {
  const chunk = jobs.slice(i, i + 5);
  fs.writeFileSync(`queue_chunks/chunk_${chunkIndex}.json`, JSON.stringify(chunk, null, 2));
  chunkIndex++;
}
console.log(`Created ${chunkIndex} chunks.`);
