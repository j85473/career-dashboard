import assert from 'node:assert/strict';
import test from 'node:test';
import { employerProofFixture } from '../../../tests/fixtures/atsEmployerProof';
import { applyRetainedEmployerPlan, retainedEmployerPlanHash, verifyRetainedEmployerProof,
  type RetainedEmployerBoard, type RetainedEmployerPlan } from '../retainedAtsEmployerRepair';

test('retained repair replays source proof and refuses substituted employers or missing evidence', async () => {
  await verifyRetainedEmployerProof(employerProofFixture());
  for (const mutate of [(board: RetainedEmployerBoard) => { board.company = 'Guessed Employer'; },
    (board: RetainedEmployerBoard) => { board.sources.pop(); },
    (board: RetainedEmployerBoard) => { board.sources[1].body = 'changed'; },
    (board: RetainedEmployerBoard) => { board.sources[0].responseUrl = 'https://other.fa.us2.oraclecloud.com/'; },
  ]) {
    const board = employerProofFixture(); mutate(board);
    await assert.rejects(verifyRetainedEmployerProof(board));
  }
});
test('posting proof is confined to the saved requisition, title and returned evidence', async () => {
  await verifyRetainedEmployerProof(employerProofFixture(true));
  for (const mutate of [(board: RetainedEmployerBoard) => { board.job!.title = 'Other Title'; },
    (board: RetainedEmployerBoard) => { board.job!.publicAtsPostingId = '1001'; },
    (board: RetainedEmployerBoard) => { board.evidence!.location = 'Guessed Location'; },
    (board: RetainedEmployerBoard) => { board.sources[0].responseUrl = String(board.job!.url).replace('/1000/', '/1001/'); },
  ]) {
    const board = employerProofFixture(true); mutate(board);
    await assert.rejects(verifyRetainedEmployerProof(board));
  }
});
test('incomplete, changed or expired recovery plans cannot begin a database write', async () => {
  const client = { $transaction: () => assert.fail('Invalid plans must not reach a writer') };
  for (const kind of ['incomplete', 'changed', 'expired']) {
    const plan: RetainedEmployerPlan = { version: 1, createdAt: new Date().toISOString(), complete: true, boards: [employerProofFixture()] };
    if (kind === 'incomplete') plan.complete = false;
    if (kind === 'expired') plan.boards[0].checkedAt = '2020-01-01T00:00:00Z';
    const hash = retainedEmployerPlanHash(plan);
    if (kind === 'changed') plan.boards[0].company = 'Different Employer';
    await assert.rejects(applyRetainedEmployerPlan(client as never, plan, hash));
  }
});
