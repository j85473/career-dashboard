import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobicyJob, parseRemoteOkJob } from '../jobIngestion';

// Shapes captured live on 2026-08-16.

test('RemoteOK skips the legal notice that leads every response', () => {
  // The feed's first element is an attribution notice, not a job.
  assert.equal(parseRemoteOkJob({ legal: 'API Terms of Service: please link back' }), null);
});

test('RemoteOK items map onto the ingestion shape', () => {
  const parsed = parseRemoteOkJob({
    id: '1136800',
    slug: 'remote-channel-manager-acme-1136800',
    position: 'Channel Account Manager',
    company: 'Acme',
    location: 'Slave Lake, ',
    description: 'Own the reseller motion.',
    url: 'https://remoteOK.com/remote-jobs/remote-channel-manager-acme-1136800',
    date: '2026-08-15T01:20:47+00:00',
  });
  assert.ok(parsed);
  assert.equal(parsed.sourceId, '1136800');
  assert.equal(parsed.title, 'Channel Account Manager');
  // A trailing comma is an artefact of their location formatting.
  assert.equal(parsed.location, 'Slave Lake');
  assert.equal((parsed.postedAt as Date).toISOString(), '2026-08-15T01:20:47.000Z');
});

test('a RemoteOK item with no location is remote, not unknown', () => {
  const parsed = parseRemoteOkJob({ id: '1', position: 'Partner Manager', company: 'Acme', location: '' });
  assert.equal(parsed?.location, 'Remote');
});

test('Jobicy items map onto the ingestion shape', () => {
  const parsed = parseJobicyJob({
    id: 150836,
    url: 'https://jobicy.com/jobs/150836-channel-manager',
    jobTitle: 'Channel Manager',
    companyName: 'Gopuff',
    jobGeo: 'USA',
    jobDescription: 'Grow the partner channel.',
    pubDate: '2026-08-16T03:41:13+00:00',
  });
  assert.ok(parsed);
  assert.equal(parsed.sourceId, '150836');
  assert.equal(parsed.company, 'Gopuff');
  assert.equal(parsed.location, 'USA');
  assert.equal(parsed.source, 'Jobicy');
});

test('Jobicy falls back to the excerpt when no full description is present', () => {
  const parsed = parseJobicyJob({ id: 2, jobTitle: 'Partner Manager', jobExcerpt: 'Short blurb' });
  assert.equal(parsed?.description, 'Short blurb');
});

test('both parsers reject items with no usable identity', () => {
  assert.equal(parseRemoteOkJob({ position: 'No id here' }), null);
  assert.equal(parseJobicyJob({ jobTitle: 'No id here' }), null);
  assert.equal(parseRemoteOkJob({ id: '5' }), null);
  assert.equal(parseJobicyJob({ id: 5 }), null);
});
