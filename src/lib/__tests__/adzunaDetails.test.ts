import assert from 'node:assert/strict';
import test from 'node:test';

import { adzunaDetailsUrl, extractAdzunaPostingText } from '../adzunaDetails';
import { decideJdRecovery } from '../jdRecoveryPolicy';

const FOOTER = [
  '### Top job titles',
  '',
  '*   [Government](https://www.adzuna.com/government)',
  '*   [Virtual Assistant](https://www.adzuna.com/virtual-assistant)',
  '',
  '#### Country selection',
  '',
  '© 2026 ADZUNA LTD ',
].join('\n');

const POSTING_BODY = [
  'Are you an experienced Sales Professional looking for career development opportunities? Join our World Class Sales Team.',
  '',
  '**Responsibilities:**',
  '',
  '*   Manage assigned distributor accounts across a multi-state territory and grow revenue with existing partners.',
  '*   Build quarterly account plans and coordinate distributor enablement with regional leadership.',
  '*   Review partner performance, identify growth opportunities, and maintain executive relationships.',
  '',
  '**Qualifications:**',
  '',
  '*   Five or more years of B2B sales experience managing channel partners or distributors.',
  '*   Demonstrated ability to build territory plans and forecast revenue accurately.',
  '*   Bachelor’s degree or equivalent experience; travel up to 50% within the region.',
].join('\n');

function livePage(body: string): string {
  return [
    'Title: Sales Consultant Job in Sioux Falls, SD',
    '',
    'URL Source: https://www.adzuna.com/details/5883916856',
    '',
    'Markdown Content:',
    '## Sales Consultant jobs in Sioux Falls, SD',
    '',
    ' What?   Where?   Search [Advanced](https://www.adzuna.com/advanced-search)',
    '',
    '# Sales Consultant',
    '',
    '[❮ back to last search](https://www.adzuna.com/details/5883916856#)![Image 1: Partner](https://zunastatic-abf.kxcdn.com/x.png)',
    '',
    ' Sysco ',
    '',
    'Sioux Falls, South Dakota, 57103',
    '',
    '[**$105,055** per year - estimated ?](https://www.adzuna.com/details/5883916856#)',
    '',
    `[Apply for this job](https://www.adzuna.com/land/ad/5883916856?aztt=abc)${body}`,
    '## Stats for this job',
    '',
    '### Salary comparison:',
    '',
    '## Similar jobs',
    '',
    '[Business Development Manager](https://www.adzuna.com/land/ad/5802793124)',
    '',
    FOOTER,
  ].join('\n');
}

test('builds the details URL from the Adzuna ad id', () => {
  assert.equal(
    adzunaDetailsUrl({ source: 'Adzuna', sourceId: '5888245814', url: 'https://www.adzuna.com/land/ad/5888245814?se=x' }),
    'https://www.adzuna.com/details/5888245814',
  );
  assert.equal(
    adzunaDetailsUrl({ source: 'Adzuna', sourceId: null, url: 'https://www.adzuna.com/land/ad/5888245814?se=x' }),
    'https://www.adzuna.com/details/5888245814',
  );
  assert.equal(adzunaDetailsUrl({ source: 'Jobicy', sourceId: '5888245814', url: null }), null);
  assert.equal(adzunaDetailsUrl({ source: 'Adzuna', sourceId: 'abc', url: 'https://example.com/job' }), null);
});

test('extracts only the posting from a live details page', () => {
  const text = extractAdzunaPostingText(livePage(POSTING_BODY));
  assert.match(text, /World Class Sales Team/);
  assert.match(text, /Bachelor’s degree/);
  assert.doesNotMatch(text, /back to last search|Similar jobs|Salary comparison|Top job titles|Virtual Assistant|What\?/);
  assert.doesNotMatch(text, /https?:\/\//);
  assert.equal(decideJdRecovery(text, 0).kind, 'ready');
});

test('a details page that rendered without its body is not a recovery', () => {
  // Adzuna occasionally serves the details page without the posting text.
  // The furniture around it is long enough to pass the length gate on its
  // own, so it must not reach the gate.
  const text = extractAdzunaPostingText(livePage(''));
  assert.ok(text.length < 200, text);
  assert.equal(decideJdRecovery(text, 0).kind, 'retry');
});

test('an expired listing is recognised as closed', () => {
  const page = [
    'Title: Business Solutions Advisor Job in Palos Hills, IL',
    '',
    'Markdown Content:',
    ' What?   Where?   Search [Advanced](https://www.adzuna.com/advanced-search)',
    '',
    'Unfortunately, this job is no longer available',
    '',
    'Our mission is to help you land that dream job with unique tools',
    '',
    '# Business Solutions Advisor',
    '',
    'Location:Palos Hills, IL Company:Bank of America',
    '## Description:',
    '',
    POSTING_BODY,
    '',
    FOOTER,
  ].join('\n');
  const text = extractAdzunaPostingText(page);
  assert.doesNotMatch(text, /Top job titles|ADZUNA LTD/);
  assert.equal(decideJdRecovery(text, 0).kind, 'closed');
});

test('an error page yields nothing', () => {
  assert.equal(extractAdzunaPostingText('Title: Access Denied\n\n## Our systems have detected suspicious behaviour'), '');
  assert.equal(extractAdzunaPostingText(''), '');
});
