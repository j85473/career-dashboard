import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { NextResponse } from 'next/server';

/**
 * The last weekly board-pruning review.
 *
 * The review has always computed these numbers and always printed them to the
 * system journal, where nobody reads them. That is how the demoted board tier
 * grew past the active catalog unnoticed. This serves the same report to the
 * Dashboard so the state of the board catalog is visible without an SSH
 * session.
 */
const REPORT_PATH = process.env.ATS_BOARD_REVIEW_REPORT
  || path.join(/* turbopackIgnore: true */ process.cwd(), 'data', 'runtime', 'ats-board-review.json');

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const raw = await readFile(REPORT_PATH, 'utf8');
    return NextResponse.json({ available: true, report: JSON.parse(raw) as unknown });
  } catch (error) {
    // A review that has never run is the ordinary state of a fresh install, and
    // is reported as such rather than as a fault. Anything else is a fault.
    const missing = (error as NodeJS.ErrnoException)?.code === 'ENOENT';
    return NextResponse.json({
      available: false,
      reason: missing
        ? 'No weekly board review has been published yet. The first one runs Monday morning.'
        : `The board review could not be read: ${error instanceof Error ? error.message : String(error)}`,
    }, { status: missing ? 200 : 500 });
  }
}
