import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import * as mammoth from 'mammoth';

const requireFromRoot = createRequire(path.resolve('package.json'));
const cli = path.join(path.dirname(requireFromRoot.resolve('mammoth/package.json')), 'bin/mammoth');

async function documentFixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mammoth-compatibility-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
    <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
      <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
      <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
    </Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8"?>
    <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
      <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
    </Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>Channel &amp; partner growth</w:t></w:r></w:p>
        <w:p><w:r><w:t>Minneapolis – remote</w:t></w:r></w:p>
      </w:body>
    </w:document>`);
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  const file = path.join(directory, 'posting.docx');
  await writeFile(file, buffer);
  return { directory, buffer, file };
}

test('Word extraction preserves paragraphs, Unicode and XML escapes with the updated parser dependency', async t => {
  const { buffer } = await documentFixture(t);
  const extracted = await mammoth.extractRawText({ buffer });
  assert.equal(extracted.value, 'Channel & partner growth\n\nMinneapolis – remote\n\n');
});

test('the Word reader CLI retains help and both conversion formats with the scoped parser override', async t => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--output-format/);
  const { file } = await documentFixture(t);
  for (const format of ['html', 'markdown']) {
    const result = spawnSync(process.execPath, [cli, file, '--output-format', format], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Minneapolis – remote/);
    if (format === 'html') assert.match(result.stdout, /<p>Channel &amp; partner growth<\/p>/);
    else {
      assert.match(result.stdout, /Channel & partner growth/);
      assert.doesNotMatch(result.stdout, /<p>/);
    }
  }
});

test('the Word reader CLI preserves positional output and rejects conflicting destinations', async t => {
  const { directory, file } = await documentFixture(t);
  const output = path.join(directory, 'posting.md');
  const result = spawnSync(process.execPath, [cli, file, output, '--output-format', 'markdown'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(output, 'utf8'), /Channel & partner growth/);
  const conflict = spawnSync(process.execPath, [cli, file, output, '--output-dir', directory], { encoding: 'utf8' });
  assert.equal(conflict.status, 2);
  assert.match(conflict.stderr, /not allowed with argument/);
});
