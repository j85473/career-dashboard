import 'dotenv/config';

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { prisma } from '../src/lib/prisma';

const VERSION = 'ats-pipeline-watchdog-v1';

/**
 * Watch whether the pipeline is producing, not whether its parts look correct.
 *
 * Every ATS stall on 2026-09-02 had the same shape: a narrow signal was treated
 * as a broad verdict, and nothing downstream noticed the result. One retired
 * board closed a whole platform for six hours. One demotion froze a week of
 * already-downloaded postings. Detail work outranked listing work permanently
 * because no rule measured whether listing was still moving.
 *
 * Each of those was invisible to component-level checks -- every part was doing
 * exactly what it was told. They were all obvious at the outcome level: workers
 * were busy and no board was finishing. That is the signal this watches, and it
 * is why the checks below are deliberately about throughput and blockage rather
 * than about any particular rule being right.
 *
 * Detection is always safe to run. Repair is not, so it is opt-in and confined
 * to the two conditions where the evidence itself proves the block was wrong:
 * a platform closed on board-level evidence, and batches deferred past a
 * horizon by a circuit that is no longer open. Everything else is reported for
 * a human, because a stall whose cause is not yet understood is exactly when
 * automatic action is most likely to make things worse.
 */

const STALL_MINUTES = 30;
const BUSY_RECEIPT_FLOOR = 50;
/**
 * A deferral further out than this is a scheduling decision, not a retry, and
 * is only ever pulled back when the circuit that caused it has since closed.
 */
const DEFERRAL_HORIZON_HOURS = 6;

type Finding = {
  severity: 'critical' | 'warning' | 'info';
  check: string;
  detail: string;
  repairable: boolean;
};

async function scalar(sql: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ n: bigint | number }>>(sql);
  return Number(rows[0]?.n ?? 0);
}

async function collectFindings(): Promise<Finding[]> {
  const findings: Finding[] = [];

  // 1. The outcome check. Workers burning quanta while nothing completes is the
  //    single signal that caught every failure today, whatever the cause.
  //
  //    "No board finished" is not sufficient on its own. A board crosses
  //    listing, compaction, enrichment and sealing before it completes, so for
  //    a while after a restart every lane can be working correctly with nothing
  //    yet finished -- which is exactly what this check reported the first time
  //    it ran, while 883 boards were completing their listing phase. Phase
  //    advancement is the difference between a pipeline that is stuck and one
  //    that is merely mid-flight, so both must be silent before this fires.
  const [processed, receipts, advanced] = await Promise.all([
    scalar(`select count(*) n from "AtsEndpointSweepReceipt"
            where "processedAt" > now() at time zone 'UTC' - interval '${STALL_MINUTES} minutes'`),
    scalar(`select count(*) n from "AtsAcquisitionWorkReceipt"
            where "startedAt" > now() at time zone 'UTC' - interval '${STALL_MINUTES} minutes'`),
    scalar(`select count(*) n from "AtsAcquisitionWorkReceipt"
            where "startedAt" > now() at time zone 'UTC' - interval '${STALL_MINUTES} minutes'
              and "yieldReason" in ('listing_complete','compaction_complete','segments_sealed')`),
  ]);
  if (processed === 0 && advanced === 0 && receipts > BUSY_RECEIPT_FLOOR) {
    findings.push({
      severity: 'critical',
      check: 'no_boards_completing',
      detail: `${receipts} work quanta in ${STALL_MINUTES} minutes, no board finished and no batch `
        + 'advanced a phase. Workers are busy on work that is going nowhere.',
      repairable: false,
    });
  } else if (processed === 0 && advanced > 0) {
    findings.push({
      severity: 'info',
      check: 'in_flight_no_completions',
      detail: `No board finished in ${STALL_MINUTES} minutes, but ${advanced} batches advanced a phase. `
        + 'Normal while the pipeline refills after a restart or a long block.',
      repairable: false,
    });
  }

  // 2. A platform closed on evidence about individual boards. A board serving
  //    HTML or a 404 says nothing about the platform, and closing on it takes
  //    every board on that platform offline for hours.
  const boardLevelCircuits = await prisma.$queryRawUnsafe<Array<{
    provider: string; openUntil: Date | null; lastError: string | null;
  }>>(`select provider, "openUntil", "lastError" from "ProviderCircuit"
       where "openUntil" > now() at time zone 'UTC'
         and provider like 'ATS-%'
         and ("lastError" ilike '%instead of%' or "lastError" ilike '%HTTP 404%')`);
  for (const circuit of boardLevelCircuits) {
    findings.push({
      severity: 'critical',
      check: 'platform_closed_on_board_evidence',
      detail: `${circuit.provider} is closed until ${circuit.openUntil?.toISOString()} because of `
        + `"${circuit.lastError}" -- a condition of one board, not of the platform.`,
      repairable: true,
    });
  }

  // 3. Work parked past the horizon while its platform is reachable.
  const strandedRows = await prisma.$queryRawUnsafe<Array<{ n: bigint; phase: string }>>(
    `select count(*) n, b."acquisitionPhase" phase
       from "AtsIngestionBatch" b
       join "AtsCompany" c on c.slug = b.slug and c.platform = b.platform
      where b."writerMode" = 'v2'
        and b.status in ('fetching','partial','synchronized','reset_draining')
        and c.status = 'active'
        and b."nextAcquireAt" > now() at time zone 'UTC' + interval '${DEFERRAL_HORIZON_HOURS} hours'
        and not exists (
          select 1 from "ProviderCircuit" p
           where p.provider = 'ATS-' || b.platform
             and p."openUntil" > now() at time zone 'UTC')
      group by 2`);
  for (const row of strandedRows) {
    findings.push({
      severity: 'warning',
      check: 'work_deferred_without_a_live_block',
      detail: `${Number(row.n)} active-board ${row.phase} batches are deferred beyond `
        + `${DEFERRAL_HORIZON_HOURS}h although their platform is reachable.`,
      repairable: true,
    });
  }

  // 4. One phase holding every lane. Not a fault on its own -- a genuinely
  //    empty listing queue looks the same -- so it is reported, never repaired.
  const phaseRows = await prisma.$queryRawUnsafe<Array<{ n: bigint; work: string }>>(
    `select count(*) n, "workType" work from "AtsAcquisitionWorkReceipt"
      where "startedAt" > now() at time zone 'UTC' - interval '${STALL_MINUTES} minutes'
      group by 2 order by 1 desc`);
  const total = phaseRows.reduce((sum, row) => sum + Number(row.n), 0);
  const dominant = phaseRows[0];
  if (total > BUSY_RECEIPT_FLOOR && dominant && Number(dominant.n) / total > 0.98) {
    findings.push({
      severity: 'warning',
      check: 'single_phase_monopoly',
      detail: `${dominant.work} is ${Math.round(Number(dominant.n) / total * 100)}% of all work in the `
        + `last ${STALL_MINUTES} minutes. Expected when other queues are empty; a stall if they are not.`,
      repairable: false,
    });
  }

  // 5. The worker is alive and holding capacity.
  const liveSlots = await scalar(
    `select count(*) n from "AtsAcquisitionWorkerSlot"
      where "leaseExpiresAt" > now() at time zone 'UTC'`);
  if (liveSlots === 0) {
    findings.push({
      severity: 'critical',
      check: 'no_live_workers',
      detail: 'No worker slot holds a live lease. Acquisition is stopped, not slow.',
      repairable: false,
    });
  }

  return findings;
}

/**
 * A repair that keeps being needed is a fault, not a cure.
 *
 * The real hazard of unattended repair is not one wrong action, it is a loop:
 * reopen a circuit, watch the same condition close it, reopen it again, and now
 * a provider is being hammered by the thing meant to protect it -- and the
 * recurring fault is invisible because every cycle looks self-healed.
 *
 * So repairs are counted and capped. Past the cap the watchdog stops repairing
 * that action and escalates it to a critical finding, which is the correct
 * outcome: something is re-breaking and a human should know.
 */
const REPAIR_LEDGER = path.join('data', 'runtime', 'ats-watchdog-repairs.json');
const REPAIR_WINDOW_HOURS = 6;
const REPAIR_MAX_PER_WINDOW = 3;

type RepairLedger = Record<string, string[]>;

async function readLedger(): Promise<RepairLedger> {
  try {
    const raw = await fs.readFile(REPAIR_LEDGER, 'utf8');
    return JSON.parse(raw) as RepairLedger;
  } catch {
    return {};
  }
}

function recentRepairs(ledger: RepairLedger, action: string): number {
  const cutoff = Date.now() - REPAIR_WINDOW_HOURS * 3600_000;
  return (ledger[action] || []).filter((stamp) => Date.parse(stamp) > cutoff).length;
}

async function noteRepair(ledger: RepairLedger, action: string): Promise<void> {
  const cutoff = Date.now() - REPAIR_WINDOW_HOURS * 3600_000;
  const kept = (ledger[action] || []).filter((stamp) => Date.parse(stamp) > cutoff);
  kept.push(new Date().toISOString());
  ledger[action] = kept;
  await fs.mkdir(path.dirname(REPAIR_LEDGER), { recursive: true });
  await fs.writeFile(REPAIR_LEDGER, JSON.stringify(ledger, null, 2));
}

async function repair(findings: Finding[]): Promise<Record<string, number>> {
  const applied: Record<string, number> = {};
  const ledger = await readLedger();

  if (findings.some((f) => f.check === 'platform_closed_on_board_evidence')
      && recentRepairs(ledger, 'reopen_circuit') < REPAIR_MAX_PER_WINDOW) {
    await noteRepair(ledger, 'reopen_circuit');
    const rows = await prisma.$queryRawUnsafe<Array<{ provider: string }>>(
      `update "ProviderCircuit" set state='closed', "openUntil"=null,
              "consecutiveFailures"=0, "updatedAt"=now()
        where "openUntil" > now() at time zone 'UTC'
          and provider like 'ATS-%'
          and ("lastError" ilike '%instead of%' or "lastError" ilike '%HTTP 404%')
        returning provider`);
    applied.circuitsReopened = rows.length;
  }

  if (findings.some((f) => f.check === 'work_deferred_without_a_live_block')
      && recentRepairs(ledger, 'resume_batches') < REPAIR_MAX_PER_WINDOW) {
    await noteRepair(ledger, 'resume_batches');
    // Only after the circuits above are closed, so a batch is never pulled
    // forward into a platform that is still refusing calls.
    await prisma.$executeRawUnsafe(`select set_config('career_dashboard.ats_v2_writer','2',false)`);
    const moved = await prisma.$executeRawUnsafe(
      `update "AtsIngestionBatch" b set "nextAcquireAt" = now() at time zone 'UTC'
         from "AtsCompany" c
        where c.slug = b.slug and c.platform = b.platform
          and b."writerMode" = 'v2'
          and b.status in ('fetching','partial','synchronized','reset_draining')
          and c.status = 'active'
          and b."nextAcquireAt" > now() at time zone 'UTC' + interval '${DEFERRAL_HORIZON_HOURS} hours'
          and not exists (
            select 1 from "ProviderCircuit" p
             where p.provider = 'ATS-' || b.platform
               and p."openUntil" > now() at time zone 'UTC')`);
    applied.batchesResumed = Number(moved);
  }

  return applied;
}

async function main(argv: string[]): Promise<void> {
  const shouldRepair = argv.includes('--repair');
  const findings = await collectFindings();
  if (shouldRepair) {
    const ledger = await readLedger();
    for (const [action, check] of [
      ['reopen_circuit', 'platform_closed_on_board_evidence'],
      ['resume_batches', 'work_deferred_without_a_live_block'],
    ] as const) {
      if (findings.some((f) => f.check === check) && recentRepairs(ledger, action) >= REPAIR_MAX_PER_WINDOW) {
        findings.push({
          severity: 'critical',
          check: `${action}_repair_exhausted`,
          detail: `Repaired ${REPAIR_MAX_PER_WINDOW} times in ${REPAIR_WINDOW_HOURS}h and the condition `
            + 'is back. Something is re-breaking; repairing again would only hide it.',
          repairable: false,
        });
      }
    }
  }
  const repaired = shouldRepair ? await repair(findings) : {};
  const critical = findings.filter((f) => f.severity === 'critical');

  console.log(JSON.stringify({
    version: VERSION,
    checkedAt: new Date().toISOString(),
    healthy: findings.length === 0,
    critical: critical.length,
    warnings: findings.filter((f) => f.severity === 'warning').length,
    findings,
    repairMode: shouldRepair,
    repaired,
    note: 'Detection is read-only. Repair only ever reopens a platform closed on board-level evidence '
      + 'and resumes work deferred behind a block that is no longer live; every other finding is left '
      + 'for a human, because an unexplained stall is when automatic action is most likely to hurt.',
  }, null, 2));

  // Non-zero exit so a scheduler or a shell caller can alert without parsing.
  if (critical.length > 0) process.exitCode = 2;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  main(process.argv.slice(2))
    .catch((error) => { console.error(error); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
