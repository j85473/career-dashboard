import assert from 'node:assert/strict';
import test from 'node:test';

import { parseHimalayasCompanyWebsite } from '../himalayasMcp';

test('the public company-details response yields a clean official website', () => {
  const text = `# Panopto\n\n## Links\n🌐 **Website:** https://panopto.com?utm_source=himalayas.app&utm_medium=himalayas.app&ref=himalayas.app&source=himalayas.app\n💼 **Open Jobs:** https://himalayas.app/companies/panopto/jobs`;
  assert.equal(parseHimalayasCompanyWebsite(text), 'https://panopto.com/');
});

test('missing and unsafe website values are refused', () => {
  assert.equal(parseHimalayasCompanyWebsite('## Links\nNo website listed'), null);
  assert.equal(parseHimalayasCompanyWebsite('🌐 **Website:** javascript:alert(1)'), null);
});
