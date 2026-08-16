import crypto from 'node:crypto';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const RAPIDAPI_ASSIGNMENT = /^\s*(?:export\s+)?(RAPIDAPI_KEYS|RAPIDAPI_KEY(?:_[0-9]+)?)\s*=(.*)$/;

function decodeEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.at(-1) === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function canonicalRapidApiKeys(rawValues) {
  const keys = rawValues
    .flatMap((value) => String(value || '').split(/[\n,]/))
    .map((key) => key.trim())
    .filter(Boolean);
  const unique = [...new Set(keys)];
  for (const key of unique) {
    if (key.length < 10 || /[\s,=#]/.test(key)) {
      throw new Error('RapidAPI keys must be at least 10 characters and contain no whitespace, commas, equals signs, or comment markers.');
    }
  }
  if (unique.length === 0) throw new Error('No RapidAPI keys were provided.');
  return unique;
}

export function rapidApiKeysFromEnvText(text) {
  const consolidated = [];
  const legacy = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(RAPIDAPI_ASSIGNMENT);
    if (!match) continue;
    const value = decodeEnvValue(match[2]);
    if (match[1] === 'RAPIDAPI_KEYS') consolidated.push(value);
    else legacy.push(value);
  }
  return canonicalRapidApiKeys(consolidated.some((value) => value.trim()) ? consolidated : legacy);
}

export function replaceRapidApiKeyAssignments(text, keys) {
  const retained = text
    .split(/\r?\n/)
    .filter((line) => !RAPIDAPI_ASSIGNMENT.test(line));
  while (retained.at(-1) === '') retained.pop();
  return `${retained.join('\n')}\nRAPIDAPI_KEYS=${canonicalRapidApiKeys(keys).join(',')}\n`;
}

export function rapidApiKeyFingerprint(keys) {
  const canonical = canonicalRapidApiKeys(keys).join(',');
  return {
    count: canonical.split(',').length,
    sha256: crypto.createHash('sha256').update(canonical).digest('hex'),
  };
}

async function atomicReplaceEnvironment(envPath, keys) {
  const original = await readFile(envPath, 'utf8');
  const currentMode = (await stat(envPath)).mode & 0o777;
  const temporaryPath = `${envPath}.rapidapi-${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, replaceRapidApiKeyAssignments(original, keys), { mode: 0o600, flag: 'wx' });
    await chmod(temporaryPath, currentMode || 0o600);
    await rename(temporaryPath, envPath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const [command, envPath] = process.argv.slice(2);
  if (command === 'canonicalize') {
    process.stdout.write(canonicalRapidApiKeys([await readStdin()]).join(','));
    return;
  }
  if (!envPath) throw new Error('Usage: rapidapi-key-env.mjs <fingerprint|export|normalize|apply> <env-file>');

  if (command === 'apply') {
    await atomicReplaceEnvironment(envPath, canonicalRapidApiKeys([await readStdin()]));
  } else if (command === 'normalize') {
    const text = await readFile(envPath, 'utf8');
    await atomicReplaceEnvironment(envPath, rapidApiKeysFromEnvText(text));
  }

  const keys = rapidApiKeysFromEnvText(await readFile(envPath, 'utf8'));
  if (command === 'export') process.stdout.write(keys.join(','));
  else if (command === 'fingerprint' || command === 'normalize' || command === 'apply') {
    process.stdout.write(`${JSON.stringify(rapidApiKeyFingerprint(keys))}\n`);
  } else {
    throw new Error(`Unknown command: ${command || '(missing)'}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1] === '-') {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
