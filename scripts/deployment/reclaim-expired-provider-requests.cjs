// Request reservations are capacity fences. Expired reservations no longer
// authorize contact; an atomic expiry predicate protects a renewed lease.
async function reclaimExpiredProviderRequests(prisma, now) {
  const result = await prisma.providerCircuit.updateMany({
    where: { requestLeaseToken: { not: null }, requestLeaseExpiresAt: { lte: now } },
    data: { requestLeaseToken: null, requestLeaseOwner: null, requestLeaseExpiresAt: null },
  });
  return result.count;
}

module.exports = { reclaimExpiredProviderRequests };
