import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL UNIQUE,
  original_name TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  stored_path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  taken_at TEXT,
  uploaded_at TEXT NOT NULL,
  album TEXT NOT NULL DEFAULT '',
  caption TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  thumb_path TEXT,
  preview_path TEXT,
  thumb_status TEXT NOT NULL DEFAULT 'pending',
  thumb_error TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_photos_deleted ON photos(deleted_at);
CREATE INDEX IF NOT EXISTS idx_photos_uploaded ON photos(uploaded_at);
CREATE INDEX IF NOT EXISTS idx_photos_taken ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album);
CREATE INDEX IF NOT EXISTS idx_photos_favorite ON photos(favorite);
`;

const SORTS = {
  newest: 'COALESCE(taken_at, uploaded_at) DESC, id DESC',
  oldest: 'COALESCE(taken_at, uploaded_at) ASC, id ASC',
  uploaded: 'uploaded_at DESC, id DESC',
  name: 'original_name COLLATE NOCASE ASC, id ASC',
  largest: 'size DESC, id DESC'
};

const UNSORTED = '__unsorted__';

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function buildFilter(filter = {}) {
  const clauses = [];
  const params = [];
  const view = filter.view === 'favorites' || filter.view === 'trash' ? filter.view : 'all';

  if (view === 'trash') {
    clauses.push('deleted_at IS NOT NULL');
  } else {
    clauses.push('deleted_at IS NULL');
  }

  if (view === 'favorites') clauses.push('favorite = 1');

  if (typeof filter.album === 'string' && filter.album.length > 0) {
    if (filter.album === UNSORTED) {
      clauses.push("album = ''");
    } else {
      clauses.push('album = ?');
      params.push(filter.album);
    }
  }

  const q = typeof filter.q === 'string' ? filter.q.trim() : '';
  if (q) {
    const like = `%${escapeLike(q.slice(0, 200))}%`;
    clauses.push(
      "(original_name LIKE ? ESCAPE '\\' OR source_path LIKE ? ESCAPE '\\' OR caption LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR album LIKE ? ESCAPE '\\')"
    );
    params.push(like, like, like, like, like);
  }

  return { where: `WHERE ${clauses.join(' AND ')}`, params, view };
}

export class PhotoStore {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    try {
      this.db.exec('PRAGMA optimize;');
    } catch {
      // Ignore optimization failures on shutdown.
    }
    this.db.close();
  }

  get(sql, ...params) {
    return this.db.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.db.prepare(sql).all(...params);
  }

  run(sql, ...params) {
    return this.db.prepare(sql).run(...params);
  }

  findByHash(hash) {
    return this.get('SELECT * FROM photos WHERE hash = ?', hash);
  }

  getById(id) {
    return this.get('SELECT * FROM photos WHERE id = ?', id);
  }

  list(filter = {}, sort = 'newest', offset = 0, limit = 120) {
    const { where, params } = buildFilter(filter);
    const orderBy = SORTS[sort] || SORTS.newest;
    const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0);
    const safeLimit = Math.min(500, Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 120));
    const totalRow = this.get(`SELECT COUNT(*) AS count FROM photos ${where}`, ...params);
    const rows = this.all(
      `SELECT * FROM photos ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      ...params,
      safeLimit,
      safeOffset
    );
    return {
      total: Number(totalRow?.count || 0),
      items: rows,
      offset: safeOffset,
      limit: safeLimit
    };
  }

  insert(photo) {
    const result = this.run(
      `INSERT INTO photos (
        hash, original_name, source_path, stored_path, mime, size, width, height,
        taken_at, uploaded_at, album, thumb_path, preview_path, thumb_status, thumb_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(hash) DO NOTHING`,
      photo.hash,
      photo.originalName,
      photo.sourcePath || '',
      photo.storedPath,
      photo.mime || '',
      photo.size,
      photo.width ?? null,
      photo.height ?? null,
      photo.takenAt || null,
      photo.uploadedAt,
      photo.album || '',
      photo.thumbPath || null,
      photo.previewPath || null,
      photo.thumbStatus || 'pending',
      photo.thumbError || null
    );
    return {
      changes: Number(result.changes || 0),
      id: Number(result.lastInsertRowid || 0)
    };
  }

  update(id, patch) {
    const fields = [];
    const params = [];
    const assign = (column, value) => {
      fields.push(`${column} = ?`);
      params.push(value);
    };

    if (patch.favorite !== undefined) assign('favorite', patch.favorite ? 1 : 0);
    if (patch.caption !== undefined) assign('caption', patch.caption);
    if (patch.tags !== undefined) assign('tags', patch.tags);
    if (patch.album !== undefined) assign('album', patch.album);
    if (!fields.length) return this.getById(id);

    const result = this.run(`UPDATE photos SET ${fields.join(', ')} WHERE id = ?`, ...params, id);
    if (!Number(result.changes)) return null;
    return this.getById(id);
  }

  setDerivatives(id, { thumbPath, previewPath, thumbStatus, thumbError, width, height }) {
    this.run(
      `UPDATE photos SET
        thumb_path = COALESCE(?, thumb_path),
        preview_path = COALESCE(?, preview_path),
        thumb_status = COALESCE(?, thumb_status),
        thumb_error = ?,
        width = COALESCE(?, width),
        height = COALESCE(?, height)
      WHERE id = ?`,
      thumbPath || null,
      previewPath || null,
      thumbStatus || null,
      thumbError || null,
      width ?? null,
      height ?? null,
      id
    );
    return this.getById(id);
  }

  softDelete(id, when = new Date().toISOString()) {
    const result = this.run('UPDATE photos SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL', when, id);
    return Number(result.changes) > 0;
  }

  restore(id) {
    const result = this.run('UPDATE photos SET deleted_at = NULL WHERE id = ?', id);
    return Number(result.changes) > 0;
  }

  albums() {
    return this.all(
      `SELECT album, COUNT(*) AS count FROM photos
       WHERE deleted_at IS NULL AND album <> ''
       GROUP BY album
       ORDER BY album COLLATE NOCASE ASC`
    ).map((row) => ({ album: row.album, count: Number(row.count) }));
  }

  stats() {
    const active = this.get(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(size), 0) AS bytes,
        COALESCE(SUM(CASE WHEN favorite = 1 THEN 1 ELSE 0 END), 0) AS favorites,
        COALESCE(SUM(CASE WHEN album = '' THEN 1 ELSE 0 END), 0) AS unsorted,
        COALESCE(SUM(CASE WHEN thumb_status = 'failed' THEN 1 ELSE 0 END), 0) AS failedThumbs
       FROM photos WHERE deleted_at IS NULL`
    );
    const trash = this.get('SELECT COUNT(*) AS count FROM photos WHERE deleted_at IS NOT NULL');
    return {
      total: Number(active.total || 0),
      bytes: Number(active.bytes || 0),
      favorites: Number(active.favorites || 0),
      unsorted: Number(active.unsorted || 0),
      failedThumbs: Number(active.failedThumbs || 0),
      trashed: Number(trash.count || 0)
    };
  }

  bulk(action, { ids = null, all = false, filter = null, album = null } = {}) {
    if (!Array.isArray(ids) || ids.length === 0) {
      if (!all) throw new Error('No photos selected');
      ids = null;
    } else {
      ids = [...new Set(ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0))];
      if (!ids.length) throw new Error('No valid photo ids');
      all = false;
    }

    const clauses = [];
    const params = [];
    if (ids) {
      if (ids.length > 1000) throw new Error('Too many photos selected at once');
      clauses.push(`id IN (${ids.map(() => '?').join(', ')})`);
      params.push(...ids);
    } else if (filter) {
      const built = buildFilter(filter);
      clauses.push(built.where.replace(/^WHERE /, ''));
      params.push(...built.params);
    }

    const now = new Date().toISOString();
    const stateClauses = {
      delete: ['deleted_at IS NULL'],
      restore: ['deleted_at IS NOT NULL'],
      favorite: ['deleted_at IS NULL'],
      unfavorite: ['deleted_at IS NULL'],
      album: ['deleted_at IS NULL'],
      destroy: ['deleted_at IS NOT NULL']
    }[action];

    if (!stateClauses) throw new Error('Unknown action');
    const where = `WHERE ${[...clauses, ...stateClauses].join(' AND ')}`;

    if (action === 'destroy') {
      const rows = this.all(
        `SELECT id, stored_path, thumb_path, preview_path FROM photos ${where}`,
        ...params
      );
      if (!rows.length) return { count: 0, files: [] };
      this.run(`DELETE FROM photos ${where}`, ...params);
      return { count: rows.length, files: rows };
    }

    let result;
    if (action === 'delete') {
      result = this.run(`UPDATE photos SET deleted_at = ? ${where}`, now, ...params);
    } else if (action === 'restore') {
      result = this.run(`UPDATE photos SET deleted_at = NULL ${where}`, ...params);
    } else if (action === 'favorite') {
      result = this.run(`UPDATE photos SET favorite = 1 ${where}`, ...params);
    } else if (action === 'unfavorite') {
      result = this.run(`UPDATE photos SET favorite = 0 ${where}`, ...params);
    } else if (action === 'album') {
      result = this.run(`UPDATE photos SET album = ? ${where}`, album || '', ...params);
    }

    return { count: Number(result?.changes || 0), files: [] };
  }

  csvRows() {
    return this.all(
      `SELECT id, original_name, source_path, album, caption, tags, favorite,
              taken_at, uploaded_at, width, height, mime, size, hash, deleted_at
       FROM photos
       ORDER BY id ASC`
    );
  }
}

export { SCHEMA, SORTS };
