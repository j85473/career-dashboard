import { buildAimResultFromFactualVector } from '../src/lib/aimResultBuilder';
import { loadAimQuestionRegistry } from '../src/lib/aimQuestionRegistry';
import { loadAimScoringPolicy } from '../src/lib/aimScoringPolicy';
import { canonicalJson } from '../src/lib/scoringCanonicalJson';

async function readCanonicalStdin(): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  // A UTF-8 character can span stdin chunks; decode only after joining the bytes.
  const bytes = Buffer.concat(chunks).toString('utf8');
  if (bytes.length === 0) throw new Error('Aim result builder requires canonical JSON on stdin');
  const parsed = JSON.parse(bytes) as unknown;
  if (canonicalJson(parsed) !== bytes) throw new Error('Aim result builder stdin is not canonical JSON');
  return parsed;
}

async function main(): Promise<void> {
  const { registry } = loadAimQuestionRegistry();
  const { policy } = loadAimScoringPolicy(registry);
  const input = await readCanonicalStdin();
  process.stdout.write(canonicalJson(buildAimResultFromFactualVector(input, { registry, policy })));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Aim result builder failed: ${message}\n`);
  process.exitCode = 1;
});
