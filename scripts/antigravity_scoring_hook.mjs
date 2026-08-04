import fs from 'node:fs';
import path from 'node:path';

const UUID_PATTERN = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const UNLOCKED_NEXT_PATTERN = new RegExp(`^npm run --silent scoring:next -- --request ${UUID_PATTERN}$`, 'i');
const LOCKED_NEXT_PATTERN = new RegExp(`^npm run --silent scoring:next -- --request (${UUID_PATTERN})$`, 'i');

const input = await new Promise((resolve, reject) => {
  let body = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    body += chunk;
  });
  process.stdin.on('end', () => {
    try {
      resolve(JSON.parse(body));
    } catch (error) {
      reject(error);
    }
  });
  process.stdin.on('error', reject);
});

function respond(decision, reason, permissionOverrides) {
  process.stdout.write(JSON.stringify({
    decision,
    reason,
    ...(permissionOverrides ? { permissionOverrides } : {}),
  }));
}

function resolveToolPath(workspaceRoot, candidate) {
  if (typeof candidate !== 'string' || !candidate.trim()) return null;
  return path.resolve(workspaceRoot, candidate);
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

try {
  const workspaceRoot = path.resolve(input.workspacePaths?.[0] || process.cwd());
  const toolName = input.toolCall?.name;
  const args = input.toolCall?.args || {};
  const lockPath = path.join(workspaceRoot, '.agents', 'scoring-lock.json');
  const protectedRoots = [
    path.join(workspaceRoot, '.agents', 'agents'),
    path.join(workspaceRoot, '.agents', 'hooks.json'),
    path.join(workspaceRoot, 'scripts', 'antigravity_scoring_hook.mjs'),
  ];

  if (['write_to_file', 'replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
    const target = resolveToolPath(workspaceRoot, args.TargetFile);
    if (!target) {
      respond('deny', 'Native-scoring boundary: write target is missing or invalid.');
      process.exit(0);
    }
    if (protectedRoots.some((protectedPath) => isInside(protectedPath, target))) {
      respond('deny', 'Immutable Antigravity agent and hook definitions cannot be edited by tools.');
      process.exit(0);
    }
  }

  if (!fs.existsSync(lockPath)) {
    if (
      toolName === 'run_command'
      && typeof args.CommandLine === 'string'
      && args.CommandLine.trim() === 'npm run --silent scoring:request -- --source agy'
    ) {
      respond(
        'allow',
        'The registered runner may create one durable native-scoring request.',
        ['command(npm run --silent scoring:request -- --source agy)'],
      );
      process.exit(0);
    }
    if (
      toolName === 'run_command'
      && typeof args.CommandLine === 'string'
      && UNLOCKED_NEXT_PATTERN.test(args.CommandLine.trim())
    ) {
      const commandLine = args.CommandLine.trim();
      respond(
        'allow',
        'The registered runner may advance one exact durable request before its phase lock is created.',
        [`command(${commandLine})`],
      );
      process.exit(0);
    }
    if (
      toolName === 'run_command'
      && typeof args.CommandLine === 'string'
      && args.CommandLine.trim().startsWith('npm run --silent scoring:')
    ) {
      respond('deny', 'Native-scoring commands must match one registered-runner command exactly.');
      process.exit(0);
    }
    respond('allow', 'No native-scoring lock is active.');
    process.exit(0);
  }

  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  if (
    typeof lock.requestId !== 'string'
    || !['context', 'standard'].includes(lock.phase)
    || typeof lock.batchId !== 'string'
    || !lock.batchId.startsWith(`native_${lock.requestId}_${lock.phase}_`)
  ) {
    respond('deny', 'Native-scoring boundary: lock is not bound to one durable request phase.');
    process.exit(0);
  }
  const runRoot = path.resolve(workspaceRoot, lock.runRoot);
  const manifestPath = path.resolve(workspaceRoot, lock.manifestFile);
  if (!isInside(path.join(workspaceRoot, '.agents', 'eval_runs'), runRoot)) {
    respond('deny', 'Native-scoring boundary: active run root is unsafe.');
    process.exit(0);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.batchId !== lock.batchId) {
    respond('deny', 'Native-scoring boundary: lock and manifest batch IDs differ.');
    process.exit(0);
  }
  if (
    !Array.isArray(manifest.chunks)
    || manifest.chunks.length < 1
    || manifest.chunks.some((chunk) => chunk.type !== lock.phase)
  ) {
    respond('deny', 'Native-scoring boundary: manifest chunks do not match the locked phase.');
    process.exit(0);
  }
  const chunksByAbsoluteInput = new Map();
  const allowedResults = new Set();
  for (const chunk of manifest.chunks || []) {
    chunksByAbsoluteInput.set(path.resolve(runRoot, chunk.inputFile), chunk);
    allowedResults.add(path.resolve(runRoot, chunk.resultFile));
  }

  if (toolName === 'define_subagent') {
    respond('deny', 'Transient subagent definitions are disabled while native scoring is locked.');
    process.exit(0);
  }

  if (toolName === 'invoke_subagent') {
    const subagents = args.Subagents;
    if (!Array.isArray(subagents) || subagents.length < 1 || subagents.length > 2) {
      respond('deny', 'Invoke exactly one or two evaluators to preserve the concurrency limit.');
      process.exit(0);
    }

    if (subagents.length === 1 && subagents[0]?.TypeName === 'scoring-manager-v6') {
      const manager = subagents[0];
      const promptMatch = typeof manager.Prompt === 'string'
        ? /^Run exactly this native scoring wave\.\nManifest: ([^\n]+)\nChunks: (chunk_\d{4}(?:, chunk_\d{4}){0,19})$/.exec(manager.Prompt)
        : null;
      const submittedManifest = promptMatch
        ? path.resolve(workspaceRoot, promptMatch[1])
        : null;
      const submittedChunks = promptMatch ? promptMatch[2].split(', ') : [];
      const knownChunks = new Set((manifest.chunks || []).map((chunk) => chunk.chunkId));
      if (
        manager.Workspace !== 'inherit'
        || submittedManifest !== manifestPath
        || submittedChunks.length < 1
        || new Set(submittedChunks).size !== submittedChunks.length
        || submittedChunks.some((chunkId) => !knownChunks.has(chunkId))
      ) {
        respond('deny', 'Scoring-manager invocation must match one bounded manifest wave exactly.');
        process.exit(0);
      }
      respond('allow', 'Pinned scoring manager matches the active manifest and bounded wave.');
      process.exit(0);
    }

    for (const subagent of subagents) {
      if (
        !subagent
        || typeof subagent !== 'object'
        || !['context-job-evaluator-v6', 'standard-job-evaluator-v6'].includes(subagent.TypeName)
        || subagent.Workspace !== 'inherit'
        || typeof subagent.Prompt !== 'string'
      ) {
        respond('deny', 'Only pinned V6 evaluator types with the inherited workspace may be invoked.');
        process.exit(0);
      }
      const prefix = 'Evaluate only the assigned chunk file: ';
      if (!subagent.Prompt.startsWith(prefix) || subagent.Prompt.includes('\n')) {
        respond('deny', 'Evaluator prompts must contain only the exact assigned chunk-file instruction.');
        process.exit(0);
      }
      const inputPath = path.resolve(workspaceRoot, subagent.Prompt.slice(prefix.length));
      const chunk = chunksByAbsoluteInput.get(inputPath);
      const expectedTypeName = chunk?.type === 'standard'
        ? 'standard-job-evaluator-v6'
        : chunk?.type === 'context'
          ? 'context-job-evaluator-v6'
          : null;
      if (!chunk || subagent.TypeName !== expectedTypeName) {
        respond('deny', 'Evaluator type or chunk path does not match the immutable manifest.');
        process.exit(0);
      }
    }
    respond('allow', 'Pinned evaluator invocation matches the active manifest.');
    process.exit(0);
  }

  if (toolName === 'run_command') {
    const commandLine = typeof args.CommandLine === 'string' ? args.CommandLine.trim() : '';
    const match = LOCKED_NEXT_PATTERN.exec(commandLine);
    if (!match || typeof lock.requestId !== 'string' || match[1] !== lock.requestId) {
      respond('deny', 'While scoring is locked, the runner may execute only scoring:next for one UUID request.');
      process.exit(0);
    }
    respond(
      'allow',
      'Runner command is restricted to the deterministic scoring state machine.',
      [`command(${commandLine})`],
    );
    process.exit(0);
  }

  if (toolName === 'view_file') {
    const target = resolveToolPath(workspaceRoot, args.AbsolutePath);
    if (
      !target
      || (target !== manifestPath && !chunksByAbsoluteInput.has(target))
    ) {
      respond('deny', 'While scoring is locked, reads are restricted to the manifest and declared chunk inputs.');
      process.exit(0);
    }
    respond('allow', 'Read is confined to a manifest-declared immutable input.');
    process.exit(0);
  }

  if (toolName === 'write_to_file') {
    const target = resolveToolPath(workspaceRoot, args.TargetFile);
    if (
      !target
      || !allowedResults.has(target)
      || args.Overwrite !== false
      || fs.existsSync(target)
    ) {
      respond('deny', 'Results may only be created once at manifest-declared result paths.');
      process.exit(0);
    }
    respond(
      'allow',
      'Create-only result write matches the active manifest.',
      [`write_file(${target})`],
    );
    process.exit(0);
  }

  if (['replace_file_content', 'multi_replace_file_content'].includes(toolName)) {
    respond('deny', 'Edits and overwrites are disabled while native scoring is locked.');
    process.exit(0);
  }

  respond('allow', 'Tool is outside the native-scoring boundary matcher.');
} catch (error) {
  respond(
    'deny',
    `Native-scoring boundary failed closed: ${error instanceof Error ? error.message : String(error)}`,
  );
}
