import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.jfif', '.png', '.webp', '.gif', '.avif',
  '.heic', '.heif', '.tif', '.tiff', '.bmp', '.jxl',
  '.cr2', '.cr3', '.nef', '.nrw', '.arw', '.srf', '.sr2', '.dng',
  '.orf', '.rw2', '.raf', '.pef', '.srw', '.x3f', '.3fr', '.erf',
  '.kdc', '.mef', '.mos', '.mrw', '.nksc', '.rwl', '.iiq', '.cap'
]);

export const MIME_BY_FORMAT = {
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heif: 'image/heic',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  jp2: 'image/jp2',
  jxl: 'image/jxl'
};

export const EXT_BY_FORMAT = {
  jpeg: '.jpg',
  jpg: '.jpg',
  png: '.png',
  webp: '.webp',
  gif: '.gif',
  avif: '.avif',
  heif: '.heic',
  tiff: '.tiff',
  bmp: '.bmp',
  jp2: '.jp2',
  jxl: '.jxl'
};

function integer(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function loadConfig(overrides = {}) {
  const root = path.resolve(overrides.root || path.resolve(import.meta.dirname, '..'));
  const dataDir = path.resolve(overrides.dataDir || process.env.DATA_DIR || path.join(root, 'data'));
  const storageDir = path.resolve(overrides.storageDir || process.env.STORAGE_DIR || path.join(root, 'storage'));

  const config = {
    root,
    dataDir,
    storageDir,
    originalsDir: path.join(storageDir, 'originals'),
    thumbsDir: path.join(storageDir, 'thumbs'),
    previewsDir: path.join(storageDir, 'previews'),
    incomingDir: path.join(storageDir, 'incoming'),
    dbPath: path.join(dataDir, 'photos.db'),
    host: overrides.host || process.env.HOST || '127.0.0.1',
    port: overrides.port ?? integer(process.env.PORT, 3000, 0, 65535),
    maxFileBytes: (overrides.maxFileMb ?? integer(process.env.MAX_UPLOAD_MB, 200, 1, 4096)) * 1024 * 1024,
    maxBatchFiles: integer(overrides.maxBatchFiles ?? process.env.UPLOAD_BATCH_SIZE, 8, 1, 24),
    processConcurrency: integer(
      overrides.processConcurrency ?? process.env.PROCESS_CONCURRENCY,
      Math.max(2, Math.min(4, os.cpus().length - 1 || 2)),
      1,
      12
    ),
    thumbSize: integer(overrides.thumbSize ?? process.env.THUMB_SIZE, 600, 160, 1600),
    previewSize: integer(overrides.previewSize ?? process.env.PREVIEW_SIZE, 1600, 400, 6000),
    thumbQuality: integer(overrides.thumbQuality ?? process.env.THUMB_QUALITY, 78, 30, 100),
    previewQuality: integer(overrides.previewQuality ?? process.env.PREVIEW_QUALITY, 82, 30, 100),
    maxInputPixels: integer(overrides.maxInputPixels ?? process.env.MAX_INPUT_PIXELS, 512_000_000, 1_000_000, 4_000_000_000),
    openBrowser: overrides.openBrowser ?? process.env.NO_OPEN !== '1',
    drive: {
      clientId: String(overrides.driveClientId ?? process.env.GOOGLE_CLIENT_ID ?? '').trim(),
      clientSecret: String(overrides.driveClientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? '').trim(),
      redirectUri: String(overrides.driveRedirectUri ?? process.env.GOOGLE_REDIRECT_URI ?? '').trim(),
      pollMinutes: integer(overrides.drivePollMinutes ?? process.env.GOOGLE_DRIVE_POLL_MINUTES, 15, 1, 1440),
      pollSeconds: integer(overrides.drivePollSeconds ?? process.env.GOOGLE_DRIVE_POLL_SECONDS, 5, 1, 86400)
    },
    auth: {
      enabled: overrides.authEnabled ?? process.env.AUTH_ENABLED !== '0',
      email: String(overrides.authEmail ?? process.env.JIO_EMAIL ?? 'sgis'),
      password: String(overrides.authPassword ?? process.env.JIO_PASSWORD ?? 'sgis'),
      secret: String(
        overrides.authSecret ??
          process.env.AUTH_SECRET ??
          `${crypto.randomUUID()}${crypto.randomUUID()}`
      )
    }
  };

  config.allowedExtensions = IMAGE_EXTENSIONS;

  for (const dir of [config.dataDir, config.storageDir, config.originalsDir, config.thumbsDir, config.previewsDir, config.incomingDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  return config;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
