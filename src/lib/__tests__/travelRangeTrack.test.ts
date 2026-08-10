import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { TravelRangeTrack } from '../../components/TravelRangeTrack';

test('travel range track fills only the explicit interval and exposes an accessible equivalent', () => {
  const html = renderToStaticMarkup(React.createElement(TravelRangeTrack, {
    range: {
      kind: 'range',
      minimumPercent: 50,
      maximumPercent: 75,
      label: '50-75%',
      sourceText: 'Travel is 50-75%.',
    },
  }));
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Travel stated in job description: 50-75%\. Travel is 50-75%\."/);
  assert.match(html, /left:50%/);
  assert.match(html, /width:25%/);
  assert.doesNotMatch(html, /width:75%/);
});

test('point travel uses a narrow marker rather than a filled interval', () => {
  const html = renderToStaticMarkup(React.createElement(TravelRangeTrack, {
    range: {
      kind: 'point', minimumPercent: 50, maximumPercent: 50, label: '50%', sourceText: 'Travel is 50%.',
    },
  }));
  assert.match(html, /travel-range-point/);
  assert.match(html, /left:50%/);
  assert.doesNotMatch(html, /travel-range-segment/);
});
