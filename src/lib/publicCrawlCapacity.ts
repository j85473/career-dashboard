import { Prisma } from './prismaClient';
import { atsRunnableLegacyBatchSql, atsRunnableSegmentSql } from './atsAdmissionCapacity';

/** Public crawlers persist bounded jobs directly; they do not append API
 * listing observations. Keep the operator gate and runnable writer pressure,
 * without charging them for another provider's unfinished catalogue. */
export async function publicCrawlCapacity(client: Pick<Prisma.TransactionClient, '$queryRaw'>, now = new Date()) {
    const [snapshot] = await client.$queryRaw<Array<{ persistence: bigint; gate: string }>>(Prisma.sql`
        SELECT (COALESCE((SELECT SUM(GREATEST(segment."itemCount"-segment."processingOffset",0))
            FROM "AtsIngestionSegment" segment WHERE ${atsRunnableSegmentSql(now)}),0)
          + COALESCE((SELECT SUM(GREATEST(batch."jobCount"-batch."processingOffset",0))
            FROM "AtsIngestionBatch" batch WHERE ${atsRunnableLegacyBatchSql(now)}),0))::bigint AS persistence,
          (SELECT "admissionState" FROM "AtsAcquisitionRuntimeGate" WHERE id='global') AS gate
    `);
    const configured = Number(process.env.ATS_ACQUISITION_JOB_LOW_WATERMARK || 1000);
    const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : 1000;
    const persistence = Number(snapshot?.persistence || 0);
    // Reserve a full public-board turn, even though writes are sequential.
    return { healthy: !!snapshot && snapshot.gate === 'open' && persistence + 50 < limit, persistence, limit };
}
