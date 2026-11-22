import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import exifr from 'exifr';
import { EXT_BY_FORMAT, MIME_BY_FORMAT } from './config.js';
import { toApiPhoto } from './serialize.js';

sharp.cache({ memory: 64, files: 20, items: 50 });
sharp.concurrency(1);

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jpe': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.bmp': 'image/bmp',
  '.jxl': 'image/jxl'
};

export class UploadError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UploadError';
    this.status = status;
  }
}

export class Limiter {
  constructor(max = 2) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.next();
    });
  }

  next() {
    while (this.active < this.max && this.queue.length) {
      const job = this.queue.shift();
      this.active += 1;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.next();
        });
    }
  }
}

export class HashStorage {
  constructor(destination) {
    this.destination = destination;
  }

  _handleFile(req, file, cb) {
    const id = crypto.randomUUID();
    const filePath = path.join(this.destination, id);
    const hash = crypto.createHash('sha256');
    let size = 0;
    let settled = false;

    const output = fs.createWriteStream(filePath, { flags: 'wx' });

    const fail = (error) => {
      if (settled) return;
      settled = true;
      output.destroy();
      fsp.unlink(filePath).catch(() => {});
      cb(error);
    };

    file.stream.on('data', (chunk) => {
      hash.update(chunk);
      size += chunk.length;
    });
    file.stream.on('error', fail);
    output.on('error', fail);
    output.on('finish', () => {
      if (settled) return;
      settled = true;
      cb(null, {
        destination: this.destination,
        filename: id,
        path: filePath,
        hash: hash.digest('hex'),
        size
      });
    });

    file.stream.pipe(output);
  }

  _removeFile(req, file, cb) {
    if (!file?.path) return cb(null);
    fsp.unlink(file.path).then(() => cb(null), (error) => cb(error.code === 'ENOENT' ? null : error));
  }
}

const RETRYABLE_FILE_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES']);

async function removeQuietly(target) {
  if (!target) return;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.unlink(target);
      return;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      if (!RETRYABLE_FILE_ERRORS.has(error.code) || attempt === 4) {
        console.warn(`[media] Could not remove ${target}: ${error.message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function moveFile(source, destination) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await fsp.rename(source, destination);
      return;
    } catch (error) {
      if (error.code === 'EXDEV') {
        await fsp.copyFile(source, destination);
        await removeQuietly(source);
        return;
      }
      if (!RETRYABLE_FILE_ERRORS.has(error.code) || attempt === 4) throw error;
      if (attempt >= 1) {
        try {
          await fsp.copyFile(source, destination);
          await removeQuietly(source);
          return;
        } catch {
          // Rename may still succeed on the next attempt.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

function basenameOf(name) {
  const cleaned = String(name || 'photo')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .split(/[\\/]/)
    .pop()
    .trim();
  return (cleaned || 'photo').slice(0, 400);
}

function normalizeSourcePath(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  return normalized.slice(0, 1000);
}

function parseDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getUTCFullYear();
  if (year < 1900 || year > 2100) return null;
  return date;
}

function firstExifDate(exif) {
  if (!exif) return null;
  for (const key of ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'ModifyDate']) {
    const date = parseDate(exif[key]);
    if (date) return date;
  }
  return null;
}

function validTimestamp(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const date = new Date(n);
  return date.getUTCFullYear() >= 1900 && date.getUTCFullYear() <= 2100 ? date : null;
}

function safeString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function shortenError(error) {
  return String(error?.message || error || 'Unknown error')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

export async function generateDerivatives(sourcePath, hash, config, limiter) {
  const relPath = `${hash.slice(0, 2)}/${hash}.webp`;
  const thumbAbs = path.join(config.thumbsDir, hash.slice(0, 2), `${hash}.webp`);
  const previewAbs = path.join(config.previewsDir, hash.slice(0, 2), `${hash}.webp`);

  await fsp.mkdir(path.dirname(thumbAbs), { recursive: true });
  await fsp.mkdir(path.dirname(previewAbs), { recursive: true });

  await limiter.run(async () => {
    const base = sharp(sourcePath, {
      failOn: 'none',
      limitInputPixels: config.maxInputPixels,
      animated: false
    }).rotate();

    await Promise.all([
      base
        .clone()
        .resize({
          width: config.thumbSize,
          height: config.thumbSize,
          fit: 'cover',
          position: 'centre'
        })
        .webp({ quality: config.thumbQuality, effort: 4 })
        .toFile(thumbAbs),
      base
        .clone()
        .resize({
          width: config.previewSize,
          height: config.previewSize,
          fit: 'inside',
          withoutEnlargement: true
        })
        .webp({ quality: config.previewQuality, effort: 4 })
        .toFile(previewAbs)
    ]);
  });

  return { thumbRel: relPath, previewRel: relPath, thumbAbs, previewAbs };
}

export class MediaProcessor {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.limiter = new Limiter(config.processConcurrency);
  }

  async process(file, options = {}) {
    const config = this.config;
    const album = safeString(options.album, 120).trim();
    const meta = options.meta && typeof options.meta === 'object' ? options.meta : {};

    let originalMoved = false;
    let destination = null;
    let thumbAbs = null;
    let previewAbs = null;

    try {
      const originalName = basenameOf(file.originalname);
      const originalExt = path.extname(originalName).toLowerCase();
      const declaredMime = String(file.mimetype || '').toLowerCase();

      if (!file.size) throw new UploadError('The file is empty');
      if (file.size > config.maxFileBytes) {
        throw new UploadError(`File is larger than the ${Math.round(config.maxFileBytes / 1024 / 1024)} MB limit`);
      }
      if (!declaredMime.startsWith('image/') && !config.allowedExtensions.has(originalExt)) {
        throw new UploadError('Unsupported file type — choose photos or image files');
      }
      if (originalExt === '.svg' || declaredMime === 'image/svg+xml') {
        throw new UploadError('SVG files are not supported');
      }

      const existing = this.store.findByHash(file.hash);
      if (existing) {
        await removeQuietly(file.path);
        return { ok: true, duplicate: true, photo: toApiPhoto(existing), inTrash: !!existing.deleted_at };
      }

      let metadata = null;
      let metadataError = null;
      try {
        metadata = await sharp(file.path, {
          failOn: 'none',
          limitInputPixels: config.maxInputPixels
        }).metadata();
      } catch (error) {
        metadataError = error;
      }

      if (metadata?.format === 'svg') throw new UploadError('SVG files are not supported');

      let exif = null;
      try {
        exif = await exifr.parse(file.path, {
          pick: ['DateTimeOriginal', 'CreateDate', 'DateTimeDigitized', 'ModifyDate']
        });
      } catch {
        // Not every image has readable EXIF data.
      }

      const exifDate = firstExifDate(exif);
      const fallbackDate = validTimestamp(meta.lastModified) || new Date();
      const takenAt = (exifDate || fallbackDate).toISOString();

      const swaps = metadata?.orientation >= 5 && metadata?.orientation <= 8;
      const width = metadata?.width ? (swaps ? metadata.height : metadata.width) : null;
      const height = metadata?.height ? (swaps ? metadata.width : metadata.height) : null;

      const formatExt = EXT_BY_FORMAT[metadata?.format];
      const ext = formatExt || (config.allowedExtensions.has(originalExt) ? originalExt : '.img');
      const mime = MIME_BY_FORMAT[metadata?.format] || (declaredMime.startsWith('image/') ? declaredMime : MIME_BY_EXT[ext] || 'application/octet-stream');

      let thumbRel = null;
      let previewRel = null;
      let thumbStatus = 'failed';
      let thumbError = metadataError ? `Could not read image: ${shortenError(metadataError)}` : null;

      try {
        const derivatives = await generateDerivatives(file.path, file.hash, config, this.limiter);
        thumbRel = derivatives.thumbRel;
        previewRel = derivatives.previewRel;
        thumbAbs = derivatives.thumbAbs;
        previewAbs = derivatives.previewAbs;
        thumbStatus = 'ok';
        thumbError = null;
      } catch (error) {
        thumbError = shortenError(error);
        if (thumbAbs) await removeQuietly(thumbAbs);
        if (previewAbs) await removeQuietly(previewAbs);
        thumbAbs = null;
        previewAbs = null;
      }

      const year = takenAt.slice(0, 4);
      const month = takenAt.slice(5, 7);
      const storedRel = `${year}/${month}/${file.hash}${ext}`;
      destination = path.join(config.originalsDir, year, month, `${file.hash}${ext}`);
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      await moveFile(file.path, destination);
      originalMoved = true;

      const uploadedAt = new Date().toISOString();
      const inserted = this.store.insert({
        hash: file.hash,
        originalName,
        sourcePath: normalizeSourcePath(meta.relativePath),
        storedPath: storedRel,
        mime,
        size: file.size,
        width,
        height,
        takenAt,
        uploadedAt,
        album,
        thumbPath: thumbRel,
        previewPath: previewRel,
        thumbStatus,
        thumbError
      });

      if (!inserted.changes) {
        const raced = this.store.findByHash(file.hash);
        const existingPath = raced ? path.join(config.originalsDir, raced.stored_path) : null;
        if (!existingPath || path.resolve(existingPath) !== path.resolve(destination)) {
          await removeQuietly(destination);
        }
        if (raced) {
          return { ok: true, duplicate: true, photo: toApiPhoto(raced), inTrash: !!raced.deleted_at };
        }
        throw new UploadError('Could not save this photo');
      }

      const row = this.store.getById(inserted.id);
      return { ok: true, photo: toApiPhoto(row) };
    } catch (error) {
      await removeQuietly(file.path);
      if (originalMoved && destination) await removeQuietly(destination);
      if (thumbAbs) await removeQuietly(thumbAbs);
      if (previewAbs) await removeQuietly(previewAbs);

      if (error instanceof UploadError) throw error;
      console.error('[upload] Failed to process file:', error);
      throw new UploadError('Could not process this file');
    }
  }
}

export async function cleanupIncoming(directory, maxAgeMs = 12 * 60 * 60 * 1000) {
  let entries;
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  const cutoff = Date.now() - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(directory, entry.name);
    try {
      const stat = await fsp.stat(full);
      if (stat.mtimeMs < cutoff) {
        await fsp.unlink(full);
        removed += 1;
      }
    } catch {
      // Ignore files that disappear during cleanup.
    }
  }
  return removed;
}
