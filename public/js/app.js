import { api, photoQuery } from './api.js';
import { Lightbox } from './lightbox.js';
import { Uploader } from './uploader.js';
import {
  $,
  $$,
  albumPicker,
  announce,
  clamp,
  confirmDialog,
  debounce,
  formatBytes,
  formatDateTime,
  formatDuration,
  formatNumber,
  icon,
  isTypingTarget,
  plural,
  toast
} from './ui.js';

const PAGE_SIZE = 120;
const DEFAULT_DRIVE_FOLDER = 'GO#2026';
const DEFAULT_DRIVE_INTERVAL_SECONDS = 5;
const UNSORTED = '__unsorted__';
const VIEWS = new Set(['all', 'favorites', 'trash']);
const SORTS = new Set(['newest', 'oldest', 'uploaded', 'name', 'largest']);
const PHOTO_EXT = /\.(jpe?g|jpe|jfif|png|webp|gif|avif|heic|heif|tiff?|bmp|jxl|cr2|cr3|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|srw|x3f|3fr|erf|kdc|mef|mos|mrw|nksc|rwl|iiq|cap)$/i;
const ALBUM_COLORS = ['#e6b95c', '#7fb7a4', '#c98f7d', '#8ba4d9', '#c9a2d6', '#d9b47f', '#88b7c9', '#b8a7d9'];

const els = {
  app: $('#app'),
  main: $('#main'),
  sidebar: $('#sidebar'),
  sidebarClose: $('#sidebar-close'),
  sidebarScrim: $('#sidebar-scrim'),
  menuBtn: $('#menu-btn'),
  brandLink: $('#brand-link'),
  navButtons: $$('[data-nav]'),
  countAll: $('#count-all'),
  countFavorites: $('#count-favorites'),
  countTrash: $('#count-trash'),
  albumList: $('#album-list'),
  albumOptions: $('#album-options'),
  storageUsed: $('#storage-used'),
  storageBar: $('#storage-bar'),
  storageSub: $('#storage-sub'),
  viewTitle: $('#view-title'),
  viewSubtitle: $('#view-subtitle'),
  searchInput: $('#search-input'),
  sortSelect: $('#sort-select'),
  selectBtn: $('#select-btn'),
  uploadBtn: $('#upload-btn'),
  newBanner: $('#new-banner'),
  newCount: $('#new-count'),
  newRefresh: $('#new-refresh'),
  newDismiss: $('#new-dismiss'),
  gallery: $('#gallery'),
  scrollProgress: $('#scroll-progress'),
  empty: $('#empty'),
  loadMore: $('#load-more'),
  loadSpinner: $('#load-spinner'),
  loadError: $('#load-error'),
  sentinel: $('#sentinel'),
  bulkBar: $('#bulk-bar'),
  bulkCount: $('#bulk-count'),
  bulkSelectAll: $('#bulk-select-all'),
  bulkFavoriteBtn: $('[data-bulk="favorite"]'),
  bulkAlbumBtn: $('[data-bulk="album"]'),
  bulkRestoreBtn: $('[data-bulk="restore"]'),
  bulkFavoriteLabel: $('#bulk-favorite-label'),
  bulkDeleteLabel: $('#bulk-delete-label'),
  uploadDialog: $('#upload-dialog'),
  uploadForm: $('#upload-form'),
  uploadClose: $('#upload-close'),
  uploadCancel: $('#upload-cancel'),
  dropzone: $('#dropzone'),
  pickFiles: $('#pick-files'),
  pickFolder: $('#pick-folder'),
  fileInput: $('#file-input'),
  folderInput: $('#folder-input'),
  uploadSelection: $('#upload-selection'),
  uploadSelectionCount: $('#upload-selection-count'),
  uploadSelectionSize: $('#upload-selection-size'),
  uploadClearSelection: $('#upload-clear-selection'),
  uploadScanning: $('#upload-scanning'),
  uploadAlbum: $('#upload-album'),
  uploadStart: $('#upload-start'),
  uploadLimitNote: $('#upload-limit-note'),
  dropOverlay: $('#drop-overlay'),
  queue: $('#queue'),
  queueTitle: $('#queue-title'),
  queueSubtitle: $('#queue-subtitle'),
  queueBar: $('#queue-bar'),
  queueStats: $('#queue-stats'),
  queueList: $('#queue-list'),
  queuePause: $('#queue-pause'),
  queueRetry: $('#queue-retry'),
  queueClear: $('#queue-clear'),
  queueMinimize: $('#queue-minimize'),
  queueClose: $('#queue-close'),
  uploadIndicator: $('#upload-indicator'),
  uploadIndicatorLabel: $('#upload-indicator-label'),
  uploadIndicatorPercent: $('#upload-indicator-percent'),
  themeToggle: $('#theme-toggle'),
  themeIcon: $('#theme-icon'),
  themeLabel: $('#theme-label'),
  driveStatus: $('#drive-status'),
  driveCardBody: $('#drive-card-body'),
  driveFolderLine: $('#drive-folder-line'),
  driveLastLine: $('#drive-last-line'),
  driveConnect: $('#drive-connect'),
  driveManage: $('#drive-manage'),
  driveSync: $('#drive-sync'),
  driveChange: $('#drive-change'),
  driveDisconnect: $('#drive-disconnect'),
  driveDialog: $('#drive-dialog'),
  driveForm: $('#drive-form'),
  driveFolderSearch: $('#drive-folder-search'),
  driveFolderSelect: $('#drive-folder-select'),
  driveAlbum: $('#drive-album'),
  driveSubfolders: $('#drive-subfolders'),
  driveExisting: $('#drive-existing'),
  driveInterval: $('#drive-interval'),
  driveCancel: $('#drive-cancel'),
  driveClose: $('#drive-dialog-close'),
  driveApply: $('#drive-apply'),
  authScreen: $('#auth-screen'),
  authForm: $('#auth-form'),
  authEmail: $('#auth-email'),
  authPassword: $('#auth-password'),
  authError: $('#auth-error'),
  authSubmit: $('#auth-submit'),
  authParticipant: $('#auth-participant'),
  authAdmin: $('#auth-admin'),
  authSwitch: $('#auth-switch')
};

const state = {
  view: 'all',
  album: null,
  q: '',
  sort: 'newest',
  items: [],
  total: 0,
  hasMore: false,
  loading: false,
  loadingMore: false,
  loaded: false,
  error: null,
  loadError: null,
  requestId: 0,
  controller: null,
  selected: new Set(),
  selectAllMatching: false,
  selectMode: false,
  albums: [],
  stats: null,
  newCount: 0,
  queueOpen: false,
  queueMinimized: false,
  pendingFiles: [],
  pendingScan: 0,
  dropToken: 0,
  dragDepth: 0,
  needsRefreshOnClose: false,
  session: { added: 0, duplicates: 0 },
  drive: null,
  driveKnownLastSync: null,
  driveFolders: [],
  drivePopup: null,
  driveAuthTimer: null,
  driveAuthTimeout: null,
  driveAutoConfiguring: false,
  role: 'admin',
  appStarted: false
};

let lastQueueStats = null;
let lastQueueListSignature = '';

/* ------------------------------------------------------------------
   Gallery motion — staggered reveals + gentle parallax on scroll
   ------------------------------------------------------------------ */

let revealIndex = 0;
let revealObserver = null;

if (typeof IntersectionObserver === 'function') {
  revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        revealObserver.unobserve(entry.target);
      }
    },
    { root: els.main, rootMargin: '0px 0px -6% 0px', threshold: 0.04 }
  );
}

const uploader = new Uploader({
  onUpdate: handleUploadUpdate,
  onBatchComplete: handleBatchComplete,
  onIdle: handleUploadIdle
});

const lightbox = new Lightbox({
  onUpdated: handleLightboxUpdated,
  onRemoved: handleLightboxRemoved,
  onRestored: handleLightboxRestored,
  onAlbumsChanged: () => {
    loadAlbums();
  },
  onClose: handleLightboxClosed
});

const debouncedSearch = debounce(() => {
  applySearchValue(els.searchInput.value);
}, 280);

const debouncedDriveFolders = debounce(() => {
  loadDriveFolders(els.driveFolderSearch.value);
}, 320);

function photoById(id) {
  return state.items.find((photo) => photo.id === Number(id)) || null;
}

function currentFilter() {
  const filter = { view: state.view };
  if (state.album) filter.album = state.album;
  if (state.q) filter.q = state.q;
  return filter;
}

function viewLabel() {
  if (state.album) return state.album === UNSORTED ? 'Unsorted photos' : state.album;
  if (state.view === 'favorites') return 'Favorites';
  if (state.view === 'trash') return 'Trash';
  return 'All photos';
}

function albumLabelFor(album) {
  return album === UNSORTED ? 'Unsorted' : album;
}

/* ------------------------------------------------------------------
   Loading photos
   ------------------------------------------------------------------ */

function updateHeader() {
  const label = viewLabel();
  const total = formatNumber(state.total);
  let subtitle;

  if (state.loading) {
    subtitle = 'Loading photos…';
  } else if (state.view === 'trash') {
    subtitle = `${total} ${plural(state.total, 'photo')} in Trash`;
  } else if (state.view === 'favorites') {
    subtitle = `${total} favorite ${plural(state.total, 'photo')}`;
  } else if (state.album) {
    subtitle = `${total} ${plural(state.total, 'photo')} · ${state.album === UNSORTED ? 'not in an album' : 'in this album'}`;
  } else {
    subtitle = `${total} ${plural(state.total, 'photo')}`;
  }

  if (state.q) subtitle += ` matching “${state.q}”`;

  els.viewTitle.textContent = label;
  els.viewSubtitle.textContent = subtitle;
  document.title = `${label} — Gurukul Olympics 2026`;
}

function updateLoadArea() {
  const showMore = state.hasMore && !state.loading && !state.loadingMore && state.items.length > 0;
  els.loadMore.hidden = !showMore;
  els.loadSpinner.hidden = !state.loadingMore;
  els.loadError.hidden = !state.loadError;
  els.loadError.textContent = state.loadError || '';
}

function scheduleAutoFill() {
  requestAnimationFrame(() => {
    if (state.loading || state.loadingMore || !state.hasMore) return;
    const mainRect = els.main.getBoundingClientRect();
    const sentinelRect = els.sentinel.getBoundingClientRect();
    if (sentinelRect.top <= mainRect.bottom + 900) loadMore();
  });
}

function renderSkeletons() {
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 24; index += 1) {
    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-card';
    fragment.append(skeleton);
  }
  els.gallery.replaceChildren(fragment);
  els.empty.hidden = true;
}

async function loadFirstPage({ scrollTop = true } = {}) {
  state.requestId += 1;
  const requestId = state.requestId;
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;

  state.loading = true;
  state.loadingMore = false;
  state.loadError = null;
  state.error = null;
  state.items = [];
  state.total = 0;
  state.hasMore = false;

  if (scrollTop) els.main.scrollTo({ top: 0 });
  els.gallery.setAttribute('aria-busy', 'true');
  renderSkeletons();
  updateHeader();
  updateLoadArea();

  try {
    const data = await api(
      `/api/photos?${photoQuery({
        view: state.view,
        album: state.album,
        q: state.q,
        sort: state.sort,
        offset: 0,
        limit: PAGE_SIZE
      })}`,
      { signal: controller.signal }
    );
    if (requestId !== state.requestId) return;

    state.items = Array.isArray(data.items) ? data.items : [];
    state.total = Number(data.total || 0);
    state.hasMore = !!data.hasMore;
    state.loaded = true;
    renderGallery();
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== state.requestId) return;
    state.loaded = true;
    state.items = [];
    state.error = error.message || 'Could not load your photos.';
  } finally {
    if (requestId !== state.requestId) return;
    state.loading = false;
    els.gallery.removeAttribute('aria-busy');
    updateHeader();
    updateEmptyState();
    updateLoadArea();
    scheduleAutoFill();
  }
}

async function loadMore() {
  if (state.loading || state.loadingMore || !state.hasMore) return;

  const requestId = state.requestId;
  const signal = state.controller?.signal;
  state.loadingMore = true;
  state.loadError = null;
  updateLoadArea();

  try {
    const data = await api(
      `/api/photos?${photoQuery({
        view: state.view,
        album: state.album,
        q: state.q,
        sort: state.sort,
        offset: state.items.length,
        limit: PAGE_SIZE
      })}`,
      { signal }
    );
    if (requestId !== state.requestId) return;

    const known = new Set(state.items.map((photo) => photo.id));
    const fresh = (Array.isArray(data.items) ? data.items : []).filter((photo) => !known.has(photo.id));

    state.items.push(...fresh);
    state.total = Number(data.total ?? state.total);
    state.hasMore = fresh.length > 0 && !!data.hasMore;
    appendPhotos(fresh);
    updateHeader();
    updateEmptyState();
  } catch (error) {
    if (error.name === 'AbortError' || requestId !== state.requestId) return;
    state.loadError = error.message || 'Could not load more photos.';
  } finally {
    if (requestId === state.requestId) {
      state.loadingMore = false;
      updateLoadArea();
      scheduleAutoFill();
    }
  }
}

function renderGallery() {
  const fragment = document.createDocumentFragment();
  revealObserver?.disconnect();
  revealIndex = 0;
  for (const photo of state.items) fragment.append(createCard(photo));
  els.gallery.replaceChildren(fragment);
  updateEmptyState();
  updateLoadArea();
}

function appendPhotos(photos) {
  if (!photos.length) return;
  const fragment = document.createDocumentFragment();
  revealIndex = 0;
  for (const photo of photos) fragment.append(createCard(photo));
  els.gallery.append(fragment);
}

/* ------------------------------------------------------------------
   Photo cards
   ------------------------------------------------------------------ */

function fallbackFor(photo) {
  const wrap = document.createElement('div');
  wrap.className = 'card-fallback';
  wrap.innerHTML = icon('image');
  const label = document.createElement('span');
  const match = /\.([a-z0-9]{2,6})$/i.exec(photo.name || '');
  label.textContent = match ? match[1].toUpperCase() : photo.thumbOk === false ? 'No preview' : 'Photo';
  wrap.append(label);
  return wrap;
}

function createCard(photo) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.id = String(photo.id);
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', photo.name || 'Photo');

  const selected = isPhotoSelected(photo.id);
  card.setAttribute('aria-pressed', selected ? 'true' : 'false');
  if (selected) card.classList.add('is-selected');

  const media = document.createElement('div');
  media.className = 'card-media';

  const sources = [photo.previewUrl, photo.originalUrl, photo.thumbUrl].filter(Boolean);
  if (sources.length) {
    const img = document.createElement('img');
    let attempt = 0;
    img.alt = photo.caption || photo.name || '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => img.classList.add('is-loaded'));
    img.addEventListener('error', () => {
      attempt += 1;
      if (attempt < sources.length) img.src = sources[attempt];
      else media.replaceChildren(fallbackFor(photo));
    });
    img.src = sources[0];
    media.append(img);
  } else {
    media.append(fallbackFor(photo));
  }
  card.append(media);

  const check = document.createElement('button');
  check.type = 'button';
  check.className = 'card-check';
  check.tabIndex = -1;
  check.innerHTML = icon('check');
  check.setAttribute('aria-label', selected ? 'Deselect photo' : 'Select photo');
  card.append(check);

  if (state.view !== 'trash') {
    const fav = document.createElement('button');
    fav.type = 'button';
    fav.className = `card-fav${photo.favorite ? ' is-fav' : ''}`;
    fav.innerHTML = icon(photo.favorite ? 'heart-solid' : 'heart');
    fav.setAttribute('aria-pressed', photo.favorite ? 'true' : 'false');
    fav.setAttribute('aria-label', photo.favorite ? 'Remove from favorites' : 'Add to favorites');
    card.append(fav);
  }

  const caption = document.createElement('div');
  caption.className = 'card-caption';
  const captionText = document.createElement('span');
  captionText.textContent = photo.caption || photo.name || 'Untitled photo';
  caption.append(captionText);
  card.append(caption);

  card.style.setProperty('--reveal-delay', `${Math.min(revealIndex, 14) * 45}ms`);
  revealIndex += 1;
  if (revealObserver) revealObserver.observe(card);
  else card.classList.add('is-revealed');

  return card;
}

function setCardSelected(card, selected) {
  if (!card) return;
  card.classList.toggle('is-selected', selected);
  card.setAttribute('aria-pressed', selected ? 'true' : 'false');
  const check = card.querySelector('.card-check');
  if (check) check.setAttribute('aria-label', selected ? 'Deselect photo' : 'Select photo');
}

function syncCard(photo) {
  const card = els.gallery.querySelector(`.card[data-id="${photo.id}"]`);
  if (!card) return;

  const fav = card.querySelector('.card-fav');
  if (fav) {
    fav.classList.toggle('is-fav', !!photo.favorite);
    fav.innerHTML = icon(photo.favorite ? 'heart-solid' : 'heart');
    fav.setAttribute('aria-pressed', photo.favorite ? 'true' : 'false');
    fav.setAttribute('aria-label', photo.favorite ? 'Remove from favorites' : 'Add to favorites');
  }

  const caption = card.querySelector('.card-caption span');
  if (caption) caption.textContent = photo.caption || photo.name || 'Untitled photo';
}

/* ------------------------------------------------------------------
   Empty state
   ------------------------------------------------------------------ */

function emptyAction(label, action, { primary = false, iconName = '' } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `btn ${primary ? 'primary' : 'ghost'}`;
  button.dataset.emptyAction = action;
  if (iconName) {
    button.innerHTML = `${icon(iconName)}<span></span>`;
    button.querySelector('span').textContent = label;
  } else {
    button.textContent = label;
  }
  return button;
}

function buildEmptyState() {
  const wrap = document.createElement('div');
  wrap.className = 'empty-inner';

  let iconName = 'image';
  let title = 'A home for your photographs';
  let text = 'Add a folder of photos and Gurukul Olympics will keep the originals on this computer while generating fast previews for browsing.';
  let actions = [emptyAction('Add photos', 'upload', { primary: true, iconName: 'upload' })];
  let tip = 'Tip: you can also drop a folder anywhere on this page.';
  let showArt = true;

  if (state.error) {
    iconName = 'alert';
    title = 'Could not load your library';
    text = state.error;
    actions = [emptyAction('Try again', 'retry', { primary: true, iconName: 'refresh' })];
    tip = '';
    showArt = false;
  } else if (state.q) {
    iconName = 'search';
    title = `No matches for “${state.q}”`;
    text = 'Try a different file name, album, caption, or tag.';
    actions = [
      emptyAction('Clear search', 'clear-search', { primary: true }),
      emptyAction('View all photos', 'browse-all')
    ];
    tip = '';
    showArt = false;
  } else if (state.view === 'trash') {
    iconName = 'trash';
    title = 'Trash is empty';
    text = 'Photos you remove from the library wait here until you restore them or delete them permanently.';
    actions = [emptyAction('Back to library', 'browse-all', { primary: true })];
    tip = '';
    showArt = false;
  } else if (state.view === 'favorites') {
    iconName = 'heart';
    title = 'No favorites yet';
    text = 'Tap the heart on any photo to keep the ones you love in one quick place.';
    actions = [
      emptyAction('Browse all photos', 'browse-all', { primary: true }),
      emptyAction('Add photos', 'upload', { iconName: 'upload' })
    ];
    tip = '';
    showArt = false;
  } else if (state.album) {
    iconName = 'folder';
    title = state.album === UNSORTED ? 'No unsorted photos' : `Nothing in “${state.album}” yet`;
    text = 'Open any photo and give it an album name, or add new photos straight into this album.';
    actions = [
      emptyAction('Add photos', 'upload', { primary: true, iconName: 'upload' }),
      emptyAction('View all photos', 'browse-all')
    ];
    tip = '';
    showArt = false;
  }

  if (showArt) {
    const art = document.createElement('div');
    art.className = 'empty-art';
    art.setAttribute('aria-hidden', 'true');
    art.innerHTML =
      '<span class="art-card one"></span><span class="art-card two"></span><span class="art-card three"></span><span class="art-sun"></span>';
    wrap.append(art);
  } else {
    const iconWrap = document.createElement('div');
    iconWrap.className = 'empty-icon';
    iconWrap.innerHTML = icon(iconName);
    wrap.append(iconWrap);
  }

  const heading = document.createElement('h2');
  heading.textContent = title;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  const actionRow = document.createElement('div');
  actionRow.className = 'empty-actions';
  for (const action of actions) actionRow.append(action);

  wrap.append(heading, paragraph, actionRow);

  if (tip) {
    const tipNode = document.createElement('p');
    tipNode.className = 'empty-tip';
    tipNode.innerHTML = 'Tip: you can also drop a folder anywhere on this page, or press <kbd>/</kbd> to search.';
    wrap.append(tipNode);
  }

  els.empty.replaceChildren(wrap);
}

function updateEmptyState() {
  if (state.loading) {
    els.empty.hidden = true;
    return;
  }
  const empty = state.items.length === 0;
  els.empty.hidden = !empty;
  if (empty) buildEmptyState();
}

/* ------------------------------------------------------------------
   Albums and stats
   ------------------------------------------------------------------ */

function colorFor(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return ALBUM_COLORS[hash % ALBUM_COLORS.length];
}

function appendAlbumItem(album, label, count, color) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'album-item';
  button.dataset.album = album;
  button.title = `${label} · ${formatNumber(count)} ${plural(count, 'photo')}`;
  if (state.album === album) button.classList.add('is-active');

  const dot = document.createElement('span');
  dot.className = 'album-dot';
  dot.style.setProperty('--album-color', color);

  const name = document.createElement('span');
  name.className = 'album-name';
  name.textContent = label;

  const counter = document.createElement('span');
  counter.className = 'album-count';
  counter.textContent = formatNumber(count);

  button.append(dot, name, counter);
  els.albumList.append(button);
}

function renderAlbums() {
  els.albumList.replaceChildren();

  const unsorted = Number(state.stats?.unsorted || 0);
  if (unsorted > 0 || state.album === UNSORTED) {
    appendAlbumItem(UNSORTED, 'Unsorted', unsorted, '#8a8f98');
  }

  for (const item of state.albums) {
    appendAlbumItem(item.album, item.album, Number(item.count || 0), colorFor(item.album));
  }

  if (!els.albumList.children.length) {
    const empty = document.createElement('p');
    empty.className = 'album-empty';
    empty.textContent = 'No albums yet';
    els.albumList.append(empty);
  }

  syncNav();
}

function populateAlbumOptions() {
  const values = state.albums.map((item) => item.album);
  if (state.album && state.album !== UNSORTED && !values.includes(state.album)) values.unshift(state.album);
  els.albumOptions.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement('option');
      option.value = value;
      return option;
    })
  );
}

async function loadAlbums() {
  try {
    const data = await api('/api/albums');
    state.albums = Array.isArray(data.albums) ? data.albums : [];
    renderAlbums();
    populateAlbumOptions();
  } catch (error) {
    console.warn('[mosaic] Could not load albums:', error.message);
  }
}

function renderStats() {
  const stats = state.stats;
  if (!stats) return;

  els.countAll.textContent = formatNumber(stats.total);
  els.countFavorites.textContent = formatNumber(stats.favorites);
  els.countTrash.textContent = formatNumber(stats.trashed);

  els.storageUsed.textContent = formatBytes(stats.bytes);

  if (stats.disk && Number.isFinite(stats.disk.total) && stats.disk.total > 0) {
    const percent = clamp((stats.bytes / stats.disk.total) * 100, 0, 100);
    els.storageBar.style.width = `${percent > 0 && percent < 0.4 ? 0.4 : percent}%`;
    els.storageSub.textContent = `${formatBytes(stats.bytes)} of originals · ${formatBytes(stats.disk.free)} free`;
  } else {
    els.storageBar.style.width = '0%';
    els.storageSub.textContent = `${formatNumber(stats.total)} originals kept locally`;
  }

  els.storageSub.title = stats.failedThumbs
    ? `${formatNumber(stats.failedThumbs)} photos have no generated preview`
    : 'Your originals stay local.';

  if (stats.limits?.maxFileBytes) {
    els.uploadLimitNote.textContent = `Up to ${formatBytes(stats.limits.maxFileBytes)} per photo`;
  }

  renderAlbums();
}

async function loadStats() {
  try {
    state.stats = await api('/api/stats');
    renderStats();
  } catch (error) {
    console.warn('[mosaic] Could not load library stats:', error.message);
  }
}

/* ------------------------------------------------------------------
   Navigation and search
   ------------------------------------------------------------------ */

function syncNav() {
  for (const button of els.navButtons) {
    button.classList.toggle('is-active', button.dataset.nav === state.view && !state.album);
  }
  for (const item of $$('.album-item', els.albumList)) {
    item.classList.toggle('is-active', item.dataset.album === state.album);
  }
}

function writeUrl() {
  const params = new URLSearchParams();
  if (state.view !== 'all') params.set('view', state.view);
  if (state.album) params.set('album', state.album);
  if (state.q) params.set('q', state.q);
  if (state.sort !== 'newest') params.set('sort', state.sort);
  const query = params.toString();
  const url = query ? `${location.pathname}?${query}` : location.pathname;
  try {
    history.replaceState(null, '', url);
  } catch {
    // Ignore history failures in restricted contexts.
  }
}

function readStateFromUrl() {
  const params = new URLSearchParams(location.search);
  const view = params.get('view');
  const album = params.get('album');
  const q = params.get('q');
  const sort = params.get('sort');

  state.view = VIEWS.has(view) ? view : 'all';
  state.album = state.view === 'all' && album ? album.slice(0, 120) : null;
  state.q = q ? q.trim().slice(0, 200) : '';
  state.sort = SORTS.has(sort) ? sort : 'newest';

  els.searchInput.value = state.q;
  els.sortSelect.value = state.sort;
}

function applyNavigation(options = {}) {
  const view = options.view ?? state.view;
  const album = options.album !== undefined ? options.album : state.album;
  const q = options.q !== undefined ? options.q : state.q;
  const sort = options.sort !== undefined ? options.sort : state.sort;

  state.view = VIEWS.has(view) ? view : 'all';
  state.album = state.view === 'all' && album ? album : null;
  state.q = String(q || '').trim().slice(0, 200);
  if (SORTS.has(sort)) state.sort = sort;

  if (els.searchInput.value !== state.q) els.searchInput.value = state.q;
  els.sortSelect.value = state.sort;

  debouncedSearch.cancel();
  setSelectMode(false);
  syncNav();
  writeUrl();
  closeSidebar();
  loadFirstPage({ scrollTop: options.scrollTop !== false });
}

function applySearchValue(value) {
  const q = String(value || '').trim().slice(0, 200);
  if (q === state.q) return;
  applyNavigation({ q });
}

/* ------------------------------------------------------------------
   Selection and bulk actions
   ------------------------------------------------------------------ */

function selectionCount() {
  return state.selectAllMatching ? state.total : state.selected.size;
}

function isPhotoSelected(id) {
  return state.selectAllMatching || state.selected.has(Number(id));
}

function setCardSelectionForId(id, selected) {
  const card = els.gallery.querySelector(`.card[data-id="${id}"]`);
  setCardSelected(card, selected);
}

function updateBulkBar() {
  const count = selectionCount();
  const visible = count > 0;
  els.bulkBar.hidden = !visible;
  if (!visible) return;

  const trash = state.view === 'trash';
  els.bulkCount.textContent = `${formatNumber(count)} selected`;
  els.bulkFavoriteBtn.hidden = trash;
  els.bulkAlbumBtn.hidden = trash;
  els.bulkRestoreBtn.hidden = !trash;
  els.bulkDeleteLabel.textContent = trash ? 'Delete forever' : 'Trash';
  els.bulkFavoriteLabel.textContent = selectionAllFavorite() ? 'Unfavorite' : 'Favorite';

  const everything =
    state.selectAllMatching ||
    (state.total > 0 && state.selected.size >= state.total && state.selected.size > 0);
  els.bulkSelectAll.textContent = everything ? 'Clear all' : 'Select all';
}

function selectionAllFavorite() {
  if (state.selectAllMatching) return state.view === 'favorites';
  let any = false;
  for (const photo of state.items) {
    if (!state.selected.has(photo.id)) continue;
    any = true;
    if (!photo.favorite) return false;
  }
  return any;
}

function clearSelection() {
  state.selected.clear();
  state.selectAllMatching = false;
  for (const card of $$('.card.is-selected', els.gallery)) setCardSelected(card, false);
  updateBulkBar();
}

function setSelectMode(enabled) {
  state.selectMode = !!enabled;
  els.app.classList.toggle('select-mode', state.selectMode);
  els.selectBtn.setAttribute('aria-pressed', state.selectMode ? 'true' : 'false');
  els.selectBtn.textContent = state.selectMode ? 'Done' : 'Select';
  if (!state.selectMode) clearSelection();
}

function toggleSelected(id) {
  if (state.selectAllMatching) {
    state.selected = new Set(state.items.map((photo) => photo.id));
    state.selectAllMatching = false;
  }

  const numericId = Number(id);
  const next = !state.selected.has(numericId);
  if (next) state.selected.add(numericId);
  else state.selected.delete(numericId);

  if (!state.selectMode) setSelectMode(true);
  setCardSelectionForId(numericId, next);
  updateBulkBar();
}

function selectAllInView() {
  if (selectionCount() > 0) {
    const everything =
      state.selectAllMatching ||
      (state.total > 0 && state.selected.size >= state.total && state.selected.size > 0);
    if (everything) {
      clearSelection();
      return;
    }
  }

  if (!state.selectMode) setSelectMode(true);
  state.selected = new Set(state.items.map((photo) => photo.id));
  state.selectAllMatching = state.items.length < state.total;
  for (const card of $$('.card', els.gallery)) setCardSelected(card, true);
  updateBulkBar();
  announce(`Selected ${formatNumber(selectionCount())} photos`);
}

function removeItemsLocally(ids) {
  const idSet = new Set(ids.map(Number));
  const before = state.items.length;
  state.items = state.items.filter((photo) => !idSet.has(photo.id));
  const removed = before - state.items.length;
  state.total = Math.max(0, state.total - removed);

  for (const id of idSet) {
    state.selected.delete(id);
    const card = els.gallery.querySelector(`.card[data-id="${id}"]`);
    card?.remove();
  }

  updateHeader();
  updateLoadArea();
  updateEmptyState();
  updateBulkBar();
}

function applyBulkLocally(action, ids, album) {
  const idSet = new Set(ids.map(Number));

  if (action === 'favorite' || action === 'unfavorite') {
    const favorite = action === 'favorite';
    for (const photo of state.items) {
      if (!idSet.has(photo.id)) continue;
      photo.favorite = favorite;
      syncCard(photo);
    }
    if (!favorite && state.view === 'favorites') {
      removeItemsLocally(ids);
    } else {
      updateHeader();
      updateLoadArea();
      updateEmptyState();
    }
    return;
  }

  if (action === 'album') {
    const target = String(album || '');
    const remove = [];
    for (const photo of state.items) {
      if (!idSet.has(photo.id)) continue;
      photo.album = target;
      syncCard(photo);
      if (state.album) {
        const wanted = state.album === UNSORTED ? '' : state.album;
        if (target !== wanted) remove.push(photo.id);
      }
    }
    if (remove.length) removeItemsLocally(remove);
    else {
      updateHeader();
      updateLoadArea();
      updateEmptyState();
    }
    return;
  }

  let remove = null;
  if (action === 'delete' && state.view !== 'trash') remove = ids;
  else if (action === 'restore' && state.view === 'trash') remove = ids;
  else if (action === 'destroy') remove = ids;

  if (remove) removeItemsLocally(remove);
  else {
    updateHeader();
    updateLoadArea();
    updateEmptyState();
  }
}

async function performBulk(action, extra = {}) {
  const count = selectionCount();
  if (!count) return null;

  const allMatching = state.selectAllMatching;
  const payload = { action, filter: currentFilter(), ...extra };
  if (allMatching) payload.all = true;
  else payload.ids = [...state.selected];

  try {
    const data = await api('/api/photos/bulk', { method: 'POST', body: payload });
    const affected = Number(data?.count || 0);

    setSelectMode(false);
    if (allMatching) {
      await Promise.allSettled([loadStats(), loadAlbums()]);
      await loadFirstPage({ scrollTop: false });
    } else {
      applyBulkLocally(action, payload.ids, extra.album);
      loadStats();
      loadAlbums();
    }
    return affected;
  } catch (error) {
    toast(error.message || 'Could not update those photos.', { type: 'error' });
    return null;
  }
}

function bulkScopeNote(count) {
  return state.selectAllMatching
    ? ` This applies to all ${formatNumber(count)} photos that match the current view.`
    : '';
}

async function bulkFavorite() {
  const action = selectionAllFavorite() ? 'unfavorite' : 'favorite';
  const affected = await performBulk(action);
  if (affected === null) return;
  if (!affected) {
    toast('No photos were changed.', { type: 'info' });
    return;
  }
  toast(
    `${formatNumber(affected)} ${plural(affected, 'photo')} ${action === 'favorite' ? 'added to favorites' : 'removed from favorites'}`,
    { type: 'success' }
  );
}

async function bulkAlbum() {
  const count = selectionCount();
  let current = '';
  if (state.selectAllMatching) {
    current = state.album && state.album !== UNSORTED ? state.album : '';
  } else {
    let first = true;
    for (const photo of state.items) {
      if (!state.selected.has(photo.id)) continue;
      if (first) {
        current = photo.album || '';
        first = false;
      } else if (current !== (photo.album || '')) {
        current = '';
        break;
      }
    }
  }

  const choice = await albumPicker({
    title: `Add ${formatNumber(count)} ${plural(count, 'photo')} to an album`,
    current,
    albums: state.albums.map((item) => item.album),
    confirmLabel: 'Apply album'
  });
  if (choice === null) return;

  const affected = await performBulk('album', { album: choice });
  if (affected === null) return;
  if (!affected) {
    toast('No photos were changed.', { type: 'info' });
    return;
  }
  toast(
    choice
      ? `${formatNumber(affected)} ${plural(affected, 'photo')} added to “${choice}”`
      : `${formatNumber(affected)} ${plural(affected, 'photo')} removed from their album`,
    { type: 'success' }
  );
}

async function bulkDelete() {
  const count = selectionCount();
  const permanent = state.view === 'trash';
  const scope = bulkScopeNote(count);

  const sure = await confirmDialog(
    permanent
      ? {
          title: count === 1 ? 'Delete this photo forever?' : 'Delete these photos forever?',
          message:
            count === 1
              ? `The original file will be removed from this computer. This cannot be undone.${scope}`
              : `${formatNumber(count)} photos will be removed from this computer forever. This cannot be undone.${scope}`,
          confirmLabel: 'Delete forever',
          danger: true
        }
      : {
          title: count === 1 ? 'Move this photo to Trash?' : 'Move these photos to Trash?',
          message:
            count === 1
              ? `You can restore it from Trash later.${scope}`
              : `${formatNumber(count)} photos will leave the library and wait in Trash. You can restore them later.${scope}`,
          confirmLabel: 'Move to Trash',
          danger: false
        }
  );
  if (!sure) return;

  const affected = await performBulk(permanent ? 'destroy' : 'delete');
  if (affected === null) return;
  if (!affected) {
    toast('No photos were changed.', { type: 'info' });
    return;
  }
  toast(
    permanent
      ? `${formatNumber(affected)} ${plural(affected, 'photo')} deleted permanently`
      : `${formatNumber(affected)} ${plural(affected, 'photo')} moved to Trash`,
    { type: 'success' }
  );
}

async function bulkRestore() {
  const affected = await performBulk('restore');
  if (affected === null) return;
  if (!affected) {
    toast('No photos were changed.', { type: 'info' });
    return;
  }
  toast(`${formatNumber(affected)} ${plural(affected, 'photo')} restored`, { type: 'success' });
}

async function togglePhotoFavorite(photo) {
  if (!photo || state.view === 'trash' || state.role === 'participant') return;

  const next = !photo.favorite;
  photo.favorite = next;
  syncCard(photo);

  try {
    const data = await api(`/api/photos/${photo.id}`, { method: 'PATCH', body: { favorite: next } });
    if (data?.photo) {
      Object.assign(photo, data.photo);
      syncCard(photo);
    }

    if (state.view === 'favorites' && !photo.favorite) {
      removeItemsLocally([photo.id]);
      loadStats();
      loadAlbums();
    }

    announce(photo.favorite ? 'Added to favorites' : 'Removed from favorites');
  } catch (error) {
    photo.favorite = !next;
    syncCard(photo);
    toast(error.message || 'Could not update favorite.', { type: 'error' });
  }
}

/* ------------------------------------------------------------------
   Lightbox integration
   ------------------------------------------------------------------ */

function openPhoto(id) {
  lightbox.open(id, {
    getItems: () => state.items,
    getTotal: () => state.total,
    hasMore: () => state.hasMore,
    requestMore: () => loadMore(),
    view: state.view
  });
}

function handleLightboxUpdated(photo, meta = {}) {
  const item = photoById(photo.id);
  if (item) Object.assign(item, photo);
  syncCard(item || photo);

  if (state.view === 'favorites' && !photo.favorite) {
    state.needsRefreshOnClose = true;
  }

  if (state.album && meta.albumChanged) {
    const wanted = state.album === UNSORTED ? '' : state.album;
    if ((photo.album || '') !== wanted) state.needsRefreshOnClose = true;
  }
}

function handleLightboxRemoved(photo) {
  removeItemsLocally([photo.id]);
  loadStats();
  loadAlbums();
}

function handleLightboxRestored(photo) {
  removeItemsLocally([photo.id]);
  loadStats();
  loadAlbums();
}

function handleLightboxClosed() {
  if (!state.needsRefreshOnClose) return;
  state.needsRefreshOnClose = false;
  loadFirstPage({ scrollTop: false });
  loadStats();
  loadAlbums();
}

/* ------------------------------------------------------------------
   New photos banner
   ------------------------------------------------------------------ */

function showNewBanner() {
  if (!state.newCount) return;
  const count = state.newCount;
  els.newCount.textContent = `${formatNumber(count)} new ${plural(count, 'photo')}`;

  const paragraph = els.newCount.parentElement;
  if (paragraph) {
    for (const node of [...paragraph.childNodes]) {
      if (node.nodeType === Node.TEXT_NODE) node.remove();
    }
    paragraph.append(document.createTextNode(count === 1 ? ' is ready' : ' are ready'));
  }

  els.newRefresh.textContent = count === 1 ? 'Show it' : 'Show them';
  els.newBanner.hidden = false;
}

function hideNewBanner() {
  state.newCount = 0;
  els.newBanner.hidden = true;
}

function showNewPhotos() {
  hideNewBanner();
  applyNavigation({ view: 'all', album: null, q: '', sort: 'uploaded' });
  loadStats();
}

/* ------------------------------------------------------------------
   Uploads
   ------------------------------------------------------------------ */

function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

function looksLikePhoto(file) {
  if (!file || !file.size) return false;
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name || '')) return false;
  return (file.type || '').startsWith('image/') || PHOTO_EXT.test(file.name || '');
}

function tagRelativePath(file, path) {
  try {
    Object.defineProperty(file, '__relativePath', { value: path, configurable: true });
  } catch {
    try {
      file.__relativePath = path;
    } catch {
      // Ignore read-only File objects.
    }
  }
  return file;
}

function readEntry(entry) {
  return new Promise((resolve) => {
    if (!entry) {
      resolve([]);
      return;
    }

    if (entry.isFile) {
      entry.file(
        (file) => {
          tagRelativePath(file, String(entry.fullPath || entry.name || '').replace(/^\//, ''));
          resolve([file]);
        },
        () => resolve([])
      );
      return;
    }

    if (entry.isDirectory) {
      const reader = entry.createReader();
      const entries = [];

      const readBatch = () => {
        reader.readEntries(
          async (batch) => {
            if (!batch.length) {
              const nested = await Promise.all(entries.map(readEntry));
              resolve(nested.flat());
              return;
            }
            entries.push(...batch);
            readBatch();
          },
          () => resolve([])
        );
      };

      readBatch();
      return;
    }

    resolve([]);
  });
}

function setScanning(delta) {
  state.pendingScan = Math.max(0, state.pendingScan + delta);
  renderPendingSelection();
}

function renderPendingSelection() {
  const count = state.pendingFiles.length;
  const totalBytes = state.pendingFiles.reduce((sum, file) => sum + file.size, 0);

  els.uploadSelection.hidden = count === 0;
  els.uploadSelectionCount.textContent = `${formatNumber(count)} ${plural(count, 'photo')}`;
  els.uploadSelectionSize.textContent = formatBytes(totalBytes);
  els.uploadScanning.hidden = state.pendingScan === 0;
  els.uploadStart.disabled = count === 0 || state.pendingScan > 0;
  els.uploadStart.textContent = count
    ? `Add ${formatNumber(count)} ${plural(count, 'photo')}`
    : 'Add photos';
}

function addPendingFiles(files, token = state.dropToken) {
  if (token !== state.dropToken) return 0;

  const keys = new Set(state.pendingFiles.map(fileKey));
  let rejected = 0;
  let duplicates = 0;
  let added = 0;

  for (const file of files) {
    if (!looksLikePhoto(file)) {
      rejected += 1;
      continue;
    }
    const key = fileKey(file);
    if (keys.has(key)) {
      duplicates += 1;
      continue;
    }
    keys.add(key);
    state.pendingFiles.push(file);
    added += 1;
  }

  renderPendingSelection();

  if (rejected) {
    toast(`${formatNumber(rejected)} ${plural(rejected, 'file')} skipped — not a supported photo.`, {
      type: 'info'
    });
  }
  if (duplicates) {
    toast(`${formatNumber(duplicates)} already in the selection.`, { type: 'info' });
  }

  return added;
}

function resetUploadSelection() {
  state.dropToken += 1;
  state.pendingFiles = [];
  state.pendingScan = 0;
  els.dropzone.classList.remove('is-dragging');
  renderPendingSelection();
}

function openUploadDialog({ album = '' } = {}) {
  if (state.role === 'participant') {
    toast('Participants can only view the library.', { type: 'error' });
    return;
  }
  if (album) els.uploadAlbum.value = album.slice(0, 120);

  if (els.uploadDialog.open) {
    els.dropzone.focus();
    return;
  }

  if (lightbox.isOpen) lightbox.close();
  closeSidebar();
  resetDragState();

  state.dropToken += 1;
  state.pendingFiles = [];
  state.pendingScan = 0;

  els.uploadDialog.showModal();
  renderPendingSelection();
  setTimeout(() => els.dropzone.focus(), 40);
}

function closeUploadDialog() {
  if (els.uploadDialog.open) els.uploadDialog.close();
  resetUploadSelection();
}

function startUpload(event) {
  event.preventDefault();
  if (!state.pendingFiles.length || state.pendingScan > 0) return;

  const files = state.pendingFiles.slice();
  const album = els.uploadAlbum.value.trim().slice(0, 120);
  closeUploadDialog();

  const result = uploader.addFiles(files, album);
  if (result.rejected) {
    toast(`${formatNumber(result.rejected)} ${plural(result.rejected, 'file')} skipped — not a supported photo.`, {
      type: 'info'
    });
  }
  if (result.duplicate) {
    toast(`${formatNumber(result.duplicate)} already uploaded or queued.`, { type: 'info' });
  }
  if (!result.added) return;

  openQueue();
  uploader.start();
  announce(`Uploading ${formatNumber(result.added)} ${plural(result.added, 'photo')}`);
}

async function receiveDataTransfer(dataTransfer) {
  const entries = [];
  const files = [];
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];

  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
    if (entry) {
      entries.push(entry);
    } else {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }

  if (!entries.length && !files.length) {
    files.push(...Array.from(dataTransfer.files || []));
  }

  const token = state.dropToken;

  if (!entries.length) {
    addPendingFiles(files, token);
    return;
  }

  setScanning(1);
  try {
    const nested = await Promise.all(entries.map(readEntry));
    if (token === state.dropToken) addPendingFiles([...files, ...nested.flat()], token);
  } finally {
    setScanning(-1);
  }
}

async function handleDroppedDataTransfer(dataTransfer) {
  if (!dataTransfer || state.role === 'participant') return;
  if (!els.uploadDialog.open) openUploadDialog();
  try {
    await receiveDataTransfer(dataTransfer);
  } catch (error) {
    toast(error.message || 'Could not read those files.', { type: 'error' });
  }
}

function hasFileDrag(event) {
  const transfer = event.dataTransfer;
  if (!transfer) return false;
  if (transfer.files && transfer.files.length > 0) return true;
  return Array.from(transfer.types || []).includes('Files');
}

function resetDragState() {
  state.dragDepth = 0;
  els.dropOverlay.hidden = true;
  els.dropzone.classList.remove('is-dragging');
}

function handleUploadUpdate(stats) {
  lastQueueStats = stats;
  renderQueue(stats);
}

function handleBatchComplete({ items }) {
  for (const item of items) {
    if (item.accounted) continue;
    if (item.status === 'done') {
      item.accounted = true;
      if (item.recovered) {
        state.session.duplicates += 1;
      } else {
        state.session.added += 1;
        state.newCount += 1;
      }
    } else if (item.status === 'duplicate') {
      item.accounted = true;
      state.session.duplicates += 1;
    }
  }

  if (state.session.added > 0) showNewBanner();
}

function handleUploadIdle(stats) {
  loadStats();
  loadAlbums();

  if (
    !state.items.length &&
    !state.loading &&
    !state.album &&
    !state.q &&
    state.view === 'all' &&
    state.session.added > 0
  ) {
    hideNewBanner();
    loadFirstPage({ scrollTop: false });
  }

  const added = state.session.added;
  const duplicates = state.session.duplicates;
  state.session = { added: 0, duplicates: 0 };

  const failed = Number(stats.error || 0);
  const parts = [];
  if (added) parts.push(`${formatNumber(added)} ${plural(added, 'photo')} added`);
  if (duplicates) parts.push(`${formatNumber(duplicates)} already in library`);
  if (failed) parts.push(`${formatNumber(failed)} failed`);

  if (!parts.length) return;

  toast(parts.join(' · '), {
    type: failed ? 'error' : 'success',
    actionLabel: failed ? 'Review' : '',
    onAction: failed ? () => openQueue() : null,
    duration: failed ? 8000 : 4200
  });
}

function openQueue() {
  state.queueOpen = true;
  state.queueMinimized = false;
  renderQueue(lastQueueStats || uploader.getStats());
}

function closeQueue() {
  state.queueOpen = false;
  renderQueue(lastQueueStats || uploader.getStats());
}

function toggleUploadPause() {
  if (uploader.paused) uploader.resume();
  else uploader.pause();
}

function retryFailedUploads() {
  const retried = uploader.retryFailed();
  if (!retried) return;
  openQueue();
}

function clearUploads() {
  if (!uploader.clearFinished()) return;
  if (!uploader.items.length) closeQueue();
  else renderQueue(uploader.getStats());
}

function queueStatChip(label, value, className = '') {
  const chip = document.createElement('span');
  chip.className = `queue-stat${className ? ` ${className}` : ''}`;
  const strong = document.createElement('strong');
  strong.textContent = formatNumber(value);
  chip.append(strong, document.createTextNode(label));
  return chip;
}

function queueRowStatus(item) {
  if (item.status === 'error') return item.error || 'Upload failed';
  if (item.status === 'duplicate') return item.error || 'Already in library';
  if (item.status === 'done') return 'Added';
  if (item.status === 'processing') return 'Making previews…';
  if (item.status === 'uploading') return 'Uploading…';
  return uploader.paused ? 'Paused' : 'Waiting';
}

function renderQueueList(stats) {
  const items = uploader.items;
  const signature = [
    stats.total,
    stats.queued,
    stats.uploading,
    stats.processing,
    stats.done,
    stats.duplicate,
    stats.error,
    stats.paused ? 1 : 0
  ].join('|');

  if (signature === lastQueueListSignature) return;
  lastQueueListSignature = signature;

  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'queue-empty';
    empty.textContent = 'Chosen photos will appear here.';
    els.queueList.replaceChildren(empty);
    return;
  }

  const active = [];
  const queued = [];
  const failed = [];
  const finished = [];

  for (const item of items) {
    if (item.status === 'uploading' || item.status === 'processing') active.push(item);
    else if (item.status === 'queued') queued.push(item);
    else if (item.status === 'error') failed.push(item);
    else if (item.status === 'done' || item.status === 'duplicate') finished.push(item);
  }

  const shown = [
    ...active,
    ...queued.slice(0, 8),
    ...failed.slice(-6),
    ...finished.slice(-24)
  ].slice(0, 48);

  const fragment = document.createDocumentFragment();
  for (const item of shown) {
    const row = document.createElement('div');
    row.className = 'queue-item';
    if (item.status === 'error') row.classList.add('is-error');
    if (item.status === 'duplicate') row.classList.add('is-duplicate');

    const badge = document.createElement('span');
    badge.className = 'queue-item-icon';
    badge.textContent = uploader.uploadLabel(item);

    const main = document.createElement('div');
    main.className = 'queue-item-main';

    const name = document.createElement('div');
    name.className = 'queue-item-name';
    name.textContent = item.name;

    const sub = document.createElement('div');
    sub.className = 'queue-item-sub';
    const status = queueRowStatus(item);
    sub.textContent =
      item.status === 'error' || item.status === 'duplicate'
        ? status
        : `${status} · ${formatBytes(item.size)}`;

    main.append(name, sub);

    const statusWrap = document.createElement('span');
    statusWrap.className = 'queue-item-status';
    if (item.status === 'uploading' || item.status === 'processing') {
      const spinner = document.createElement('span');
      spinner.className = 'spinner';
      statusWrap.append(spinner);
    } else if (item.status === 'done' || item.status === 'duplicate') {
      statusWrap.innerHTML = icon('check');
    } else if (item.status === 'error') {
      statusWrap.innerHTML = icon('alert');
      const iconNode = statusWrap.querySelector('.icon');
      if (iconNode) iconNode.style.color = 'var(--danger)';
    }

    row.title = item.status === 'error' ? item.error || item.name : item.name;
    row.append(badge, main, statusWrap);
    fragment.append(row);
  }

  const scrollTop = els.queueList.scrollTop;
  els.queueList.replaceChildren(fragment);
  els.queueList.scrollTop = scrollTop;
}

function renderQueue(stats) {
  if (!stats) stats = lastQueueStats || uploader.getStats();
  lastQueueStats = stats;

  const busy = !!stats.busy;
  els.queue.hidden = !state.queueOpen;
  els.queue.classList.toggle('minimized', state.queueMinimized);
  els.queue.classList.toggle('is-idle', !busy && stats.total > 0 && !stats.error);
  els.queue.classList.toggle('is-error', !busy && stats.error > 0);

  els.uploadIndicator.hidden = state.queueOpen || !busy;
  els.uploadIndicatorLabel.textContent = stats.paused ? 'Paused' : 'Uploading';
  els.uploadIndicatorPercent.textContent = `${Math.round(clamp(stats.percent, 0, 100))}%`;

  if (busy) {
    els.queueTitle.textContent = stats.paused
      ? 'Uploads paused'
      : `Uploading ${formatNumber(stats.total)} ${plural(stats.total, 'photo')}`;
    let subtitle = `${formatNumber(stats.finished)} of ${formatNumber(stats.total)} done`;
    if (stats.paused) subtitle += ' · paused';
    else if (stats.eta) subtitle += ` · ${formatDuration(stats.eta)} left`;
    els.queueSubtitle.textContent = subtitle;
  } else if (stats.total) {
    els.queueTitle.textContent = stats.error ? 'Some uploads need attention' : 'Uploads complete';
    const parts = [];
    if (stats.done) parts.push(`${formatNumber(stats.done)} added`);
    if (stats.duplicate) parts.push(`${formatNumber(stats.duplicate)} already here`);
    if (stats.error) parts.push(`${formatNumber(stats.error)} failed`);
    els.queueSubtitle.textContent = parts.join(' · ');
  } else {
    els.queueTitle.textContent = 'Uploads';
    els.queueSubtitle.textContent = 'No uploads yet';
  }

  els.queueBar.style.width = `${clamp(stats.percent, 0, 100)}%`;

  const chips = [];
  if (stats.queued) chips.push(queueStatChip('waiting', stats.queued));
  const active = stats.uploading + stats.processing;
  if (active) chips.push(queueStatChip('uploading', active));
  if (stats.done) chips.push(queueStatChip('added', stats.done, 'is-done'));
  if (stats.duplicate) chips.push(queueStatChip('already here', stats.duplicate));
  if (stats.error) chips.push(queueStatChip('failed', stats.error, 'is-error'));
  els.queueStats.replaceChildren(...chips);

  els.queuePause.hidden = !busy;
  els.queuePause.textContent = stats.paused ? 'Resume' : 'Pause';
  els.queueRetry.hidden = !stats.error;
  els.queueRetry.textContent = stats.error ? `Retry failed (${formatNumber(stats.error)})` : 'Retry failed';
  els.queueClear.hidden = busy || stats.done + stats.duplicate + stats.error === 0;
  els.queueMinimize.setAttribute('aria-label', state.queueMinimized ? 'Expand uploads' : 'Minimize uploads');

  renderQueueList(stats);
}

/* ------------------------------------------------------------------
   Sidebar, theme and global events
   ------------------------------------------------------------------ */

function openSidebar() {
  els.app.classList.add('sidebar-open');
  els.sidebarScrim.hidden = false;
}

function closeSidebar() {
  els.app.classList.remove('sidebar-open');
  els.sidebarScrim.hidden = true;
}

function applyTheme(theme) {
  const dark = theme !== 'light';
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const use = els.themeIcon.querySelector('use');
  const iconName = dark ? 'sun' : 'moon';
  if (use) use.setAttribute('href', `#i-${iconName}`);
  else els.themeIcon.innerHTML = `<use href="#i-${iconName}"></use>`;
  els.themeLabel.textContent = dark ? 'Light mode' : 'Dark mode';
  els.themeToggle.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0b0c0e' : '#f6f3ec');
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  try {
    localStorage.setItem('mosaic-theme', next);
  } catch {
    // Storage can be unavailable in private or restricted contexts.
  }
  applyTheme(next);
}

/* ------------------------------------------------------------------
   Google Drive
   ------------------------------------------------------------------ */

function formatDriveInterval(seconds) {
  const value = Number(seconds) || DEFAULT_DRIVE_INTERVAL_SECONDS;
  if (value < 60) return `${value} sec`;
  if (value < 3600) return `${Math.round(value / 60)} min`;
  return `${Math.round(value / 3600)} hr`;
}

function renderDriveStatus(status) {
  const previous = state.drive;
  state.drive = status;

  if (
    previous &&
    status.lastSync &&
    previous.lastSync !== status.lastSync &&
    Number(status.lastResult?.added || 0) > 0
  ) {
    state.newCount += Number(status.lastResult.added);
    showNewBanner();
    loadStats();
    loadAlbums();
  }

  state.driveKnownLastSync = status.lastSync || null;

  const connected = !!status.connected;
  els.driveConnect.hidden = connected;
  els.driveManage.hidden = !connected;
  els.driveCardBody.hidden = !connected;

  if (!connected) {
    els.driveStatus.textContent = status.configured ? 'Not connected' : 'Add Google credentials to connect';
    return;
  }
  if (!status.configured) {
    els.driveStatus.textContent = 'Paused — add Google credentials';
    return;
  }
  if (!status.folder) {
    els.driveStatus.textContent = 'Connected — choose a folder';
    els.driveFolderLine.textContent = 'No folder chosen yet';
    els.driveFolderLine.title = '';
    els.driveLastLine.textContent = 'Pick a Drive folder to start importing.';
    els.driveSync.hidden = true;
    els.driveChange.textContent = 'Choose folder';
    return;
  }

  els.driveSync.hidden = false;
  els.driveSync.disabled = !!status.importing;
  els.driveChange.textContent = 'Change folder';
  els.driveFolderLine.textContent = `Folder: ${status.folder.name}`;
  els.driveFolderLine.title = status.folder.name;
  els.driveStatus.textContent = status.enabled
    ? `Watching every ${formatDriveInterval(status.intervalSeconds)}${status.importing ? ' · syncing…' : ''}`
    : 'Connected, watching paused';

  const last = status.lastResult;
  if (last?.at) {
    const parts = [];
    if (last.added) parts.push(`${formatNumber(last.added)} added`);
    if (last.duplicates) parts.push(`${formatNumber(last.duplicates)} duplicates`);
    if (last.failed) parts.push(`${formatNumber(last.failed)} failed`);
    els.driveLastLine.textContent = `Last sync ${formatDateTime(last.at)}${parts.length ? ` · ${parts.join(', ')}` : ''}`;
  } else {
    els.driveLastLine.textContent = 'Waiting for the first sync';
  }
}

async function loadDriveStatus({ silent = false } = {}) {
  try {
    renderDriveStatus(await api('/api/drive/status'));
  } catch (error) {
    if (!silent) els.driveStatus.textContent = 'Status unavailable';
  }
}

function stopDriveAuthWatch() {
  if (state.driveAuthTimer) clearInterval(state.driveAuthTimer);
  if (state.driveAuthTimeout) clearTimeout(state.driveAuthTimeout);
  state.driveAuthTimer = null;
  state.driveAuthTimeout = null;
}

function startDriveAuthWatch() {
  stopDriveAuthWatch();
  state.driveAuthTimer = setInterval(async () => {
    try {
      const status = await api('/api/drive/status');
      if (status.connected) {
        stopDriveAuthWatch();
        state.drivePopup = null;
        renderDriveStatus(status);
        toast('Google Drive connected', { type: 'success' });
        autoConfigureDefaultDrive();
      } else if (state.drivePopup?.closed) {
        stopDriveAuthWatch();
      }
    } catch {
      // Keep waiting; the server may still be exchanging the code.
    }
  }, 1800);

  state.driveAuthTimeout = setTimeout(stopDriveAuthWatch, 5 * 60 * 1000);
}

function connectDrive() {
  if (state.role === 'participant') return;
  if (state.drive && state.drive.configured === false) {
    toast('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then restart Gurukul Olympics.', {
      type: 'error',
      duration: 7000
    });
    return;
  }

  const popup = window.open('', 'mosaic-drive', 'width=820,height=880');
  if (!popup || popup.closed) {
    toast('Allow pop-ups to connect Google Drive.', { type: 'error' });
    return;
  }

  state.drivePopup = popup;

  api('/api/drive/auth')
    .then((data) => {
      if (!data?.url) throw new Error('Google sign-in is not available.');
      popup.location.href = data.url;
      startDriveAuthWatch();
    })
    .catch((error) => {
      popup.close();
      state.drivePopup = null;
      toast(
        error.message || 'Could not start Google sign-in. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
        { type: 'error', duration: 7000 }
      );
    });
}

async function autoConfigureDefaultDrive() {
  if (state.role !== 'admin' || state.driveAutoConfiguring) return;
  if (!state.drive?.connected || state.drive.folder) return;

  state.driveAutoConfiguring = true;
  try {
    const data = await api(`/api/drive/folders?q=${encodeURIComponent(DEFAULT_DRIVE_FOLDER)}`);
    const folders = Array.isArray(data.folders) ? data.folders : [];
    const folder =
      folders.find((item) => item.name.toLowerCase() === DEFAULT_DRIVE_FOLDER.toLowerCase()) || folders[0];

    if (!folder) {
      toast(`Drive folder “${DEFAULT_DRIVE_FOLDER}” was not found — choose a folder manually.`, {
        type: 'info',
        duration: 7000
      });
      openDriveDialog();
      return;
    }

    const result = await api('/api/drive/config', {
      method: 'POST',
      body: {
        folderId: folder.id,
        folderName: folder.name,
        album: DEFAULT_DRIVE_FOLDER,
        intervalSeconds: DEFAULT_DRIVE_INTERVAL_SECONDS,
        includeSubfolders: true,
        importExisting: true,
        enabled: true
      }
    });

    renderDriveStatus(result.status);
    toast(`Watching “${folder.name}” every ${DEFAULT_DRIVE_INTERVAL_SECONDS} sec`, { type: 'success' });
    loadStats();
    loadAlbums();
  } catch (error) {
    toast(error.message || 'Could not configure the default Drive folder.', { type: 'error' });
    openDriveDialog();
  } finally {
    state.driveAutoConfiguring = false;
  }
}

function handleDriveMessage(event) {
  if (event.origin !== location.origin) return;
  if (event.data?.type !== 'mosaic-drive-oauth') return;

  stopDriveAuthWatch();
  state.drivePopup = null;

  if (event.data.connected) {
    toast('Google Drive connected', { type: 'success' });
    loadDriveStatus().then(() => autoConfigureDefaultDrive());
  } else if (event.data.error) {
    toast(event.data.error, { type: 'error', duration: 7000 });
  }
}

function renderDriveFolders() {
  const previous = els.driveFolderSelect.value;
  const preferred = previous || state.drive?.folder?.id || '';
  const options = state.driveFolders.map((folder) => {
    const option = document.createElement('option');
    option.value = folder.id;
    option.textContent = folder.name;
    return option;
  });

  if (!options.length) {
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = 'No folders found';
    options.push(empty);
  }

  els.driveFolderSelect.replaceChildren(...options);
  if (preferred && state.driveFolders.some((folder) => folder.id === preferred)) {
    els.driveFolderSelect.value = preferred;
  }
}

async function loadDriveFolders(query = '') {
  try {
    const data = await api(`/api/drive/folders?q=${encodeURIComponent(query)}`);
    state.driveFolders = Array.isArray(data.folders) ? data.folders : [];
    renderDriveFolders();
  } catch (error) {
    state.driveFolders = [];
    const option = document.createElement('option');
    option.value = '';
    option.textContent = error.message || 'Could not load folders';
    els.driveFolderSelect.replaceChildren(option);
  }
}

async function openDriveDialog() {
  if (!state.drive?.connected) {
    toast('Connect Google Drive first.', { type: 'error' });
    return;
  }

  const config = state.drive;
  els.driveAlbum.value = config.album || '';
  delete els.driveAlbum.dataset.auto;
  els.driveSubfolders.checked = config.includeSubfolders !== false;
  els.driveExisting.checked = config.importExisting !== false;

  const seconds = String(config.intervalSeconds || DEFAULT_DRIVE_INTERVAL_SECONDS);
  if (![...els.driveInterval.options].some((option) => option.value === seconds)) {
    const custom = document.createElement('option');
    custom.value = seconds;
    custom.textContent = formatDriveInterval(Number(seconds));
    els.driveInterval.append(custom);
  }
  els.driveInterval.value = seconds;

  els.driveDialog.showModal();
  await loadDriveFolders(els.driveFolderSearch.value.trim());
  setTimeout(() => els.driveFolderSearch.focus(), 40);
}

async function submitDriveConfig(event) {
  event.preventDefault();
  const folderId = els.driveFolderSelect.value;
  if (!folderId) {
    toast('Choose a Drive folder first.', { type: 'error' });
    return;
  }

  const folderName = state.driveFolders.find((folder) => folder.id === folderId)?.name || 'Google Drive';

  try {
    const data = await api('/api/drive/config', {
      method: 'POST',
      body: {
        folderId,
        folderName,
        album: els.driveAlbum.value.trim().slice(0, 120),
        intervalSeconds: Number(els.driveInterval.value) || DEFAULT_DRIVE_INTERVAL_SECONDS,
        includeSubfolders: els.driveSubfolders.checked,
        importExisting: els.driveExisting.checked,
        enabled: true
      }
    });

    els.driveDialog.close();
    renderDriveStatus(data.status);
    toast(`Now watching “${folderName}”`, { type: 'success' });
    loadStats();
    loadAlbums();
  } catch (error) {
    toast(error.message || 'Could not save the Drive settings.', { type: 'error' });
  }
}

async function disconnectDrive() {
  const sure = await confirmDialog({
    title: 'Disconnect Google Drive?',
    message: 'Gurukul Olympics will stop watching the folder. Photos already imported stay in your library.',
    confirmLabel: 'Disconnect',
    danger: true
  });
  if (!sure) return;

  try {
    await api('/api/drive/disconnect', { method: 'POST' });
    stopDriveAuthWatch();
    if (els.driveDialog.open) els.driveDialog.close();
    toast('Google Drive disconnected', { type: 'success' });
    loadDriveStatus();
  } catch (error) {
    toast(error.message || 'Could not disconnect Google Drive.', { type: 'error' });
  }
}

async function syncDriveNow() {
  if (state.role === 'participant') return;
  if (!state.drive?.connected || !state.drive.folder) {
    toast('Choose a Drive folder first.', { type: 'error' });
    return;
  }

  els.driveSync.disabled = true;
  try {
    const data = await api('/api/drive/sync', { method: 'POST' });
    if (state.drive && data.lastSync) state.drive.lastSync = data.lastSync;
    renderDriveStatus(data.status);

    if (data.added) {
      state.newCount += Number(data.added);
      showNewBanner();
      if (!state.items.length && state.view === 'all' && !state.album && !state.q) {
        loadFirstPage({ scrollTop: false });
      }
    }

    const parts = [];
    if (data.added) parts.push(`${formatNumber(data.added)} added`);
    if (data.duplicates) parts.push(`${formatNumber(data.duplicates)} already in library`);
    if (data.failed) parts.push(`${formatNumber(data.failed)} failed`);
    if (data.skipped) parts.push(`${formatNumber(data.skipped)} skipped`);

    toast(parts.length ? `Drive sync · ${parts.join(' · ')}` : 'Drive sync complete — nothing new', {
      type: data.failed ? 'error' : 'success'
    });

    loadStats();
    loadAlbums();
  } catch (error) {
    toast(error.message || 'Could not sync Google Drive.', { type: 'error' });
  } finally {
    loadDriveStatus({ silent: true });
  }
}

/* ------------------------------------------------------------------
   Sign-in and participant mode
   ------------------------------------------------------------------ */

function playSplash() {
  const splash = $('#splash');
  if (!splash) {
    checkAuth();
    return;
  }

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let finished = false;

  function finish() {
    if (finished) return;
    finished = true;
    splash.classList.add('is-leaving');
    setTimeout(() => {
      splash.hidden = true;
      checkAuth();
    }, reduced ? 40 : 650);
  }

  splash.addEventListener('click', finish);
  setTimeout(finish, reduced ? 450 : 2800);
}

function showAuthScreen() {
  els.authScreen.hidden = false;
  els.authError.hidden = true;
  els.authForm.hidden = true;
  document.body.classList.remove('participant');
  setTimeout(() => els.authParticipant.focus(), 60);
}

function showAdminForm() {
  els.authForm.hidden = false;
  els.authError.hidden = true;
  setTimeout(() => els.authEmail.focus(), 60);
}

function applyViewOnly(viewOnly) {
  lightbox.setViewOnly(viewOnly);
  if (!viewOnly) return;
  setSelectMode(false);
  hideNewBanner();
  resetDragState();
}

function startApp() {
  if (state.appStarted) return;
  state.appStarted = true;

  loadStats();
  loadAlbums();
  if (state.role === 'admin') {
    loadDriveStatus().then(() => autoConfigureDefaultDrive());
  }
  loadFirstPage({ scrollTop: false });

  setInterval(() => {
    if (!document.hidden && state.role === 'admin') loadDriveStatus({ silent: true });
  }, 60 * 1000);
}

async function enterApp(role) {
  state.role = role === 'participant' ? 'participant' : 'admin';
  document.body.classList.toggle('participant', state.role === 'participant');
  els.authScreen.hidden = true;
  els.authError.hidden = true;
  els.authPassword.value = '';
  applyViewOnly(state.role === 'participant');
  startApp();
}

async function checkAuth() {
  try {
    const status = await api('/api/auth/status');
    if (status.authenticated) {
      enterApp(status.role);
    } else {
      showAuthScreen();
    }
  } catch {
    showAuthScreen();
  }
}

async function submitLogin(event) {
  event.preventDefault();
  const email = els.authEmail.value.trim();
  const password = els.authPassword.value;
  els.authError.hidden = true;
  els.authSubmit.disabled = true;

  try {
    const data = await api('/api/auth/login', { method: 'POST', body: { email, password } });
    enterApp(data.role);
  } catch (error) {
    els.authError.textContent = error.message || 'Invalid email or password';
    els.authError.hidden = false;
  } finally {
    els.authSubmit.disabled = false;
  }
}

async function enterAsParticipant() {
  els.authParticipant.disabled = true;
  try {
    const data = await api('/api/auth/participant', { method: 'POST' });
    enterApp(data.role);
  } catch (error) {
    els.authError.textContent = error.message || 'Could not open the gallery.';
    els.authError.hidden = false;
  } finally {
    els.authParticipant.disabled = false;
  }
}

async function switchUser() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Clear the local view even if the server call fails.
  }
  location.reload();
}

function bindEvents() {
  els.authForm.addEventListener('submit', submitLogin);
  els.authParticipant.addEventListener('click', enterAsParticipant);
  els.authAdmin.addEventListener('click', showAdminForm);
  els.authSwitch.addEventListener('click', switchUser);

  for (const button of els.navButtons) {
    button.addEventListener('click', () => {
      applyNavigation({ view: button.dataset.nav, album: null, q: '' });
    });
  }

  els.brandLink.addEventListener('click', (event) => {
    event.preventDefault();
    applyNavigation({ view: 'all', album: null, q: '' });
  });

  els.albumList.addEventListener('click', (event) => {
    const button = event.target.closest('.album-item');
    if (!button) return;
    const album = button.dataset.album;
    if (state.view === 'all' && state.album === album) {
      applyNavigation({ view: 'all', album: null, q: '' });
    } else {
      applyNavigation({ view: 'all', album, q: '' });
    }
  });

  els.searchInput.addEventListener('input', () => debouncedSearch());
  els.searchInput.addEventListener('search', () => {
    debouncedSearch.cancel();
    applySearchValue(els.searchInput.value);
  });

  els.sortSelect.addEventListener('change', () => {
    if (els.sortSelect.value === state.sort) return;
    applyNavigation({ sort: els.sortSelect.value });
  });

  els.selectBtn.addEventListener('click', () => {
    setSelectMode(!state.selectMode);
  });

  els.uploadBtn.addEventListener('click', () => openUploadDialog());

  els.menuBtn.addEventListener('click', openSidebar);
  els.sidebarClose.addEventListener('click', closeSidebar);
  els.sidebarScrim.addEventListener('click', closeSidebar);

  els.gallery.addEventListener('click', (event) => {
    const card = event.target.closest('.card');
    if (!card) return;

    const photo = photoById(card.dataset.id);
    if (!photo) return;

    if (event.target.closest('.card-check')) {
      toggleSelected(photo.id);
      return;
    }
    if (event.target.closest('.card-fav')) {
      togglePhotoFavorite(photo);
      return;
    }
    if (state.selectMode) {
      toggleSelected(photo.id);
      return;
    }
    openPhoto(photo.id);
  });

  els.gallery.addEventListener('keydown', (event) => {
    if (event.target !== event.target.closest('.card')) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;

    const card = event.target.closest('.card');
    const photo = card ? photoById(card.dataset.id) : null;
    if (!photo) return;

    event.preventDefault();
    if (state.selectMode) toggleSelected(photo.id);
    else openPhoto(photo.id);
  });

  els.loadMore.addEventListener('click', () => loadMore());

  els.empty.addEventListener('click', (event) => {
    const button = event.target.closest('[data-empty-action]');
    if (!button) return;

    const action = button.dataset.emptyAction;
    if (action === 'upload') {
      openUploadDialog({ album: state.album && state.album !== UNSORTED ? state.album : '' });
    } else if (action === 'clear-search') {
      els.searchInput.value = '';
      applyNavigation({ q: '' });
    } else if (action === 'browse-all') {
      applyNavigation({ view: 'all', album: null, q: '' });
    } else if (action === 'retry') {
      loadFirstPage({ scrollTop: false });
    }
  });

  els.newRefresh.addEventListener('click', showNewPhotos);
  els.newDismiss.addEventListener('click', hideNewBanner);

  els.bulkSelectAll.addEventListener('click', selectAllInView);

  els.bulkBar.addEventListener('click', (event) => {
    const button = event.target.closest('[data-bulk]');
    if (!button) return;
    const action = button.dataset.bulk;

    if (action === 'clear') setSelectMode(false);
    else if (action === 'favorite') bulkFavorite();
    else if (action === 'album') bulkAlbum();
    else if (action === 'delete') bulkDelete();
    else if (action === 'restore') bulkRestore();
  });

  els.themeToggle.addEventListener('click', toggleTheme);

  /* Google Drive */
  els.driveConnect.addEventListener('click', connectDrive);
  els.driveManage.addEventListener('click', openDriveDialog);
  els.driveChange.addEventListener('click', openDriveDialog);
  els.driveSync.addEventListener('click', syncDriveNow);
  els.driveDisconnect.addEventListener('click', disconnectDrive);
  els.driveFolderSearch.addEventListener('input', () => debouncedDriveFolders());
  els.driveFolderSelect.addEventListener('change', () => {
    if (els.driveAlbum.value && els.driveAlbum.dataset.auto !== '1') return;
    const selected = state.driveFolders.find((folder) => folder.id === els.driveFolderSelect.value);
    els.driveAlbum.value = selected?.name || '';
    if (selected) els.driveAlbum.dataset.auto = '1';
  });
  els.driveAlbum.addEventListener('input', () => delete els.driveAlbum.dataset.auto);
  els.driveForm.addEventListener('submit', submitDriveConfig);
  els.driveCancel.addEventListener('click', () => els.driveDialog.close());
  els.driveClose.addEventListener('click', () => els.driveDialog.close());
  els.driveDialog.addEventListener('click', (event) => {
    if (event.target === els.driveDialog) els.driveDialog.close();
  });
  window.addEventListener('message', handleDriveMessage);

  /* Upload dialog */
  els.uploadClose.addEventListener('click', closeUploadDialog);
  els.uploadCancel.addEventListener('click', closeUploadDialog);
  els.uploadForm.addEventListener('submit', startUpload);

  els.uploadDialog.addEventListener('close', () => {
    if (!els.uploadDialog.open) resetUploadSelection();
  });

  els.uploadDialog.addEventListener('click', (event) => {
    if (event.target === els.uploadDialog) closeUploadDialog();
  });

  els.uploadClearSelection.addEventListener('click', () => {
    state.pendingFiles = [];
    renderPendingSelection();
  });

  els.pickFiles.addEventListener('click', () => els.fileInput.click());
  els.pickFolder.addEventListener('click', () => els.folderInput.click());

  els.dropzone.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    els.fileInput.click();
  });

  els.dropzone.addEventListener('keydown', (event) => {
    if (event.target !== els.dropzone) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    els.fileInput.click();
  });

  els.dropzone.addEventListener('dragover', (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    els.dropzone.classList.add('is-dragging');
  });

  els.dropzone.addEventListener('dragleave', (event) => {
    if (els.dropzone.contains(event.relatedTarget)) return;
    els.dropzone.classList.remove('is-dragging');
  });

  els.dropzone.addEventListener('drop', (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    event.stopPropagation();
    els.dropzone.classList.remove('is-dragging');
    handleDroppedDataTransfer(event.dataTransfer);
  });

  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files || []);
    els.fileInput.value = '';
    if (!files.length) return;
    if (!els.uploadDialog.open) openUploadDialog();
    addPendingFiles(files);
  });

  els.folderInput.addEventListener('change', () => {
    const files = Array.from(els.folderInput.files || []);
    els.folderInput.value = '';
    if (!files.length) return;
    if (!els.uploadDialog.open) openUploadDialog();
    addPendingFiles(files);
  });

  /* Queue */
  els.uploadIndicator.addEventListener('click', openQueue);
  els.queueClose.addEventListener('click', closeQueue);
  els.queueMinimize.addEventListener('click', () => {
    state.queueMinimized = !state.queueMinimized;
    renderQueue(lastQueueStats || uploader.getStats());
  });
  els.queuePause.addEventListener('click', toggleUploadPause);
  els.queueRetry.addEventListener('click', retryFailedUploads);
  els.queueClear.addEventListener('click', clearUploads);

  /* Global drag and drop */
  window.addEventListener('dragenter', (event) => {
    if (!hasFileDrag(event) || state.role === 'participant') return;
    event.preventDefault();
    if (els.uploadDialog.open) return;
    state.dragDepth += 1;
    els.dropOverlay.hidden = false;
  });

  window.addEventListener('dragover', (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', (event) => {
    if (!hasFileDrag(event)) return;
    state.dragDepth = Math.max(0, state.dragDepth - 1);
    if (!state.dragDepth) els.dropOverlay.hidden = true;
  });

  window.addEventListener('drop', (event) => {
    if (!hasFileDrag(event)) return;
    event.preventDefault();
    resetDragState();
    handleDroppedDataTransfer(event.dataTransfer);
  });

  window.addEventListener('dragend', resetDragState);

  /* Keyboard */
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && els.app.classList.contains('sidebar-open')) {
      closeSidebar();
    }

    if (event.target === els.searchInput) {
      if (event.key === 'Escape' && els.searchInput.value) {
        event.preventDefault();
        els.searchInput.value = '';
        applyNavigation({ q: '' });
      } else if (event.key === 'Enter') {
        event.preventDefault();
        debouncedSearch.cancel();
        applySearchValue(els.searchInput.value);
      }
      return;
    }

    if (isTypingTarget(event.target)) return;

    if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      if (document.querySelector('dialog[open]') || lightbox.isOpen) return;
      event.preventDefault();
      els.searchInput.focus();
      els.searchInput.select();
    }
  });

  window.addEventListener('popstate', () => {
    readStateFromUrl();
    setSelectMode(false);
    syncNav();
    loadFirstPage({ scrollTop: true });
  });

  /* Scroll progress bar + a touch of depth as photos pass by */
  let scrollTicking = false;
  els.main.addEventListener(
    'scroll',
    () => {
      if (scrollTicking) return;
      scrollTicking = true;
      requestAnimationFrame(() => {
        const max = els.main.scrollHeight - els.main.clientHeight;
        const progress = max > 0 ? clamp(els.main.scrollTop / max, 0, 1) : 0;
        els.scrollProgress.style.transform = `scaleX(${progress})`;

        const viewTop = els.main.getBoundingClientRect().top;
        const viewHeight = els.main.clientHeight;
        for (const card of els.gallery.children) {
          if (!card.classList?.contains('card') || !card.classList.contains('is-revealed')) continue;
          const rect = card.getBoundingClientRect();
          if (rect.bottom < -100 || rect.top > viewTop + viewHeight + 100) continue;
          const offset = (rect.top + rect.height / 2 - viewTop - viewHeight / 2) / viewHeight;
          card.style.setProperty('--py', `${clamp(-offset * 14, -8, 8).toFixed(1)}px`);
        }
        scrollTicking = false;
      });
    },
    { passive: true }
  );

  /* Infinite scroll */
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) loadMore();
      }
    },
    { root: els.main, rootMargin: '1200px 0px' }
  );
  observer.observe(els.sentinel);
}

/* ------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------ */

readStateFromUrl();
bindEvents();
applyTheme(document.documentElement.dataset.theme || 'dark');
syncNav();
renderQueue(uploader.getStats());
writeUrl();
playSplash();
