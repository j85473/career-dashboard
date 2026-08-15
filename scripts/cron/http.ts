import './env';

function dashboardUrl(pathname: string): URL {
  const baseUrl = process.env.DASHBOARD_URL || 'http://localhost:3000';
  return new URL(pathname, baseUrl);
}

function authorizationHeader(): string {
  const secret = process.env.PIPELINE_SECRET?.trim();
  if (!secret) throw new Error('PIPELINE_SECRET is required for scheduled API calls.');
  return `Bearer ${secret}`;
}

async function dashboardRequest(pathname: string, method: 'GET' | 'POST', timeoutMs: number): Promise<Response> {
  const url = dashboardUrl(pathname);
  const response = await fetch(url, {
    method,
    headers: { Authorization: authorizationHeader() },
    signal: AbortSignal.timeout(timeoutMs),
  });

  return response;
}

export async function postDashboard(pathname: string, timeoutMs = 30_000): Promise<string> {
  const response = await dashboardRequest(pathname, 'POST', timeoutMs);
  const body = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body;
}

export async function getDashboardJson<T>(pathname: string, timeoutMs = 30_000): Promise<T> {
  const response = await dashboardRequest(pathname, 'GET', timeoutMs);
  const body = await response.text();
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${body.slice(0, 500)}`);
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`${pathname} returned invalid JSON.`);
  }
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runScheduledTask(label: string, pathname: string, timeoutMs?: number): Promise<void> {
  console.log(`=== ${label} ===`);
  console.log(await postDashboard(pathname, timeoutMs));
}

export async function runDiscoveryAndWait(): Promise<void> {
  console.log('=== STARTING ATS DISCOVERY ===');
  console.log(await postDashboard('/api/ats-companies/discover'));

  const deadline = Date.now() + 6 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const status = await getDashboardJson<{ isRunning?: boolean; logs?: string[] }>('/api/ats-companies/discover');
    const logs = Array.isArray(status.logs) ? status.logs : [];
    const joinedLogs = logs.join('\n');

    if (!status.isRunning) {
      if (/\[Process error:/i.test(joinedLogs) || /\[Discovery process failed/i.test(joinedLogs)) {
        throw new Error(`ATS discovery failed: ${logs.slice(-5).join(' | ')}`);
      }
      if (/\[Discovery process completed successfully\]/i.test(joinedLogs)) {
        console.log('ATS discovery completed successfully.');
        return;
      }
      throw new Error(`ATS discovery stopped without a success marker: ${logs.slice(-5).join(' | ')}`);
    }

    await sleep(10_000);
  }

  throw new Error('ATS discovery exceeded its six-hour schedule timeout.');
}

export async function runPipelineAndWait(): Promise<void> {
  console.log('=== STARTING CAREER DASHBOARD PIPELINE ===');
  let startBody: string;
  try {
    startBody = await postDashboard('/api/pipeline/run');
  } catch (error) {
    // The pipeline runs continuously, so cron finding it already up is the
    // normal case every minute — not a failure. Treating it as one produced
    // ~1,400 error exits a day and buried real failures in the log.
    const message = error instanceof Error ? error.message : String(error);
    if (/Pipeline already running/i.test(message)) {
      console.log('Pipeline is already running; nothing to start.');
      return;
    }
    throw error;
  }
  console.log(startBody);
  try {
    const startResult = JSON.parse(startBody) as { paused?: boolean };
    if (startResult.paused === true) {
      console.log('Pipeline schedule is paused; waiting for a manual resume.');
      return;
    }
  } catch {
    // The HTTP helper already validated the response; non-JSON legacy replies
    // continue through the existing status polling path.
  }

  // The dashboard ticker reads the PipelineState row directly, so this echo is
  // purely for post-mortem. Printing it unchanged every 15s made 61% of the log
  // one repeated line; only transitions are worth keeping.
  let lastReportedLine = '';
  while (true) {
    const status = await getDashboardJson<{
      isRunning?: boolean;
      currentStep?: string;
      stepProgress?: string;
    }>('/api/pipeline/status');
    const currentStep = status.currentStep || 'Unknown';
    const progress = status.stepProgress || '';

    if (/^(Error|Warning)$/i.test(currentStep)) {
      throw new Error(`Pipeline finished in ${currentStep}: ${progress}`);
    }
    if (!status.isRunning) {
      if (/^Idle$/i.test(currentStep) && /complete/i.test(progress)) {
        console.log(progress);
        return;
      }
      throw new Error(`Pipeline stopped in unexpected state ${currentStep}: ${progress}`);
    }

    const line = `[${currentStep}] ${progress}`;
    if (line !== lastReportedLine) {
      console.log(line);
      lastReportedLine = line;
    }
    await sleep(15_000);
  }
}

export function runCronMain(task: () => Promise<void>): void {
  task().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
