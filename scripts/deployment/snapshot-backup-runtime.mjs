import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

// These files carry recovery history. Logs and live process coordination do not.
// Read and validate into a private snapshot before tar sees them: the live
// directory is atomically rewritten, and the repair ledger can be mid-write.
export async function snapshotBackupRuntime(source, destination) {
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  for (const name of ['ats-watchdog-repairs.json', 'discover_progress.json']) {
    let contents;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const candidate = await fs.readFile(path.join(source, name), 'utf8');
        const value = JSON.parse(candidate);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('Expected an object');
        }
        if (name === 'ats-watchdog-repairs.json' && !Object.values(value).every(
          (entries) => Array.isArray(entries) && entries.every(
            (stamp) => typeof stamp === 'string' && Number.isFinite(Date.parse(stamp)),
          ),
        )) throw new Error('Invalid repair history');
        contents = candidate;
        break;
      } catch (error) {
        // A discovery checkpoint need not exist until discovery first runs.
        if (error.code === 'ENOENT' && name === 'discover_progress.json') break;
        if (attempt === 2) throw new Error(`Cannot snapshot recovery file ${name}`);
        await delay(50);
      }
    }
    if (contents !== undefined) {
      await fs.writeFile(path.join(destination, name), contents, { mode: 0o600 });
    }
  }
  // Verified logo bytes are retained display assets. Snapshot complete atomic
  // entries only; temporary or corrupt cache files must not fail a DB backup.
  const logoDirectory = path.join(source, 'company-logos');
  let logos;
  try { logos = await fs.readdir(logoDirectory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of logos) {
    if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
    let contents;
    try {
      const filename = path.join(logoDirectory, entry.name);
      if ((await fs.stat(filename)).size > 256 * 1024) continue;
      contents = await fs.readFile(filename, 'utf8');
      const value = JSON.parse(contents);
      if (value.version !== 1 || value.key !== entry.name.slice(0, -5)
        || !Number.isFinite(value.verifiedAt) || typeof value.sourceUrl !== 'string' || typeof value.png !== 'string') continue;
      const png = Buffer.from(value.png, 'base64');
      if (png.length > 128 * 1024 || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) continue;
    } catch { continue; }
    const target = path.join(destination, 'company-logos');
    await fs.mkdir(target, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(target, entry.name), contents, { mode: 0o600 });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Runtime source and snapshot destination are required');
  snapshotBackupRuntime(source, destination).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
