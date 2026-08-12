import fs from 'node:fs';
import path from 'node:path';

import { parseScoringExchangeJson, validateExportManifest } from '../src/lib/scoringExchange';

const input = process.argv[2];
if (!input) throw new Error('Usage: npm run scoring:exchange:validate -- <exchange.json>');
const resolved = path.resolve(input);
const parsed = parseScoringExchangeJson(fs.readFileSync(resolved));
if (String(parsed.schemaVersion).endsWith('-export-v1')) validateExportManifest(parsed);
const members = Array.isArray(parsed.jobs) ? parsed.jobs.length : Array.isArray(parsed.results) ? parsed.results.length : 0;
console.log(JSON.stringify({ valid: true, schemaVersion: parsed.schemaVersion, members, path: resolved }));
