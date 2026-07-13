import crypto from 'crypto';

const COOKIE_NAME = 'mulegenie_auth';
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

function envValue(name) {
  const value = process.env[name];
  if (!value) return '';
  const trimmed = String(value).trim();
  return /^__REPLACE_ME__$/i.test(trimmed) ? '' : trimmed;
}

function parseCookies(header = '') {
  return String(header)
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separator = part.indexOf('=');
      if (separator === -1) return cookies;
      const name = part.slice(0, separator).trim();
      const value = part.slice(separator + 1).trim();
      try {
        cookies[name] = decodeURIComponent(value);
      } catch {
        cookies[name] = value;
      }
      return cookies;
    }, {});
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  return leftBuffer.length === rightBuffer.length &&
    crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createToken(userId, secret, ttlSeconds) {
  const payload = base64UrlJson({
    sub: userId,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
    nonce: crypto.randomBytes(12).toString('base64url')
  });
  return `${payload}.${sign(payload, secret)}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, secret))) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed.sub || !parsed.exp || parsed.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return { id: String(parsed.sub) };
  } catch {
    return null;
  }
}

function cookieOptions(req) {
  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const secure = process.env.NODE_ENV === 'production' || req?.secure || forwardedProto === 'https';
  return [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${DEFAULT_SESSION_TTL_SECONDS}`,
    secure ? 'Secure' : ''
  ].filter(Boolean).join('; ');
}

export function createAuthentication(options = {}) {
  const username = envValue('APP_AUTH_USERNAME') || 'user';
  const password = envValue('APP_AUTH_PASSWORD');
  const enabled = !!password;
  const runtimeInstanceId = options.runtimeInstanceId || '';
  const secret = envValue('APP_AUTH_SECRET') ||
    (password ? crypto.createHash('sha256').update(`mulegenie:${password}`).digest('hex') : '');

  if (process.env.NODE_ENV === 'production' && !enabled) {
    throw new Error('APP_AUTH_PASSWORD must be configured when NODE_ENV=production');
  }
  if (process.env.NODE_ENV === 'production' && !envValue('APP_AUTH_SECRET')) {
    throw new Error('APP_AUTH_SECRET must be configured when NODE_ENV=production');
  }

  function getUserFromRequest(req) {
    if (!enabled) return { id: 'local-user' };
    const token = parseCookies(req?.headers?.cookie)[COOKIE_NAME];
    return verifyToken(token, secret);
  }

  function status(req, res) {
    const user = getUserFromRequest(req);
    return res.json({
      enabled,
      authenticated: !!user,
      user: user ? { id: user.id } : null,
      runtimeInstanceId
    });
  }

  function login(req, res) {
    if (!enabled) {
      return res.json({ authenticated: true, user: { id: 'local-user' } });
    }

    const suppliedUsername = String(req.body?.username || '').trim();
    const suppliedPassword = String(req.body?.password || '');
    if (!safeEqual(suppliedUsername, username) || !safeEqual(suppliedPassword, password)) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = createToken(username, secret, DEFAULT_SESSION_TTL_SECONDS);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; ${cookieOptions(req)}`);
    return res.json({ authenticated: true, user: { id: username } });
  }

  function logout(req, res) {
    const options = cookieOptions(req)
      .replace(`Max-Age=${DEFAULT_SESSION_TTL_SECONDS}`, 'Max-Age=0');
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=; ${options}`);
    return res.json({ authenticated: false });
  }

  function requireAuth(req, res, next) {
    const user = getUserFromRequest(req);
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    req.user = user;
    return next();
  }

  function authenticateSocket(socket, next) {
    const user = getUserFromRequest({ headers: socket.handshake.headers });
    if (!user) return next(new Error('Authentication required'));
    socket.data.user = user;
    return next();
  }

  return {
    enabled,
    status,
    login,
    logout,
    requireAuth,
    authenticateSocket
  };
}
