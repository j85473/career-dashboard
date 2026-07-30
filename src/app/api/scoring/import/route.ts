import { NextResponse } from 'next/server';

export async function POST() {
  return NextResponse.json(
    {
      error: 'Browser JSON score import is disabled.',
      details: [
        'Native V6 scores must be bound to an immutable batch manifest.',
        'Run `npm run scoring:validate` first, then `npm run scoring:import` after reviewing the dry-run summary.',
      ].join(' '),
    },
    { status: 410 },
  );
}
