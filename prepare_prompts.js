const fs = require('fs');
const profiles = JSON.parse(fs.readFileSync('profiles.json', 'utf8'));
const resume = fs.readFileSync('data/resumes/core_resume.txt', 'utf8');

for (let i = 0; i < 45; i++) {
  const chunk = JSON.parse(fs.readFileSync(`queue_chunks/chunk_${i}.json`, 'utf8'));
  const prompt = `Here is the user's Context DB rules:
${profiles.context}

Here is the user's Wildcard preferences:
${profiles.wildcard}

Here is the user's Resume:
${resume}

Please evaluate the following jobs:
${JSON.stringify(chunk, null, 2)}
`;
  fs.writeFileSync(`queue_chunks/prompt_${i}.txt`, prompt);
}
console.log('Prompts created.');
