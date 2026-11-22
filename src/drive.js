import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DriveStore, driveStatePath } from './drive-store.js';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/drive/v3';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const OVERLAP_MS = 5 * 60 * 1000;
const MAX_FOLDERS = 150;
const MAX_FOLDER_DEPTH = 4;
const MAX_FILES_PER_SYNC = 2000;
const IMAGE_EXT = /\.(jpe?g|jpe|jfif|png|webp|gif|avif|heic|heif|tiff?|bmp|jxl|cr2|cr3|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|srw|x3f|3fr|erf|kdc|mef|mos|mrw|nksc|rwl|iiq|cap)$/i;

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isDriveImage(file) {
  if (!file || !file.name) return false;
  const mime = String(file.mimeType || '');
  if (mime.startsWith('application/vnd.google-apps.')) return false;
  if (/^image\//i.test(mime) && !/svg/i.test(mime)) return true;
  return IMAGE_EXT.test(file.name) && !/\.svg$/i.test(file.name);
}

function maxModified(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

async function runWithConcurrency(items, limit, worker) {
  let index = 0;
  const count = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: count }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await worker(item);
      }
    })
  );
}

export class DriveClient {
  constructor({ credentials, store, fetchImpl = fetch }) {
    this.credentials = credentials || {};
    this.store = store;
    this.fetch = fetchImpl;
  }

  isConfigured() {
    return !!(this.credentials.clientId && this.credentials.clientSecret);
  }

  buildAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.credentials.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPE,
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true'
    });
    return `${AUTH_URL}?${params}`;
  }

  async exchangeCode(code, redirectUri) {
    const body = new URLSearchParams({
      code,
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code'
    });

    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Google sign-in failed (${response.status})`);
    }
    if (!data.access_token) throw new Error('Google did not return an access token.');

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token || this.store.data.tokens?.refresh_token,
      expiry_date: Date.now() + Number(data.expires_in || 3600) * 1000,
      scope: data.scope || SCOPE,
      token_type: data.token_type || 'Bearer'
    };
  }

  async refreshToken() {
    const refreshToken = this.store.data.tokens?.refresh_token;
    if (!refreshToken) throw new Error('Google Drive needs to be connected again.');

    const body = new URLSearchParams({
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    });

    const response = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Could not refresh the Google Drive connection.');
    }

    const tokens = {
      ...this.store.data.tokens,
      access_token: data.access_token,
      expiry_date: Date.now() + Number(data.expires_in || 3600) * 1000,
      scope: data.scope || this.store.data.tokens.scope || SCOPE
    };
    this.store.setTokens(tokens);
    await this.store.save();
    return tokens.access_token;
  }

  async accessToken(force = false) {
    const tokens = this.store.data.tokens;
    if (!tokens?.access_token) throw new Error('Google Drive is not connected.');
    if (!force && tokens.expiry_date && tokens.expiry_date > Date.now() + 60 * 1000) {
      return tokens.access_token;
    }
    return this.refreshToken();
  }

  async api(endpoint, params = {}) {
    let token = null;
    let refreshed = false;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      token = await this.accessToken();
      const url = new URL(`${API_BASE}${endpoint}`);
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }

      let response;
      try {
        response = await this.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      } catch (error) {
        if (attempt < 3) {
          await sleep(400 * 2 ** attempt);
          continue;
        }
        throw new Error('Could not reach Google Drive.');
      }

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.refreshToken();
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < 3) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
      }

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error?.message || payload?.error || `Google Drive request failed (${response.status})`);
      }
      return payload;
    }

    throw new Error('Google Drive is temporarily unavailable.');
  }

  async listFolders(query = '') {
    let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    const clean = String(query || '').trim().slice(0, 100);
    if (clean) q += ` and name contains '${escapeQuery(clean)}'`;

    const payload = await this.api('/files', {
      q,
      pageSize: 100,
      orderBy: 'name_natural',
      fields: 'nextPageToken,files(id,name,modifiedTime)'
    });

    return (payload.files || []).map((file) => ({
      id: file.id,
      name: file.name || 'Untitled folder',
      modifiedTime: file.modifiedTime || null
    }));
  }

  async listSubfolders(parentId) {
    const payload = await this.api('/files', {
      q: `'${escapeQuery(parentId)}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      pageSize: 1000,
      fields: 'nextPageToken,files(id,name)'
    });
    return payload.files || [];
  }

  async listFiles(folderId, since) {
    const files = [];
    let pageToken = null;

    for (let page = 0; page < 10; page += 1) {
      const payload = await this.api('/files', {
        q: `'${escapeQuery(folderId)}' in parents and trashed = false and modifiedTime > '${escapeQuery(since)}'`,
        pageSize: 1000,
        orderBy: 'modifiedTime',
        pageToken,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)'
      });

      files.push(...(payload.files || []));
      pageToken = payload.nextPageToken;
      if (!pageToken) break;
    }

    return files;
  }

  async download(file, destination) {
    let token = null;
    let response = null;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      token = await this.accessToken();
      const url = `${API_BASE}/files/${encodeURIComponent(file.id)}?alt=media`;
      response = await this.fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (response.status === 401 && attempt === 0) {
        await this.refreshToken();
        continue;
      }
      if (response.status !== 429 && response.status < 500) break;
      if (attempt < 3) await sleep(500 * 2 ** attempt);
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload?.error?.message || `Could not download “${file.name}” (${response.status})`);
    }

    const hash = crypto.createHash('sha256');
    let size = 0;
    const hasher = new Transform({
      transform(chunk, encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      }
    });

    await pipeline(
      Readable.fromWeb(response.body),
      hasher,
      fs.createWriteStream(destination, { flags: 'wx' })
    );

    return { hash: hash.digest('hex'), size };
  }
}

export class DriveWatcher {
  constructor({ store, client, config, processor, pollMinutes = 15, logger = console }) {
    this.store = store;
    this.client = client;
    this.config = config;
    this.processor = processor;
    this.pollMinutes = pollMinutes;
    this.logger = logger;
    this.timer = null;
    this.current = null;
    this.stopped = false;
  }

  status() {
    return {
      ...this.store.publicStatus(),
      configured: this.client.isConfigured(),
      importing: !!this.current
    };
  }

  start() {
    this.stopped = false;
    this.schedule(3000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async close() {
    this.stop();
    if (this.current) {
      await Promise.race([this.current.catch(() => {}), sleep(5000)]);
    }
  }

  schedule(delayMs) {
    if (this.timer) clearTimeout(this.timer);
    const config = this.store.data.config || {};
    const seconds = Math.max(
      1,
      Number(config.intervalSeconds) || (Number(config.intervalMinutes) || this.pollMinutes) * 60
    );
    const interval = seconds * 1000;

    this.timer = setTimeout(async () => {
      this.timer = null;
      if (this.stopped) return;
      if (this.store.connected && this.client.isConfigured() && this.store.data.config?.enabled) {
        try {
          await this.syncNow();
        } catch (error) {
          this.logger.warn?.(`[drive] Sync failed: ${error.message}`);
        }
      }
      if (!this.stopped) this.schedule(interval);
    }, delayMs);

    this.timer.unref?.();
  }

  async configure(patch) {
    const previous = this.store.data.config;
    const next = { ...(previous || {}), ...patch };

    if (patch.folderId && patch.folderId !== previous?.folderId) {
      this.store.data.lastSync = null;
      this.store.data.seen = {};
      next.importExisting = patch.importExisting !== false;
    }

    this.store.setConfig(next);
    await this.store.save();
    if (next.enabled) this.stopped = false;
    this.schedule(next.enabled ? 2500 : 60 * 1000);
    return this.status();
  }

  async syncNow() {
    if (this.current) return this.current;
    this.current = this.runSync().finally(() => {
      this.current = null;
    });
    return this.current;
  }

  cursor() {
    if (!this.store.data.lastSync) {
      const config = this.store.data.config || {};
      if (config.importExisting === false) return new Date().toISOString();
      return new Date(0).toISOString();
    }
    const overlap = Math.max(0, Date.parse(this.store.data.lastSync) - OVERLAP_MS);
    return new Date(overlap || 0).toISOString();
  }

  async collectFolders(config) {
    const root = {
      id: config.folderId,
      name: config.folderName || 'Google Drive',
      path: ''
    };
    const folders = [root];

    if (config.includeSubfolders === false) return folders;

    const queue = [{ id: root.id, path: '', depth: 0 }];
    const visited = new Set([root.id]);

    while (queue.length && folders.length < MAX_FOLDERS) {
      const current = queue.shift();
      if (current.depth >= MAX_FOLDER_DEPTH) continue;

      let children = [];
      try {
        children = await this.client.listSubfolders(current.id);
      } catch (error) {
        this.logger.warn?.(`[drive] Could not list subfolders: ${error.message}`);
        continue;
      }

      for (const child of children) {
        if (!child?.id || visited.has(child.id)) continue;
        visited.add(child.id);
        const folderPath = [current.path, child.name].filter(Boolean).join('/');
        folders.push({ id: child.id, name: child.name || 'Folder', path: folderPath });
        queue.push({ id: child.id, path: folderPath, depth: current.depth + 1 });
        if (folders.length >= MAX_FOLDERS) break;
      }
    }

    return folders;
  }

  async runSync() {
    const config = this.store.data.config;
    if (!config?.folderId) throw new Error('Choose a Google Drive folder first.');
    if (!this.client.isConfigured()) throw new Error('Google Drive credentials are not configured.');
    if (!this.store.connected) throw new Error('Google Drive is not connected.');

    const startedAt = Date.now();
    const since = this.cursor();
    const folders = await this.collectFolders(config);
    const candidates = [];

    for (const folder of folders) {
      const files = await this.client.listFiles(folder.id, since);
      for (const file of files) {
        candidates.push({ ...file, folderPath: folder.path, folderName: folder.name });
      }
    }

    candidates.sort((a, b) => Date.parse(a.modifiedTime) - Date.parse(b.modifiedTime));
    if (candidates.length > MAX_FILES_PER_SYNC) candidates.length = MAX_FILES_PER_SYNC;

    const result = {
      found: candidates.length,
      added: 0,
      duplicates: 0,
      failed: 0,
      skipped: 0,
      errors: []
    };

    let handledTime = null;

    const handleFile = async (file) => {
      if (this.stopped) return;
      if (this.store.wasSeen(file.id, file.modifiedTime)) return;

      const name = file.name || 'photo';

      if (!isDriveImage(file)) {
        this.store.markSeen(file.id, file.modifiedTime);
        result.skipped += 1;
        handledTime = maxModified(handledTime, file.modifiedTime);
        return;
      }

      const size = Number(file.size || 0);
      const maxBytes = Number(this.config.maxFileBytes || 0);
      if (maxBytes && size > maxBytes) {
        this.store.markSeen(file.id, file.modifiedTime);
        result.skipped += 1;
        result.errors.push({ name, error: 'Larger than the per-file limit' });
        handledTime = maxModified(handledTime, file.modifiedTime);
        return;
      }

      const temporary = path.join(this.config.incomingDir, `drive-${crypto.randomUUID()}`);

      try {
        const downloaded = await this.client.download(file, temporary);
        const outcome = await this.processor.process(
          {
            originalname: name,
            mimetype: file.mimeType || '',
            size: downloaded.size || size,
            hash: downloaded.hash,
            path: temporary
          },
          {
            album: config.album || '',
            meta: {
              relativePath: [file.folderPath, name].filter(Boolean).join('/'),
              lastModified: Date.parse(file.modifiedTime) || Date.now()
            }
          }
        );

        if (!outcome?.ok) throw new Error(outcome?.error || 'Could not import this photo');
        if (outcome.duplicate) result.duplicates += 1;
        else result.added += 1;

        this.store.markSeen(file.id, file.modifiedTime);
        handledTime = maxModified(handledTime, file.modifiedTime);
      } catch (error) {
        result.failed += 1;
        result.errors.push({ name, error: String(error?.message || error).slice(0, 300) });
        await fsp.unlink(temporary).catch(() => {});
      }
    };

    await runWithConcurrency(candidates, 2, handleFile);

    const fallbackTime = candidates.length ? candidates.reduce((latest, file) => maxModified(latest, file.modifiedTime), null) : null;
    const lastSync = handledTime || (result.failed === 0 ? fallbackTime : this.store.data.lastSync);

    await this.store.recordSync({
      lastSync,
      result: {
        ...result,
        durationMs: Date.now() - startedAt,
        folderName: config.folderName || 'Google Drive'
      }
    });

    return {
      ok: true,
      added: result.added,
      duplicates: result.duplicates,
      failed: result.failed,
      skipped: result.skipped,
      found: result.found,
      lastSync
    };
  }
}

export function registerDriveRoutes(app, { config, processor }) {
  const store = new DriveStore(driveStatePath(config.dataDir));
  const ready = store.load();

  const client = new DriveClient({ credentials: config.drive, store });
  const watcher = new DriveWatcher({
    store,
    client,
    config,
    processor,
    pollMinutes: config.drive.pollMinutes
  });

  app.locals.driveWatcher = watcher;
  app.locals.closeDriveWatcher = () => watcher.close();

  ready.then(() => {
    if (store.connected && client.isConfigured() && store.data.config?.enabled) watcher.start();
  });

  app.get('/api/drive/status', async (req, res) => {
    await ready;
    res.json(watcher.status());
  });

  app.get('/api/drive/auth', async (req, res) => {
    await ready;
    if (!client.isConfigured()) {
      return res.status(400).json({
        error: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart Mosaic.'
      });
    }

    const redirectUri = config.drive.redirectUri || `${req.protocol}://${req.get('host')}/api/drive/oauth/callback`;
    const value = crypto.randomBytes(24).toString('hex');
    store.data.state = { value, redirectUri, at: Date.now() };
    await store.save();

    res.json({ url: client.buildAuthUrl(redirectUri, value) });
  });

  app.get('/api/drive/oauth/callback', async (req, res) => {
    await ready;

    const failed = (message) => res.redirect(`/drive-callback.html?error=${encodeURIComponent(message)}`);

    if (req.query.error) return failed(String(req.query.error));
    if (!client.isConfigured()) return failed('Google Drive is not configured on this server.');

    const expected = store.data.state;
    if (!expected || req.query.state !== expected.value || Date.now() - expected.at > 10 * 60 * 1000) {
      return failed('The Google sign-in request expired. Please try again.');
    }
    if (!req.query.code) return failed('Google did not return an authorization code.');

    try {
      const tokens = await client.exchangeCode(String(req.query.code), expected.redirectUri);
      store.setTokens(tokens);
      store.clearState();
      await store.save();
      if (store.data.config?.enabled) watcher.start();
      res.redirect('/drive-callback.html?connected=1');
    } catch (error) {
      failed(error.message || 'Could not connect Google Drive.');
    }
  });

  app.post('/api/drive/disconnect', async (req, res) => {
    await ready;
    await watcher.close();
    await store.disconnect();
    res.json({ ok: true });
  });

  app.get('/api/drive/folders', async (req, res) => {
    await ready;
    if (!store.connected) return res.status(401).json({ error: 'Connect Google Drive first.' });

    try {
      const folders = await client.listFolders(req.query.q || '');
      res.json({ folders });
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not list Drive folders.' });
    }
  });

  app.post('/api/drive/config', async (req, res) => {
    await ready;
    if (!client.isConfigured()) return res.status(400).json({ error: 'Google Drive credentials are not configured.' });
    if (!store.connected) return res.status(401).json({ error: 'Connect Google Drive first.' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const folderId = String(body.folderId || '').trim().slice(0, 200);
    if (!folderId) return res.status(400).json({ error: 'Choose a Google Drive folder.' });

    const intervalMinutes = Math.min(1440, Math.max(1, Number.parseInt(body.intervalMinutes, 10) || config.drive.pollMinutes));
    const requestedSeconds = Number.parseInt(body.intervalSeconds, 10);
    const intervalSeconds = Math.min(
      86400,
      Math.max(5, Number.isFinite(requestedSeconds) && requestedSeconds > 0 ? requestedSeconds : intervalMinutes * 60)
    );

    try {
      const status = await watcher.configure({
        folderId,
        folderName: String(body.folderName || 'Google Drive').slice(0, 120),
        album: String(body.album || '').trim().slice(0, 120),
        intervalMinutes: Math.max(1, Math.round(intervalSeconds / 60)),
        intervalSeconds,
        includeSubfolders: body.includeSubfolders !== false,
        importExisting: body.importExisting !== false,
        enabled: body.enabled !== false
      });
      res.json({ ok: true, status });
    } catch (error) {
      res.status(400).json({ error: error.message || 'Could not save the Drive settings.' });
    }
  });

  app.post('/api/drive/sync', async (req, res) => {
    await ready;
    if (!store.connected) return res.status(401).json({ error: 'Connect Google Drive first.' });
    if (!store.data.config?.folderId) return res.status(400).json({ error: 'Choose a Google Drive folder first.' });

    try {
      const result = await watcher.syncNow();
      res.json({ ok: true, ...result, status: watcher.status() });
    } catch (error) {
      res.status(502).json({ error: error.message || 'Could not sync Google Drive.' });
    }
  });

  return { store, client, watcher };
}
