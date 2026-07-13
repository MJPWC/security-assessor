import assert from 'node:assert/strict';
import { createAuthentication } from './server/auth.js';

const originalEnv = {
  APP_AUTH_USERNAME: process.env.APP_AUTH_USERNAME,
  APP_AUTH_PASSWORD: process.env.APP_AUTH_PASSWORD,
  APP_AUTH_SECRET: process.env.APP_AUTH_SECRET,
  NODE_ENV: process.env.NODE_ENV
};

function mockResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

try {
  process.env.APP_AUTH_USERNAME = 'tester';
  process.env.APP_AUTH_PASSWORD = 'correct-horse-battery-staple';
  process.env.APP_AUTH_SECRET = 'test-signing-secret-that-is-not-for-production';
  process.env.NODE_ENV = 'test';

  const auth = createAuthentication();
  const failed = mockResponse();
  auth.login({ body: { username: 'tester', password: 'wrong' }, headers: {} }, failed);
  assert.equal(failed.statusCode, 401);

  const login = mockResponse();
  auth.login({
    body: { username: 'tester', password: 'correct-horse-battery-staple' },
    headers: {}
  }, login);
  assert.equal(login.statusCode, 200);
  assert.match(login.headers['set-cookie'], /HttpOnly/);
  assert.match(login.headers['set-cookie'], /SameSite=Lax/);

  const cookie = login.headers['set-cookie'].split(';')[0];
  const status = mockResponse();
  auth.status({ headers: { cookie } }, status);
  assert.equal(status.body.authenticated, true);
  assert.equal(status.body.user.id, 'tester');

  let nextCalled = false;
  auth.requireAuth({ headers: { cookie } }, mockResponse(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const unauthorized = mockResponse();
  auth.requireAuth({ headers: {} }, unauthorized, () => {});
  assert.equal(unauthorized.statusCode, 401);

  process.env.NODE_ENV = 'production';
  delete process.env.APP_AUTH_SECRET;
  assert.throws(
    () => createAuthentication(),
    /APP_AUTH_SECRET must be configured/
  );

  console.log('Authentication tests passed');
} finally {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
