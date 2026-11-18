import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeVisual, buildVisualsPrompt, VISUALS_RESPONSE_SCHEMA } from '../dist/news/news-visuals.js';
import { NewsMediaService } from '../dist/news/news-media.service.js';

const sample = { type: 'bar', title: 'Measured impact', source: { name: 'Report' }, items: [{ label: 'A', value: -5 }, { label: 'B', value: 10 }] };
test('visual sanitizer preserves the AI editorial slot, paragraph, anchor and relative position', () => {
  const placement = { slot: 'body', afterParagraph: 8, anchor: 'A measured 35 percent reduction', position: 0.7 };
  assert.deepEqual(sanitizeVisual({ ...sample, placement }, 'extracted').placement, placement);
  assert.equal(sanitizeVisual({ ...sample, placement: { slot: 'navigation' } }, 'extracted').placement, undefined);
  assert.deepEqual(sanitizeVisual({ ...sample, placement: { slot: 'body', afterParagraph: -1, anchor: 'x'.repeat(200), position: Infinity } }, 'extracted').placement,
    { slot: 'body', anchor: 'x'.repeat(180) });
});

test('visual prompt covers the later sections of long articles and supplies stable paragraph references', () => {
  const body = ['Opening.', '## Background\n' + 'Background detail '.repeat(400), '## Results\nLate evidence: a 35 percent reduction.'].join('\n\n');
  const prompt = buildVisualsPrompt({ title: 'Long article', summary: '', body, category: 'api' });
  assert.ok(prompt.includes('Late evidence: a 35 percent reduction'));
  assert.ok(prompt.includes('[P3]'));
  assert.ok(prompt.includes('afterParagraph'));
  assert.deepEqual(VISUALS_RESPONSE_SCHEMA.properties.visuals.items.properties.placement.properties.slot.enum,
    ['after_title', 'after_summary', 'after_context', 'body', 'after_body']);
});

test('charts reject misleading empty shares, impossible gauges and increasing funnels', () => {
  const source = { name: 'Report' };
  assert.equal(sanitizeVisual({ type: 'donut', title: 'Empty shares', source, items: [{ label: 'A', value: 0 }, { label: 'B', value: 0 }] }, 'extracted'), null);
  assert.equal(sanitizeVisual({ type: 'gauge', title: 'Impossible progress', source, max: 100, items: [{ label: 'A', value: 125 }] }, 'extracted'), null);
  assert.equal(sanitizeVisual({ type: 'funnel', title: 'Not a funnel', source, items: [{ label: 'A', value: 50 }, { label: 'B', value: 100 }, { label: 'C', value: 10 }] }, 'extracted'), null);
  assert.ok(sanitizeVisual(sample, 'extracted'));
});

test('temporary media budgets do not permanently mark an article as finished', async () => {
  const old = process.env.NEWS_VISUALS_DAILY_MAX;
  process.env.NEWS_VISUALS_DAILY_MAX = '0';
  try {
    const service = new NewsMediaService({ query: async () => assert.fail('must stay pending for a later day') });
    assert.equal(await service.attachVisuals({ body: 'Detailed article '.repeat(100), summary: '', important: true }), false);
  } finally { if (old === undefined) delete process.env.NEWS_VISUALS_DAILY_MAX; else process.env.NEWS_VISUALS_DAILY_MAX = old; }
});

test('additional news formats require explicit bounds, documented changes and known milestone states', () => {
  const common = { title: 'Documented change', source: { name: 'Official report' } };
  assert.ok(sanitizeVisual({ ...common, type: 'before_after', before: { label: 'Before', detail: 'Old rule' }, after: { label: 'After', detail: 'New rule' } }, 'extracted'));
  assert.equal(sanitizeVisual({ ...common, type: 'before_after', before: { label: 'Before', detail: 'Same rule' }, after: { label: 'After', detail: 'Same rule' } }, 'extracted'), null);
  assert.ok(sanitizeVisual({ ...common, type: 'range', ranges: [{ label: 'Estimate', low: 10, high: 20, value: 15 }] }, 'extracted'));
  assert.equal(sanitizeVisual({ ...common, type: 'range', ranges: [{ label: 'Estimate', low: 20, high: 10 }] }, 'extracted'), null);
  assert.equal(sanitizeVisual({ ...common, type: 'range', ranges: [{ label: 'Estimate', low: 10, high: 20, value: 30 }] }, 'extracted'), null);
  assert.ok(sanitizeVisual({ ...common, type: 'waterfall', items: [{ label: 'Revenue', value: 100, unit: '$' }, { label: 'Cost', value: -40, unit: '$' }] }, 'extracted'));
  assert.equal(sanitizeVisual({ ...common, type: 'waterfall', items: [{ label: 'Revenue', value: 100, unit: '$' }, { label: 'Cost', value: -40, unit: '%' }] }, 'extracted'), null);
  const checklist = sanitizeVisual({ ...common, type: 'checklist', steps: [{ label: 'Approved', status: 'done' }, { label: 'Release', status: 'pending' }] }, 'extracted');
  assert.equal(checklist.steps[1].status, 'pending');
  assert.equal(sanitizeVisual({ ...common, type: 'checklist', steps: [{ label: 'Unverified', status: 'maybe' }, { label: 'Release', status: 'pending' }] }, 'extracted'), null);
});
