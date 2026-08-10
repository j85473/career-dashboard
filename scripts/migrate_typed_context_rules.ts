import 'dotenv/config';

import { createHash } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';

import {
  typedContextRule,
  validateTypedContextRules,
} from '../src/lib/contextFeedbackPolicy';

const prisma = new PrismaClient();
const MIGRATION_ID = 'typed-context-bootstrap-2026-08-09';
const PROFILE_ID = 'global';
const EMPTY_SENTINEL = 'No established negative preference rules.';

type Arguments = {
  apply: boolean;
  confirmSelection?: string;
};

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') {
      parsed.apply = true;
    } else if (argument === '--confirm-selection') {
      parsed.confirmSelection = argv[index + 1] || '';
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (parsed.apply && !/^[a-f0-9]{64}$/i.test(parsed.confirmSelection || '')) {
    throw new Error('Apply mode requires --confirm-selection <dry-run-sha256>');
  }
  return parsed;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ruleKey(id: string): string {
  // Use the same content-derived key as every future native Context import so
  // the bootstrap cannot create a parallel copy of an existing rule.
  return id;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const [schema] = await prisma.$queryRaw<Array<{ contextRules: boolean }>>`
    SELECT to_regclass('"ContextRule"') IS NOT NULL AS "contextRules";
  `;
  if (args.apply && !schema?.contextRules) {
    throw new Error('Apply mode requires the expand migration (ContextRule is missing)');
  }
  const profile = await prisma.contextProfile.findUnique({
    where: { id: PROFILE_ID },
    select: { id: true, rulesText: true, updatedAt: true },
  });
  if (!profile) {
    throw new Error(`Context profile ${PROFILE_ID} does not exist`);
  }

  const validation = validateTypedContextRules(profile.rulesText);
  const accepted = validation.accepted.filter((rule) => rule.text !== EMPTY_SENTINEL);
  const rejected = validation.rejected.map((rule) => ({
    ...rule,
    typed: typedContextRule(rule.text),
  }));
  const selection = {
    migrationId: MIGRATION_ID,
    profileId: profile.id,
    profileUpdatedAt: profile.updatedAt.toISOString(),
    profileHash: sha256(profile.rulesText),
    accepted: accepted.map((rule) => ({
      ruleKey: ruleKey(rule.id),
      text: rule.text,
      dimension: rule.dimension,
      scope: rule.scope,
    })),
    retired: rejected.map((rule) => ({
      ruleKey: ruleKey(rule.typed.id),
      text: rule.text,
      dimension: rule.typed.dimension,
      scope: rule.typed.scope,
      reason: rule.reason,
    })),
  };
  const selectionHash = sha256(`${JSON.stringify(selection)}\n`);
  const report = {
    mode: args.apply ? 'apply' : 'dry-run',
    selectionHash,
    ...selection,
  };

  if (!args.apply) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.stderr.write(
      `Dry run only. Review selection hash ${selectionHash}, then rerun with --apply --confirm-selection ${selectionHash}.\n`,
    );
    return;
  }
  if (args.confirmSelection !== selectionHash) {
    throw new Error(`Selection changed: expected ${args.confirmSelection}, current ${selectionHash}. Run a new dry run.`);
  }

  const migratedAt = new Date();
  const acceptedKeys = accepted.map((rule) => ruleKey(rule.id));
  const retiredKeys = rejected.map((rule) => ruleKey(rule.typed.id));

  await prisma.$transaction(async (tx) => {
    const currentProfile = await tx.contextProfile.findUnique({
      where: { id: PROFILE_ID },
      select: { rulesText: true, updatedAt: true },
    });
    if (
      !currentProfile
      || currentProfile.updatedAt.getTime() !== profile.updatedAt.getTime()
      || sha256(currentProfile.rulesText) !== selection.profileHash
    ) {
      throw new Error('Context profile changed after the dry run; transaction aborted');
    }

    for (const rule of accepted) {
      await tx.contextRule.upsert({
        where: { ruleKey: ruleKey(rule.id) },
        create: {
          contextProfileId: PROFILE_ID,
          ruleKey: ruleKey(rule.id),
          dimension: rule.dimension,
          scope: rule.scope,
          ruleText: rule.text,
          sourceDecisionIds: [],
          confidence: null,
          active: true,
          lastConfirmedAt: migratedAt,
          provenance: {
            migrationId: MIGRATION_ID,
            source: rule.source,
            confidence: rule.confidence,
            sourceProfileHash: selection.profileHash,
          } satisfies Prisma.InputJsonValue,
        },
        update: {
          dimension: rule.dimension,
          scope: rule.scope,
          ruleText: rule.text,
          active: true,
          retiredAt: null,
          retiredReason: null,
          lastConfirmedAt: migratedAt,
          provenance: {
            migrationId: MIGRATION_ID,
            source: rule.source,
            confidence: rule.confidence,
            sourceProfileHash: selection.profileHash,
          } satisfies Prisma.InputJsonValue,
        },
      });
    }

    for (const rule of rejected) {
      await tx.contextRule.upsert({
        where: { ruleKey: ruleKey(rule.typed.id) },
        create: {
          contextProfileId: PROFILE_ID,
          ruleKey: ruleKey(rule.typed.id),
          dimension: rule.typed.dimension,
          scope: rule.typed.scope,
          ruleText: rule.text,
          sourceDecisionIds: [],
          confidence: null,
          active: false,
          retiredAt: migratedAt,
          retiredReason: rule.reason,
          provenance: {
            migrationId: MIGRATION_ID,
            source: rule.typed.source,
            confidence: rule.typed.confidence,
            sourceProfileHash: selection.profileHash,
          } satisfies Prisma.InputJsonValue,
        },
        update: {
          dimension: rule.typed.dimension,
          scope: rule.typed.scope,
          ruleText: rule.text,
          active: false,
          retiredAt: migratedAt,
          retiredReason: rule.reason,
          provenance: {
            migrationId: MIGRATION_ID,
            source: rule.typed.source,
            confidence: rule.typed.confidence,
            sourceProfileHash: selection.profileHash,
          } satisfies Prisma.InputJsonValue,
        },
      });
    }

    await tx.contextRule.updateMany({
      where: {
        contextProfileId: PROFILE_ID,
        ruleKey: { startsWith: 'legacy-' },
        active: true,
        ...(acceptedKeys.length + retiredKeys.length > 0
          ? { ruleKey: { startsWith: 'legacy-', notIn: [...acceptedKeys, ...retiredKeys] } }
          : {}),
      },
      data: {
        active: false,
        retiredAt: migratedAt,
        retiredReason: `${MIGRATION_ID}: no longer present in the selected legacy profile`,
      },
    });
  });

  process.stdout.write(`${JSON.stringify({ ...report, appliedAt: migratedAt.toISOString() }, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
