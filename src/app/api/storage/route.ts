import { readStoragePressure } from '@/lib/storagePressure';

export const dynamic = 'force-dynamic';
export async function GET() {
  return Response.json(readStoragePressure(), { headers: { 'Cache-Control': 'no-store' } });
}
