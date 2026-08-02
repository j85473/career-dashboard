import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

type Evidence = { id: string; tags: string[]; scope_notes: string };

const evaluatorPrompt = fs.readFileSync('.agents/agents/standard-job-evaluator-v6/agent.md', 'utf8');
const inventoryMatch = evaluatorPrompt.match(/### Minified Evidence Inventory\s+```json\s+([\s\S]*?)\s+```/);
assert.ok(inventoryMatch, 'standard evaluator must contain the evidence inventory');
const inventory = JSON.parse(inventoryMatch[1]) as Evidence[];

test('evidence inventory does not promote adjacency into unsupported professional ownership', () => {
  const forbiddenTags = new Set([
    'C-suite communication',
    'strategic account management',
    'executive escalation',
    'RevOps',
    'workflow architecture',
    'SaaS NRR adjacency',
    'healthcare-commercial expertise',
  ]);
  for (const evidence of inventory) {
    for (const tag of evidence.tags) {
      assert.equal(forbiddenTags.has(tag), false, `${evidence.id} contains inflated tag ${tag}`);
    }
  }
  assert.match(inventory.find((item) => item.id === 'DSI-012')?.scope_notes || '', /Do not convert.*B2B SaaS/i);
  assert.match(inventory.find((item) => item.id === 'AGY-001')?.scope_notes || '', /no verified professional engineering tenure/i);
});
