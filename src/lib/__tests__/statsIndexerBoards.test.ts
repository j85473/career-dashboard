import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { load } from 'cheerio';
import { readIndexerBoardStats } from '../statsIndexerBoards';
import { IndexerBoardsCard } from '../../components/IndexerBoardsCard';
import { AtsWebDiscoveryState } from '../atsWebDiscoveryState';

test('24-hour discovery counts use first sighting, deduplicate repeat finds, and preserve saved state', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'indexer-stats-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'state.sqlite');
  const now = Date.UTC(2026, 9, 23, 20);
  const state = new AtsWebDiscoveryState(file);
  const board = (slug: string) => ({ platform: 'lever', slug, matchedUrl: `https://jobs.lever.co/${slug}` });
  state.recordBoard(board('old'), 'https://example.org', now - 86_400_001);
  state.recordBoard(board('old'), 'https://example.org', now);
  state.recordBoard(board('boundary'), 'https://example.org', now - 86_400_000);
  state.recordBoard(board('new'), 'https://example.org', now);
  state.recordBoard(board('new'), 'https://example.org', now);
  for (const slug of ['old', 'boundary', 'new']) state.finishCandidate(board(slug), 'registered', now);
  for (const status of ['existing', 'retired', 'rejected', 'waiting_for_admission', 'pending', 'retry']) {
    state.recordBoard(board(status), 'https://example.org', now);
    state.finishCandidate(board(status), status, now);
  }
  state.close();
  const before = readFileSync(file);
  assert.deepEqual(readIndexerBoardStats(now, file), { available: true, last24Hours: 2, allTime: 3 });
  assert.deepEqual(readFileSync(file), before);
});

test('an empty tracked indexer is zero; missing or incompatible state is unavailable and never created', t => {
  const folder = mkdtempSync(path.join(os.tmpdir(), 'indexer-empty-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'state.sqlite');
  assert.deepEqual(readIndexerBoardStats(0, file), { available: false, last24Hours: null, allTime: null });
  assert.equal(existsSync(file), false);
  const state = new AtsWebDiscoveryState(file); state.close();
  assert.deepEqual(readIndexerBoardStats(0, file), { available: true, last24Hours: 0, allTime: 0 });
  const db = new DatabaseSync(file); db.exec('DROP TABLE boards'); db.close();
  assert.equal(readIndexerBoardStats(0, file).available, false);
});

test('the card puts the rolling 24-hour value on the left and lifetime on the right', () => {
  const $ = load(renderToStaticMarkup(React.createElement(IndexerBoardsCard, { stats: { available: true, last24Hours: 12, allTime: 1234 } })));
  assert.deepEqual($('.ops-indexer-values > div').map((_, el) => $(el).text()).get(), ['Last 24 hours12', 'All time1,234']);
  const unavailable = load(renderToStaticMarkup(React.createElement(IndexerBoardsCard)));
  assert.deepEqual(unavailable('strong').map((_, el) => unavailable(el).text()).get(), ['—', '—']);
});
