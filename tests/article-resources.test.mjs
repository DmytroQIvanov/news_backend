import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildResources,
  classifyResource,
  cleanResourceUrl,
  extractEmbeds,
  extractFigures,
  extractLinkCandidates,
  extractTextIdentifiers,
  isFreeLicense,
  matchTerms,
  parsePagePreview,
  youtubeVideoId,
} from '../dist/news/article-resources.js';

const PAGE = 'https://news.example.com/politics/2026/11/16/new-decree-signed';

const ARTICLE_HTML = `<html><head><title>x</title></head><body>
<header><nav><a href="/politics">Політика</a><a href="https://facebook.com/newsexample">Facebook</a></nav></header>
<article>
  <h1>Президент підписав указ</h1>
  <p>Президент підписав <a href="https://www.president.gov.ua/documents/1232025-55555?utm_source=tg">указ № 123/2025</a> про нові правила для енергетики, повідомили в Офісі Президента.</p>
  <figure><img src="https://cdn.example.com/photos/kyiv-substation-1200x800.jpg" width="1200" height="800"><figcaption>Підстанція у Києві після ремонту. Фото: Олена Петренко</figcaption></figure>
  <p>Документ ґрунтується на <a href="https://www.iea.org/reports/ukraine-energy-security-2026.pdf">звіті Міжнародного енергетичного агентства</a>, опублікованому минулого тижня.</p>
  <p>Код моделі навантаження відкрили на GitHub: <a href="https://github.com/energy-ua/grid-model">energy-ua/grid-model</a>, а інтерактивне <a href="https://huggingface.co/spaces/energy-ua/grid-demo">демо</a> вже працює.</p>
  <p>Міністр також виклав <a href="https://x.com/minenergy_ua/status/1856000000000000000">допис</a> із поясненнями.</p>
  <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
  <p>Про попередні рішення ми писали в матеріалі <a href="/politics/2026/10/01/energy-plan">про енергетичний план уряду на зиму</a>, який досі обговорюють.</p>
  <img src="https://cdn.example.com/avatar/author.jpg" class="author-avatar" width="64">
  <div class="share-buttons"><a href="https://twitter.com/intent/tweet?url=x">Tweet</a></div>
  <div class="related-news"><p><a href="/sport/2026/11/16/football">Футбол: збірна перемогла</a></p></div>
  <p>Читайте також: <a href="/tag/energy">енергетика</a></p>
</article>
<footer><a href="/privacy">Privacy</a></footer>
</body></html>`;

test('cleanResourceUrl drops tracking params, private hosts and non-https schemes', () => {
  assert.equal(cleanResourceUrl('http://example.org/a?utm_source=x&id=5#top'), 'https://example.org/a?id=5');
  assert.equal(cleanResourceUrl('mailto:a@b.c'), null);
  assert.equal(cleanResourceUrl('https://192.168.1.1/x'), null);
  assert.equal(cleanResourceUrl('/x', 'https://site.org/a/b'), 'https://site.org/x');
});

test('extractLinkCandidates keeps prose links and drops navigation, sharing, teasers and tags', () => {
  const links = extractLinkCandidates(ARTICLE_HTML, PAGE);
  const urls = links.map((l) => l.url);
  assert.ok(urls.includes('https://www.president.gov.ua/documents/1232025-55555'), 'tracking parameter removed');
  assert.ok(urls.some((u) => u.includes('iea.org')));
  assert.ok(urls.some((u) => u.includes('github.com/energy-ua/grid-model')));
  assert.ok(urls.some((u) => u.includes('huggingface.co/spaces')));
  assert.ok(urls.some((u) => u.includes('/status/')));
  assert.ok(urls.includes('https://news.example.com/politics/2026/10/01/energy-plan'), 'same-site link inside prose is kept');
  assert.ok(!urls.some((u) => /intent|facebook\.com\/newsexample|\/tag\/|\/privacy|football/.test(u)), urls.join('\n'));
  const decree = links.find((l) => l.url.includes('president.gov.ua'));
  assert.equal(decree.anchor, 'указ № 123/2025');
  assert.match(decree.context, /енергетики/);
});

test('classifyResource covers documents, studies, code, demos, media and coverage', () => {
  assert.equal(classifyResource('https://www.president.gov.ua/documents/1232025', 'указ № 123/2025'), 'primary_source');
  assert.equal(classifyResource('https://zakon.rada.gov.ua/laws/show/1234-20', 'Закон'), 'primary_source');
  assert.equal(classifyResource('https://www.kmu.gov.ua/news/uriad-ukhvalyv', 'повідомили в уряді', ''), 'press_release');
  assert.equal(classifyResource('https://reyestr.court.gov.ua/Review/123', 'рішення суду'), 'court');
  assert.equal(classifyResource('https://www.iea.org/reports/x.pdf', 'звіт МЕА'), 'report');
  assert.equal(classifyResource('https://www.nature.com/articles/s41586-026-1', 'study'), 'study');
  assert.equal(classifyResource('https://arxiv.org/abs/2601.01234'), 'paper');
  assert.equal(classifyResource('https://ukrstat.gov.ua/operativ/x'), 'data');
  assert.equal(classifyResource('https://github.com/a/b'), 'repo');
  assert.equal(classifyResource('https://huggingface.co/spaces/a/b'), 'demo');
  assert.equal(classifyResource('https://huggingface.co/a/b'), 'model');
  assert.equal(classifyResource('https://huggingface.co/datasets/a/b'), 'dataset');
  assert.equal(classifyResource('https://www.youtube.com/watch?v=dQw4w9WgXcQ'), 'video');
  assert.equal(classifyResource('https://t.me/channel/123'), 'social');
  assert.equal(classifyResource('https://www.google.com/maps/place/Kyiv'), 'map');
  assert.equal(classifyResource('https://docs.example.dev/start'), 'docs');
  assert.equal(classifyResource('https://www.reuters.com/world/x'), 'related_article');
  assert.equal(classifyResource('https://apps.apple.com/app/id1'), 'product');
  assert.equal(classifyResource('https://kyivfest.org', 'фестиваль Kyiv Fest'), 'event');
  assert.equal(classifyResource('https://somecompany.com'), 'website');
});

test('buildResources ranks primary material first and caps outside coverage', () => {
  const candidates = [
    ...['a', 'b', 'c', 'd', 'e'].map((x) => ({ url: `https://www.reuters.com/${x}`, anchor: `Reuters story ${x}`, context: '', origin: 'article' })),
    { url: 'https://github.com/energy-ua/grid-model', anchor: 'energy-ua/grid-model', context: '', origin: 'article' },
    { url: 'https://www.president.gov.ua/documents/1', anchor: 'указ № 123/2025', context: '', origin: 'article' },
    { url: PAGE, anchor: 'self', context: '', origin: 'article' },
  ];
  const res = buildResources(candidates, PAGE);
  assert.equal(res[0].type, 'primary_source');
  assert.equal(res[0].id, 'r1');
  assert.equal(res.filter((r) => r.type === 'related_article').length, 3);
  assert.ok(!res.some((r) => r.url === PAGE), 'the article itself is not a resource');
  const repo = res.find((r) => r.type === 'repo');
  assert.ok(repo.match.includes('energy-ua/grid-model') && repo.match.includes('GitHub'));
  assert.ok(res[0].match.includes('№ 123/2025'));
});

test('matchTerms finds document numbers, quoted titles and names', () => {
  const terms = matchTerms('https://example.org/r', 'доповідь «Стан енергетики 2026»', '', 'Міністерство оприлюднило постанову № 456 від 1 листопада');
  assert.ok(terms.includes('Стан енергетики 2026'));
  assert.ok(terms.includes('№ 456'));
});

test('extractTextIdentifiers finds exact GitHub, Hugging Face, arXiv, DOI and bare URLs only', () => {
  const ids = extractTextIdentifiers(
    'Код — github.com/openai/whisper. Модель: huggingface.co/meta-llama/Llama-3-8B. Препринт arXiv:2601.01234v2, DOI: 10.1038/s41586-026-0001-1. Деталі: https://example.org/report.pdf.',
  );
  const urls = ids.map((i) => i.url);
  assert.ok(urls.includes('https://github.com/openai/whisper'));
  assert.ok(urls.includes('https://huggingface.co/meta-llama/Llama-3-8B'));
  assert.ok(urls.includes('https://arxiv.org/abs/2601.01234'));
  assert.ok(urls.includes('https://doi.org/10.1038/s41586-026-0001-1'));
  assert.ok(urls.includes('https://example.org/report.pdf'), urls.join(' '));
  assert.equal(extractTextIdentifiers('Компанія виклала код на GitHub').length, 0, 'no identifier, no guess');
});

test('extractFigures keeps article photos with caption, credit, keywords and position; skips avatars', () => {
  const figs = extractFigures(ARTICLE_HTML, PAGE, 'News Example');
  assert.equal(figs.length, 1);
  const [f] = figs;
  assert.equal(f.url, 'https://cdn.example.com/photos/kyiv-substation-1200x800.jpg');
  assert.match(f.caption, /Підстанція/);
  assert.equal(f.credit, 'Олена Петренко');
  assert.ok(f.position > 0 && f.position < 0.5);
  assert.ok(f.match.some((w) => w.startsWith('підстан')), f.match.join(','));
});

test('extractEmbeds finds YouTube players; youtubeVideoId parses all URL shapes', () => {
  const embeds = extractEmbeds(ARTICLE_HTML);
  assert.equal(embeds[0].kind, 'video');
  assert.equal(embeds[0].videoId, 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://youtu.be/dQw4w9WgXcQ?t=3'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://www.youtube.com/shorts/dQw4w9WgXcQ'), 'dQw4w9WgXcQ');
  assert.equal(youtubeVideoId('https://example.com/watch?v=x'), null);
  const tg = extractEmbeds('<article><p>Текст</p><script async src="https://telegram.org/js/telegram-widget.js" data-telegram-post="minenergy/123"></script></article>');
  assert.equal(tg[0].url, 'https://t.me/minenergy/123');
});

test('parsePagePreview reads Open Graph tags; isFreeLicense rejects NC/ND', () => {
  const p = parsePagePreview(
    '<head><meta property="og:title" content="Ukraine Energy Security 2026"><meta name="description" content="Annual review"><meta property="og:image" content="/i.png"><meta property="og:site_name" content="IEA"></head>',
    'https://www.iea.org/reports/x',
  );
  assert.deepEqual(p, { title: 'Ukraine Energy Security 2026', description: 'Annual review', image: 'https://www.iea.org/i.png', siteName: 'IEA' });
  assert.ok(isFreeLicense('CC BY-SA 4.0'));
  assert.ok(isFreeLicense('Public domain'));
  assert.ok(isFreeLicense('CC0'));
  assert.ok(!isFreeLicense('CC BY-NC 2.0'));
  assert.ok(!isFreeLicense('Fair use'));
});

test('real-page cases: follow-us blocks, video timestamps, date anchors, shorteners and teaser images are dropped', async () => {
  const { extractLinkCandidates, extractFigures, buildResources, isWeakAnchor } = await import('../dist/news/article-resources.js');
  const page = 'https://news.example.com/a/1';
  const html = `<article>
    <p>Підписуйтесь на нас у <a href="https://t.me/newsexample">Telegram</a>, <a href="https://invite.viber.com/?g2=x">Viber</a> та <a href="https://www.instagram.com/newsexample/">Instagram</a>, щоб нічого не пропустити.</p>
    <p>Таймкоди відео: <a href="https://www.youtube.com/watch?v=DEviAsf7JDI&t=20s">00:20</a>, <a href="https://www.youtube.com/watch?v=DEviAsf7JDI&t=113s">01:53</a> і повний запис <a href="https://youtu.be/DEviAsf7JDI">на YouTube</a> для охочих.</p>
    <p>Допис опублікували <a href="https://twitter.com/clash/status/123?ref_src=twsrc">November 16, 2026</a>, а потім повторили <a href="https://x.com/clash/status/123">у X</a> та <a href="https://bit.ly/promo">за посиланням зі знижкою</a> сьогодні.</p>
    <a href="/other-story"><img src="https://cdn.example.com/teaser.jpg" width="800"></a>
    <figure><img src="https://cdn.example.com/real.jpg" width="900"><figcaption>Справжнє фото до цієї новини з місця події</figcaption></figure>
  </article>`;
  const urls = extractLinkCandidates(html, page).map((c) => c.url);
  assert.ok(!urls.some((u) => /t\.me|viber|instagram|bit\.ly/.test(u)), urls.join('\n'));
  assert.equal(urls.filter((u) => u.includes('youtube.com')).length, 1, 'one video, one link');
  assert.ok(urls.includes('https://www.youtube.com/watch?v=DEviAsf7JDI'));
  assert.equal(urls.filter((u) => u.includes('/status/123')).length, 1, 'twitter.com and x.com are one post');
  const res = buildResources(extractLinkCandidates(html, page).map((c) => ({ ...c, origin: 'article' })), page);
  assert.equal(res.find((r) => r.type === 'social').title, 'X', 'a date is not a title');
  assert.ok(isWeakAnchor('заявив') && isWeakAnchor('16 листопада 2026') && !isWeakAnchor('NetHunt CRM') && !isWeakAnchor('указ № 12'));
  const figs = extractFigures(html, page, 'News');
  assert.deepEqual(figs.map((f) => f.url), ['https://cdn.example.com/real.jpg'], 'a linked teaser image is not a story photo');
});
