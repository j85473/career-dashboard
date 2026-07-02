import fs from 'fs';

let content = fs.readFileSync('src/lib/jobIngestion.ts', 'utf8');

// Export generateFingerprint
content = content.replace('function generateFingerprint', 'export function generateFingerprint');

fs.writeFileSync('src/lib/jobIngestion.ts', content);
