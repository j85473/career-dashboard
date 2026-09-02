// Capacity reservations are not work receipts. Only clear a reservation after
// its expiry; the atomic predicate preserves any concurrently renewed lease.
async function reclaimExpiredAtsWorkerSlots(prisma, now) {
  const result = await prisma.atsAcquisitionWorkerSlot.updateMany({
    where: {
      leaseToken: { not: null },
      leaseExpiresAt: { lte: now },
    },
    data: {
      leaseOwner: null,
      leaseToken: null,
      workerKind: null,
      releaseId: null,
      acquiredAt: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
    },
  });
  return result.count;
}

module.exports = { reclaimExpiredAtsWorkerSlots };
