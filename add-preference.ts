import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.userPreference.create({
    data: {
      type: 'hard_reject',
      text: 'I cannot be based out of Oronoco, MN. If the job requires being based in Oronoco, reject it. If the territory includes Oronoco but is based out of Minneapolis or somewhere in the metro, that is fine.'
    }
  });
  console.log("Added UserPreference for Oronoco nuanced location rule.");
}
main().catch(console.error).finally(() => prisma.$disconnect());
