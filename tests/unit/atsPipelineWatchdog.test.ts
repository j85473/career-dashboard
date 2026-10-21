import assert from 'node:assert/strict';
import test from 'node:test';
import { acquisitionProgressFinding } from '../../scripts/ats_pipeline_watchdog';

test('busy workers without any durable advancement still raise the acquisition stall alert', () => {
  const finding = acquisitionProgressFinding({ processed: 0, receipts: 140, advanced: 0, progressed: 0 });
  assert.equal(finding?.severity, 'critical');
  assert.equal(finding?.check, 'no_boards_completing');
  assert.equal(finding?.repairable, false);
});

test('saved item progress keeps a large unfinished board out of the critical stall state', () => {
  const finding = acquisitionProgressFinding({ processed: 0, receipts: 140, advanced: 0, progressed: 5 });
  assert.equal(finding?.severity, 'info');
  assert.match(finding!.detail, /5 items made durable progress/);
  assert.equal(finding?.repairable, false);
});

test('completed boards, intermediate phase advancement and quiet work retain their existing meanings', () => {
  assert.equal(acquisitionProgressFinding({ processed: 1, receipts: 140, advanced: 0, progressed: 0 }), null);
  assert.equal(acquisitionProgressFinding({ processed: 0, receipts: 50, advanced: 0, progressed: 0 }), null);
  assert.equal(acquisitionProgressFinding({ processed: 0, receipts: 140, advanced: 1, progressed: 0 })?.severity, 'info');
});
