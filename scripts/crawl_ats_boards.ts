import { chmodSync, existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { cpus, loadavg } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ATS_WEB_DISCOVERY_DEFAULTS, runAtsWebDiscovery, type WebDiscoveryOptions } from '../src/lib/atsWebDiscovery';
import { normalizeDiscoveryUrl } from '../src/lib/atsWebDiscoveryLinks';
import { AtsWebDiscoveryState } from '../src/lib/atsWebDiscoveryState';

export function parseWebDiscoveryArguments(argv: string[]) {
  const seeds: string[] = [];
  const options: Partial<WebDiscoveryOptions> = {};
  let statePath = process.env.ATS_WEB_DISCOVERY_STATE || 'data/runtime/ats-web-discovery/state.sqlite';
  let publish = false;
  let status = false;
  let help = false;
  let publishLimit = 3;
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (name === '--help') { help = true; continue; }
    if (name === '--publish') { publish = true; continue; }
    if (name === '--status') { status = true; continue; }
    if (!['--state', '--seed', '--seeds-file', '--max-requests', '--max-seconds', '--max-depth', '--max-urls', '--publish-limit'].includes(name)) {
      throw new Error(`Unknown argument: ${name}`);
    }
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
    if (name === '--seed') seeds.push(value);
    else {
      if (values.has(name)) throw new Error(`Duplicate argument: ${name}`);
      values.set(name, value);
    }
  }
  if (values.has('--seeds-file')) {
    seeds.push(...readFileSync(values.get('--seeds-file')!, 'utf8').split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith('#')));
  }
  for (const seed of seeds) if (!normalizeDiscoveryUrl(seed)) throw new Error('Seed is not a valid public HTTP(S) URL');
  if (values.has('--state')) statePath = values.get('--state')!;
  const integers = { '--max-requests': 'maxRequests', '--max-seconds': 'maxSeconds', '--max-depth': 'maxDepth', '--max-urls': 'maxUrls' } as const;
  for (const [flag, key] of Object.entries(integers)) {
    const raw = values.get(flag);
    if (raw !== undefined) {
      const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isSafeInteger(value) || value < (key === 'maxDepth' ? 0 : 1)) throw new Error(`Invalid value for ${flag}`);
      options[key] = value;
    }
  }
  if (values.has('--publish-limit')) {
    const raw = values.get('--publish-limit')!;
    publishLimit = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(publishLimit) || publishLimit < 1 || publishLimit > 20) throw new Error('Publish limit must be between 1 and 20');
  }
  if (status && (publish || seeds.length || Object.keys(options).length)) throw new Error('--status cannot be combined with crawling or publishing');
  return { seeds, options, statePath: path.resolve(statePath), publish, publishLimit, status, help };
}

export function resourcePressure(resources: { load?: number; hostCpuCount?: number; availableMemoryBytes?: number } = {}): string | null {
  // loadavg is host-wide. availableParallelism reflects the service's CPU quota
  // (one under CPUQuota=50%), so using it would pause a healthy 12-CPU host.
  const hostCpuCount = Math.max(1, resources.hostCpuCount ?? cpus().length);
  if ((resources.load ?? loadavg()[0]) > hostCpuCount * 0.85) return 'paused_for_cpu_load';
  // Linux exposes reclaimable memory in MemAvailable. Raw free memory on macOS
  // excludes reclaimable caches and would incorrectly pause a local probe.
  let available = resources.availableMemoryBytes ?? Infinity;
  if (resources.availableMemoryBytes === undefined && process.platform === 'linux') {
    const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (match) available = Number(match[1]) * 1024;
  }
  return available < 1024 ** 3 ? 'paused_for_memory_pressure' : null;
}

async function main() {
  const args = parseWebDiscoveryArguments(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node --import tsx scripts/crawl_ats_boards.ts [options]
  --seed URL                  Add a public starting page (repeatable)
  --seeds-file PATH           Add one starting URL per line; # comments supported
  --state PATH                Dedicated SQLite crawl state
  --max-requests N            Bound crawler requests per pass (default 60)
  --max-seconds N             Bound crawler pass duration (default 300)
  --max-depth N               Bound link distance from a seed (default 5)
  --max-urls N                Bound queued/retry URLs; history is retained (default 500000)
  --status                    Read saved counts without network or database access
  --publish                   Validate and hand off up to three saved board candidates
  --publish-limit N           Handoff batch size, 1-20 (separate from crawl budget)
Without --publish, the Dashboard database is never opened. Reuse --state to resume.`);
    return;
  }
  if (args.status && !existsSync(args.statePath)) throw new Error('No saved crawler state exists at that path');
  if (!args.status) {
    mkdirSync(path.dirname(args.statePath), { recursive: true, mode: 0o700 });
    const disk = statfsSync(path.dirname(args.statePath));
    if (disk.bavail * disk.bsize < 1024 ** 3) throw new Error('Crawler needs at least 1 GiB of free disk space');
  }
  process.umask(0o077);
  const state = new AtsWebDiscoveryState(args.statePath, args.status);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const maximumPendingUrls = args.options.maxUrls ?? ATS_WEB_DISCOVERY_DEFAULTS.maxUrls;
    if (args.status) { console.log(JSON.stringify(state.report(maximumPendingUrls), null, 2)); return; }
    chmodSync(args.statePath, 0o600);
    const result = await runAtsWebDiscovery(state, args.seeds, args.options, { signal: abort.signal, pressure: resourcePressure });
    let handoff: Record<string, number> | undefined;
    if (args.publish && !abort.signal.aborted && !resourcePressure()) {
      const [{ PrismaClient }, { publishAtsWebDiscoveries }, { validateSlug, PLATFORMS }] = await Promise.all([
        import('../src/lib/prismaClient'), import('../src/lib/atsWebDiscoveryHandoff'), import('../src/scripts/discoverATS'),
      ]);
      const client = new PrismaClient();
      try {
        handoff = await publishAtsWebDiscoveries(state, client,
          (platform, slug) => validateSlug(platform as keyof typeof PLATFORMS, slug), args.publishLimit, Date.now, abort.signal);
      } finally { await client.$disconnect(); }
    }
    console.log(JSON.stringify({ statePath: args.statePath, ...result, ...(handoff ? { handoff, inventory: state.report(maximumPendingUrls) } : {}) }, null, 2));
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    state.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'ATS web discovery failed'); process.exitCode = 1; });
}
