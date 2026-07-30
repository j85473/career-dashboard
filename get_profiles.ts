import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function main() {
  const context = await prisma.contextProfile.findUnique({ where: { id: 'global' } });
  const wildcard = await prisma.wildcardProfile.findUnique({ where: { id: 'global' } });
  console.log(JSON.stringify({ context: context?.rulesText, wildcard: wildcard?.profileText }));
}
main().finally(() => prisma.$disconnect());
