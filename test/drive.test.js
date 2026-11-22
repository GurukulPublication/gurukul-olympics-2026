import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DriveClient, DriveWatcher, isDriveImage } from '../src/drive.js';
import { DriveStore } from '../src/drive-store.js';

async function makeTempDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'mosaic-drive-test-'));
}

function makeStore(directory) {
  return new DriveStore(path.join(directory, 'drive.json'));
}

test('DriveStore persists tokens, config and sync results', async () => {
  const directory = await makeTempDir();
  const store = makeStore(directory);
  await store.load();

  store.setTokens({ access_token: 'a', refresh_token: 'r', expiry_date: Date.now() + 1000 });
  store.setConfig({ folderId: 'folder-1', folderName: 'Photos', enabled: true });
  await store.recordSync({
    lastSync: '2026-01-01T00:00:00.000Z',
    result: { added: 2, errors: [{ name: 'x', error: 'bad' }] }
  });

  const reloaded = makeStore(directory);
  await reloaded.load();

  assert.equal(reloaded.connected, true);
  assert.equal(reloaded.data.tokens.refresh_token, 'r');
  assert.equal(reloaded.data.config.folderName, 'Photos');
  assert.equal(reloaded.data.lastSync, '2026-01-01T00:00:00.000Z');
  assert.equal(reloaded.data.lastResult.added, 2);
  assert.equal(reloaded.publicStatus().folder.id, 'folder-1');

  await reloaded.disconnect();
  assert.equal(reloaded.connected, false);
  assert.equal(reloaded.data.config, null);

  await fsp.rm(directory, { recursive: true, force: true });
});

test('Drive image detection skips documents and SVGs', () => {
  assert.equal(isDriveImage({ name: 'IMG_1234.JPG', mimeType: 'image/jpeg' }), true);
  assert.equal(isDriveImage({ name: 'raw.CR3', mimeType: '' }), true);
  assert.equal(isDriveImage({ name: 'picture.svg', mimeType: 'image/svg+xml' }), false);
  assert.equal(isDriveImage({ name: 'notes.txt', mimeType: 'text/plain' }), false);
  assert.equal(isDriveImage({ name: 'doc.docx', mimeType: 'application/vnd.google-apps.document' }), false);
});

test('DriveClient builds an offline OAuth URL', async () => {
  const directory = await makeTempDir();
  const store = makeStore(directory);
  await store.load();

  const client = new DriveClient({
    credentials: { clientId: 'client-123', clientSecret: 'secret-456' },
    store
  });
  const url = new URL(
    client.buildAuthUrl('http://127.0.0.1:3000/api/drive/oauth/callback', 'state-abc')
  );

  assert.equal(url.origin, 'https://accounts.google.com');
  assert.equal(url.searchParams.get('client_id'), 'client-123');
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('state'), 'state-abc');
  assert.match(url.searchParams.get('scope'), /drive\.readonly/);

  await fsp.rm(directory, { recursive: true, force: true });
});

test('DriveWatcher imports new files once and respects the sync cursor', async () => {
  const directory = await makeTempDir();
  const incoming = path.join(directory, 'incoming');
  await fsp.mkdir(incoming, { recursive: true });

  const store = makeStore(directory);
  await store.load();
  store.setTokens({ access_token: 'a', refresh_token: 'r', expiry_date: Date.now() + 60000 });
  store.setConfig({
    folderId: 'folder-1',
    folderName: 'Camera Roll',
    album: 'Drive',
    enabled: true,
    importExisting: true
  });
  await store.save();

  const file = {
    id: 'file-1',
    name: 'holiday.jpg',
    mimeType: 'image/jpeg',
    size: 3,
    modifiedTime: '2026-03-05T10:00:00.000Z'
  };

  let listings = 0;
  const client = {
    isConfigured: () => true,
    async listSubfolders() {
      return [];
    },
    async listFiles() {
      listings += 1;
      return [file];
    },
    async download(target, destination) {
      await fsp.writeFile(destination, 'abc');
      return { hash: 'hash-1', size: 3 };
    }
  };

  const calls = [];
  const processor = {
    async process(photoFile, options) {
      calls.push({ photoFile, options });
      return { ok: true, duplicate: false, photo: { id: 7 } };
    }
  };

  const watcher = new DriveWatcher({
    store,
    client,
    processor,
    config: { incomingDir: incoming, maxFileBytes: 1024 * 1024 },
    logger: { warn() {} }
  });

  const first = await watcher.syncNow();
  assert.equal(first.added, 1);
  assert.equal(first.found, 1);
  assert.equal(first.lastSync, file.modifiedTime);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].photoFile.originalname, 'holiday.jpg');
  assert.equal(calls[0].photoFile.hash, 'hash-1');
  assert.equal(calls[0].options.album, 'Drive');
  assert.match(calls[0].options.meta.relativePath, /holiday\.jpg$/);

  const second = await watcher.syncNow();
  assert.equal(listings, 2);
  assert.equal(second.added, 0);
  assert.equal(calls.length, 1);

  watcher.stop();
  await fsp.rm(directory, { recursive: true, force: true });
});
