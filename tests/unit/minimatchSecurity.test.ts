import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const rootRequire = createRequire(path.resolve('package.json'));
const match = rootRequire('minimatch');
const glob = rootRequire('glob');

test('legacy lint and browser cleanup consumers use the patched upstream matcher', () => {
  for (const name of ['glob', 'eslint', '@eslint/config-array', '@typescript-eslint/typescript-estree', 'eslint-plugin-react']) {
    const consumer = createRequire(rootRequire.resolve(name));
    assert.equal(consumer.resolve('minimatch'), path.resolve('vendor/minimatch-compat/index.cjs'));
  }
  assert.equal(rootRequire('minimatch-engine/package.json').version, '11.0.1');
  assert.equal(typeof match, 'function');
});

test('legacy matching retains braces, globstars, exclusions and lint configuration options', () => {
  assert.equal(match('src/app/page.tsx', 'src/**/*.{ts,tsx}'), true);
  assert.equal(match('src/.cache/page.ts', 'src/**/*.ts'), false);
  assert.equal(match('src/.cache/page.ts', 'src/**/*.ts', { dot: true }), true);
  assert.equal(match('Button', 'B*'), true);
  assert.equal(match('handlerClick', 'handler*'), true);
  assert.equal(match('README.MD', '*.md', { nocase: true }), true);
  assert.equal(match('src/app/page.tsx', '*.tsx', { matchBase: true }), true);
  assert.deepEqual(match.match(['a.ts', 'a.js'], '!*.js'), ['a.ts']);
  const parsed = new match.Minimatch('*.ts');
  assert.equal(parsed.set[0][0]._glob, '*.ts');
  assert.equal(parsed.set[0][0].test('page.ts'), true);
  assert.equal(parsed.match('page.js'), false);
});

test('real glob traversal and browser cleanup remove only the intended temporary profiles', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'dashboard-matcher-'));
  try {
    for (const dir of ['profile-one/nested', 'profile-two', 'keep-profile']) await mkdir(path.join(root, dir), { recursive: true });
    for (const file of ['profile-one/nested/data.json', 'profile-two/data.json', 'keep-profile/data.json']) {
      await writeFile(path.join(root, file), '{}');
    }
    const expected = ['profile-one/nested/data.json', 'profile-two/data.json'];
    assert.deepEqual(glob.sync('profile-*/**/*.json', { cwd: root }).sort(), expected);
    const found = await promisify(glob)('profile-*/**/*.json', { cwd: root });
    assert.deepEqual((found as string[]).sort(), expected);
    const pluginRequire = createRequire(rootRequire.resolve('puppeteer-extra-plugin-user-data-dir'));
    await promisify(pluginRequire('rimraf'))(path.join(root, 'profile-*'));
    await access(path.join(root, 'keep-profile/data.json'));
    await assert.rejects(access(path.join(root, 'profile-one')));
    await assert.rejects(access(path.join(root, 'profile-two')));
  } finally { await rm(root, { recursive: true, force: true }); }
});
