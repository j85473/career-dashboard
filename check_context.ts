import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const rules = await prisma.contextProfile.findFirst();
  console.log(rules?.rulesText);
}
main().catch(console.error).finally(() => prisma.$disconnect());
