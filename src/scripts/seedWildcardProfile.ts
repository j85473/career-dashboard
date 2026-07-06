import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const profileText = `# I'm Feeling Lucky: Wildcard Context Profile

## Core Identity & Role Archetype
- **The "Executive-in-Training" / High-Agency Operator**: A highly versatile generalist capable of moving seamlessly from high-level strategic planning to ground-level execution without ego. 
- **The Garbage Disposal for Problems**: Thrives in ambiguous environments where problems don't fit neatly into specific departments (e.g. commercial strategy, GTM, internal ops, special projects).
- **The Builder (0 to 1)**: Energized by standing up new systems, workflows, processes, and tools from scratch rather than maintaining the status quo. 

## Environment Preferences
- **Extreme Autonomy**: Prefers environments with high trust and zero micromanagement. ("Manage yourself entirely — no hand-holding").
- **High-Velocity & High-Stakes**: Wants to work in fast-paced, high-performing environments (e.g., scaling startups, venture studios, tight executive teams).
- **AI-First Culture**: Needs an environment that encourages and expects the use of AI as a force multiplier to amplify output.
- **Leadership Proximity**: Attracted to roles close to real decision-making (e.g., right-hand roles, chief of staff, strategy ops) for exposure, leverage, and learning velocity.

## Commercial & Systems Leverage
- **Commercial Translation**: Experience translates best when a role needs business judgment, sales instincts, customer understanding, and pipeline/process thinking.
- **AI as Leverage**: Drawn to roles where AI fluency creates unusual leverage (e.g., workflow automation, agentic processes, prompt systems, process redesign).

## Extreme Travel
- **Constant Motion**: Admires and desires a lifestyle of constant motion. Highly values roles with extensive travel (planes, trains, automobiles).
- **International**: International travel is the ultimate "holy grail". There is no such thing as "too much travel", especially when tied to meaningful business work (launches, executive support, new markets).

## Hard Rejects (Do Not Recommend)
- Highly siloed, bureaucratic, or rigid corporate environments.
- Roles focused purely on maintaining legacy systems (maintenance mode).
- Executive assistant roles disguised as chief of staff, or project coordinators disguised as strategy roles.
- Pure engineering, ML, or data science roles requiring deep technical credentials.
- Positions where tasks are predetermined, static, and require constant oversight.

## The Golden Exemplar
The following job description (Human Agency: Chief of Staff) is the perfect embodiment of this profile. When evaluating new wildcard jobs, use this as the benchmark for "Vibe Alignment":

"At Human Agency, the chief of staff is the prototype for every person we hire. You're someone who wants to be running a company — a dynamic C-suite leader — but you're choosing to ride shotgun alongside an executive because you know it's the fastest path to getting there... You are floor to ceiling. You will take out the trash, sweep the floors, and then walk into the board meeting and run it. Nothing is beneath you. There is no ceiling above you. You are a garbage disposal for problems... Manage yourself entirely — no hand-holding, no coaching, no check-ins about how your day is going."`;

async function main() {
  await prisma.wildcardProfile.upsert({
    where: { id: 'global' },
    update: { profileText },
    create: { id: 'global', profileText }
  });
  console.log("Wildcard Profile successfully seeded into the database!");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
