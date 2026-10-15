import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tsImport } from 'tsx/esm/api';

const { assertPrismaRehearsalUrl } = await tsImport('../src/lib/prismaRehearsal.ts', import.meta.url);
const configuration = dotenv.parse(readFileSync(new URL('../.env.prisma7', import.meta.url)));
assertPrismaRehearsalUrl(configuration.DATABASE_URL, configuration.DATABASE_RUNTIME_HOST);
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error('Usage: node scripts/prisma7-rehearsal.mjs <command> [arguments...]');
const child = spawn(command, args, {
  env: { ...process.env, ...configuration, PRISMA7_REHEARSAL: '1' },
  stdio: 'inherit',
  shell: false,
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : (code ?? 1); });
