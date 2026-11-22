const BATCH_SIZE = 4;
const MAX_ACTIVE_BATCHES = 3;
const MAX_BATCH_BYTES = 300 * 1024 * 1024;

const ALLOWED_EXT = /\.(jpe?g|jpe|jfif|png|webp|gif|avif|heic|heif|tiff?|bmp|jxl|cr2|cr3|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|srw|x3f|3fr|erf|kdc|mef|mos|mrw|nksc|rwl|iiq|cap)$/i;

function isPhoto(file) {
  if (!file || !file.size) return false;
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) return false;
  return file.type.startsWith('image/') || ALLOWED_EXT.test(file.name);
}

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,6})$/i.exec(name || '');
  return match ? match[1].toUpperCase() : 'IMG';
}

export class Uploader {
  constructor({ onUpdate, onBatchComplete, onIdle } = {}) {
    this.items = [];
    this.albumQueues = new Map();
    this.activeBatches = new Map();
    this.keys = new Set();
    this.nextItemId = 0;
    this.nextBatchId = 0;
    this.paused = false;
    this.wasBusy = false;
    this.startedAt = null;
    this.lastNotifyAt = 0;
    this.notifyTimer = null;
    this.onUpdate = onUpdate;
    this.onBatchComplete = onBatchComplete;
    this.onIdle = onIdle;
    this.beforeUnload = (event) => {
      if (this.isBusy()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', this.beforeUnload);
  }

  isBusy() {
    return this.activeBatches.size > 0 || this.items.some((item) => item.status === 'queued');
  }

  addFiles(fileList, album = '') {
    const added = [];
    let rejected = 0;
    let duplicate = 0;
    const cleanAlbum = String(album || '').trim().slice(0, 120);

    for (const file of fileList) {
      if (!isPhoto(file)) {
        rejected += 1;
        continue;
      }
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (this.keys.has(key)) {
        duplicate += 1;
        continue;
      }
      this.keys.add(key);
      const item = {
        id: ++this.nextItemId,
        file,
        name: file.name,
        relativePath: file.__relativePath || file.webkitRelativePath || file.name,
        size: file.size,
        album: cleanAlbum,
        status: 'queued',
        error: null,
        attempts: 0,
        photo: null,
        recovered: false
      };
      this.items.push(item);
      added.push(item);

      const queue = this.albumQueues.get(cleanAlbum) || [];
      queue.push(item);
      this.albumQueues.set(cleanAlbum, queue);
    }

    if (added.length) {
      if (!this.startedAt) this.startedAt = Date.now();
      this.notify(true);
    }

    return { added: added.length, rejected, duplicate };
  }

  start() {
    this.paused = false;
    if (!this.startedAt) this.startedAt = Date.now();
    this.pump();
    this.notify(true);
  }

  pause() {
    this.paused = true;
    this.notify(true);
  }

  resume() {
    this.paused = false;
    this.pump();
    this.notify(true);
  }

  pump() {
    if (this.paused) return;
    while (this.activeBatches.size < MAX_ACTIVE_BATCHES) {
      const batchItems = this.takeBatch();
      if (!batchItems.length) break;
      this.runBatch(batchItems);
    }
    this.notify();
    this.checkIdle();
  }

  takeBatch() {
    for (const [album, queue] of this.albumQueues) {
      const picked = [];
      let bytes = 0;
      while (queue.length && picked.length < BATCH_SIZE) {
        const item = queue[0];
        if (item.status !== 'queued') {
          queue.shift();
          continue;
        }
        if (picked.length && bytes + item.size > MAX_BATCH_BYTES) break;
        queue.shift();
        picked.push(item);
        bytes += item.size;
        if (bytes >= MAX_BATCH_BYTES) break;
      }
      if (!queue.length) this.albumQueues.delete(album);
      if (picked.length) return picked;
    }
    return [];
  }

  requeue(items, attempts) {
    for (const item of items) {
      item.status = 'queued';
      item.error = null;
      item.photo = null;
      if (attempts !== undefined) item.attempts = attempts;
    }
    const grouped = new Map();
    for (const item of items) {
      const list = grouped.get(item.album) || [];
      list.push(item);
      grouped.set(item.album, list);
    }
    for (const [album, list] of grouped) {
      const queue = this.albumQueues.get(album) || [];
      queue.unshift(...list);
      this.albumQueues.set(album, queue);
    }
  }

  runBatch(items) {
    const batch = {
      id: ++this.nextBatchId,
      items,
      loaded: 0,
      total: Math.max(1, items.reduce((sum, item) => sum + item.size, 0)),
      progress: 0,
      retries: Math.max(...items.map((item) => item.attempts))
    };
    this.activeBatches.set(batch.id, batch);
    this.wasBusy = true;
    if (!this.startedAt) this.startedAt = Date.now();

    for (const item of items) {
      item.status = 'uploading';
      item.error = null;
      item.batchId = batch.id;
    }
    this.notify(true);

    const form = new FormData();
    form.append('album', items[0].album || '');
    form.append(
      'meta',
      JSON.stringify(
        items.map((item) => ({
          relativePath: item.relativePath,
          lastModified: item.file.lastModified
        }))
      )
    );
    for (const item of items) form.append('files', item.file, item.name);

    const xhr = new XMLHttpRequest();
    batch.xhr = xhr;
    xhr.open('POST', '/api/upload');
    xhr.timeout = 20 * 60 * 1000;
    xhr.responseType = 'text';

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      batch.loaded = event.loaded;
      batch.progress = Math.min(1, event.loaded / Math.max(1, event.total));
      this.notify();
    };

    xhr.upload.onload = () => {
      for (const item of items) {
        if (item.status === 'uploading') item.status = 'processing';
      }
      this.notify(true);
    };

    xhr.onload = () => {
      this.activeBatches.delete(batch.id);
      let payload = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }

      if (xhr.status >= 200 && xhr.status < 300 && Array.isArray(payload?.results)) {
        this.applyResults(items, payload.results);
        this.finishBatch(batch, items);
        return;
      }

      const message =
        (payload && typeof payload === 'object' && payload.error) ||
        (xhr.status === 0 ? 'The upload was interrupted.' : `Upload failed (${xhr.status}).`);
      const retryable = xhr.status === 0 || xhr.status >= 500;

      if (retryable && batch.retries < 1) {
        this.retryBatchLater(items, message, batch.retries + 1);
        return;
      }

      this.failItems(items, message);
      this.finishBatch(batch, items);
    };

    xhr.onerror = () => {
      this.activeBatches.delete(batch.id);
      if (batch.retries < 1) {
        this.retryBatchLater(items, 'Network interrupted — retrying…', batch.retries + 1);
      } else {
        this.failItems(items, 'Could not upload — check that the server is running.');
        this.finishBatch(batch, items);
      }
    };

    xhr.ontimeout = () => {
      this.activeBatches.delete(batch.id);
      this.failItems(items, 'The upload timed out.');
      this.finishBatch(batch, items);
    };

    xhr.onabort = () => {
      this.activeBatches.delete(batch.id);
      this.failItems(items, 'Upload was cancelled.');
      this.finishBatch(batch, items);
    };

    try {
      xhr.send(form);
    } catch (error) {
      this.activeBatches.delete(batch.id);
      this.failItems(items, error.message || 'Could not start the upload.');
      this.finishBatch(batch, items);
    }
  }

  retryBatchLater(items, message, attempt) {
    for (const item of items) {
      item.status = 'queued';
      item.error = null;
      item.attempts = attempt;
    }
    this.notify(true);
    setTimeout(() => {
      const grouped = new Map();
      for (const item of items) {
        const list = grouped.get(item.album) || [];
        list.push(item);
        grouped.set(item.album, list);
      }
      for (const [album, list] of grouped) {
        const queue = this.albumQueues.get(album) || [];
        queue.unshift(...list);
        this.albumQueues.set(album, queue);
      }
      this.pump();
      this.notify(true);
    }, 1400);
  }

  applyResults(items, results) {
    items.forEach((item, index) => {
      const result = results[index];
      if (!result) {
        item.status = 'error';
        item.error = 'The server did not return a result for this photo.';
        return;
      }
      if (!result.ok) {
        item.status = 'error';
        item.error = result.error || 'Could not add this photo.';
        return;
      }
      if (result.duplicate) {
        item.photo = result.photo || null;
        if (item.attempts > 0) {
          item.status = 'done';
          item.recovered = true;
        } else {
          item.status = 'duplicate';
          item.error = result.inTrash ? 'Already in Trash' : null;
        }
        return;
      }
      item.status = 'done';
      item.photo = result.photo || null;
    });
  }

  failItems(items, message) {
    for (const item of items) {
      item.status = 'error';
      item.error = message;
    }
  }

  finishBatch(batch, items) {
    this.notify(true);
    this.onBatchComplete?.({
      batchId: batch.id,
      items,
      album: items[0]?.album || ''
    });
    this.pump();
    this.checkIdle();
  }

  checkIdle() {
    if (this.activeBatches.size > 0) return;
    const hasQueued = this.items.some((item) => item.status === 'queued');
    if (hasQueued) return;
    if (this.wasBusy) {
      this.wasBusy = false;
      this.onIdle?.(this.getStats());
    }
  }

  retryFailed() {
    const failed = this.items.filter((item) => item.status === 'error');
    if (!failed.length) return 0;
    this.startedAt = Date.now();
    this.requeue(failed, 0);
    this.paused = false;
    this.notify(true);
    this.pump();
    return failed.length;
  }

  clearFinished() {
    if (this.isBusy()) return false;
    this.items = this.items.filter((item) => !['done', 'duplicate', 'error'].includes(item.status));
    this.startedAt = null;
    this.wasBusy = false;
    this.notify(true);
    return true;
  }

  getFailures() {
    return this.items.filter((item) => item.status === 'error');
  }

  getStats() {
    const counts = {
      queued: 0,
      uploading: 0,
      processing: 0,
      done: 0,
      duplicate: 0,
      error: 0
    };
    let totalBytes = 0;
    let doneBytes = 0;

    for (const item of this.items) {
      counts[item.status] = (counts[item.status] || 0) + 1;
      totalBytes += item.size;
      if (item.status === 'done' || item.status === 'duplicate') doneBytes += item.size;
    }

    const total = this.items.length;
    const finished = counts.done + counts.duplicate + counts.error;
    let activeFraction = 0;
    for (const batch of this.activeBatches.values()) {
      activeFraction += (batch.progress || 0) * batch.items.length;
    }
    const percent = total ? Math.min(100, ((finished + activeFraction) / total) * 100) : 0;

    let eta = null;
    if (this.startedAt && finished >= 3 && !this.paused) {
      const elapsed = (Date.now() - this.startedAt) / 1000;
      if (elapsed > 3) {
        const rate = finished / elapsed;
        if (rate > 0) eta = (total - finished - activeFraction) / rate;
      }
    }

    return {
      ...counts,
      total,
      finished,
      totalBytes,
      doneBytes,
      percent,
      eta,
      active: this.activeBatches.size,
      paused: this.paused,
      busy: this.isBusy(),
      complete: total > 0 && finished === total,
      errors: this.getFailures()
    };
  }

  uploadLabel(item) {
    return extensionOf(item.name);
  }

  notify(force = false) {
    const now = Date.now();
    const elapsed = now - this.lastNotifyAt;

    if (force || elapsed > 120) {
      this.lastNotifyAt = now;
      if (this.notifyTimer) {
        clearTimeout(this.notifyTimer);
        this.notifyTimer = null;
      }
      this.onUpdate?.(this.getStats());
      return;
    }

    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        this.lastNotifyAt = Date.now();
        this.onUpdate?.(this.getStats());
      }, 120);
    }
  }
}
