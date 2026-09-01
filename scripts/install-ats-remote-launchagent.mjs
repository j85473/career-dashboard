#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APPLY = process.argv.includes('--apply');
const LABEL = 'com.josephlamb.career-dashboard-ats-remote';
const root = process.cwd();
const uid = process.getuid?.();

function command(commandName, args, options = {}) {
  const result = spawnSync(commandName, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(`${commandName} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
  return String(result.stdout || '').trim();
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function plist(input) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.node)}</string>
    <string>${xml(path.join(root, 'scripts/with-env.mjs'))}</string>
    <string>${xml(input.node)}</string>
    <string>${xml(path.join(root, 'scripts/run-ats-remote-worker.mjs'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(root)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ATS_DISTRIBUTED_WORKERS_ENABLED</key>
    <string>true</string>
    <key>ATS_REMOTE_WORKER_SLOTS</key>
    <string>${xml(input.slots)}</string>
    <!-- The lane planner clamps to ATS_ACQUISITION_CONCURRENCY, so it has to
         match the leased slot count or the plan is computed for fewer lanes
         than are actually running. -->
    <key>ATS_ACQUISITION_CONCURRENCY</key>
    <string>${xml(input.slots)}</string>
    <key>ATS_WORKER_RELEASE_ID</key>
    <string>${xml(input.releaseId)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <!-- Unconditional: a clean exit is not a reason to stay down. The worker
       waits out a paused pipeline itself, so if the process is gone at all,
       something ended it and acquisition should come back. -->
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xml(input.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(input.stderrPath)}</string>
</dict>
</plist>
`;
}

async function main() {
  if (uid == null) throw new Error('The ATS remote LaunchAgent requires a local macOS user session.');
  const packagePath = path.join(root, 'package.json');
  if (!fs.existsSync(packagePath) || !fs.existsSync(path.join(root, '.git'))) {
    throw new Error('Run this installer from the Career Dashboard Git worktree root.');
  }
  const releaseId = execFileSync('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (!/^[a-f0-9]{40}$/i.test(releaseId)) throw new Error('Unable to resolve the exact Git release ID.');
  const originMain = command('git', ['-c', 'core.fsmonitor=false', 'rev-parse', 'origin/main']);
  if (originMain !== releaseId) {
    throw new Error(`Mac worker release ${releaseId} is not the deployed origin/main ${originMain}.`);
  }

  const runtimePaths = [
    'package.json',
    'package-lock.json',
    'scripts/run-ats-remote-worker.mjs',
    'scripts/with-env.mjs',
    'scripts/workers/ats-remote-continuation.ts',
    'src/lib/atsAcquisition.ts',
    'src/lib/atsAcquisitionCompatibility.ts',
    'src/lib/atsAcquisitionCoordination.ts',
    'src/lib/atsAcquisitionDispatcherV2.ts',
    'src/lib/atsAcquisitionLedger.ts',
    'src/lib/controlPrisma.ts',
    'src/lib/ingestionControl.ts',
    'src/lib/jobIngestion.ts',
    'src/lib/pipelineState.ts',
    'src/lib/prisma.ts',
  ];
  const dirtyRuntime = command('git', [
    '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '--untracked-files=all', '--', ...runtimePaths,
  ]);
  if (dirtyRuntime) {
    throw new Error(`Mac ATS runtime differs from the deployed release:\n${dirtyRuntime}`);
  }

  const runtimeDirectory = path.join(root, 'data/runtime');
  const launchAgentsDirectory = path.join(os.homedir(), 'Library/LaunchAgents');
  const plistPath = path.join(launchAgentsDirectory, `${LABEL}.plist`);
  const stdoutPath = path.join(runtimeDirectory, 'ats-remote-continuation.log');
  const stderrPath = path.join(runtimeDirectory, 'ats-remote-continuation.error.log');
  // Release B runs every ATS lane here. Default to the gate's 8-slot ceiling
  // and allow a smaller value while ramping the Pi's write load up gradually.
  const slots = Math.max(1, Math.min(
    8,
    Number.parseInt(process.env.ATS_REMOTE_WORKER_SLOTS || '8', 10) || 8,
  ));
  const document = plist({ node: process.execPath, releaseId, stdoutPath, stderrPath, slots });
  const proposal = {
    apply: APPLY,
    label: LABEL,
    releaseId,
    node: process.execPath,
    workingDirectory: root,
    plistPath,
    stdoutPath,
    stderrPath,
  };
  if (!APPLY) {
    console.log(JSON.stringify(proposal));
    return;
  }

  fs.mkdirSync(runtimeDirectory, { recursive: true });
  fs.mkdirSync(launchAgentsDirectory, { recursive: true });
  const temporaryPath = `${plistPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, document, { mode: 0o600 });
  fs.renameSync(temporaryPath, plistPath);

  const domain = `gui/${uid}`;
  spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { encoding: 'utf8' });
  command('launchctl', ['bootstrap', domain, plistPath]);
  command('launchctl', ['kickstart', '-k', `${domain}/${LABEL}`]);
  const status = command('launchctl', ['print', `${domain}/${LABEL}`]);
  console.log(JSON.stringify({ ...proposal, installed: true, status: status.slice(0, 2_000) }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
