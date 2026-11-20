import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const i18n = require('../dist/news/article-i18n.js');
const svc = require('../dist/news/article-i18n.service.js');

const uaVisual = {
  id: 'v1', type: 'step_flow', title: 'Хронологія подій навколо відставки', caption: 'Ключові дати кадрової кризи',
  source: { name: 'CNBC' },
  steps: [{ label: 'Відставка Дженсена Хуана', sub: 'Рада директорів прийняла рішення' }, { label: '2026' }],
  items: [{ label: 'Nvidia', value: 5, unit: '$ млрд' }],
};

test('scriptLang: prose has a language, names and numbers do not', () => {
  assert.equal(i18n.scriptLang('Рада директорів прийняла рішення'), 'uk');
  assert.equal(i18n.scriptLang('The board accepted the resignation'), 'en');
  assert.equal(i18n.scriptLang('Nvidia'), null);
  assert.equal(i18n.scriptLang('2026'), null);
  assert.equal(i18n.scriptLang('GPU'), null);
});

test('visualSlots covers text only, never numbers or source', () => {
  const slots = i18n.visualSlots(JSON.parse(JSON.stringify(uaVisual))).map((s) => s.get());
  assert.ok(slots.includes('Хронологія подій навколо відставки'));
  assert.ok(slots.includes('$ млрд'));
  assert.ok(!slots.includes('CNBC'));
});

test('localizeArticleRow hides wrong-language parts until translated, then shows the overlay', () => {
  const row = {
    article: { background: 'Firaxis has a thirty year history of strategy games.', whats_next: 'Development is expected to continue next year.',
      facts: [{ claim: 'The next game faced production difficulties during the year.' }] },
    media: { visuals: [uaVisual] },
  };
  const hiddenUk = i18n.localizeArticleRow(row, 'uk');
  assert.equal(hiddenUk.article.background, undefined);
  assert.equal(hiddenUk.article.facts.length, 0);
  assert.equal(hiddenUk.media.visuals.length, 1, 'a Ukrainian visual stays on the Ukrainian page');
  assert.equal(hiddenUk.i18n_pending, true);

  const hiddenEn = i18n.localizeArticleRow(row, 'en');
  assert.equal(hiddenEn.media.visuals.length, 0, 'a Ukrainian visual is not shown on the English page');
  assert.equal(hiddenEn.article.background, row.article.background);

  const withOverlay = { ...row, article: { ...row.article, i18n: { uk: { background: 'Firaxis має тридцятирічну історію стратегій.', facts: ['Наступна гра зіткнулася з труднощами виробництва.'] } } } };
  const uk = i18n.localizeArticleRow(withOverlay, 'uk');
  assert.equal(uk.article.background, 'Firaxis має тридцятирічну історію стратегій.');
  assert.equal(uk.article.facts[0].claim, 'Наступна гра зіткнулася з труднощами виробництва.');
  assert.equal(uk.article.i18n, undefined, 'raw overlay is not leaked');
});

test('buildOverlay translates only what is in the wrong language and validates the result', async () => {
  const calls = [];
  const fake = async (lang, texts) => { calls.push(texts); return { texts: texts.map((t) => (lang === 'en' ? `EN: The board accepted ${t.length}` : t)), model: 'test' }; };
  const src = { background: 'Це контекст, написаний українською мовою.', whats_next: 'This is already English prose here.', facts: [{ claim: 'Рада директорів прийняла рішення про відставку.' }], visuals: [uaVisual] };
  const overlay = await svc.buildOverlay(src, 'en', undefined, fake);
  assert.ok(overlay.background.startsWith('EN:'));
  assert.equal(overlay.whats_next, undefined, 'English text is left alone');
  assert.equal(overlay.facts.length, 1);
  assert.equal(overlay.visuals.length, 1);
  assert.equal(overlay.visuals[0].source.name, 'CNBC');
  assert.equal(overlay.visuals[0].items[0].value, 5);
  // a translator that answers in the wrong language is a failure, not a result
  const bad = async (_l, texts) => ({ texts: texts.map(() => 'Все ще українською мовою тут'), model: 'x' });
  assert.equal(await svc.buildOverlay(src, 'en', undefined, bad), null);
  // length mismatch is a failure
  const short = async () => ({ texts: ['only one'], model: 'x' });
  assert.equal(await svc.buildOverlay(src, 'en', undefined, short), null);
});

test('localizePreview only passes a preview in the right language', () => {
  assert.equal(i18n.localizePreview(uaVisual, null, 'en'), null);
  assert.equal(i18n.localizePreview(uaVisual, null, 'uk').id, 'v1');
  assert.equal(i18n.localizePreview(uaVisual, { ...uaVisual, title: 'Timeline of the resignation events' }, 'en').title, 'Timeline of the resignation events');
});
