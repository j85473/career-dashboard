import { passesPreFilter } from './src/lib/jobFiltering';
import * as fs from 'fs';

const data = JSON.parse(fs.readFileSync('./chunks/chunk_39.json', 'utf-8'));
const junk_ids: string[] = [];
const patterns: string[] = [];

for (const job of data) {
    const result = passesPreFilter(job);
    if (!result.passes) {
        junk_ids.push(job.id);
        if (!patterns.includes(result.reason)) {
            patterns.push(result.reason);
        }
    }
}

fs.writeFileSync('./chunks/chunk_39_result.json', JSON.stringify({ junk_ids, patterns }));
console.log("Done");
