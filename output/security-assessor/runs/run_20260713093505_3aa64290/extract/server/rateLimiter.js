const buckets = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function createRateLimiter({
  name,
  windowMs,
  max,
  message = 'Too many requests. Please wait before trying again.'
}) {
  const limiterName = name || 'default';
  const effectiveWindowMs = parsePositiveInt(windowMs, 60_000);
  const effectiveMax = parsePositiveInt(max, 60);

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const ip = getClientIp(req);
    const key = `${limiterName}:${ip}`;
    const current = buckets.get(key);

    let bucket = current;
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + effectiveWindowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, effectiveMax - bucket.count);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    res.setHeader('X-RateLimit-Limit', String(effectiveMax));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > effectiveMax) {
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({
        error: message,
        rateLimit: {
          name: limiterName,
          retryAfterSeconds
        }
      });
    }

    return next();
  };
}

function envLimit(prefix, defaults) {
  return {
    windowMs: parsePositiveInt(process.env[`${prefix}_WINDOW_MS`], defaults.windowMs),
    max: parsePositiveInt(process.env[`${prefix}_MAX`], defaults.max)
  };
}

export const rateLimiters = {
  sessionCreate: createRateLimiter({
    name: 'session-create',
    ...envLimit('RATE_LIMIT_SESSION_CREATE', { windowMs: 60_000, max: 20 }),
    message: 'Too many sessions created from this IP. Please wait before creating another session.'
  }),
  llmProcess: createRateLimiter({
    name: 'llm-process',
    ...envLimit('RATE_LIMIT_LLM_PROCESS', { windowMs: 60_000, max: 12 }),
    message: 'Too many generation requests from this IP. Please wait before starting another LLM job.'
  }),
  generation: createRateLimiter({
    name: 'generation',
    ...envLimit('RATE_LIMIT_GENERATION', { windowMs: 60_000, max: 30 }),
    message: 'Too many generation actions from this IP. Please wait before trying again.'
  }),
  read: createRateLimiter({
    name: 'read',
    ...envLimit('RATE_LIMIT_READ', { windowMs: 60_000, max: 180 }),
    message: 'Too many read requests from this IP. Please wait before trying again.'
  }),
  download: createRateLimiter({
    name: 'download',
    ...envLimit('RATE_LIMIT_DOWNLOAD', { windowMs: 60_000, max: 60 }),
    message: 'Too many download requests from this IP. Please wait before downloading again.'
  })
};

export function checkRateLimit(name, identifier, options = {}) {
  const profile = {
    sessionCreate: envLimit('RATE_LIMIT_SESSION_CREATE', { windowMs: 60_000, max: 20 }),
    llmProcess: envLimit('RATE_LIMIT_LLM_PROCESS', { windowMs: 60_000, max: 12 }),
    generation: envLimit('RATE_LIMIT_GENERATION', { windowMs: 60_000, max: 30 }),
    read: envLimit('RATE_LIMIT_READ', { windowMs: 60_000, max: 180 }),
    download: envLimit('RATE_LIMIT_DOWNLOAD', { windowMs: 60_000, max: 60 })
  }[name] || envLimit('RATE_LIMIT_GENERATION', { windowMs: 60_000, max: 30 });

  const limiterName = options.name || name || 'manual';
  const now = Date.now();
  const key = `${limiterName}:${identifier || 'unknown'}`;
  const current = buckets.get(key);
  let bucket = current;

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + profile.windowMs };
    buckets.set(key, bucket);
  }

  bucket.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

  if (bucket.count > profile.max) {
    return {
      allowed: false,
      retryAfterSeconds,
      limit: profile.max,
      remaining: 0,
      resetAt: bucket.resetAt
    };
  }

  return {
    allowed: true,
    retryAfterSeconds,
    limit: profile.max,
    remaining: Math.max(0, profile.max - bucket.count),
    resetAt: bucket.resetAt
  };
}

export function clearRateLimitBuckets() {
  buckets.clear();
}
