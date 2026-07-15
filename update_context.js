const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const newRules = `CORE PROFESSIONAL EXPERIENCE & ACHIEVEMENTS:

1. Data-Driven Churn Analysis & Operations:
• Collaborated with internal reporting teams to build a centralized database that successfully paired cancellation data directly with individual sales representative metrics.
• Iterated on this database by introducing cloud APIs to perform generalized data summaries and identify recurring performance patterns, creating a highly successful framework for tracking and addressing churn.

2. Strategic Partner Onboarding:
• Utilized a proactive onboarding strategy of auditing a new channel partner's existing processes early in the relationship to identify operational flaws.
• Immediately followed up constructive criticism with actionable software or process solutions, establishing undeniable utility and value from day one.

3. Product Launches & Relationship Management:
• Cultivated elite, high-trust relationships with channel partners—often leading to personal milestones like wedding invitations—by maintaining complete transparency.
• Drove excitement and adoption during new product launches by framing the conversation entirely around mutual revenue generation and making money together, effectively aligning incentives and bypassing typical launch friction.
`;

async function main() {
  let context = await prisma.contextProfile.findFirst();
  if (context) {
    const updated = await prisma.contextProfile.update({
      where: { id: context.id },
      data: { rulesText: newRules }
    });
    console.log("Updated existing context profile.");
  } else {
    const created = await prisma.contextProfile.create({
      data: {
        id: "global",
        rulesText: newRules
      }
    });
    console.log("Created new context profile.");
  }
}
main().catch(e => { console.error(e); process.exit(1); }).finally(async () => { await prisma.$disconnect(); });
