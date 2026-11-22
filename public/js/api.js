export class ApiError extends Error {
  constructor(message, status = 0, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
  }
}

export async function api(path, options = {}) {
  const { method = 'GET', body, signal } = options;
  const init = { method, signal, headers: {} };

  if (body !== undefined) {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    throw new ApiError('Could not reach the Gurukul Olympics server. Is it still running?', 0, null);
  }

  const type = response.headers.get('content-type') || '';
  let payload = null;
  try {
    payload = type.includes('application/json') ? await response.json() : await response.text();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const message =
      (payload && typeof payload === 'object' && payload.error) ||
      (typeof payload === 'string' && payload.trim()) ||
      `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

export function photoQuery({ view = 'all', album = null, q = '', sort = 'newest', offset = 0, limit = 120 }) {
  const params = new URLSearchParams();
  params.set('view', view);
  params.set('sort', sort);
  params.set('offset', String(offset));
  params.set('limit', String(limit));
  if (album) params.set('album', album);
  if (q) params.set('q', q);
  return params.toString();
}
