import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const profile = await prisma.contextProfile.findUnique({ where: { id: 'global' } });
  if (profile) {
    const newRule = '\n\nLOCATION RULES:\n- Base Location: Jobs MUST be based in the Twin Cities metro area (e.g., Minneapolis, St. Paul, etc.). Reject jobs where the base office is outside the metro (like Oronoco, Rochester, Duluth, etc.).\n- Territories: It is completely fine if a job\'s sales territory *includes* Oronoco, greater Minnesota, or surrounding states, as long as the candidate is based in the metro.';
    await prisma.contextProfile.update({
      where: { id: 'global' },
      data: { rulesText: profile.rulesText + newRule }
    });
    console.log("Updated rulesText:", profile.rulesText + newRule);
  }
}
main().catch(console.error).finally(() => prisma.$disconnect());
