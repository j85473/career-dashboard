import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Resolve the persisted Agy project for a workspace. CLI-created projects use
 * a direct folder resource; GUI projects commonly use a gitFolder resource.
 * The direct record must win because it is the one created by
 * `agy --new-project agents` and therefore discovers workspace agents in CLI
 * print mode.
 */
export function findRegisteredAgyProjectIds(
  projectsRoot: string,
  workspaceRoot: string,
): string[] {
  if (!fs.existsSync(projectsRoot)) return [];
  const normalizedWorkspace = path.resolve(workspaceRoot);
  const directMatches = new Set<string>();
  const gitMatches = new Set<string>();

  for (const name of fs.readdirSync(projectsRoot).filter((entry) => entry.endsWith('.json')).sort()) {
    try {
      const project = JSON.parse(fs.readFileSync(path.join(projectsRoot, name), 'utf8')) as {
        id?: unknown;
        projectResources?: { resources?: Array<{ folderUri?: string; gitFolder?: { folderUri?: string } }> };
      };
      if (typeof project.id !== 'string' || !UUID_PATTERN.test(project.id)) continue;
      for (const resource of project.projectResources?.resources || []) {
        if (
          resource.folderUri?.startsWith('file:')
          && path.resolve(fileURLToPath(resource.folderUri)) === normalizedWorkspace
        ) {
          directMatches.add(project.id);
        } else if (
          resource.gitFolder?.folderUri?.startsWith('file:')
          && path.resolve(fileURLToPath(resource.gitFolder.folderUri)) === normalizedWorkspace
        ) {
          gitMatches.add(project.id);
        }
      }
    } catch {
      // Ignore unrelated or malformed registry records.
    }
  }

  const direct = [...directMatches].sort();
  const git = [...gitMatches].sort().filter((id) => !directMatches.has(id));
  return [...direct, ...git];
}

export function findRegisteredAgyProjectId(
  projectsRoot: string,
  workspaceRoot: string,
): string | null {
  return findRegisteredAgyProjectIds(projectsRoot, workspaceRoot)[0] || null;
}

export function findRegisteredAgyProjectIdWithAgent(
  projectsRoot: string,
  workspaceRoot: string,
  exposesAgent: (projectId: string) => boolean,
): string | null {
  return findRegisteredAgyProjectIds(projectsRoot, workspaceRoot)
    .find((projectId) => exposesAgent(projectId)) || null;
}
