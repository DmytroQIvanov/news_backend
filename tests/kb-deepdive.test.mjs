import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const g = require('../dist/kb/kb-deepdive-gates.js');
const { KbDeepDiveService } = require('../dist/kb/kb-deepdive.service.js');

const para = (n, cite = 'S1') => `${'The company described the plan in a plain statement and listed the steps in order. '.repeat(n)} [${cite}]`;
const body = (sections = 5, perSection = 3, words = 30) => Array.from({ length: sections }, (_, i) => `## Section ${i + 1}\n\n${Array.from({ length: perSection }, (_, j) => para(words / 12 + 1, `S${((i + j) % 7) + 1}`)).join('\n\n')}`).join('\n\n');

test('parseSections / remapCitations / stripInternalRefs', () => {
  const s = g.parseSections('## A\n\nOne [S2].\n\nTwo [S3, S2].\n\n## B\n\nThree.');
  assert.equal(s.length, 2);
  assert.equal(s[0].paragraphs.length, 2);
  const r = g.remapCitations('Alpha [S3]. Beta [S1, S3]. Gamma [S9].', ['a', 'b', 'c']);
  assert.equal(r.body, 'Alpha [1]. Beta [2, 1]. Gamma .');
  assert.deepEqual(r.sources, ['c', 'a']);
  assert.equal(g.stripInternalRefs('Text [E3] more [F1, F2] end [D4].'), 'Text more end.');
});

test('deterministic gates reject short, uncited, sensational and number-inventing drafts', () => {
  const material = 'The company invested 2000 units in 2026.';
  const good = body(5, 4, 60);
  assert.equal(g.deterministicGates({ title: 'How the company structured its plan', standfirst: 'A plain description of the steps.', body: good, sourcesAvailable: 7, material }, { minWords: 600 }).ok, true);
  const short = g.deterministicGates({ title: 'How the company structured its plan', standfirst: 'Plain.', body: body(2, 1, 40), sourcesAvailable: 7, material }, { minWords: 1300 });
  assert.equal(short.ok, false);
  assert.match(short.problems.join(' '), /too short/);
  const uncited = g.deterministicGates({ title: 'How the company structured its plan', standfirst: 'Plain.', body: `${good}\n\n${'A long paragraph without any citation at all. '.repeat(8)}`, sourcesAvailable: 7, material }, { minWords: 600 });
  assert.match(uncited.problems.join(' '), /no citation/);
  const hype = g.deterministicGates({ title: 'The company shatters the market', standfirst: 'Plain.', body: good, sourcesAvailable: 7, material }, { minWords: 600 });
  assert.match(hype.problems.join(' '), /sensational/);
  const invented = g.deterministicGates({ title: 'How the company structured its plan', standfirst: 'Plain.', body: `${good}\n\nThe plan cost 987654 units. [S1]`, sourcesAvailable: 7, material }, { minWords: 600 });
  assert.match(invented.problems.join(' '), /numbers not in the material/);
});

test('verification passes only without unsupported paragraphs and with at most 25% partial', () => {
  const v = (verdict) => ({ index: 0, verdict, issues: [] });
  assert.equal(g.verificationPasses(Array(8).fill(v('supported')), 8).ok, true);
  assert.equal(g.verificationPasses([...Array(7).fill(v('supported')), v('unsupported')], 8).ok, false);
  assert.equal(g.verificationPasses([...Array(5).fill(v('supported')), v('partial'), v('partial'), v('partial')], 8).ok, false);
  assert.equal(g.verificationPasses([...Array(6).fill(v('supported')), v('partial'), v('partial')], 8).ok, true);
  assert.equal(g.verificationPasses([v('supported')], 8).ok, false, 'unchecked paragraphs do not pass');
});

function service(callImpl) {
  const inserted = [];
  const db = {
    async query(sql, params) {
      if (/INSERT INTO news_items/.test(sql)) { inserted.push(params); return { rows: [{ id: '501' }] }; }
      if (/FROM sources WHERE slug/.test(sql)) return { rows: [{ id: 'src-1' }] };
      return { rows: [] };
    },
  };
  const s = new KbDeepDiveService(db);
  s.call = callImpl;
  s.translator = async (_l, head, text) => ({ title: `UK ${head.title}`, summary: `UK ${head.summary}`, why: 'UK why', body: `UK ${text}`.padEnd(text.length, ' x'), model: 'stub' });
  return { s, inserted };
}

const material = {
  context: Array.from({ length: 8 }, (_, i) => `[S${i + 1}] Source ${i + 1} (2026-11-19) "Title ${i + 1}"\n    The company invested 2000 units and described the plan in a plain statement.`).join('\n'),
  docs: Array.from({ length: 8 }, (_, i) => ({ source: `Source ${i + 1}`, pub: '2026-11-19', title: `Title ${i + 1}`, url: `https://example${i + 1}.com/a`, evidenceRoot: `root${i + 1}` })),
  origins: 8, events: 5,
};
const topic = { key: 'entity:1', kind: 'entity', title: 'Acme', brief: 'Explain Acme.', category: 'global_tech' };

function fakeCall(verifyVerdict) {
  return async (_models, _system, prompt, _schema, _max, purpose) => {
    if (purpose === 'deepdive_outline') return { model: 'writer', text: JSON.stringify({ angle: 'A plain angle', why: 'Because it matters.', sections: Array.from({ length: 5 }, (_, i) => ({ heading: `Part ${i + 1}`, purpose: 'x', use: ['S1'] })) }) };
    if (purpose === 'deepdive_section') { const i = (prompt.match(/section (\d)/) ?? [0, 1])[1]; return { model: 'writer', text: Array.from({ length: 3 }, (_, j) => para(7, `S${((Number(i) + j) % 7) + 1}`)).join('\n\n') }; }
    if (purpose === 'deepdive_head') return { model: 'writer', text: JSON.stringify({ title: 'How Acme structured its plan', standfirst: 'A plain description of the plan and its steps.' }) };
    if (purpose === 'deepdive_verify') {
      const n = (prompt.match(/^#\d+ /gm) ?? []).length;
      return { model: 'gemma', text: JSON.stringify({ paragraphs: Array.from({ length: n }, (_, k) => ({ index: k, verdict: verifyVerdict, issues: verifyVerdict === 'supported' ? [] : [{ claim: 'x', why: 'not in source' }] })) }) };
    }
    return { model: 'writer', text: para(7) };
  };
}

test('a draft that passes every gate is translated and published with the deepdive tier', async () => {
  const { s, inserted } = service(fakeCall('supported'));
  const out = await s.write(topic, material, 7);
  assert.equal(out.status, 'published', JSON.stringify(out));
  assert.equal(inserted.length, 1);
  const metadata = JSON.parse(inserted[0][9]);
  assert.equal(metadata.editorial_tier, 'deepdive');
  assert.equal(metadata.kb.review.state, 'approved');
  assert.equal(metadata.kb.review.independent_verifier, 'gemma');
  assert.ok(metadata.article.body_uk.length > 1000);
  assert.ok(/\[1\]/.test(metadata.article.body), 'citations are renumbered');
});

test('unsupported paragraphs (even after repair) discard the draft: nothing is inserted', async () => {
  const { s, inserted } = service(fakeCall('unsupported'));
  const out = await s.write(topic, material, 8);
  assert.equal(out.status, 'rejected');
  assert.equal(inserted.length, 0);
});
