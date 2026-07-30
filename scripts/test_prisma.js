const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const prefs = await prisma.userPreference.findMany();
  console.log("Found", prefs.length, "preferences.");
}
run().then(() => prisma.$disconnect()).catch(console.error);
