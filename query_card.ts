import fs from 'fs';
const content = fs.readFileSync('src/components/JobList.tsx', 'utf8');
console.log(content.includes('luckyFitScore'));
