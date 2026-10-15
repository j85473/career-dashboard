# Prisma 7 upgrade rehearsal

This branch upgrades the Dashboard's database client and CLI to Prisma 7.10.0.
It follows the separate routine dependency update commit `a5709ad`. It does not
activate a production release or change the scoring/lifecycle rules.

## Application changes

- Generate the client into `src/generated/prisma` using the supported CommonJS
  module format, retaining the existing Next.js/tsx and maintenance-script setup.
- Import database types and clients through `src/lib/prismaClient.ts`. That
  boundary supplies the PostgreSQL adapter to app, worker, and maintenance clients.
- Retain the five-connection data pool, two-connection control pool, ten/five
  second queue deadlines, and independent five-second connect deadlines. Worker
  URLs with explicit pool settings retain those settings at the adapter boundary.
- Move schema location, migration paths, environment loading, and the database
  URL into `prisma.config.ts`. Explicit service/command environment wins over
  dotenv files. Generation uses an unreachable fallback when no URL is supplied.
- Keep all model definitions and recorded SQL migrations unchanged. Installed
  PostgreSQL extensions remain in the database; Prisma 7 no longer declares them
  in the datasource block. Empty test databases explicitly provision their needed
  extensions before creating tables.
- Preserve transaction retry behavior when raw SQL reports a serialization
  failure or deadlock through Prisma 7's driver-adapter error metadata.
- Pin the PostgreSQL adapter alongside CLI/client versions. Scoped overrides
  patch the CLI's vulnerable DeepmergeTS and MySQL2 dependencies while preserving
  the existing local braces security fix.

Existing scores remain authoritative. No score clearing, invalidation,
reconciliation, requeue, or rescore is part of this upgrade.

## Private database copy

The October 15 rehearsal uses a separate PostgreSQL 17 instance on the M70,
bound only to loopback port **55433**. Its private storage is
`/media/nas/career-dashboard-prisma7-20261015`, outside production database and
backup directories. The Mac reaches it over a separate SSH forward. It has no
application service, pipeline worker, or scheduler attached.

The production database is approximately 103 GB. A verified copy of the completed
October 15 nightly dump was retained. A logical restore on the archive disk was
too slow, so the full rehearsal copy uses PostgreSQL's physical backup protocol,
with a spread checkpoint and bounded transfer resources. The partial logical
restore and fixture databases are separate from that full copy.

The full copied database is renamed `career_prisma7` and uses a distinct
`career_prisma7` login. Its password is kept only in private files, including the
ignored, mode-0600 `.env.prisma7` file in the upgrade worktree. Do not copy the
production `.env` files into this worktree.

Start the private forward if needed:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:55433:127.0.0.1:55433 m70
```

Run commands through the rehearsal wrapper, which checks the loopback address,
port, database name, and role before launching a Prisma CLI/client command:

```sh
node scripts/prisma7-rehearsal.mjs npx --no-install prisma migrate status
node scripts/prisma7-rehearsal.mjs npx --no-install prisma migrate deploy
node scripts/prisma7-rehearsal.mjs node --import tsx tests/integration/prisma7Rehearsal.ts
```

Set `PRISMA7_REHEARSAL_REPORT` to a private output file to retain the complete
preservation report. The integration harness fingerprints every saved Job column
before and after its checks, compares score/history counts, and removes only its
own uniquely named board/batch fixtures.

## Validation and limits

Routine update validation: 2,182 tests passed, 10 skipped, production build passed,
lint passed with three pre-existing warnings, browser wrappers launched and read
local HTML through installed Chrome, and npm audit reported zero vulnerabilities.
The licensed CloakBrowser binary and live provider collection were not exercised.

Prisma branch validation includes unit tests, production build, schema validation,
scoped dependency resolution/audit, real PostgreSQL scoring imports (including
concurrent identical/divergent imports and rollback), scheduler migration and
provider budget reservation tests, and ATS SQL fixtures in UTC and Chicago time.
The full-copy checks and their results must be recorded before release review.

Replaying the recorded migration chain into an empty database currently fails at
`20260808190000_pipeline_lock_shared`: it alters `PipelineState`, which an older
baseline never creates. This predates the Prisma upgrade. Do not edit an applied
migration or use a reset to conceal the gap. A clean-install baseline repair is
separate work; the existing-database upgrade must be proved against the copied
production history. The historical scoring verifier now requires separately
provisioned empty `career_dashboard_scoring_v2_verify` and
`career_dashboard_scoring_v2_upgrade_verify` fixture databases and never resets
existing contents.

Neither branch has been pushed or deployed. Production Node.js is still on the
24 LTS line; its maintenance patch update belongs in a coordinated release step.
TypeScript, ESLint, and dotenv major upgrades remain separate work.
