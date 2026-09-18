#!/usr/bin/env node
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  const unfinished = await prisma.atsDiscoveryAuditRun.findFirst({
    where: { status: { in: ['running', 'validating'] } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, status: true },
  });

  if (!unfinished) {
    console.log('[Deploy] No unfinished exhaustive discovery audit needs to resume.');
    process.exitCode = 1;
    return;
  }

  console.log(`[Deploy] Exhaustive discovery audit ${unfinished.id} is ${unfinished.status}; it will resume after activation.`);
}

main()
  .catch((error) => {
    console.error('[Deploy] Unable to determine discovery-audit recovery state:', error);
    process.exitCode = 2;
  })
  .finally(() => prisma.$disconnect());
