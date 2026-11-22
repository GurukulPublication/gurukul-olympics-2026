const numberFormat = new Intl.NumberFormat();

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

export function icon(name, className = '') {
  return `<svg class="icon ${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

export function formatNumber(value) {
  return numberFormat.format(Number(value) || 0);
}

export function formatBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 10 || index === 0 ? Math.round(size) : size.toFixed(1)} ${units[index]}`;
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return Number(count) === 1 ? singular : pluralForm;
}

export function parseDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDate(iso, options = {}) {
  const date = parseDate(iso);
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    ...options
  }).format(date);
}

export function formatDateTime(iso) {
  const date = parseDate(iso);
  if (!date) return '—';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function debounce(fn, wait = 300) {
  let timer = null;
  let lastArgs = null;

  function debounced(...args) {
    lastArgs = args;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const argsToUse = lastArgs;
      lastArgs = null;
      fn(...argsToUse);
    }, wait);
  }

  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };

  debounced.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    const argsToUse = lastArgs;
    lastArgs = null;
    if (argsToUse) fn(...argsToUse);
  };

  return debounced;
}

export function toast(message, options = {}) {
  const { type = 'info', actionLabel = '', onAction = null, duration = 4200 } = options;
  const stack = $('#toasts');
  if (!stack) return null;

  while (stack.children.length >= 4) {
    stack.firstElementChild?.remove();
  }

  const node = document.createElement('div');
  node.className = `toast is-${type}`;
  node.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'info';
  const iconWrap = document.createElement('span');
  iconWrap.className = 'toast-icon';
  iconWrap.innerHTML = icon(iconName);

  const messageNode = document.createElement('div');
  messageNode.className = 'toast-message';
  messageNode.textContent = message;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Dismiss notification');
  close.innerHTML = icon('close');

  node.append(iconWrap, messageNode);

  if (actionLabel && typeof onAction === 'function') {
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'text-btn toast-action';
    action.textContent = actionLabel;
    action.addEventListener('click', () => {
      onAction();
      dismiss();
    });
    node.append(action);
  }

  node.append(close);

  let timeout = null;
  let remaining = duration;
  let startedAt = Date.now();
  let dismissed = false;

  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    if (timeout) clearTimeout(timeout);
    node.classList.add('is-leaving');
    setTimeout(() => node.remove(), 220);
  }

  function startTimer() {
    if (!duration || dismissed) return;
    startedAt = Date.now();
    timeout = setTimeout(dismiss, remaining);
  }

  close.addEventListener('click', dismiss);
  node.addEventListener('pointerenter', () => {
    if (timeout) clearTimeout(timeout);
    timeout = null;
    remaining -= Date.now() - startedAt;
  });
  node.addEventListener('pointerleave', () => {
    if (remaining > 0) startTimer();
  });

  stack.append(node);
  startTimer();
  return { dismiss };
}

export function announce(message) {
  const node = $('#announcer');
  if (!node) return;
  node.textContent = '';
  setTimeout(() => {
    node.textContent = message;
  }, 40);
}

export function confirmDialog({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = true
} = {}) {
  const dialog = $('#confirm-dialog');
  const titleNode = $('#confirm-title');
  const messageNode = $('#confirm-message');
  const confirmButton = $('#confirm-ok');
  const cancelButton = $('#confirm-cancel');
  const closeButton = $('#confirm-close');
  const iconWrap = $('#confirm-icon');

  if (!dialog) return Promise.resolve(false);

  titleNode.textContent = title;
  messageNode.textContent = message;
  confirmButton.textContent = confirmLabel;
  cancelButton.textContent = cancelLabel;
  confirmButton.classList.toggle('danger', danger);
  confirmButton.classList.toggle('primary', !danger);
  iconWrap.classList.toggle('confirm-icon', danger);
  iconWrap.innerHTML = icon(danger ? 'alert' : 'info');

  return new Promise((resolve) => {
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    }

    confirmButton.onclick = () => finish(true);
    cancelButton.onclick = () => finish(false);
    closeButton.onclick = () => finish(false);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(false);
    };
    dialog.onclick = (event) => {
      if (event.target === dialog) finish(false);
    };

    dialog.showModal();
    cancelButton.focus();
  });
}

export function albumPicker({ title = 'Add to album', current = '', albums = [], confirmLabel = 'Save album' } = {}) {
  const dialog = $('#album-dialog');
  const titleNode = $('#album-dialog-title');
  const input = $('#album-input');
  const form = $('#album-form');
  const cancel = $('#album-cancel');
  const closeButton = $('#album-dialog-close');
  const chips = $('#album-chips');

  if (!dialog) return Promise.resolve(null);

  titleNode.textContent = title;
  input.value = current;
  chips.innerHTML = '';

  const unique = [...new Set(albums.filter(Boolean))].slice(0, 14);
  for (const album of unique) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'album-chip';
    chip.textContent = album;
    chip.addEventListener('click', () => {
      input.value = album;
      input.focus();
    });
    chips.append(chip);
  }

  const apply = $('#album-apply');
  apply.textContent = confirmLabel;

  return new Promise((resolve) => {
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      dialog.close();
      resolve(value);
    }

    form.onsubmit = (event) => {
      event.preventDefault();
      finish(input.value.trim().slice(0, 120));
    };
    cancel.onclick = () => finish(null);
    closeButton.onclick = () => finish(null);
    dialog.oncancel = (event) => {
      event.preventDefault();
      finish(null);
    };
    dialog.onclick = (event) => {
      if (event.target === dialog) finish(null);
    };

    dialog.showModal();
    setTimeout(() => {
      input.focus();
      input.select();
    }, 40);
  });
}

export function isTypingTarget(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
