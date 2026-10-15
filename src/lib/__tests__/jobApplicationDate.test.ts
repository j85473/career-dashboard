import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaClient } from '../prismaClient';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import JobCard from '../../components/JobCard';

import { applicationDateFromHistory, withApplicationDates } from '../jobApplicationDate';

const appliedAt = new Date('2026-10-12T17:49:46.680Z');
const interviewedAt = new Date('2026-10-13T22:01:59.860Z');
const earlierInbox = { status: 'inbox', createdAt: new Date('2026-10-12T15:48:05.134Z') };
const applied = { status: 'applied', createdAt: appliedAt };
const interviewed = { status: 'interviewing', createdAt: interviewedAt };

test('Twice as Nice retains October 12 after its October 13 interview transition', () => {
  assert.equal(applicationDateFromHistory([interviewed, applied, earlierInbox]), appliedAt);
});

test('returning from Interviewing to Applied retains the original application date', () => {
  assert.equal(applicationDateFromHistory([
    { status: 'applied', createdAt: new Date('2026-10-14T12:00:00Z') },
    interviewed, applied, earlierInbox,
  ]), appliedAt);
});

test('Not Applied followed by a new application starts a new application date', () => {
  const reappliedAt = new Date('2026-10-15T12:00:00Z');
  assert.equal(applicationDateFromHistory([
    { status: 'applied', createdAt: reappliedAt },
    { status: 'inbox', createdAt: new Date('2026-10-14T12:00:00Z') },
    interviewed, applied, earlierInbox,
  ]), reappliedAt);
});

test('missing Applied history never substitutes an interview or last-edit date', () => {
  assert.equal(applicationDateFromHistory([]), null);
  assert.equal(applicationDateFromHistory([interviewed, earlierInbox]), null);
  assert.equal(applicationDateFromHistory([earlierInbox, applied]), null);
});

test('a page reads active-job history once and preserves order, scores and source objects', async () => {
  let queries = 0;
  const jobs = [
    { id: 'interview', status: 'interviewing', updatedAt: interviewedAt, aimFitScore: 78, reqFitScore: 82 },
    { id: 'inbox', status: 'inbox', aimFitScore: 91, reqFitScore: 88 },
    { id: 'missing', status: 'applied', updatedAt: interviewedAt, aimFitScore: 72, reqFitScore: 80 },
  ];
  const store = {
    jobStatusHistory: {
      findMany: async (query: unknown) => {
        queries++;
        assert.deepEqual(query, {
          where: { jobId: { in: ['interview', 'missing'] } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { jobId: true, status: true, createdAt: true },
        });
        return [interviewed, applied, earlierInbox].map((event) => ({ ...event, jobId: 'interview' }));
      },
    },
  } as unknown as Pick<PrismaClient, 'jobStatusHistory'>;
  const before = structuredClone(jobs);
  const result = await withApplicationDates(jobs, store);
  assert.equal(queries, 1);
  assert.deepEqual(result, jobs.map((job) => ({ ...job, appliedAt: job.id === 'interview' ? appliedAt : null })));
  assert.deepEqual(jobs, before);
  jobs[0].updatedAt = new Date('2026-10-16T12:00:00Z');
  assert.equal((await withApplicationDates(jobs, store))[0].appliedAt, appliedAt);
});

test('pages without active applications do not read application history', async () => {
  const store = {
    jobStatusHistory: { findMany: async () => { throw new Error('Unexpected history query'); } },
  } as unknown as Pick<PrismaClient, 'jobStatusHistory'>;
  assert.deepEqual(await withApplicationDates([{ id: 'inbox', status: 'inbox' }], store), [
    { id: 'inbox', status: 'inbox', appliedAt: null },
  ]);
  assert.deepEqual(await withApplicationDates([], store), []);
});

test('Applied and Interviewing cards render the application date despite a later edit', () => {
  for (const status of ['applied', 'interviewing']) {
    const html = renderToStaticMarkup(React.createElement(JobCard, {
      job: { id: 'twice', title: 'Channel Sales Manager', company: '#twiceasnice Recruiting',
        status, appliedAt: appliedAt.toISOString(), updatedAt: interviewedAt.toISOString() },
      onSelect: () => {},
    }));
    assert.match(html, /Applied Oct 12, 2026/);
    assert.doesNotMatch(html, /Applied Oct 13, 2026/);
  }
});

test('a card with no recorded application date does not display its last edit as Applied', () => {
  const html = renderToStaticMarkup(React.createElement(JobCard, {
    job: { id: 'legacy', title: 'Sales Manager', company: 'Employer', status: 'interviewing',
      appliedAt: null, updatedAt: interviewedAt.toISOString() },
    onSelect: () => {},
  }));
  assert.match(html, /Applied /);
  assert.doesNotMatch(html, /Applied Oct/);
});
