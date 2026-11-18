import test from 'node:test';
import assert from 'node:assert/strict';
import { searchPixabayPhotos } from '../dist/common/pixabay.js';
import { searchOpenversePhotos } from '../dist/common/openverse.js';
import { pickStockPhoto, rankStockPhotos } from '../dist/common/stock-photos.js';
import { downloadPhoto, photoFileType, PhotoStorageService } from '../dist/common/photo-storage.service.js';
import { resolvePhotoMedia } from '../dist/common/photo-media.interceptor.js';
import { R2Storage } from '../dist/common/r2-storage.js';
import { NewsMediaService } from '../dist/news/news-media.service.js';

const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const photo = (overrides = {}) => ({
  id: '101', provider: 'pixabay', url: 'https://cdn.pixabay.com/photo/server.jpg',
  thumbUrl: 'https://cdn.pixabay.com/photo/server-thumb.jpg', photoPageUrl: 'https://pixabay.com/photos/server-101/',
  photographer: 'Alice', photographerUrl: 'https://pixabay.com/users/alice-1/', alt: 'server rack blue lights',
  width: 1280, height: 720, avgColor: null, credit: 'Alice / Pixabay',
  license: 'Pixabay Content License', licenseUrl: 'https://pixabay.com/service/license-summary/', ...overrides,
});
const pixabayHit = { id: 101, type: 'photo', largeImageURL: photo().url, previewURL: photo().thumbUrl,
  pageURL: photo().photoPageUrl, imageWidth: 1920, imageHeight: 1080, tags: photo().alt, user: 'Alice', user_id: 1 };
const openverseHit = { id: 'ov-101', url: 'https://images.example.org/server.jpg', thumbnail: 'https://images.example.org/thumb.jpg',
  foreign_landing_url: 'https://example.org/server', creator: 'Bob', creator_url: 'https://example.org/bob', title: 'Server rack',
  width: 1600, height: 900, license: 'by', license_version: '4.0', license_url: 'https://creativecommons.org/licenses/by/4.0/',
  mature: false, category: 'photograph', tags: [{ name: 'datacenter' }] };

test('Pixabay accepts uppercase key, caches successful requests for 24h and rejects unsafe/nonphoto results', async (t) => {
  const old = { lower: process.env.pixabay_api_key, upper: process.env.PIXABAY_API_KEY };
  process.env.pixabay_api_key = ''; // Empty lowercase .env placeholder must not mask an uppercase secret.
  process.env.PIXABAY_API_KEY = 'test-key-never-log';
  t.after(() => {
    if (old.lower === undefined) delete process.env.pixabay_api_key; else process.env.pixabay_api_key = old.lower;
    if (old.upper === undefined) delete process.env.PIXABAY_API_KEY; else process.env.PIXABAY_API_KEY = old.upper;
  });
  let calls = 0;
  const fetchFn = async (raw) => {
    calls++;
    const url = new URL(raw);
    assert.equal(url.searchParams.get('key'), 'test-key-never-log');
    assert.equal(url.searchParams.get('image_type'), 'photo');
    assert.equal(url.searchParams.get('orientation'), 'horizontal');
    assert.equal(url.searchParams.get('safesearch'), 'true');
    return json({ hits: [pixabayHit, { ...pixabayHit, type: 'vector' }, { ...pixabayHit, largeImageURL: 'https://attacker.example/img.jpg' },
      { ...pixabayHit, imageWidth: -1 }, { ...pixabayHit, pageURL: 'https://127.0.0.1/image' }] });
  };
  const result = await searchPixabayPhotos('cache test server', { fetchFn });
  assert.equal(result.length, 1);
  assert.equal(result[0].credit, 'Alice / Pixabay');
  assert.equal(result[0].width, 1280);
  assert.equal(result[0].height, 720);
  assert.deepEqual(await searchPixabayPhotos('cache test server', { fetchFn }), result);
  assert.equal(calls, 1);
});

test('Pixabay durable cache is reused across process-memory misses without querying the API', async () => {
  const old = process.env.pixabay_api_key;
  process.env.pixabay_api_key = 'test';
  try {
    const db = { query: async (sql) => {
      assert.match(sql, /interval '24 hours'/);
      return { rows: [{ photos: [photo()], created_at: new Date() }] };
    } };
    const result = await searchPixabayPhotos('persistent test', { db, fetchFn: async () => assert.fail('must use durable cache') });
    assert.equal(result[0].id, '101');
  } finally { if (old === undefined) delete process.env.pixabay_api_key; else process.env.pixabay_api_key = old; }
});

test('Openverse preserves attribution and license URL, rejects NC/ND/SA, mature and invalid licenses', async () => {
  const result = await searchOpenversePhotos('license filter test', { fetchFn: async (raw) => {
    const url = new URL(raw);
    assert.equal(url.searchParams.get('license'), 'by,cc0,pdm');
    assert.equal(url.searchParams.get('mature'), 'false');
    return json({ results: [openverseHit, ...['by-nc', 'by-nd', 'by-sa', 'unknown'].map((license) => ({ ...openverseHit, license })),
      { ...openverseHit, mature: true }, { ...openverseHit, license_url: 'https://attacker.example/licenses/by/4.0/' },
      { ...openverseHit, license_url: 'https://creativecommons.org/licenses/by-nc/4.0/' },
      { ...openverseHit, url: 'https://192.168.1.1/private.jpg' }] });
  } });
  assert.equal(result.length, 1);
  assert.match(result[0].credit, /Server rack.*Bob \/ Openverse, CC BY 4.0/);
  assert.equal(result[0].licenseUrl, openverseHit.license_url);
});

test('photo selection prefers Pixabay, falls back after failed R2 save and never publishes a rejected hotlink', async (t) => {
  const old = process.env.pixabay_api_key;
  process.env.pixabay_api_key = 'test';
  t.after(() => { if (old === undefined) delete process.env.pixabay_api_key; else process.env.pixabay_api_key = old; });
  const requests = [];
  const fetchFn = async (raw) => {
    requests.push(new URL(raw).hostname);
    return raw.includes('pixabay.com/api') ? json({ hits: [pixabayHit] }) : json({ results: [openverseHit] });
  };
  const first = await pickStockPhoto('priority test', { query: 'server', fetchFn, accept: async (p) => ({ ...p, url: '/api/v1/media/photos/saved.jpg' }) });
  assert.equal(first.provider, 'pixabay');
  assert.deepEqual(requests, ['pixabay.com']);
  requests.length = 0;
  const fallback = await pickStockPhoto('fallback test', { query: 'server', fetchFn,
    accept: async (p) => p.provider === 'pixabay' ? null : { ...p, url: '/api/v1/media/photos/saved.jpg' } });
  assert.equal(fallback.provider, 'openverse');
  assert.deepEqual(requests, ['pixabay.com', 'api.openverse.org']);
  assert.match(fallback.url, /^\/api\/v1\/media\/photos\//);
  const unavailable = await pickStockPhoto('no storage test', { query: 'server', fetchFn, providers: ['pixabay', 'openverse'], accept: async () => null });
  assert.equal(unavailable, null);
});

test('documentary photo matching rejects partial proper names and requires two subject terms', () => {
  const options = { query: 'ULA Vulcan', mustMatchTerms: ['ula', 'vulcan'] };
  assert.equal(rankStockPhotos([photo({ alt: 'simulation of Vulcan' })], options).length, 0);
  assert.equal(rankStockPhotos([photo({ alt: 'ULA Vulcan rocket' })], options).length, 1);
  assert.equal(rankStockPhotos([photo()], { query: 'server', usedUrls: new Set([photo().url]) }).length, 0);
});

const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1100)]);
test('photo downloads validate public redirect targets, signatures, MIME and maximum byte size', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const valid = await downloadPhoto('https://example.org/photo.jpg', { lookupFn,
    fetchFn: async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(valid.extension, 'jpg');
  assert.equal(photoFileType(Buffer.from('<svg onload="alert(1)">')), null);
  assert.equal(await downloadPhoto('https://example.org/photo.jpg', { lookupFn,
    fetchFn: async () => new Response(Buffer.alloc(1100), { headers: { 'content-type': 'image/jpeg' } }) }), null);
  assert.equal(await downloadPhoto('https://example.org/photo.jpg', { lookupFn,
    fetchFn: async () => new Response(jpeg, { headers: { 'content-type': 'image/svg+xml' } }) }), null);
  assert.equal(await downloadPhoto('https://example.org/photo.jpg', { lookupFn,
    fetchFn: async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg', 'content-length': String(9 * 1024 * 1024) } }) }), null);
  let calls = 0;
  assert.equal(await downloadPhoto('https://example.org/redirect.jpg', { lookupFn, fetchFn: async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/secret' } });
  } }), null);
  assert.equal(calls, 1);
});

test('R2 photo reuse preserves the original expiration without extending retention', async () => {
  const row = { object_key: 'photos/existing.jpg', original_url: photo().url,
    created_at: '2026-01-31T12:00:00Z', expires_at: '2099-04-30T12:00:00Z' };
  let calls = 0;
  const service = new PhotoStorageService({ query: async (sql) => {
    calls++;
    assert.match(sql, /ready AND expires_at > now\(\)/);
    return { rows: [row] };
  } });
  service.storage = { configured: true, publicUrl: (key) => `/api/v1/media/${key}`, putObject: async () => assert.fail('must reuse') };
  const stored = await service.persist(photo());
  assert.equal(stored.expiresAt, row.expires_at.replace('Z', '.000Z'));
  assert.equal(stored.originalUrl, photo().url);
  assert.equal(stored.url, '/api/v1/media/photos/existing.jpg');
  assert.equal(stored.licenseUrl, photo().licenseUrl);
  assert.equal(calls, 1);
});

test('new R2 uploads are tracked before PUT and marked ready only after upload succeeds', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
  const sequence = [];
  const row = { object_key: '', original_url: 'https://93.184.216.34/test.jpg',
    created_at: new Date(), expires_at: new Date(Date.now() + 90 * 86400_000) };
  const service = new PhotoStorageService({ query: async (sql, args = []) => {
    if (sql.includes('SELECT object_key')) return { rows: [] };
    if (sql.includes('INSERT INTO stored_photos')) {
      sequence.push('register'); row.object_key = args[0];
      assert.equal(args[4], 'Pixabay Content License');
      return { rows: [row] };
    }
    if (sql.includes('SET ready = true')) sequence.push('ready');
    return { rows: [] };
  } });
  service.storage = { configured: true, publicUrl: (key) => `/api/v1/media/${key}`, putObject: async (key, body, type) => {
    assert.deepEqual(sequence, ['register']);
    assert.equal(key, row.object_key);
    assert.equal(type, 'image/jpeg');
    assert.deepEqual(body, jpeg);
    sequence.push('upload');
  } };
  const result = await service.persist(photo({ url: row.original_url }));
  assert.deepEqual(sequence, ['register', 'upload', 'ready']);
  assert.match(result.objectKey, /^photos\/[a-f0-9]{24}-[a-f0-9-]{36}\.jpg$/);
  assert.equal(result.url, `/api/v1/media/${result.objectKey}`);
});

test('expired photos disappear from API hero/gallery/figures while private R2 URLs become absolute', () => {
  const active = { url: '/api/v1/media/photos/a.jpg', objectKey: 'photos/a.jpg', expiresAt: '2026-05-01T00:00:00Z' };
  const expired = { ...active, expiresAt: '2026-04-01T00:00:00Z' };
  const result = resolvePhotoMedia({ items: [{ hero_image: expired }], media: { hero: active, figures: [expired, active],
    gallery: [{ url: 'https://publisher.example/a.jpg' }] } }, 'https://news.example', Date.parse('2026-04-15T00:00:00Z'));
  assert.deepEqual(result.items, [{}]);
  assert.equal(result.media.hero.url, 'https://news.example/api/v1/media/photos/a.jpg');
  assert.equal(result.media.figures.length, 1);
  assert.equal(result.media.gallery[0].url, 'https://publisher.example/a.jpg');
});

test('hourly cleanup deletes expired photos only, retains failed deletes for retry and preserves other R2 prefixes', async () => {
  const removed = [];
  const statements = [];
  const service = new PhotoStorageService({ query: async (sql, args = []) => {
    statements.push([sql, args]);
    if (sql.includes('SELECT object_key')) return { rows: [{ object_key: 'photos/ok.jpg' }, { object_key: 'photos/fail.jpg' }, { object_key: 'tts/en/audio.mp3' }] };
    return { rows: [] };
  } });
  service.storage = { configured: true, deleteObject: async (key) => { if (key.includes('fail')) throw new Error('403'); removed.push(key); } };
  assert.equal(await service.prune(), 1);
  assert.deepEqual(removed, ['photos/ok.jpg']);
  assert.ok(statements.some(([sql]) => sql.includes('expires_at <= now()')));
  assert.deepEqual(statements.filter(([sql]) => sql.startsWith('DELETE FROM stored_photos')).map(([, args]) => args[0]), ['photos/ok.jpg']);
});

test('R2 DELETE rejects a failed authorization instead of dropping the registry entry', async (t) => {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response('', { status: 403 });
  const storage = new R2Storage({ endpoint: 'https://r2.example', bucket: 'news', accessKeyId: 'key', secretAccessKey: 'secret', publicBaseUrl: null });
  await assert.rejects(() => storage.deleteObject('photos/test.jpg'), /R2 DELETE 403/);
  globalThis.fetch = async () => new Response(null, { status: 404 });
  await storage.deleteObject('photos/test.jpg');
});

test('resource enrichment preserves section illustrations and their R2 retention metadata', async () => {
  let saved;
  const service = new NewsMediaService({ query: async (sql, args) => {
    assert.match(sql, /UPDATE news_items SET media/);
    saved = JSON.parse(args[1]);
    return { rows: [] };
  } });
  const figure = { id: 'section-photo', kind: 'photo', url: '/api/v1/media/photos/existing.jpg',
    objectKey: 'photos/existing.jpg', originalUrl: photo().url, expiresAt: '2099-01-01T00:00:00Z',
    credit: photo().credit, license: photo().license, match: ['server'], position: 0.5, origin: 'stock' };
  await service.attachResources({ id: '1', url: 'https://127.0.0.1/blocked', category: 'api', title: 'Server',
    title_en: 'Server', summary: '', body: '', source_name: 'Test', important: false, published_at: null,
    media: { hero: { url: 'https://example.org/hero.jpg' }, ambientBg: { url: 'https://example.org/bg.jpg' },
      figures: [figure, { id: 'video', kind: 'video', url: 'https://example.org/thumb.jpg', credit: 'Test', match: [], position: 0.8, origin: 'embed' }] } });
  assert.equal(saved.figures.length, 2);
  assert.equal(saved.figures[0].objectKey, figure.objectKey);
  assert.equal(saved.figures[0].expiresAt, figure.expiresAt);
});
