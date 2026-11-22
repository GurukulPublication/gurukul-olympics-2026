import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { formatBytes } from './config.js';
import { HashStorage, MediaProcessor, UploadError, cleanupIncoming } from './media.js';
import { PhotoStore } from './store.js';
import { toApiPhoto } from './serialize.js';
import { registerDriveRoutes } from './drive.js';
import { createAuth } from './auth.js';

const BULK_ACTIONS = new Set(['favorite', 'unfavorite', 'delete', 'restore', 'album', 'destroy']);

function parseId(value) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function parseInteger(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function cleanFilter(input) {
  const filter = {};
  if (input && typeof input === 'object') {
    if (input.view === 'trash' || input.view === 'favorites' || input.view === 'all') filter.view = input.view;
    if (typeof input.album === 'string') filter.album = input.album.slice(0, 120);
    if (typeof input.q === 'string') filter.q = input.q.trim().slice(0, 200);
  }
  return filter;
}

function cleanString(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function csvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function removePhotoFiles(config, rows) {
  const targets = [];
  for (const row of rows) {
    if (row.stored_path) targets.push(path.join(config.originalsDir, row.stored_path));
    if (row.thumb_path) targets.push(path.join(config.thumbsDir, row.thumb_path));
    if (row.preview_path) targets.push(path.join(config.previewsDir, row.preview_path));
  }
  for (let i = 0; i < targets.length; i += 24) {
    await Promise.all(
      targets.slice(i, i + 24).map((target) =>
        fsp.unlink(target).catch((error) => {
          if (error.code !== 'ENOENT') console.warn(`[trash] Could not remove ${target}: ${error.message}`);
        })
      )
    );
  }
}

function multerErrorResponse(error, config) {
  const size = formatBytes(config.maxFileBytes);
  const messages = {
    LIMIT_FILE_SIZE: `A file is too large. The per-file limit is ${size}.`,
    LIMIT_FILE_COUNT: `Too many files in one batch. The limit is ${config.maxBatchFiles}.`,
    LIMIT_UNEXPECTED_FILE: 'Unexpected upload field. Please add photos through the gallery.',
    LIMIT_PART_COUNT: 'Too many parts in this upload.',
    LIMIT_FIELD_SIZE: 'Upload metadata is too large.'
  };
  return {
    status: error.code === 'LIMIT_FILE_SIZE' ? 413 : 400,
    message: messages[error.code] || 'The upload could not be read.'
  };
}

export function createApp(config) {
  const store = new PhotoStore(config.dbPath);
  const processor = new MediaProcessor(config, store);
  const app = express();

  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    );
    next();
  });
  app.use(express.json({ limit: '2mb' }));

  const auth = createAuth(config);
  app.locals.auth = auth;

  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', auth.middleware);
  app.use('/media', auth.mediaGuard);

  app.get('/api/auth/status', (req, res) => {
    res.json(auth.status(req));
  });

  app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body && typeof req.body === 'object' ? req.body : {};
    if (!auth.credentialsMatch(email, password)) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    auth.setCookie(res, 'admin');
    res.json({ ok: true, role: 'admin' });
  });

  app.post('/api/auth/participant', (req, res) => {
    auth.setCookie(res, 'participant');
    res.json({ ok: true, role: 'participant' });
  });

  app.post('/api/auth/logout', (req, res) => {
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  app.use(
    '/media/thumbs',
    express.static(config.thumbsDir, {
      fallthrough: false,
      index: false,
      dotfiles: 'ignore',
      immutable: true,
      maxAge: '1y'
    })
  );
  app.use(
    '/media/previews',
    express.static(config.previewsDir, {
      fallthrough: false,
      index: false,
      dotfiles: 'ignore',
      immutable: true,
      maxAge: '1y'
    })
  );

  const storage = new HashStorage(config.incomingDir);
  const upload = multer({
    storage,
    defParamCharset: 'utf8',
    defCharset: 'utf8',
    limits: {
      files: config.maxBatchFiles,
      fileSize: config.maxFileBytes,
      fields: 8,
      fieldSize: 1024 * 1024,
      parts: config.maxBatchFiles + 8
    }
  });

  app.get('/api/health', (req, res) => {
    res.json({ ok: true, name: 'Mosaic', time: new Date().toISOString() });
  });

  app.get('/api/photos', (req, res) => {
    const filter = cleanFilter({
      view: req.query.view,
      album: req.query.album,
      q: req.query.q
    });
    const sort = ['newest', 'oldest', 'uploaded', 'name', 'largest'].includes(req.query.sort)
      ? req.query.sort
      : 'newest';
    const offset = parseInteger(req.query.offset, 0, 0, 10_000_000);
    const limit = parseInteger(req.query.limit, 120, 1, 500);
    const result = store.list(filter, sort, offset, limit);
    res.json({
      items: result.items.map(toApiPhoto),
      total: result.total,
      offset: result.offset,
      limit: result.limit,
      hasMore: result.offset + result.items.length < result.total,
      sort,
      filter
    });
  });

  app.get('/api/photos/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid photo id' });
    const row = store.getById(id);
    if (!row) return res.status(404).json({ error: 'Photo not found' });
    res.json({ photo: toApiPhoto(row) });
  });

  app.patch('/api/photos/:id', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid photo id' });
    const row = store.getById(id);
    if (!row) return res.status(404).json({ error: 'Photo not found' });

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};

    if (body.favorite !== undefined) {
      if (typeof body.favorite !== 'boolean') return res.status(400).json({ error: 'favorite must be true or false' });
      patch.favorite = body.favorite;
    }
    if (body.caption !== undefined) {
      const caption = cleanString(body.caption, 2000);
      if (caption === undefined) return res.status(400).json({ error: 'caption must be text' });
      patch.caption = caption.trim();
    }
    if (body.tags !== undefined) {
      const tags = cleanString(body.tags, 500);
      if (tags === undefined) return res.status(400).json({ error: 'tags must be text' });
      patch.tags = tags.trim();
    }
    if (body.album !== undefined) {
      const album = cleanString(body.album, 120);
      if (album === undefined) return res.status(400).json({ error: 'album must be text' });
      patch.album = album.trim();
    }

    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });
    const updated = store.update(id, patch);
    if (!updated) return res.status(404).json({ error: 'Photo not found' });
    res.json({ photo: toApiPhoto(updated) });
  });

  app.delete('/api/photos/:id', async (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid photo id' });
    const row = store.getById(id);
    if (!row) return res.status(404).json({ error: 'Photo not found' });

    if (req.query.permanent === '1') {
      if (!row.deleted_at) {
        return res.status(400).json({ error: 'Move the photo to Trash before deleting it permanently' });
      }
      const result = store.bulk('destroy', { ids: [id] });
      await removePhotoFiles(config, result.files);
      return res.json({ ok: true, permanent: true, count: result.count });
    }

    const changed = store.softDelete(id);
    if (!changed) return res.status(400).json({ error: 'Photo is already in Trash' });
    res.json({ ok: true, photo: toApiPhoto(store.getById(id)) });
  });

  app.post('/api/photos/:id/restore', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid photo id' });
    const row = store.getById(id);
    if (!row) return res.status(404).json({ error: 'Photo not found' });
    store.restore(id);
    res.json({ ok: true, photo: toApiPhoto(store.getById(id)) });
  });

  app.post('/api/photos/bulk', async (req, res, next) => {
    try {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const action = String(body.action || '');
      if (!BULK_ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown bulk action' });

      const all = body.all === true;
      const ids = Array.isArray(body.ids) ? body.ids.slice(0, 1000) : null;
      const filter = cleanFilter(body.filter || {});
      const album = body.album === undefined ? null : cleanString(body.album, 120);
      if (action === 'album' && album === undefined) {
        return res.status(400).json({ error: 'album must be text' });
      }
      if (action === 'destroy' && all && filter.view !== 'trash') {
        return res.status(400).json({ error: 'Permanent delete is only allowed from Trash' });
      }
      if (!all && (!ids || !ids.length)) {
        return res.status(400).json({ error: 'Select at least one photo' });
      }
      if (ids && ids.some((id) => parseId(id) === null)) {
        return res.status(400).json({ error: 'One or more photo ids are invalid' });
      }

      const result = store.bulk(action, {
        ids: ids ? ids.map(parseId) : null,
        all,
        filter,
        album: action === 'album' ? album : null
      });
      if (action === 'destroy' && result.files.length) {
        await removePhotoFiles(config, result.files);
      }
      res.json({ ok: true, count: result.count, permanent: action === 'destroy' });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/albums', (req, res) => {
    res.json({ albums: store.albums() });
  });

  app.get('/api/stats', (req, res) => {
    const stats = store.stats();
    let disk = null;
    try {
      const info = fs.statfsSync(config.storageDir);
      disk = {
        free: Number(info.bavail) * Number(info.bsize),
        total: Number(info.blocks) * Number(info.bsize)
      };
    } catch {
      disk = null;
    }
    res.json({
      ...stats,
      disk,
      limits: {
        maxFileBytes: config.maxFileBytes,
        maxBatchFiles: config.maxBatchFiles
      }
    });
  });

  app.get('/api/export.csv', async (req, res, next) => {
    try {
      const rows = store.csvRows();
      const name = `mosaic-library-${new Date().toISOString().slice(0, 10)}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
      res.write('\uFEFF');
      res.write(
        [
          'id', 'file_name', 'folder', 'album', 'caption', 'tags', 'favorite',
          'taken_at', 'uploaded_at', 'width', 'height', 'mime', 'bytes', 'sha256', 'deleted_at'
        ].join(',') + '\r\n'
      );
      for (const row of rows) {
        res.write(
          [
            row.id,
            row.original_name,
            row.source_path,
            row.album,
            row.caption,
            row.tags,
            row.favorite ? 'yes' : 'no',
            row.taken_at,
            row.uploaded_at,
            row.width,
            row.height,
            row.mime,
            row.size,
            row.hash,
            row.deleted_at
          ].map(csvCell).join(',') + '\r\n'
        );
      }
      res.end();
    } catch (error) {
      next(error);
    }
  });

  const uploadMiddleware = upload.array('files', config.maxBatchFiles);

  app.post('/api/upload', (req, res, next) => {
    uploadMiddleware(req, res, (error) => {
      if (error) return next(error);
      handleUpload(req, res).catch(next);
    });
  });

  async function handleUpload(req, res) {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ error: 'No photos were received' });
    }

    let album = typeof req.body?.album === 'string' ? req.body.album.trim().slice(0, 120) : '';
    let metas = [];
    if (typeof req.body?.meta === 'string') {
      try {
        const parsed = JSON.parse(req.body.meta);
        if (Array.isArray(parsed)) metas = parsed;
      } catch {
        metas = [];
      }
    }

    const results = [];
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      try {
        const result = await processor.process(file, { album, meta: metas[index] || {} });
        results.push(result);
      } catch (error) {
        if (!(error instanceof UploadError)) console.error('[upload] Unexpected error:', error);
        results.push({
          ok: false,
          error: error instanceof UploadError ? error.message : 'Could not process this file',
          name: String(file.originalname || 'photo').slice(0, 300)
        });
      }
    }

    res.json({ results, album });
  }

  app.get('/api/photos/:id/original', (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid photo id' });
    const row = store.getById(id);
    if (!row) return res.status(404).json({ error: 'Photo not found' });
    const file = path.join(config.originalsDir, row.stored_path);
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    res.sendFile(file, (error) => {
      if (error && !res.headersSent) {
        if (error.code === 'ENOENT') return res.status(404).json({ error: 'Original file is missing' });
        next(error);
      }
    });
  });

  app.get('/api/photos/:id/download', (req, res, next) => {
    const id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid photo id' });
    const row = store.getById(id);
    if (!row) return res.status(404).json({ error: 'Photo not found' });
    const file = path.join(config.originalsDir, row.stored_path);
    res.download(file, row.original_name || 'photo', (error) => {
      if (!error) return;
      if (res.headersSent) return;
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Original file is missing' });
      next(error);
    });
  });

  registerDriveRoutes(app, { config, processor });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(
    express.static(path.join(config.root, 'public'), {
      index: 'index.html',
      dotfiles: 'ignore',
      etag: true,
      maxAge: 0
    })
  );

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof multer.MulterError) {
      const response = multerErrorResponse(error, config);
      return res.status(response.status).json({ error: response.message });
    }
    if (error?.code === 'ENOENT' || error?.status === 404) {
      return res.status(404).json({ error: 'Not found' });
    }
    if (error?.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Request is too large' });
    }
    console.error('[server] Unhandled error:', error);
    res.status(500).json({ error: 'Something went wrong on the server' });
  });

  app.locals.store = store;
  app.locals.processor = processor;
  app.locals.config = config;
  app.locals.close = () => store.close();

  cleanupIncoming(config.incomingDir).catch(() => {});

  return app;
}
