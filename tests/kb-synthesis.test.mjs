import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const s = require('../dist/kb/kb-synthesis.js');
const editor = require('../dist/kb/kb-editorial.service.js');

test('synthesis is off by default and configurable', () => {
  delete process.env.KB_SYNTHESIS;
  assert.equal(s.synthesisEnabled(), false);
  process.env.KB_SYNTHESIS = 'true';
  assert.equal(s.synthesisEnabled(), true);
  const c = s.synthConfig();
  assert.equal(c.minDocs, 3);
  assert.equal(c.minOrigins, 2);
  assert.equal(c.maxDocs, 10);
  assert.equal(c.minifyChars, 39200, '1.4 x the old 28 000 character medium budget');
  delete process.env.KB_SYNTHESIS;
});

test('topicReady needs 3 documents from 2 independent origins', () => {
  assert.equal(s.topicReady({ siblingIds: [], docs: 2, origins: 2 }), false);
  assert.equal(s.topicReady({ siblingIds: [], docs: 5, origins: 1 }), false);
  assert.equal(s.topicReady({ siblingIds: [7], docs: 3, origins: 2 }), true);
});

test('the synthesis prompt demands comparison, chronology, what is new and no copied headline', () => {
  assert.match(s.SYNTHESIS_PROMPT, /Compare what the different sources say/);
  assert.match(s.SYNTHESIS_PROMPT, /chronology/);
  assert.match(s.SYNTHESIS_PROMPT, /NEW/);
  assert.match(s.SYNTHESIS_PROMPT, /Never reuse the headline/);
  assert.equal(s.minCitedSources(), 3);
});

test('medium minimum length is 350 words in synthesis mode only', () => {
  delete process.env.KB_SYNTHESIS;
  assert.equal(editor.minWordsFor('medium'), 180);
  process.env.KB_SYNTHESIS = 'true';
  assert.equal(editor.minWordsFor('medium'), 350);
  assert.equal(editor.minWordsFor('big'), 450);
  delete process.env.KB_SYNTHESIS;
});
