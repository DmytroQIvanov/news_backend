import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const routing = require('../dist/kb/kb-routing.js');
const { KbEditorialService } = require('../dist/kb/kb-editorial.service.js');
const { budgetKey } = require('../dist/common/llm-budget.js');

const article = (extra = {}) => ({ event_id: 1, title: 'Title of the article', summary: 'Summary', body: 'Original body text. [D1]', ...extra });
const issue = { location: 'body', problem: 'unsupported', fix: 'remove' };

test('big articles use only the three Flash models and never fall back to a Lite model', () => {
  const big = KbEditorialService.tierModels('big');
  assert.deepEqual(big, ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3-flash-preview']);
  assert.ok(!big.some((m) => /lite|hydrogen/.test(m)));
  assert.ok(!KbEditorialService.tierModels('medium').some((m) => /3\.8|3\.6|gemini-3-flash/.test(m)));
  assert.equal(budgetKey('gemini-3-flash-preview'), 'gemini-3-flash');
});

test('the pace spreads the budget over the day and keeps calls for breaking news', () => {
  const p = { dayBudget: 20, urgentReserve: 3 };
  assert.equal(routing.paceAllowance({ ...p, remaining: 20, hoursLeft: 24 }), 1, 'one batch right after the reset');
  assert.equal(routing.paceAllowance({ ...p, remaining: 19, hoursLeft: 24 }), 0, 'then it waits');
  assert.equal(routing.paceAllowance({ ...p, remaining: 19, hoursLeft: 12 }), 9);
  assert.equal(routing.paceAllowance({ ...p, remaining: 3, hoursLeft: 1 }), 0, 'the reserve stays for urgent events');
  assert.equal(routing.paceAllowance({ ...p, remaining: 10, hoursLeft: 0 }), 7);
});

test('the quota day ends at midnight Pacific time', () => {
  assert.equal(routing.hoursUntilQuotaReset(Date.parse('2026-11-18T20:00:00Z')), 12);
  assert.equal(routing.hoursUntilQuotaReset(Date.parse('2026-11-19T07:30:00Z')), 0.5);
});

test('related events are placed in one batch without moving the best event', () => {
  const ids = routing.groupRelated([
    { id: 1, storylineId: 7, category: 'war' }, { id: 2, storylineId: null, category: 'tech' },
    { id: 3, storylineId: 7, category: 'world' }, { id: 4, storylineId: null, category: 'war' }, { id: 5, storylineId: null, category: 'tech' },
  ]).map((x) => x.id);
  assert.deepEqual(ids, [1, 3, 4, 2, 5]);
});

test('an article the patches could not change goes to the Flash rewrite; a patched one does not', async () => {
  const calls = [];
  const a = article();
  const b = article({ event_id: 2, body: 'Second body text here. [D1]' });
  const svc = new KbEditorialService({});
  svc.llm = async (req) => {
    calls.push(req);
    if (req.purpose === 'kb_review') return { model: 'reviewer', json: { reviews: [1, 2].map((event_id) => ({ event_id, verdict: 'fix', issues: [issue] })) } };
    if (req.models.includes('gemini-3.8-flash')) return { model: 'gemini-3.8-flash', json: { articles: [{ ...b, body: 'Rewritten body. [D1]' }] } };
    return { model: 'patcher', json: { patches: [{ event_id: 1, field: 'body', find: 'Original body text.', replace: 'Corrected body text.' }] } };
  };
  const res = await svc.reviewAndFix([{ eventId: 1, material: 'm' }, { eventId: 2, material: 'm' }], [a, b], 1000, { rewriteUnpatched: true });
  assert.equal(calls.length, 3);
  assert.match(calls[2].prompt, /EVENT 2/);
  assert.doesNotMatch(calls[2].prompt, /EVENT 1/);
  assert.match(res.articles[0].body, /Corrected/);
  assert.match(res.articles[1].body, /Rewritten/);
  assert.equal(res.reviews.get(1).verdict, 'changed_requires_review');
  assert.equal(res.reviews.get(2).verdict, 'changed_requires_review');
});

test('without the rewrite option a cheap review never spends a Flash request', async () => {
  const calls = [];
  const svc = new KbEditorialService({});
  svc.llm = async (req) => {
    calls.push(req.purpose);
    return req.purpose === 'kb_review' ? { model: 'r', json: { reviews: [{ event_id: 1, verdict: 'fix', issues: [issue] }] } } : { model: 'p', json: { patches: [] } };
  };
  await svc.reviewAndFix([{ eventId: 1, material: 'm' }], [article()], 1000);
  assert.deepEqual(calls, ['kb_review', 'kb_fix']);
});
