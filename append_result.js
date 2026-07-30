const fs = require('fs');

const chunkFile = process.argv[2]; 
const resultsFile = process.argv[3]; // We'll write the raw text to a temp file, then process

const chunk = JSON.parse(fs.readFileSync(chunkFile, 'utf8'));
const type = chunk.type;

let resultsJsonStr = fs.readFileSync(resultsFile, 'utf8');
// extract json block if needed
const match = resultsJsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
if (match) {
    resultsJsonStr = match[1];
}

const newResults = JSON.parse(resultsJsonStr);
const filePath = '.agents/eval_chunks/final_results.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

if (type === 'standard') {
    data.standardScores.push(...newResults);
} else if (type === 'wildcard') {
    data.wildcardScores.push(...newResults);
}

fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
console.log('Appended ' + newResults.length + ' results to ' + type);
