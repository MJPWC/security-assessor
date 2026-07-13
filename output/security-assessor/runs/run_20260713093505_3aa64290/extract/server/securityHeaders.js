const DEFAULT_PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'payment=()',
  'usb=()',
  'serial=()'
].join(', ');

function configuredConnectSources() {
  const configured = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    ...(process.env.CORS_ORIGINS || '').split(','),
    ...(process.env.CSP_CONNECT_SOURCES || '').split(',')
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean);

  const sources = new Set([
    "'self'",
    'http://localhost:5001',
    'http://127.0.0.1:5001',
    'ws://localhost:5001',
    'ws://127.0.0.1:5001'
  ]);

  for (const value of configured) {
    sources.add(value);
    try {
      const url = new URL(value);
      if (url.protocol === 'http:') sources.add(`ws://${url.host}`);
      if (url.protocol === 'https:') sources.add(`wss://${url.host}`);
    } catch {
      // CSP_CONNECT_SOURCES may intentionally contain a CSP source expression.
    }
  }
  return Array.from(sources);
}

function buildContentSecurityPolicy(isHttps) {
  const directives = [
    ["default-src", "'self'"],
    ["base-uri", "'self'"],
    ["object-src", "'none'"],
    ["frame-ancestors", "'none'"],
    ["form-action", "'self'"],
    ["script-src", "'self'"],
    ["style-src", "'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    ["font-src", "'self'", 'https://fonts.gstatic.com', 'data:'],
    ["img-src", "'self'", 'data:', 'blob:'],
    ["connect-src", ...configuredConnectSources()],
    ["worker-src", "'self'", 'blob:'],
    ["media-src", "'self'", 'blob:'],
    ["manifest-src", "'self'"],
    ["report-uri", '/api/security/csp-report']
  ];

  if (isHttps) directives.push(['upgrade-insecure-requests']);
  return directives.map(parts => parts.join(' ')).join('; ');
}

export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', DEFAULT_PERMISSIONS_POLICY);
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');

  const isHttps =
    req.secure ||
    String(req.get?.('x-forwarded-proto') || '').split(',')[0].trim() === 'https';

  const cspHeader = String(process.env.CSP_REPORT_ONLY || 'true').toLowerCase() === 'false'
    ? 'Content-Security-Policy'
    : 'Content-Security-Policy-Report-Only';
  res.setHeader(cspHeader, buildContentSecurityPolicy(isHttps));

  if (process.env.NODE_ENV === 'production' || isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  next();
}
