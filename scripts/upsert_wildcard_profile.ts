import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const FIVE_PILLAR_ARCHETYPE = `The 5-Pillar Dreamer Archetype:
1. Strong Autonomy: The role requires self-direction, high agency, and the ability to operate without a playbook.
2. Builder Mentality: The role involves 0-to-1 work, creating something new from scratch rather than just maintaining.
3. Ambiguity Tolerance: Thrives in chaos, unstructured environments, and rapidly changing startup conditions.
4. Broad Cross-Functional Scope: Wears multiple hats, interacting with various parts of the business.
5. Unique Growth Trajectory: High potential for exponential learning and career growth, unconventional career paths.`;

async function main() {
  await prisma.wildcardProfile.upsert({
    where: { id: 'global' },
    update: { profileText: FIVE_PILLAR_ARCHETYPE },
    create: { id: 'global', profileText: FIVE_PILLAR_ARCHETYPE },
  });
  console.log('Successfully upserted the 5-Pillar Archetype into WildcardProfile.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
