const fs = require('fs');

const start = parseInt(process.argv[2]);
const end = parseInt(process.argv[3]);

let subagents = [];
for (let i = start; i <= end; i++) {
  subagents.push({
    Prompt: `Review chunks/chunk_${i}.json. Identify junk (non-tech, scam, entry-level, medical, retail, etc). Write purely JSON report to chunks/chunk_${i}_result.json: {"junk_ids":[], "patterns":[]}. Then send message 'DONE'. DO NOT SCORE.`,
    Role: `Reviewer ${i}`,
    TypeName: "self"
  });
}

console.log(JSON.stringify(subagents, null, 2));
