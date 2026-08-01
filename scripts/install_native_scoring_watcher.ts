import 'dotenv/config';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PrismaClient } from '@prisma/client';

import { findRegisteredAgyProjectIds } from '../src/lib/agyProject';

const prisma = new PrismaClient();
const label = 'com.josephlamb.career-dashboard-native-scoring';
const projectRoot = process.cwd();
const agyCommandPermissions = [
  'command(npm run --silent scoring:request -- --source agy)',
  'command(npm run --silent scoring:next -- --request [0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})',
] as const;

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function matchingAgyProjectIds(): string[] {
  const projectsRoot = path.join(os.homedir(), '.gemini', 'config', 'projects');
  return findRegisteredAgyProjectIds(projectsRoot, projectRoot);
}

function hasNativeRunner(agyBin: string, projectId: string): boolean {
  const result = spawnSync(agyBin, ['--project', projectId, 'agents'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
    timeout: 30_000,
  });
  return result.status === 0
    && result.stdout.split(/\r?\n/).some((line) => line.trim() === 'native-scoring-runner-v6');
}

function findAgyRunnerProjectId(agyBin: string): string | null {
  return matchingAgyProjectIds().find((projectId) => hasNativeRunner(agyBin, projectId)) || null;
}

function watcherPlist(agyBin: string, projectId: string): string {
  const runtimeRoot = path.join(projectRoot, 'data', 'runtime');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>--import</string>
    <string>tsx</string>
    <string>${xml(path.join(projectRoot, 'scripts', 'native_scoring_watcher.ts'))}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(projectRoot)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>AGY_BIN</key>
    <string>${xml(agyBin)}</string>
    <key>AGY_PROJECT_ID</key>
    <string>${xml(projectId)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${xml(path.join(runtimeRoot, 'native-scoring-watcher.log'))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(runtimeRoot, 'native-scoring-watcher.error.log'))}</string>
</dict>
</plist>
`;
}

function ensureAgyProjectPermissions(projectId: string, apply: boolean): boolean {
  const configPath = path.join(os.homedir(), '.gemini', 'config', 'projects', `${projectId}.json`);
  const project = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  const outer = typeof project.permissionGrants === 'object' && project.permissionGrants !== null
    ? project.permissionGrants as Record<string, unknown>
    : {};
  const grants = typeof outer.permissionGrants === 'object' && outer.permissionGrants !== null
    ? outer.permissionGrants as Record<string, unknown>
    : {};
  const existing = Array.isArray(grants.allow)
    ? grants.allow.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const missing = agyCommandPermissions.filter((permission) => !existing.includes(permission));
  if (missing.length === 0 || !apply) return missing.length === 0;

  const next = {
    ...project,
    permissionGrants: {
      ...outer,
      permissionGrants: {
        ...grants,
        allow: [...existing, ...missing],
      },
    },
    updatedAt: new Date().toISOString(),
  };
  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  fs.renameSync(temporaryPath, configPath);
  return true;
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') throw new Error('The native scoring watcher installer supports macOS only');
  if (process.argv.slice(2).some((argument) => argument !== '--apply')) throw new Error('Unknown argument');
  const apply = process.argv.includes('--apply');
  const agyBin = process.env.AGY_BIN?.trim() || path.join(os.homedir(), '.local', 'bin', 'agy');
  if (!path.isAbsolute(agyBin) || !fs.existsSync(agyBin)) {
    throw new Error(`Agy CLI was not found at ${agyBin}. Set AGY_BIN to an absolute installed binary.`);
  }
  fs.accessSync(agyBin, fs.constants.X_OK);

  // Installation is intentionally gated on the migration having been applied.
  await prisma.nativeScoringRequest.findFirst({ select: { id: true } });

  const launchAgentsRoot = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plistPath = path.join(launchAgentsRoot, `${label}.plist`);
  if (apply && fs.existsSync(plistPath)) {
    throw new Error(`Watcher plist already exists at ${plistPath}; inspect it before replacing it`);
  }
  let projectId = findAgyRunnerProjectId(agyBin);
  if (!projectId && apply) {
    const registered = spawnSync(agyBin, ['--new-project', 'agents'], {
      cwd: projectRoot,
      encoding: 'utf8',
      shell: false,
    });
    if (registered.status !== 0) {
      throw new Error(`Agy workspace registration failed: ${(registered.stderr || registered.stdout).trim()}`);
    }
    projectId = findAgyRunnerProjectId(agyBin);
  }
  if (!projectId) {
    throw new Error(
      'No Agy project for this workspace exposes native-scoring-runner-v6. Run `agy --new-project agents` once, verify the runner is listed, then retry.',
    );
  }
  const permissionsReady = ensureAgyProjectPermissions(projectId, apply);
  const contents = watcherPlist(agyBin, projectId);
  if (!apply) {
    console.log(
      `Validated watcher configuration for ${plistPath}. ${
        permissionsReady ? 'Narrow Agy command grants are present.' : 'Installation will add only the two native-scoring command grants.'
      } Re-run with --apply to install and start it.`,
    );
    return;
  }

  fs.mkdirSync(launchAgentsRoot, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, 'data', 'runtime'), { recursive: true });
  const temporaryPath = `${plistPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporaryPath, plistPath);

  const uid = process.getuid?.();
  if (!Number.isInteger(uid)) {
    throw new Error('Unable to determine the current macOS user ID for launchctl');
  }
  const domain = `gui/${uid}`;
  const result = spawnSync('/bin/launchctl', ['bootstrap', domain, plistPath], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(`Watcher plist was written, but launchctl bootstrap failed: ${(result.stderr || result.stdout).trim()}`);
  }
  console.log(`Installed and started ${label}. Dashboard scoring requests will now launch native Agy automatically.`);
}

main()
  .catch((error: unknown) => {
    console.error(`Native watcher installation failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
