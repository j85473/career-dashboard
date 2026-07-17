import * as fs from 'fs';
import { passesPreFilter } from './src/lib/jobFiltering';

const data = JSON.parse(fs.readFileSync('./chunks/chunk_19.json', 'utf8'));
const junk_ids: string[] = [];

for (const job of data) {
  const result = passesPreFilter(job);
  if (!result.passes) {
    junk_ids.push(job.id);
  }
}

fs.writeFileSync('./chunks/chunk_19_result.json', JSON.stringify({ junk_ids, patterns: [] }, null, 2));
console.log('Result written to chunk_19_result.json with', junk_ids.length, 'junk jobs.');
