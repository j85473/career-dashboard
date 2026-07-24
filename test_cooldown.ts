import { PrismaClient } from '@prisma/client';
import { enforceRetroactiveCooldowns } from './src/lib/cooldownRecovery';

const prisma = new PrismaClient();
async function main() {
  await enforceRetroactiveCooldowns(console.log);
  
  const verkadaInbox = await prisma.job.findMany({
    where: { company: { contains: 'verkada', mode: 'insensitive' }, OR: [{ status: 'cooldown' }, { luckyStatus: 'cooldown' }] }
  });
  console.log("Verkada cooldown jobs:", verkadaInbox.length);
}
main().catch(console.error).finally(() => prisma.$disconnect());
