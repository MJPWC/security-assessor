import assert from 'node:assert/strict';
import { securityHeaders } from './server/securityHeaders.js';

function runMiddleware({ secure = false, forwardedProto = '' } = {}) {
  const headers = {};
  const req = {
    secure,
    get(name) {
      return name === 'x-forwarded-proto' ? forwardedProto : '';
    }
  };
  const res = {
    setHeader(name, value) {
      headers[name.toLowerCase()] = value;
    }
  };
  let nextCalled = false;
  securityHeaders(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  return headers;
}

const original = {
  CSP_REPORT_ONLY: process.env.CSP_REPORT_ONLY,
  CSP_CONNECT_SOURCES: process.env.CSP_CONNECT_SOURCES,
  NODE_ENV: process.env.NODE_ENV
};

try {
  process.env.NODE_ENV = 'test';
  process.env.CSP_REPORT_ONLY = 'true';
  process.env.CSP_CONNECT_SOURCES = 'https://api.example.com';

  const reportOnly = runMiddleware();
  const policy = reportOnly['content-security-policy-report-only'];
  assert.ok(policy);
  assert.match(policy, /default-src 'self'/);
  assert.match(policy, /script-src 'self'/);
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /https:\/\/api\.example\.com/);
  assert.match(policy, /wss:\/\/api\.example\.com/);
  assert.equal(reportOnly['content-security-policy'], undefined);

  process.env.CSP_REPORT_ONLY = 'false';
  const enforced = runMiddleware({ secure: true });
  assert.ok(enforced['content-security-policy']);
  assert.match(enforced['content-security-policy'], /upgrade-insecure-requests/);
  assert.match(enforced['strict-transport-security'], /max-age=/);

  console.log('Security header tests passed');
} finally {
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
