import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

test('llm budget: model families map to their daily limit key', () => {
  const { budgetKey } = require('../dist/common/llm-budget.js');
  assert.equal(budgetKey('gemini-3.1-flash-lite'), 'gemini-3.1-flash-lite');
  assert.equal(budgetKey('models/gemini-3-flash-preview'), 'gemini-3-flash');
  assert.equal(budgetKey('gemini-4-hydrogen-high'), 'gemini-4-hydrogen');
  assert.equal(budgetKey('gemini-3.5-flash-lite'), null);
  assert.equal(budgetKey('gemma-4-31b-it'), null, 'Gemma has no daily cap');
  assert.equal(budgetKey('gemini-2.5-flash-lite'), 'gemini-2.5-flash-lite');
});

test('llm budget: 20 per day, reserved share protected from other purposes (memory fallback)', async () => {
  const saved = process.env.DATABASE_URL;
  delete process.env.DATABASE_URL;
  process.env.LLM_DAILY_LIMITS = 'gemini-3.8-flash=5';
  process.env.LLM_BUDGET_RESERVED = 'gemini-3.8-flash=kb_editorial:3';
  const { reserveLlmCall, resetLlmBudgetForTests } = require('../dist/common/llm-budget.js');
  resetLlmBudgetForTests();
  const noon = Date.parse('2026-11-17T12:00:00Z');
  let granted = 0;
  for (let i = 0; i < 8; i += 1) if (await reserveLlmCall('gemini-3.8-flash', 'kb_editorial', noon)) granted += 1;
  assert.equal(granted, 5, 'never more than the daily limit');
  assert.equal(await reserveLlmCall('gemini-3.8-flash', 'memes', noon), false);
  assert.equal(await reserveLlmCall('gemini-3.5-flash-lite', 'memes', noon), true, 'unbudgeted models pass');
  // next day starts fresh
  assert.equal(await reserveLlmCall('gemini-3.8-flash', 'memes', noon + 24 * 3600_000), true);
  process.env.DATABASE_URL = saved;
  delete process.env.LLM_DAILY_LIMITS;
  delete process.env.LLM_BUDGET_RESERVED;
});

test('kb labels: every predicate of the lexicon has uk/en labels', () => {
  const { PREDICATE_LABELS } = require('../dist/kb/kb-labels.js');
  for (const p of ['acquire', 'pledge', 'provide', 'detain', 'charge', 'convict', 'supply_trade', 'attack', 'state', 'deny']) {
    assert.ok(PREDICATE_LABELS[p]?.uk && PREDICATE_LABELS[p]?.en, p);
  }
});

test('flagship history renders refs that the publisher accepts', () => {
  const { renderHistory } = require('../dist/kb/kb-history.js');
  const text = renderHistory({
    steps: [{ ref: 'H1', eventId: 2, hop: 1, viaEventId: 1, linkType: 'reaction_to', score: 0.8, title: 'Earlier strike', summary: null, date: '2026-11-10T00:00:00Z', sources: 3, facts: [], verdict: null }],
    precedents: [{ ref: 'P1', eventId: 3, title: 'Last year', date: '2025-11-01T00:00:00Z', sources: 2, facts: [] }],
    timeline: [{ ref: 'T1', entity: 'X', text: 'X — appointed — Y', date: '2024-01-01', status: 'confirmed' }],
  });
  assert.match(text, /\[H1\] hop 1 2026-11-10/);
  assert.match(text, /\[P1\] 2025-11-01/);
  assert.match(text, /\[T1\] 2024-01-01/);
  assert.equal(renderHistory({ steps: [], precedents: [], timeline: [] }), '');
});
