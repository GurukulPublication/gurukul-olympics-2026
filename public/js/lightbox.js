import { api } from './api.js';
import {
  $,
  confirmDialog,
  formatBytes,
  formatDate,
  formatDateTime,
  formatNumber,
  isTypingTarget,
  toast
} from './ui.js';

export class Lightbox {
  constructor({ onUpdated, onRemoved, onRestored, onAlbumsChanged, onClose } = {}) {
    this.root = $('#lightbox');
    this.els = {
      image: $('#lb-image'),
      loader: $('#lb-loader'),
      unavailable: $('#lb-unavailable'),
      counter: $('#lb-counter'),
      prev: $('#lb-prev'),
      next: $('#lb-next'),
      close: $('#lb-close'),
      info: $('#lb-info'),
      panel: $('#lb-panel'),
      fav: $('#lb-fav'),
      download: $('#lb-download'),
      delete: $('#lb-delete'),
      restore: $('#lb-restore'),
      date: $('#lb-date'),
      name: $('#lb-name'),
      path: $('#lb-path'),
      album: $('#lb-album-input'),
      caption: $('#lb-caption'),
      tags: $('#lb-tags'),
      saveStatus: $('#lb-save-status'),
      dimensions: $('#lb-dimensions'),
      size: $('#lb-size'),
      type: $('#lb-type'),
      folder: $('#lb-folder'),
      taken: $('#lb-taken'),
      added: $('#lb-added'),
      openOriginal: $('#lb-open-original')
    };

    this.onUpdated = onUpdated;
    this.onRemoved = onRemoved;
    this.onRestored = onRestored;
    this.onAlbumsChanged = onAlbumsChanged;
    this.onClose = onClose;

    this.isOpen = false;
    this.viewOnly = false;
    this.currentId = null;
    this.photo = null;
    this.view = 'all';
    this.getItems = () => [];
    this.getTotal = () => 0;
    this.hasMore = () => false;
    this.requestMore = async () => {};
    this.lastFocus = null;
    this.saveTimer = null;
    this.saveChain = Promise.resolve();
    this.savedTimer = null;
    this.imageToken = 0;
    this.imageFallbackTried = false;
    this.navigating = false;

    this.els.close?.addEventListener('click', () => this.close());
    this.els.prev?.addEventListener('click', () => this.navigate(-1));
    this.els.next?.addEventListener('click', () => this.navigate(1));
    this.els.info?.addEventListener('click', () => this.toggleInfo());
    this.els.fav?.addEventListener('click', () => this.toggleFavorite());
    this.els.delete?.addEventListener('click', () => this.deleteCurrent());
    this.els.restore?.addEventListener('click', () => this.restoreCurrent());

    const schedule = () => this.queueSave();
    this.els.album?.addEventListener('input', schedule);
    this.els.caption?.addEventListener('input', schedule);
    this.els.tags?.addEventListener('input', schedule);

    document.addEventListener('keydown', (event) => this.onKeyDown(event));
  }

  setViewOnly(value) {
    this.viewOnly = !!value;
    for (const field of [this.els.album, this.els.caption, this.els.tags]) {
      if (field) field.disabled = this.viewOnly;
    }
    if (this.isOpen) this.renderPhoto();
  }

  open(id, context) {
    this.getItems = context.getItems || (() => []);
    this.getTotal = context.getTotal || (() => this.getItems().length);
    this.hasMore = context.hasMore || (() => false);
    this.requestMore = context.requestMore || (async () => {});
    this.view = context.view || 'all';

    const items = this.getItems();
    const index = items.findIndex((item) => item.id === Number(id));
    if (index === -1) return;

    if (!this.isOpen) this.lastFocus = document.activeElement;
    this.currentId = Number(id);
    this.isOpen = true;
    this.root.hidden = false;
    this.root.classList.remove('info-open');
    document.body.classList.add('lightbox-open');
    this.els.saveStatus.textContent = '';
    this.els.saveStatus.className = 'save-status';
    this.renderPhoto();

    setTimeout(() => this.els.close?.focus(), 40);
  }

  close() {
    if (!this.isOpen) return;
    this.flushPending();
    this.isOpen = false;
    this.root.hidden = true;
    this.root.classList.remove('info-open');
    document.body.classList.remove('lightbox-open');
    this.currentId = null;
    this.photo = null;
    this.imageToken += 1;
    if (this.lastFocus && this.lastFocus.isConnected) {
      try {
        this.lastFocus.focus();
      } catch {
        // The originating card may have been removed.
      }
    }
    this.onClose?.();
  }

  toggleInfo() {
    this.root.classList.toggle('info-open');
  }

  onKeyDown(event) {
    if (!this.isOpen) return;

    if (event.key === 'Tab') {
      this.trapFocus(event);
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }

    if (isTypingTarget(event.target)) return;

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.navigate(-1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      this.navigate(1);
    } else if (event.key === 'f' || event.key === 'F') {
      if (!this.els.fav.hidden) {
        event.preventDefault();
        this.toggleFavorite();
      }
    } else if (event.key === 'i' || event.key === 'I') {
      if (window.matchMedia('(max-width: 1024px)').matches) {
        event.preventDefault();
        this.toggleInfo();
      }
    }
  }

  trapFocus(event) {
    const focusable = Array.from(
      this.root.querySelectorAll(
        'button:not([disabled]):not([hidden]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled])'
      )
    ).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  currentIndex() {
    return this.getItems().findIndex((item) => item.id === this.currentId);
  }

  renderPhoto() {
    const items = this.getItems();
    const index = items.findIndex((item) => item.id === this.currentId);
    if (index === -1) {
      this.close();
      return;
    }

    const photo = items[index];
    this.photo = photo;

    this.els.date.textContent = formatDate(photo.takenAt);
    this.els.name.textContent = photo.name || 'Untitled photo';
    this.els.path.textContent = photo.path || (photo.album ? `Album · ${photo.album}` : 'No folder path');
    this.els.album.value = photo.album || '';
    this.els.caption.value = photo.caption || '';
    this.els.tags.value = photo.tags || '';
    this.els.saveStatus.textContent = '';
    this.els.saveStatus.className = 'save-status';

    this.els.dimensions.textContent =
      photo.width && photo.height ? `${formatNumber(photo.width)} × ${formatNumber(photo.height)}` : '—';
    this.els.size.textContent = formatBytes(photo.size);
    this.els.type.textContent = this.typeLabel(photo);
    this.els.folder.textContent = this.folderLabel(photo);
    this.els.taken.textContent = photo.takenAt ? formatDateTime(photo.takenAt) : '—';
    this.els.added.textContent = photo.uploadedAt ? formatDateTime(photo.uploadedAt) : '—';

    this.els.download.href = photo.downloadUrl;
    this.els.download.setAttribute('download', photo.name || 'photo');
    this.els.openOriginal.href = photo.originalUrl;

    this.renderFavorite(photo.favorite);
    this.renderViewActions();

    const total = this.getTotal();
    this.els.counter.textContent = `${formatNumber(index + 1)} / ${formatNumber(Math.max(total, items.length))}`;
    this.els.prev.disabled = index <= 0;
    this.els.next.disabled = index >= items.length - 1 && !this.hasMore();

    this.renderImage(photo);
    this.els.panel.scrollTop = 0;
    this.preloadNeighbours(index);
  }

  renderFavorite(favorite) {
    this.els.fav.setAttribute('aria-pressed', favorite ? 'true' : 'false');
    this.els.fav.setAttribute('aria-label', favorite ? 'Remove from favorites' : 'Add to favorites');
    this.els.fav.innerHTML = `<svg class="icon" aria-hidden="true"><use href="#i-${favorite ? 'heart-solid' : 'heart'}"></use></svg>`;
  }

  renderViewActions() {
    if (this.viewOnly) {
      this.els.fav.hidden = true;
      this.els.restore.hidden = true;
      this.els.delete.hidden = true;
      return;
    }

    const trash = this.view === 'trash';
    this.els.fav.hidden = trash;
    this.els.restore.hidden = !trash;
    this.els.delete.hidden = false;
    this.els.delete.setAttribute('aria-label', trash ? 'Delete permanently' : 'Move to Trash');
    this.els.delete.title = trash ? 'Delete permanently' : 'Move to Trash';
  }

  renderImage(photo) {
    const token = ++this.imageToken;
    this.imageFallbackTried = false;
    const img = this.els.image;
    img.classList.remove('is-loaded');
    this.els.loader.hidden = false;
    this.els.unavailable.hidden = true;
    img.alt = photo.caption || photo.name || '';

    const useOriginal = photo.mime === 'image/gif';
    const source = useOriginal ? photo.originalUrl : photo.previewUrl || photo.originalUrl;
    if (!source) {
      this.showUnavailable();
      return;
    }

    img.onload = () => {
      if (token !== this.imageToken) return;
      this.els.loader.hidden = true;
      this.els.unavailable.hidden = true;
      img.classList.add('is-loaded');
    };

    img.onerror = () => {
      if (token !== this.imageToken) return;
      if (!this.imageFallbackTried && source !== photo.originalUrl) {
        this.imageFallbackTried = true;
        img.src = photo.originalUrl;
        return;
      }
      this.showUnavailable();
    };

    img.src = source;
  }

  showUnavailable() {
    this.els.loader.hidden = true;
    this.els.unavailable.hidden = false;
    this.els.image.classList.remove('is-loaded');
    this.els.image.removeAttribute('src');
  }

  preloadNeighbours(index) {
    const items = this.getItems();
    for (const offset of [1, -1]) {
      const neighbour = items[index + offset];
      if (!neighbour || !neighbour.previewUrl) continue;
      const image = new Image();
      image.src = neighbour.previewUrl;
    }
  }

  typeLabel(photo) {
    const extension = /\.([a-z0-9]{2,6})$/i.exec(photo.name || '');
    if (extension) return extension[1].toUpperCase();
    if (photo.mime) return photo.mime.split('/').pop().toUpperCase();
    return '—';
  }

  folderLabel(photo) {
    const path = photo.path || '';
    const parts = path.split('/').filter(Boolean);
    if (parts.length <= 1) return '—';
    return parts.slice(0, -1).join(' / ');
  }

  async navigate(delta) {
    if (!this.isOpen || this.navigating) return;
    this.navigating = true;
    this.els.prev.disabled = true;
    this.els.next.disabled = true;

    try {
      await this.flushPending();

      let items = this.getItems();
      let index = items.findIndex((item) => item.id === this.currentId);
      if (index === -1) {
        this.close();
        return;
      }

      let target = index + delta;
      if (target >= items.length && delta > 0 && this.hasMore()) {
        await this.requestMore();
        items = this.getItems();
        index = items.findIndex((item) => item.id === this.currentId);
        target = index + delta;
      }

      if (target >= 0 && target < items.length) {
        this.currentId = items[target].id;
        this.renderPhoto();
      }
    } finally {
      this.navigating = false;
      if (this.isOpen) {
        const items = this.getItems();
        const index = items.findIndex((item) => item.id === this.currentId);
        if (index !== -1) {
          this.els.prev.disabled = index <= 0;
          this.els.next.disabled = index >= items.length - 1 && !this.hasMore();
        }
      }
    }
  }

  async toggleFavorite() {
    if (!this.photo || this.view === 'trash' || this.viewOnly) return;
    const previous = this.photo.favorite;
    const next = !previous;
    this.photo.favorite = next;
    this.renderFavorite(next);
    this.onUpdated?.(this.photo, { favoriteChanged: true });

    try {
      const data = await api(`/api/photos/${this.currentId}`, {
        method: 'PATCH',
        body: { favorite: next }
      });
      if (data?.photo) {
        this.photo = { ...this.photo, ...data.photo };
        this.onUpdated?.(data.photo, { favoriteChanged: true });
      }
    } catch (error) {
      this.photo.favorite = previous;
      this.renderFavorite(previous);
      this.onUpdated?.(this.photo, { favoriteChanged: true });
      toast(error.message || 'Could not update favorite.', { type: 'error' });
    }
  }

  queueSave() {
    if (!this.isOpen || !this.photo || this.viewOnly) return;
    if (this.savedTimer) clearTimeout(this.savedTimer);
    this.els.saveStatus.textContent = 'Unsaved changes';
    this.els.saveStatus.className = 'save-status is-saving';
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persistCurrent();
    }, 600);
  }

  persistCurrent() {
    this.saveChain = this.saveChain.then(() => this.doPersist()).catch(() => {});
    return this.saveChain;
  }

  async doPersist() {
    if (!this.isOpen || !this.photo || this.viewOnly) return;
    const photoId = this.currentId;
    const patch = {};
    const album = this.els.album.value.trim().slice(0, 120);
    const caption = this.els.caption.value.trim().slice(0, 2000);
    const tags = this.els.tags.value.trim().slice(0, 500);

    if (album !== (this.photo.album || '')) patch.album = album;
    if (caption !== (this.photo.caption || '')) patch.caption = caption;
    if (tags !== (this.photo.tags || '')) patch.tags = tags;

    if (!Object.keys(patch).length) {
      if (this.currentId === photoId) {
        this.els.saveStatus.textContent = '';
        this.els.saveStatus.className = 'save-status';
      }
      return;
    }

    if (this.currentId === photoId) {
      this.els.saveStatus.textContent = 'Saving…';
      this.els.saveStatus.className = 'save-status is-saving';
    }

    try {
      const data = await api(`/api/photos/${photoId}`, { method: 'PATCH', body: patch });
      if (!data?.photo) return;
      const albumChanged = patch.album !== undefined && data.photo.album !== this.photo?.album;
      if (this.photo?.id === photoId) {
        this.photo = { ...this.photo, ...data.photo };
        if (albumChanged) {
          this.els.date.textContent = formatDate(data.photo.takenAt);
        }
      }
      this.onUpdated?.(data.photo, { albumChanged, captionChanged: patch.caption !== undefined });
      if (albumChanged) this.onAlbumsChanged?.();

      if (this.isOpen && this.currentId === photoId && !this.saveTimer) {
        this.els.saveStatus.textContent = 'Saved';
        this.els.saveStatus.className = 'save-status';
        if (this.savedTimer) clearTimeout(this.savedTimer);
        this.savedTimer = setTimeout(() => {
          if (this.els.saveStatus.textContent === 'Saved') {
            this.els.saveStatus.textContent = '';
          }
        }, 1800);
      }
    } catch (error) {
      if (this.isOpen && this.currentId === photoId) {
        this.els.saveStatus.textContent = 'Could not save changes';
        this.els.saveStatus.className = 'save-status is-error';
      }
      toast(error.message || 'Could not save photo details.', { type: 'error' });
    }
  }

  async flushPending() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.persistCurrent();
    } else {
      await this.saveChain;
    }
  }

  async deleteCurrent() {
    if (!this.photo || this.viewOnly) return;
    const photo = this.photo;
    const permanent = this.view === 'trash';

    if (permanent) {
      const sure = await confirmDialog({
        title: 'Delete this photo forever?',
        message: `“${photo.name}” will be removed from this computer. This cannot be undone.`,
        confirmLabel: 'Delete forever'
      });
      if (!sure) return;
    }

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }

    try {
      if (permanent) {
        await api(`/api/photos/${photo.id}?permanent=1`, { method: 'DELETE' });
      } else {
        await api(`/api/photos/${photo.id}`, { method: 'DELETE' });
      }
      const index = this.currentIndex();
      this.onRemoved?.(photo, { permanent });
      toast(permanent ? 'Photo deleted permanently' : 'Photo moved to Trash', {
        type: 'success'
      });

      const items = this.getItems();
      if (!items.length) {
        this.close();
        return;
      }
      const nextIndex = Math.min(Math.max(index, 0), items.length - 1);
      this.currentId = items[nextIndex].id;
      this.renderPhoto();
    } catch (error) {
      toast(error.message || 'Could not delete this photo.', { type: 'error' });
    }
  }

  async restoreCurrent() {
    if (!this.photo || this.viewOnly) return;
    const photo = this.photo;
    try {
      const index = this.currentIndex();
      const data = await api(`/api/photos/${photo.id}/restore`, { method: 'POST' });
      this.onRestored?.(data?.photo || { ...photo, deletedAt: null });
      toast('Photo restored to your library', { type: 'success' });
      const items = this.getItems();
      if (!items.length) {
        this.close();
        return;
      }
      const nextIndex = Math.min(Math.max(index, 0), items.length - 1);
      this.currentId = items[nextIndex].id;
      this.renderPhoto();
    } catch (error) {
      toast(error.message || 'Could not restore this photo.', { type: 'error' });
    }
  }
}
