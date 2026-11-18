import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const good = {
  same_event: true, match_confidence: 0.9, on_topic: true, source_type: 'national_outlet', reliability: 'high',
  independent: true, adds_information: true, characterization: 'national daily', reason: 'own reporting',
};

test('corroboration: a page is accepted only when every criterion holds', () => {
  const { acceptVerdict } = require('../dist/kb/kb-corroboration.service.js');
  assert.equal(acceptVerdict(good).accepted, true);
  assert.equal(acceptVerdict({ ...good, same_event: false }).accepted, false);
  assert.equal(acceptVerdict({ ...good, match_confidence: 0.6 }).accepted, false);
  assert.equal(acceptVerdict({ ...good, source_type: 'aggregator' }).accepted, false);
  assert.equal(acceptVerdict({ ...good, source_type: 'blog' }).accepted, false);
  assert.equal(acceptVerdict({ ...good, reliability: 'low' }).accepted, false);
  assert.equal(acceptVerdict({ ...good, independent: false }).accepted, false);
  assert.equal(acceptVerdict({ ...good, adds_information: false }).accepted, false);
});

test('corroboration: outlet roots are normalised', () => {
  const { rootOf } = require('../dist/kb/kb-corroboration.service.js');
  assert.equal(rootOf('https://www.bbc.co.uk/news/x'), 'bbc.co.uk');
  assert.equal(rootOf('https://edition.cnn.com/a'), 'cnn.com');
  assert.equal(rootOf('not a url'), '');
});
