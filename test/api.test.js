import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let tempRoot;
let server;
let baseUrl;
let app;
let config;

const files = {};

async function removeTree(target) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (attempt === 9) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

function form(filesToSend, { album = '', meta = [] } = {}) {
  const body = new FormData();
  body.append('album', album);
  body.append('meta', JSON.stringify(meta));
  for (const item of filesToSend) {
    body.append('files', new File([item.buffer], item.name, { type: item.type || 'application/octet-stream' }));
  }
  return body;
}

async function upload(filesToSend, options) {
  const response = await fetch(`${baseUrl}/api/upload`, { method: 'POST', body: form(filesToSend, options) });
  return { status: response.status, body: await response.json() };
}

async function json(url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body, headers: response.headers };
}

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-test-'));
  config = loadConfig({
    dataDir: path.join(tempRoot, 'data'),
    storageDir: path.join(tempRoot, 'storage'),
    processConcurrency: 2,
    thumbSize: 300,
    previewSize: 800,
    openBrowser: false,
    authEnabled: false
  });
  app = createApp(config);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  files.landscape = await sharp({
    create: { width: 1200, height: 800, channels: 3, background: { r: 190, g: 88, b: 48 } }
  }).jpeg().toBuffer();
  files.portrait = await sharp({
    create: { width: 700, height: 1100, channels: 3, background: { r: 40, g: 90, b: 160 } }
  }).png().toBuffer();
  files.panorama = await sharp({
    create: { width: 2400, height: 600, channels: 3, background: { r: 40, g: 140, b: 90 } }
  }).jpeg().toBuffer();
  files.animation = await sharp({
    create: { width: 500, height: 500, channels: 3, background: { r: 210, g: 180, b: 60 } }
  }).gif().toBuffer();
});

test.after(async () => {
  if (server) {
    server.closeAllConnections?.();
    server.close();
    await once(server, 'close');
  }
  app?.locals.close();
  await removeTree(tempRoot);
});

test('Mosaic photo library API', async (t) => {
  let uploaded;
  let firstPhoto;

  await t.test('uploads a mixed batch and creates derivatives', async () => {
    const response = await upload(
      [
        { buffer: files.landscape, name: 'sunset.jpg', type: 'image/jpeg' },
        { buffer: files.portrait, name: 'portrait.png', type: 'image/png' },
        { buffer: files.panorama, name: 'canyon.jpeg', type: 'image/jpeg' },
        { buffer: files.animation, name: 'sticker.gif', type: 'image/gif' }
      ],
      {
        album: 'Trips',
        meta: [
          { relativePath: 'Iceland/2024/sunset.jpg', lastModified: Date.parse('2024-06-12T18:30:00Z') },
          { relativePath: 'Studio/portrait.png', lastModified: Date.parse('2025-01-04T10:00:00Z') },
          { relativePath: 'Iceland/2024/canyon.jpeg', lastModified: Date.parse('2024-06-14T09:00:00Z') },
          { relativePath: 'Stickers/sticker.gif', lastModified: Date.parse('2023-11-20T12:00:00Z') }
        ]
      }
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.results.filter((r) => r.ok).length, 4);
    uploaded = response.body.results.map((r) => r.photo);
    firstPhoto = uploaded[0];

    assert.equal(firstPhoto.album, 'Trips');
    assert.equal(firstPhoto.path, 'Iceland/2024/sunset.jpg');
    assert.equal(firstPhoto.width, 1200);
    assert.equal(firstPhoto.height, 800);
    assert.match(firstPhoto.takenAt, /^2024-06-12/);
    assert.ok(firstPhoto.thumbUrl.startsWith('/media/thumbs/'));

    const thumb = await fetch(`${baseUrl}${firstPhoto.thumbUrl}`);
    assert.equal(thumb.status, 200);
    assert.match(thumb.headers.get('content-type'), /image\/webp/);
    const preview = await fetch(`${baseUrl}${firstPhoto.previewUrl}`);
    assert.equal(preview.status, 200);
    const original = await fetch(`${baseUrl}${firstPhoto.originalUrl}`);
    assert.equal(original.status, 200);
    assert.match(original.headers.get('content-type'), /image\/jpeg/);
    const originalBytes = Buffer.from(await original.arrayBuffer());
    assert.equal(originalBytes.length, files.landscape.length);
    const download = await fetch(`${baseUrl}${firstPhoto.downloadUrl}`);
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-disposition'), /sunset\.jpg/);
  });

  await t.test('lists, searches, sorts and paginates', async () => {
    const all = await json('/api/photos?limit=2');
    assert.equal(all.status, 200);
    assert.equal(all.body.total, 4);
    assert.equal(all.body.items.length, 2);
    assert.equal(all.body.hasMore, true);

    const pageTwo = await json('/api/photos?limit=2&offset=2');
    assert.equal(pageTwo.body.items.length, 2);
    assert.equal(pageTwo.body.hasMore, false);
    assert.ok(!all.body.items.some((a) => pageTwo.body.items.some((b) => b.id === a.id)));

    const nameSorted = await json('/api/photos?sort=name&limit=10');
    assert.deepEqual(
      nameSorted.body.items.map((item) => item.name).sort(),
      ['canyon.jpeg', 'portrait.png', 'sticker.gif', 'sunset.jpg'].sort()
    );

    const search = await json('/api/photos?q=canyon');
    assert.equal(search.body.total, 1);
    assert.equal(search.body.items[0].name, 'canyon.jpeg');

    const folder = await json(`/api/photos?q=${encodeURIComponent('Iceland/2024')}`);
    assert.equal(folder.body.total, 2);

    const albums = await json('/api/albums');
    assert.deepEqual(albums.body.albums, [{ album: 'Trips', count: 4 }]);

    const stats = await json('/api/stats');
    assert.equal(stats.body.total, 4);
    assert.equal(stats.body.bytes, files.landscape.length + files.portrait.length + files.panorama.length + files.animation.length);
    assert.ok(stats.body.disk.total > 0);
  });

  await t.test('skips exact duplicate bytes', async () => {
    const response = await upload(
      [{ buffer: files.landscape, name: 'sunset-copy.jpg', type: 'image/jpeg' }],
      { album: 'Other' }
    );
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].ok, true);
    assert.equal(response.body.results[0].duplicate, true);
    assert.equal(response.body.results[0].photo.id, firstPhoto.id);
    const stats = await json('/api/stats');
    assert.equal(stats.body.total, 4);
  });

  await t.test('handles a batch with one unsupported file', async () => {
    const response = await upload([
      { buffer: files.landscape, name: 'again.jpg', type: 'image/jpeg' },
      { buffer: Buffer.from('not an image'), name: 'notes.txt', type: 'text/plain' }
    ]);
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].duplicate, true);
    assert.equal(response.body.results[1].ok, false);
    assert.match(response.body.results[1].error, /Unsupported/);
  });

  await t.test('keeps originals whose thumbnails cannot be decoded', async () => {
    const response = await upload([
      { buffer: Buffer.from('this is not really a jpeg'), name: 'broken.jpg', type: 'image/jpeg' }
    ], { album: '' });
    assert.equal(response.status, 200);
    assert.equal(response.body.results[0].ok, true);
    assert.equal(response.body.results[0].photo.thumbOk, false);
    assert.equal(response.body.results[0].photo.thumbUrl, null);
    const original = await fetch(`${baseUrl}${response.body.results[0].photo.originalUrl}`);
    assert.equal(original.status, 200);
    const stats = await json('/api/stats');
    assert.equal(stats.body.total, 5);
  });

  await t.test('edits metadata and filters favorites', async () => {
    const updated = await json(`/api/photos/${firstPhoto.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        caption: 'Golden hour on the south coast',
        tags: 'sunset, coast, iceland',
        album: 'Iceland',
        favorite: true
      })
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.photo.favorite, true);
    assert.equal(updated.body.photo.album, 'Iceland');

    const byTag = await json('/api/photos?q=coast');
    assert.equal(byTag.body.total, 1);

    const favorites = await json('/api/photos?view=favorites');
    assert.equal(favorites.body.total, 1);
    assert.equal(favorites.body.items[0].id, firstPhoto.id);

    const invalid = await json(`/api/photos/${firstPhoto.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: 'yes' })
    });
    assert.equal(invalid.status, 400);
  });

  await t.test('favorites and moves photos in bulk', async () => {
    const ids = uploaded.map((photo) => photo.id);
    const favorite = await json('/api/photos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'favorite', ids })
    });
    assert.equal(favorite.status, 200);
    assert.equal(favorite.body.count, 4);

    const album = await json('/api/photos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'album', ids, album: 'Favorites? No, album' })
    });
    assert.equal(album.body.count, 4);

    const favorites = await json('/api/photos?view=favorites');
    assert.equal(favorites.body.total, 4);

    const all = await json('/api/photos?album=Favorites%3F%20No%2C%20album');
    assert.equal(all.body.total, 4);
  });

  await t.test('soft deletes, restores and permanently deletes', async () => {
    const deleted = await json(`/api/photos/${firstPhoto.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.ok(deleted.body.photo.deletedAt);

    const visible = await json('/api/photos?limit=10');
    assert.equal(visible.body.total, 4);
    const trash = await json('/api/photos?view=trash');
    assert.equal(trash.body.total, 1);

    const permanentWithoutTrash = await json('/api/photos/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'destroy', all: true, filter: { view: 'all' } })
    });
    assert.equal(permanentWithoutTrash.status, 400);

    const restore = await json(`/api/photos/${firstPhoto.id}/restore`, { method: 'POST' });
    assert.equal(restore.status, 200);
    assert.equal(restore.body.photo.deletedAt, null);

    await json(`/api/photos/${firstPhoto.id}`, { method: 'DELETE' });
    const permanent = await json(`/api/photos/${firstPhoto.id}?permanent=1`, { method: 'DELETE' });
    assert.equal(permanent.status, 200);
    assert.equal(permanent.body.count, 1);

    const stats = await json('/api/stats');
    assert.equal(stats.body.total, 4);
    assert.equal(stats.body.trashed, 0);

    const missing = await json(`/api/photos/${firstPhoto.id}`);
    assert.equal(missing.status, 404);
  });

  await t.test('exports CSV metadata', async () => {
    const csv = await json('/api/export.csv');
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(csv.body, /file_name/);
    assert.match(csv.body, /portrait\.png/);
    assert.match(csv.body, /canyon\.jpeg/);
  });

  await t.test('deduplicates concurrent uploads of the same file', async () => {
    const buffer = await sharp({
      create: { width: 400, height: 400, channels: 3, background: { r: 10, g: 200, b: 180 } }
    }).jpeg().toBuffer();
    const before = (await json('/api/stats')).body.total;
    const [a, b] = await Promise.all([
      upload([{ buffer, name: 'race-a.jpg', type: 'image/jpeg' }]),
      upload([{ buffer, name: 'race-b.jpg', type: 'image/jpeg' }])
    ]);
    const okCount = [a, b].filter((response) => response.body.results[0].ok).length;
    assert.equal(okCount, 2);
    const after = (await json('/api/stats')).body.total;
    assert.equal(after, before + 1);
  });

  await t.test('rejects oversized uploads with a clear message', async () => {
    const small = loadConfig({
      dataDir: config.dataDir,
      storageDir: path.join(tempRoot, 'small-storage'),
      maxFileMb: 1,
      openBrowser: false,
      authEnabled: false
    });
    const smallApp = createApp(small);
    const smallServer = http.createServer(smallApp);
    smallServer.listen(0, '127.0.0.1');
    await once(smallServer, 'listening');
    const smallUrl = `http://127.0.0.1:${smallServer.address().port}`;
    const large = crypto.randomBytes(2 * 1024 * 1024);
    const body = new FormData();
    body.append('files', new File([large], 'large.jpg', { type: 'image/jpeg' }));
    const response = await fetch(`${smallUrl}/api/upload`, { method: 'POST', body });
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /too large/i);
    smallServer.closeAllConnections?.();
    smallServer.close();
    await once(smallServer, 'close');
    smallApp.locals.close();
    await removeTree(small.storageDir);
  });
});
