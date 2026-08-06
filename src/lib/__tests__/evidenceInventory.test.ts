import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

type Evidence = { id: string; tags: string[]; scope_notes: string };

const evaluatorPrompt = fs.readFileSync('.agents/agents/standard-job-evaluator-v6/agent.md', 'utf8');
const inventoryMatch = evaluatorPrompt.match(/### Minified Evidence Inventory\s+```json\s+([\s\S]*?)\s+```/);
assert.ok(inventoryMatch, 'standard evaluator must contain the evidence inventory');
const inventory = JSON.parse(inventoryMatch[1]) as Evidence[];

test('evidence inventory preserves capability tags without promoting them into unsupported ownership', () => {
  const forbiddenTags = new Set([
    'strategic account management',
    'executive escalation',
    'healthcare-commercial expertise',
    'CRM administration',
    'forecast governance',
    'deal desk ownership',
    'enterprise account ownership',
  ]);
  for (const evidence of inventory) {
    for (const tag of evidence.tags) {
      assert.equal(forbiddenTags.has(tag), false, `${evidence.id} contains inflated tag ${tag}`);
    }
  }
  assert.match(inventory.find((item) => item.id === 'DSI-003')?.scope_notes || '', /does not establish formal RevOps department ownership/i);
  assert.match(inventory.find((item) => item.id === 'DSI-007')?.scope_notes || '', /does not establish formal RevOps department ownership, CRM administration, forecasting governance/i);
  assert.match(inventory.find((item) => item.id === 'DSI-012')?.scope_notes || '', /not formal renewal, ARR\/NRR, customer-contract ownership/i);
  assert.match(inventory.find((item) => item.id === 'DSI-015')?.scope_notes || '', /does not establish ownership of enterprise customer accounts/i);
  assert.match(inventory.find((item) => item.id === 'AGY-001')?.scope_notes || '', /no verified professional engineering tenure/i);
});
