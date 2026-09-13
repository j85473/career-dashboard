import assert from 'node:assert/strict';
import test from 'node:test';

import {
  descriptionContainment,
  descriptionShingles,
  employerRelation,
  judgeAppliedRepeat,
  repeatLocationRelation,
  repeatTitleKey,
  selectAppliedRepeat,
  type RepeatSubject,
} from '../appliedRepeatMatch';

function descriptionText(seed: string, words = 260): string {
  return Array.from({ length: words }, (_, index) => `${seed}${(index * 7919) % 1009}`).join(' ');
}

function subject(overrides: Partial<RepeatSubject> & Pick<RepeatSubject, 'id'>): RepeatSubject {
  return { title: 'Account Manager', company: 'Acme', location: 'Minneapolis, MN', description: null, ...overrides };
}

// Every pair below is a real production row from the 2026-09-13 investigation.

test('employer names from ATS boards and aggregators agree', () => {
  for (const [left, right] of [
    ['Veeam Software', 'veeamsoftware'],
    ['Sourcegraph', 'sourcegraph91'],
    ['Talking Rain', 'talkingrain.wd1'],
    ['Redwood Materials', 'redwoodmaterials'],
    ['RF-SMART', 'rfsmart'],
    ['Patch My PC', 'Patchmypc'],
    ['RDO Equipment Co.', 'RDO Equipment'],
    ['SharkNinja', 'sharkninjaoperatingllc'],
    ['3M', '3m.wd1'],
    ['Zayo Group', 'Zayo Group LLC'],
  ]) {
    assert.equal(employerRelation(left, right), 'same', `${left} / ${right}`);
  }
  for (const [left, right] of [
    ['Paycom', 'Paycom Online'],
    ['Safelite', 'Safelite Fulfilment'],
    ['Jamf', 'Jamf Software, LLC'],
    ['Flex', 'flexentialcorp'],
  ]) {
    assert.equal(employerRelation(left, right), 'prefix', `${left} / ${right}`);
  }
  assert.equal(employerRelation('HP', 'HPE'), null, 'short names never prefix-match');
  assert.equal(employerRelation('Gartner', 'Veeam'), null);
});

test('titles ignore remote tags and Sr. but keep seniority and specialty', () => {
  assert.equal(repeatTitleKey('Senior Global Partner Manager (REMOTE US)'), repeatTitleKey('Senior Global Partner Manager'));
  assert.equal(repeatTitleKey('Partner Sales Director (Remote)'), repeatTitleKey('Partner Sales Director'));
  assert.equal(repeatTitleKey('Sr. Channel Account Manager'), repeatTitleKey('Senior Channel Account Manager'));
  assert.equal(repeatTitleKey('Account Manager - Remote'), repeatTitleKey('Account Manager'));
  assert.notEqual(repeatTitleKey('Senior Enterprise Account Manager'), repeatTitleKey('Enterprise Account Manager'));
  assert.notEqual(repeatTitleKey('Lead Customer Success Manager'), repeatTitleKey('Customer Success Manager'));
  assert.notEqual(repeatTitleKey('Customer Success Manager - US [IC2]'), repeatTitleKey('Customer Success Manager'));
});

test('locations written differently by different sources are compatible', () => {
  for (const [left, right] of [
    ['United States', 'Remote, United States'],
    ['United States', 'USA - Remote'],
    ['United States', 'US Remote'],
    ['Minneapolis, Hennepin County', 'Minneapolis, MN'],
    ['Saint Paul, MN', 'Minneapolis, MN'],
    ['US-MN Minneapolis', 'Minneapolis, MN,US'],
    ['Minneapolis, Hennepin County', 'US MN Minneapolis Office'],
    ['United States', 'IA - STATEWIDE or REMOTE; Nationwide'],
    ['Greater Minneapolis-St. Paul Area', 'Eden Prairie, Minnesota'],
    ['2 Locations', 'New Jersey, USA; California, USA; Illinois, USA; Minnesota, USA; Texas, USA'],
    ['Remote/Home South Carolina; Remote/Home Georgia', 'Remote/Home Georgia'],
    ['Canada, United States', 'Remote'],
    // Joseph, 2026-09-13: a city posting of a role applied to remotely is the same opening.
    ['US - San Francisco', 'US - Remote'],
    ['California City, CA', 'US Remote'],
    ['Saint Paul, MN', 'United States'],
  ]) {
    assert.notEqual(repeatLocationRelation(left, right), 'conflict', `${left} / ${right}`);
  }
});

test('locations that name different places conflict', () => {
  for (const [left, right] of [
    ['Minnesota, United States', 'Michigan, United States'],
    ['Chicago, IL', 'Minneapolis, MN'],
    ['Worthington, Minnesota', 'South St Paul, Minnesota'],
    ['Le Mars, Plymouth County', 'South St Paul, Minnesota'],
    ['Remote/Home Washington; Remote/Home Oregon', 'Remote/Home Georgia'],
    ['Lubbock TX', 'Saint Paul, MN'],
    ['San Francisco', 'New York'],
    ['North America/USA/Missouri/St. Louis - CCP, MO', 'North America/USA/Minnesota/Eden Prairie, MN'],
  ]) {
    assert.equal(repeatLocationRelation(left, right), 'conflict', `${left} / ${right}`);
  }
});

test('a foreign location conflicts with a US one before a missing location can wave it through', () => {
  assert.equal(repeatLocationRelation('Buenos Aires, Buenos Aires, Argentina', 'Unknown Location'), 'conflict');
  assert.equal(repeatLocationRelation('Canada - Remote (ON, AB, BC, or NS Only)', 'United States'), 'conflict');
  assert.equal(repeatLocationRelation('United Kingdom', 'United States'), 'conflict');
  assert.equal(repeatLocationRelation('Ireland', 'United States'), 'conflict');
  assert.notEqual(repeatLocationRelation('Little Canada, MN', 'Plymouth, MN'), 'conflict', 'Little Canada is in Minnesota');
});

test('description containment needs substance on both sides', () => {
  const full = descriptionShingles(descriptionText('jd'));
  const stub = descriptionShingles(descriptionText('jd', 60));
  const other = descriptionShingles(descriptionText('other'));
  assert.equal(descriptionContainment(full, stub), null, 'a stub would contain-match anything');
  assert.equal(descriptionContainment(full, full), 1);
  assert.equal(descriptionContainment(full, other), 0);
});

test('a cross-source repeat is proven by its description', () => {
  const evidence = judgeAppliedRepeat(
    subject({ id: 'himalayas', company: 'Veeam Software', title: 'Senior Global Partner Manager (REMOTE US)', location: 'United States', description: descriptionText('veeam') }),
    subject({ id: 'applied', company: 'veeamsoftware', title: 'Senior Global Partner Manager (REMOTE US)', location: 'Remote, United States', description: descriptionText('veeam') }),
  );
  assert.equal(evidence?.rule, 'description');
  assert.equal(evidence?.employer, 'same');
  assert.equal(evidence?.containment, 1);
});

test('a prefix employer without description proof is not a repeat', () => {
  assert.equal(judgeAppliedRepeat(
    subject({ id: 'jobicy', company: 'Flex', location: 'USA', description: descriptionText('flex') }),
    subject({ id: 'applied', company: 'flexentialcorp', location: 'Cincinnati, OH; MN - Chaska', description: descriptionText('flexential') }),
  ), null);
  assert.equal(judgeAppliedRepeat(
    subject({ id: 'thin', company: 'Paycom', location: 'Edina, MN', description: null }),
    subject({ id: 'applied', company: 'Paycom Online', location: 'Edina, MN', description: descriptionText('paycom') }),
  ), null);
});

test('exact identity proves a repeat unless two real descriptions clearly disagree', () => {
  const identity = judgeAppliedRepeat(
    subject({ id: 'glassdoor', title: 'Regional Partner Manager', company: 'Flexential', description: null }),
    subject({ id: 'applied', title: 'Regional Partner Manager', company: 'Flexential', description: descriptionText('flexential') }),
  );
  assert.equal(identity?.rule, 'identity');
  assert.equal(judgeAppliedRepeat(
    subject({ id: 'dejobs', description: descriptionText('first') }),
    subject({ id: 'applied', description: descriptionText('second') }),
  ), null);
  assert.equal(judgeAppliedRepeat(
    subject({ id: 'placeholder', location: '2 Locations', description: null }),
    subject({ id: 'applied', location: '2 Locations', description: null }),
  ), null, 'a placeholder location is not identity');
});

test('a territory template in another state is never a repeat, however identical the text', () => {
  assert.equal(judgeAppliedRepeat(
    subject({ id: 'michigan', company: 'formerra', location: 'Michigan, United States', description: descriptionText('template') }),
    subject({ id: 'applied', company: 'formerra', location: 'Minnesota, United States', description: descriptionText('template') }),
  ), null);
});

test('Applied authority outranks a Passed "Already applied" one', () => {
  const text = descriptionText('same');
  const candidate = subject({ id: 'candidate', description: text });
  const best = selectAppliedRepeat(candidate, [
    { ...subject({ id: 'passed', description: text }), status: 'passed' },
    { ...subject({ id: 'applied', description: text }), status: 'applied' },
  ]);
  assert.equal(best?.authority.id, 'applied');
});
