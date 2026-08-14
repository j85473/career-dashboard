import type { ChildProcess } from 'node:child_process';

type ProcessGroupKiller = (pid: number, signal: NodeJS.Signals) => void;

/**
 * Signal the detached Unix process group that owns a scraper. On Windows, or
 * if the group is already gone, fall back to Node's exact child handle.
 */
export function signalChildProcessGroup(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
  killGroup: ProcessGroupKiller = process.kill,
): boolean {
  if (platform !== 'win32' && child.pid) {
    try {
      killGroup(-child.pid, signal);
      return true;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
      if (code !== 'ESRCH') throw error;
    }
  }
  return child.kill(signal);
}
