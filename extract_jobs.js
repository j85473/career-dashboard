const fs = require('fs');
const jobs = JSON.parse(fs.readFileSync('context_queue_jobs.json', 'utf8'));
const ids = ['13acc6b7-bdb1-49c3-b137-4bc60afa7959', '18ef0796-52e4-466f-be01-ea5a67d75c19', '193cca36-1a59-45fd-a233-2a1df54e641f', '1d782230-6762-484f-8dcb-adfdcd4e9f17', '1e39ac5d-d0b7-41c1-b4d4-381572fe966a'];
const extracted = jobs.filter(j => ids.includes(j.id));
console.log(JSON.stringify(extracted, null, 2));
