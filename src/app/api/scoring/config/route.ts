import { scoringV2ExportGateStatus } from '@/lib/scoringRuntimeConfig';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({ exportGates: scoringV2ExportGateStatus() }, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });
}
