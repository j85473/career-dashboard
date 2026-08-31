#!/usr/bin/env node

import { spawn } from 'node:child_process';

const environment = { ...process.env };
if (environment.ATS_REMOTE_DATABASE_HOST) {
  environment.DATABASE_RUNTIME_HOST = environment.ATS_REMOTE_DATABASE_HOST;
} else {
  // Pi releases deliberately use loopback for long-lived local pools. A Mac
  // worker must instead retain the canonical, Tailscale-reachable DB host.
  delete environment.DATABASE_RUNTIME_HOST;
}

if (!environment.DATABASE_URL) {
  console.error('DATABASE_URL is required for the ATS remote continuation worker.');
  process.exit(2);
}
const databaseUrl = new URL(environment.DATABASE_URL);
const runtimeHost = environment.DATABASE_RUNTIME_HOST || databaseUrl.hostname;
if (['localhost', '127.0.0.1', '::1'].includes(runtimeHost)) {
  console.error('The ATS remote continuation worker refuses a loopback PostgreSQL host.');
  process.exit(2);
}

const child = spawn(process.execPath, [
  '--import',
  'tsx',
  'scripts/workers/ats-remote-continuation.ts',
], {
  env: environment,
  stdio: 'inherit',
  shell: false,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 1);
});
