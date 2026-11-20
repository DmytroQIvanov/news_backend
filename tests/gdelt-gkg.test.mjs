import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deflateRawSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const g = require('../dist/news/gdelt-gkg.js');
const adapters = require('../dist/news/api-adapters.js');

function zipOf(name, text) {
  const raw = Buffer.from(text, 'utf8');
  const data = deflateRawSync(raw);
  const nm = Buffer.from(name);
  const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nm.length, 26);
  const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(raw.length, 24); cd.writeUInt16LE(nm.length, 28); cd.writeUInt32LE(0, 42);
  const cdOffset = lh.length + nm.length + data.length;
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(cd.length + nm.length, 12); eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([lh, nm, data, cd, nm, eocd]);
}

function row({ date = '20261119113000', domain, url, locations = '', title }) {
  const c = new Array(27).fill('');
  c[0] = `${date}-1`; c[1] = date; c[3] = domain; c[4] = url; c[9] = locations;
  c[26] = title ? `<PAGE_TITLE>${title}</PAGE_TITLE>` : '';
  return c.join('\t');
}

test('readFirstZipEntry inflates the CSV', () => {
  assert.equal(g.readFirstZipEntry(zipOf('x.csv', 'a\tb\n')).toString(), 'a\tb\n');
  assert.throws(() => g.readFirstZipEntry(Buffer.from('not a zip at all, definitely not')));
});

test('parseGkg keeps Ukraine rows with a title, upgrades http to https, decodes entities', () => {
  const csv = [
    row({ domain: 'www.bbc.com', url: 'http://www.bbc.com/news/1', locations: '1#Ukraine#UP#UP#49#32#UP;1#Kyiv#UP#UP12#50#30#-1044367', title: 'Russia strikes Kyiv &amp; Odesa overnight' }),
    row({ domain: 'example.com', url: 'https://example.com/2', locations: '1#France#FR#FR#46#2#FR', title: 'Something unrelated about France today' }),
    row({ domain: 'pravda.com.ua', url: 'https://pravda.com.ua/3', locations: '', title: 'Новина без згадки локації в даних' }),
    row({ domain: 'bbc.com', url: 'https://bbc.com/4', locations: '1#Ukraine#UP#UP#49#32#UP', title: 'short' }),
  ].join('\n');
  const rows = g.parseGkg(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].url, 'https://www.bbc.com/news/1');
  assert.equal(rows[0].title, 'Russia strikes Kyiv & Odesa overnight');
  assert.equal(rows[0].ukraineMentions, 2);
  assert.equal(rows[0].seendate, '20261119T113000Z');
  assert.equal(rows[1].domain, 'pravda.com.ua');
});

test('slotsBack steps 15 minutes', () => {
  assert.deepEqual(g.slotsBack('20261119113000', 3), ['20261119113000', '20261119111500', '20261119110000']);
});

test('loadGdeltGkg reads both feeds once per slot and the adapter gets feed items', async () => {
  g.resetGdeltGkgForTests();
  const calls = [];
  const en = zipOf('a.csv', row({ domain: 'bbc.com', url: 'https://bbc.com/a', locations: '1#Ukraine#UP#UP#1#1#UP', title: 'Ukraine talks continue in Geneva this week' }));
  const tr = zipOf('b.csv', row({ domain: 'ukrinform.ua', url: 'https://ukrinform.ua/b', locations: '1#Ukraine#UP#UP#1#1#UP', title: 'Переговори щодо України тривають у Женеві' }));
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (url.endsWith('lastupdate.txt')) return new Response('1 x https://data.gdeltproject.org/gdeltv2/20261119113000.gkg.csv.zip\n');
    if (url.endsWith('lastupdate-translation.txt')) return new Response('1 x https://data.gdeltproject.org/gdeltv2/20261119113000.translation.gkg.csv.zip\n');
    if (url.endsWith('.translation.gkg.csv.zip')) return url.includes('20261119113000') ? new Response(tr) : new Response('', { status: 404 });
    return url.includes('20261119113000') ? new Response(en) : new Response('', { status: 404 });
  };
  const now = Date.UTC(2026, 10, 19, 11, 40);
  const items = await g.loadGdeltGkg({ fetchFn, userAgent: 'test', now, slots: 2 });
  assert.equal(items.length, 2);
  const before = calls.length;
  await g.loadGdeltGkg({ fetchFn, userAgent: 'test', now, slots: 2 });
  assert.ok(calls.slice(before).every((u) => u.endsWith('lastupdate.txt') || u.endsWith('lastupdate-translation.txt') || u.includes('1115')), 'already read slots are not downloaded again');
  const feed = { slug: 'gdelt-ukraine', name: 'GDELT', domain: 'api.gdeltproject.org', allowedDomains: ['*'], url: 'x', category: 'politics', licenseMode: 'headline_link', adapter: 'gdelt_ukraine' };
  const articles = adapters.parseGdeltArticles(feed, { articles: g.toDocRows(items) }, now);
  assert.equal(articles.length, 2);
});
