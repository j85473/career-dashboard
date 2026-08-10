import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import {
  findRegisteredAgyProjectId,
  findRegisteredAgyProjectIds,
  findRegisteredAgyProjectIdWithAgent,
} from '../agyProject';

test('CLI direct-folder Agy project wins over an older GUI git project', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'Career Dashboard');
  const registry = path.join(root, 'projects');
  fs.mkdirSync(workspace);
  fs.mkdirSync(registry);

  const guiId = '11111111-1111-4111-8111-111111111111';
  const cliId = '22222222-2222-4222-8222-222222222222';
  fs.writeFileSync(path.join(registry, `${guiId}.json`), JSON.stringify({
    id: guiId,
    projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(workspace).href } }] },
  }));
  fs.writeFileSync(path.join(registry, `${cliId}.json`), JSON.stringify({
    id: cliId,
    projectResources: { resources: [{ folderUri: pathToFileURL(workspace).href }] },
  }));

  assert.equal(findRegisteredAgyProjectId(registry, workspace), cliId);
  assert.deepEqual(findRegisteredAgyProjectIds(registry, workspace), [cliId, guiId]);
});

test('malformed and unrelated Agy project records are ignored', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const registry = path.join(root, 'projects');
  fs.mkdirSync(registry);
  fs.writeFileSync(path.join(registry, 'bad.json'), '{');
  fs.writeFileSync(path.join(registry, 'other.json'), JSON.stringify({
    id: '33333333-3333-4333-8333-333333333333',
    projectResources: { resources: [{ folderUri: pathToFileURL(path.join(root, 'other')).href }] },
  }));

  assert.equal(findRegisteredAgyProjectId(registry, path.join(root, 'target')), null);
});

test('agent-aware resolution skips a duplicate project that lacks the native runner', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-project-test-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'Career Dashboard');
  const registry = path.join(root, 'projects');
  fs.mkdirSync(workspace);
  fs.mkdirSync(registry);

  const missingAgentId = '11111111-1111-4111-8111-111111111111';
  const nativeRunnerId = '22222222-2222-4222-8222-222222222222';
  for (const id of [missingAgentId, nativeRunnerId]) {
    fs.writeFileSync(path.join(registry, `${id}.json`), JSON.stringify({
      id,
      projectResources: { resources: [{ gitFolder: { folderUri: pathToFileURL(workspace).href } }] },
    }));
  }

  const probed: string[] = [];
  assert.equal(
    findRegisteredAgyProjectIdWithAgent(registry, workspace, (projectId) => {
      probed.push(projectId);
      return projectId === nativeRunnerId;
    }),
    nativeRunnerId,
  );
  assert.deepEqual(probed, [missingAgentId, nativeRunnerId]);
  assert.equal(
    findRegisteredAgyProjectIdWithAgent(registry, workspace, () => false),
    null,
  );
});
