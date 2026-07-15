#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

const inheritedEnvironment = { ...process.env };
const root = process.cwd();
const envFiles = ['.env', '.env.production', '.env.local', '.env.production.local'];

for (const filename of envFiles) {
  const filePath = path.join(root, filename);
  if (fs.existsSync(filePath)) {
    dotenv.config({ path: filePath, override: true, quiet: true });
  }
}

// Explicit process/service environment remains authoritative over dotenv files.
Object.assign(process.env, inheritedEnvironment);

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('Usage: node scripts/with-env.mjs <command> [args...]');
  process.exit(2);
}

const child = spawn(command, args, {
  env: process.env,
  stdio: 'inherit',
  shell: false,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}

child.on('error', (error) => {
  console.error(`Unable to start ${command}:`, error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`${command} terminated by ${signal}.`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
