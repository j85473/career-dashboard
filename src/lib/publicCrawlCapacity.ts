import { Prisma } from './prismaClient';
import { atsRunnableLegacyBatchSql, atsSegmentPersistenceCapacitySql } from './atsAdmissionCapacity';
import { ATS_PUBLIC_TURN_JOBS } from './atsPersistenceAllocation';
import { storageAllows } from './storagePressure';

/** Public crawlers persist bounded jobs directly; they do not append API
 * listing observations. Keep the operator gate and runnable writer pressure,
 * without charging them for another provider's unfinished catalogue. */
export async function publicCrawlCapacity(client: Pick<Prisma.TransactionClient, '$queryRaw'>, now = new Date()) {
    if (!storageAllows('collection')) return { healthy: false, persistence: 0, limit: 0 };
    const [snapshot] = await client.$queryRaw<Array<{ persistence: bigint; gate: string }>>(Prisma.sql`
        SELECT (COALESCE((${atsSegmentPersistenceCapacitySql(now)}),0)
          + COALESCE((SELECT SUM(GREATEST(batch."jobCount"-batch."processingOffset",0))
            FROM "AtsIngestionBatch" batch WHERE ${atsRunnableLegacyBatchSql(now)}),0))::bigint AS persistence,
          (SELECT "admissionState" FROM "AtsAcquisitionRuntimeGate" WHERE id='global') AS gate
    `);
    const setting = process.env.ATS_ACQUISITION_JOB_HIGH_WATERMARK?.trim();
    const configured = setting && /^[+-]?\d+$/.test(setting) ? Number(setting) : NaN;
    const limit = Number.isSafeInteger(configured) ? Math.max(100, Math.min(100000, configured)) : 2000;
    const persistence = Number(snapshot?.persistence || 0);
    // Reserve a full public-board turn, even though writes are sequential.
    return { healthy: !!snapshot && snapshot.gate === 'open' && persistence + ATS_PUBLIC_TURN_JOBS <= limit, persistence, limit };
}
