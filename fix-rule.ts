import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.userPreference.deleteMany({
    where: { text: { contains: 'I cannot be based out of Oronoco' } }
  });
  
  await prisma.userPreference.create({
    data: {
      type: 'hard_reject',
      text: 'I must be based out of the Minneapolis metro area. Reject jobs that require me to be based in a different city. However, if the job is based in Minneapolis but the sales territory includes other cities/regions, that is acceptable.'
    }
  });
  console.log("Updated UserPreference rule to be more general.");
}
main().catch(console.error).finally(() => prisma.$disconnect());
