import crypto from 'node:crypto';

const COOKIE_NAME = 'mosaic_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function encode(value) {
  return Buffer.from(value).toString('base64url');
}

function sign(payload, secret) {
  const body = encode(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function verify(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra) return null;

  const expected = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return null;
  if (!crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || !['admin', 'participant'].includes(payload.role)) return null;
    if (payload.exp && payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function createAuth(config) {
  const enabled = !!config.auth?.enabled;
  const secret = String(config.auth?.secret || crypto.randomUUID());

  function read(req) {
    if (!enabled) return { role: 'admin', iat: Date.now() };
    return verify(readCookie(req.headers?.cookie, COOKIE_NAME), secret);
  }

  function setCookie(res, role) {
    const now = Date.now();
    const token = sign({ role, iat: now, exp: now + MAX_AGE_MS }, secret);
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: MAX_AGE_MS,
      secure: false
    });
  }

  function clearCookie(res) {
    res.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/' });
  }

  function status(req) {
    const session = read(req);
    return {
      enabled,
      authenticated: !enabled || !!session,
      role: session?.role || (enabled ? null : 'admin')
    };
  }

  function middleware(req, res, next) {
    if (!enabled) {
      req.session = { role: 'admin' };
      return next();
    }

    const route = req.path || '';
    if (route.startsWith('/auth/') || route === '/health') return next();

    const session = read(req);
    if (!session) return res.status(401).json({ error: 'Sign in to open the gallery.' });

    req.session = session;

    if (session.role === 'participant') {
      const readOnly =
        req.method === 'GET' &&
        !route.startsWith('/drive/') &&
        route !== '/export.csv' &&
        !route.endsWith('/download');

      if (!readOnly) {
        return res.status(403).json({ error: 'Participants can only view the library.' });
      }
    }

    return next();
  }

  function mediaGuard(req, res, next) {
    if (!enabled) return next();
    if (read(req)) return next();
    return res.status(401).end();
  }

  function credentialsMatch(email, password) {
    const expectedEmail = String(config.auth?.email ?? 'Jio');
    const expectedPassword = String(config.auth?.password ?? '@Ambani');

    const emailBuffer = Buffer.from(String(email ?? ''));
    const expectedEmailBuffer = Buffer.from(expectedEmail);
    const passwordBuffer = Buffer.from(String(password ?? ''));
    const expectedPasswordBuffer = Buffer.from(expectedPassword);

    const emailOk =
      emailBuffer.length === expectedEmailBuffer.length &&
      crypto.timingSafeEqual(emailBuffer, expectedEmailBuffer);
    const passwordOk =
      passwordBuffer.length === expectedPasswordBuffer.length &&
      crypto.timingSafeEqual(passwordBuffer, expectedPasswordBuffer);

    return emailOk && passwordOk;
  }

  return {
    enabled,
    read,
    status,
    middleware,
    mediaGuard,
    setCookie,
    clearCookie,
    credentialsMatch
  };
}
