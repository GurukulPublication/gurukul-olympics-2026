import fsp from 'node:fs/promises';
import path from 'node:path';

export function emptyDriveState() {
  return {
    tokens: null,
    config: null,
    state: null,
    lastSync: null,
    lastResult: null,
    seen: {}
  };
}

export class DriveStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = emptyDriveState();
  }

  async load() {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        this.data = { ...emptyDriveState(), ...parsed };
        if (!this.data.seen || typeof this.data.seen !== 'object') this.data.seen = {};
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        console.warn(`[drive] Could not read ${this.filePath}: ${error.message}`);
      }
    }
    return this.data;
  }

  async save() {
    try {
      await fsp.chmod(this.filePath, 0o600);
    } catch {
      // Best-effort protection; Windows ignores most POSIX modes.
    }
    await fsp.writeFile(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get connected() {
    return !!(this.data.tokens && this.data.tokens.refresh_token);
  }

  setTokens(tokens) {
    this.data.tokens = { ...(this.data.tokens || {}), ...tokens };
  }

  clearState() {
    this.data.state = null;
  }

  setConfig(config) {
    this.data.config = { ...(this.data.config || {}), ...config };
  }

  async disconnect() {
    this.data = emptyDriveState();
    await this.save();
  }

  wasSeen(fileId, modifiedTime) {
    const entry = this.data.seen[fileId];
    return !!entry && String(entry.modifiedTime) === String(modifiedTime);
  }

  markSeen(fileId, modifiedTime, maxEntries = 4000) {
    this.data.seen[fileId] = { modifiedTime: String(modifiedTime), at: Date.now() };

    const ids = Object.keys(this.data.seen);
    if (ids.length > maxEntries) {
      ids
        .sort((a, b) => (this.data.seen[a].at || 0) - (this.data.seen[b].at || 0))
        .slice(0, ids.length - maxEntries)
        .forEach((id) => delete this.data.seen[id]);
    }
  }

  async recordSync({ lastSync, result }) {
    if (lastSync) this.data.lastSync = lastSync;
    this.data.lastResult = {
      at: new Date().toISOString(),
      ...result,
      errors: (result.errors || []).slice(0, 25)
    };
    await this.save();
  }

  publicStatus() {
    const config = this.data.config || {};
    const intervalSeconds = Math.max(
      1,
      Number(config.intervalSeconds) || Number(config.intervalMinutes || 15) * 60
    );

    return {
      configured: false,
      connected: this.connected,
      enabled: !!config.enabled,
      folder: config.folderId ? { id: config.folderId, name: config.folderName || 'Google Drive' } : null,
      album: config.album || '',
      intervalSeconds,
      intervalMinutes: Math.round(intervalSeconds / 60),
      includeSubfolders: config.includeSubfolders !== false,
      importExisting: config.importExisting !== false,
      lastSync: this.data.lastSync || null,
      lastResult: this.data.lastResult || null
    };
  }
}

export function driveStatePath(dataDir) {
  return path.join(dataDir, 'drive.json');
}
