import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

type Ast = { type: string; nodes: Ast[]; parent?: Ast; value?: string };
type Options = Record<string, unknown>;
interface Braces {
  (input: string | string[], options?: Options): string[];
  parse(input: string, options?: Options): Ast;
  create(input: string, options?: Options): string | string[];
  compile(input: string | Ast, options?: Options): string;
  expand(input: string | Ast, options?: Options): string[];
  stringify(input: string | Ast, options?: Options): string;
}

const requireFromRoot = createRequire(path.resolve('package.json'));
const requireFromMicromatch = createRequire(requireFromRoot.resolve('micromatch'));
const braces: Braces = requireFromMicromatch('braces');
const depthError = (error: unknown) => error instanceof SyntaxError
  && 'code' in error && error.code === 'ERR_BRACES_MAX_DEPTH';
const nested = (depth: number) => '{'.repeat(depth) + 'a,b' + '}'.repeat(depth);

test('lint dependencies resolve to the committed security fork', () => {
  assert.equal(requireFromMicromatch.resolve('braces'), path.resolve('vendor/braces/index.js'));
  assert.equal(requireFromMicromatch('braces/package.json').name, '@career-dashboard/braces');
});

test('every pattern entry point rejects excessive nesting without a stack overflow', () => {
  for (const method of ['parse', 'create', 'compile', 'expand', 'stringify'] as const) {
    for (const pattern of [nested(4000), '('.repeat(4000) + 'x' + ')'.repeat(4000), '{('.repeat(100) + 'x' + ')}'.repeat(100), '{'.repeat(101)]) {
      assert.throws(() => braces[method](pattern), depthError, method);
    }
  }
  assert.throws(() => braces(['src/{app,lib}', nested(4000)]), depthError);
  assert.throws(() => braces(nested(4000), { expand: true }), depthError);
  assert.throws(() => braces.compile(nested(101), { maxDepth: Infinity, maxLength: Infinity }), depthError);
});

test('AST entry points bound both deep trees and child-node cycles', () => {
  for (const method of ['compile', 'expand', 'stringify'] as const) {
    const root: Ast = { type: 'root', nodes: [] };
    let node = root;
    for (let i = 0; i < 4000; i++) {
      const child: Ast = { type: 'paren', nodes: [], parent: node };
      node.nodes.push(child);
      node = child;
    }
    assert.throws(() => braces[method](root), depthError, method);
    const cycle: Ast = { type: 'root', nodes: [] };
    cycle.nodes.push(cycle);
    assert.throws(() => braces[method](cycle), depthError, method);
  }
});

test('ordinary alternations, ranges, escaping and options preserve their behavior', () => {
  assert.equal(braces.compile('src/{app,lib}/**/*.{js,ts}'), 'src/(app|lib)/**/*.(js|ts)');
  assert.deepEqual(braces.expand('src/{app,{lib,tests}}/{01..03}'), [
    'src/app/01', 'src/app/02', 'src/app/03',
    'src/lib/01', 'src/lib/02', 'src/lib/03',
    'src/tests/01', 'src/tests/02', 'src/tests/03',
  ]);
  assert.deepEqual(braces.expand('file{c..a}.ts'), ['filec.ts', 'fileb.ts', 'filea.ts']);
  assert.deepEqual(braces.expand('file\\{a,b\\}'), ['file{a,b}']);
  assert.deepEqual(braces(['{a,a,b}', '{c,d}'], { expand: true, nodupes: true }), ['a', 'b', 'c', 'd']);
  assert.deepEqual(braces.expand('{,a,b}', { noempty: true }), ['a', 'b']);
  assert.equal(braces.stringify(braces.parse('src/{app,lib}/**/*.ts')), 'src/{app,lib}/**/*.ts');
  assert.throws(() => braces.expand('{1..1001}'), /range limit/);
  assert.throws(() => braces.parse('x'.repeat(10001)), /max characters/);
});

test('the nesting ceiling accepts its boundary and ignores quoted, escaped and bracketed literals', () => {
  const boundary = '('.repeat(100) + 'x' + ')'.repeat(100);
  assert.equal(braces.compile(boundary), boundary);
  assert.equal(braces.stringify(boundary), boundary);
  assert.deepEqual(braces.expand(boundary), [boundary]);
  for (const pattern of ['"' + '{'.repeat(4000) + '"', '\\{'.repeat(4000), '[' + '{'.repeat(4000) + ']']) {
    assert.doesNotThrow(() => braces.compile(pattern));
  }
  assert.throws(() => braces.parse('('.repeat(101)), depthError);
});

test('the real lint dependency handles malicious input even with a small process stack', () => {
  const script = `
    const { createRequire } = require('node:module');
    const load = createRequire(${JSON.stringify(requireFromRoot.resolve('micromatch'))});
    const braces = load('braces');
    const pattern = '{'.repeat(4000) + 'a,b' + '}'.repeat(4000);
    for (const method of ['compile', 'expand', 'stringify']) {
      try { braces[method](pattern); process.exit(1); }
      catch (error) {
        if (!(error instanceof SyntaxError) || error.code !== 'ERR_BRACES_MAX_DEPTH') throw error;
      }
    }
    console.log('handled excessive nesting');
  `;
  const child = spawnSync(process.execPath, ['--stack_size=256', '-e', script], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 0, child.stderr);
  assert.match(child.stdout, /handled excessive nesting/);
});

test('Next lint still finds configured app roots using brace patterns', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'braces-lint-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of ['admin', 'dashboard']) await mkdir(path.join(directory, 'apps', name), { recursive: true });
  await writeFile(path.join(directory, 'apps', 'readme.txt'), 'fixture');
  const pattern = path.join(directory, '{apps,packages}', '{admin,dashboard}');
  const { getRootDirs } = requireFromRoot('@next/eslint-plugin-next/dist/utils/get-root-dirs') as {
    getRootDirs(context: { cwd: string; settings: { next: { rootDir: string | string[] } } }): string[];
  };
  const expected = ['admin', 'dashboard'].map(name => path.join(directory, 'apps', name));
  assert.deepEqual(getRootDirs({ cwd: directory, settings: { next: { rootDir: pattern } } }).sort(), expected);
  assert.deepEqual(getRootDirs({ cwd: directory, settings: { next: { rootDir: [pattern] } } }).sort(), expected);
  assert.throws(() => getRootDirs({ cwd: directory, settings: { next: { rootDir: nested(4000) } } }), depthError);
});
