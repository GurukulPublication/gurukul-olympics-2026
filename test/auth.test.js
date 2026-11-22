import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

let tempRoot;
let server;
let baseUrl;
let app;

async function request(url, { cookie, ...options } = {}) {
  const response = await fetch(`${baseUrl}${url}`, {
    ...options,
    headers: {
      ...(options.headers || {}),
      ...(cookie ? { cookie } : {})
    }
  });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { status: response.status, body, cookie: response.headers.get('set-cookie') };
}

function cookieValue(response) {
  return response.cookie?.split(';')[0] || '';
}

test.before(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mosaic-auth-test-'));
  const config = loadConfig({
    dataDir: path.join(tempRoot, 'data'),
    storageDir: path.join(tempRoot, 'storage'),
    openBrowser: false,
    authEnabled: true,
    authEmail: 'Jio',
    authPassword: '@Ambani',
    authSecret: 'test-secret'
  });
  app = createApp(config);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    await app?.locals.closeDriveWatcher?.();
  } catch {
    // Ignore watcher shutdown errors.
  }
  try {
    app?.locals.close();
  } catch {
    // Ignore database close errors.
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
  await fs.rm(tempRoot, { recursive: true, force: true });
});

test('health and auth status are public; library requires a session', async () => {
  assert.equal((await request('/api/health')).status, 200);

  const status = await request('/api/auth/status');
  assert.equal(status.body.enabled, true);
  assert.equal(status.body.authenticated, false);

  const photos = await request('/api/photos');
  assert.equal(photos.status, 401);
});

test('owner login accepts the configured credentials', async () => {
  const bad = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Jio', password: 'wrong' })
  });
  assert.equal(bad.status, 401);
  assert.match(bad.body.error, /Invalid email or password/);

  const good = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'Jio', password: '@Ambani' })
  });
  assert.equal(good.status, 200);
  assert.equal(good.body.role, 'admin');
  assert.match(good.cookie, /HttpOnly/i);
  assert.match(cookieValue(good), /^mosaic_session=/);

  const status = await request('/api/auth/status', { cookie: cookieValue(good) });
  assert.equal(status.body.role, 'admin');

  const drive = await request('/api/drive/status', { cookie: cookieValue(good) });
  assert.equal(drive.status, 200);
});

test('participants can view but cannot change the library', async () => {
  const login = await request('/api/auth/participant', { method: 'POST' });
  assert.equal(login.status, 200);
  assert.equal(login.body.role, 'participant');
  const cookie = cookieValue(login);

  assert.equal((await request('/api/photos', { cookie })).status, 200);
  assert.equal((await request('/api/albums', { cookie })).status, 200);
  assert.equal((await request('/api/stats', { cookie })).status, 200);

  assert.equal(
    (
      await request('/api/photos/bulk', {
        cookie,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'favorite', ids: [1] })
      })
    ).status,
    403
  );
  assert.equal(
    (
      await request('/api/upload', {
        cookie,
        method: 'POST',
        body: new FormData()
      })
    ).status,
    403
  );
  assert.equal((await request('/api/export.csv', { cookie })).status, 403);
  assert.equal((await request('/api/drive/status', { cookie })).status, 403);
  assert.equal((await request('/api/photos/1/download', { cookie })).status, 403);
});

test('logout clears the session', async () => {
  const login = await request('/api/auth/participant', { method: 'POST' });
  const cookie = cookieValue(login);
  const logout = await request('/api/auth/logout', { cookie, method: 'POST' });
  assert.equal(logout.status, 200);
  assert.match(logout.cookie, /mosaic_session=;/);
});
