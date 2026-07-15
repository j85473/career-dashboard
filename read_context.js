const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const context = await prisma.contextProfile.findFirst();
  if (context) {
    console.log(context.rulesText);
  } else {
    console.log("No context profile found.");
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
