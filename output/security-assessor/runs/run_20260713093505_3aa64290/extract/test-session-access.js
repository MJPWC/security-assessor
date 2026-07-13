import assert from 'node:assert/strict';
import { evaluateSessionAccess } from './server/sessionAccessPolicy.js';

const sessionMeta = {
  id: 'session_123',
  ownerId: 'alice',
  sessionToken: 'session-token-alice'
};

const valid = evaluateSessionAccess({
  sessionMeta,
  userId: 'alice',
  sessionToken: 'session-token-alice'
});
assert.equal(valid.allowed, true, 'Owner with valid session token should be allowed');

const missingSession = evaluateSessionAccess({
  sessionMeta: null,
  userId: 'alice',
  sessionToken: 'session-token-alice'
});
assert.equal(missingSession.allowed, false, 'Missing session should be blocked');
assert.equal(missingSession.status, 404, 'Missing session should return not found');

const wrongOwner = evaluateSessionAccess({
  sessionMeta,
  userId: 'bob',
  sessionToken: 'session-token-alice'
});
assert.equal(wrongOwner.allowed, false, 'Different user should be blocked even with a valid token');
assert.equal(wrongOwner.status, 404, 'Different user should receive not found to avoid session enumeration');

const missingToken = evaluateSessionAccess({
  sessionMeta,
  userId: 'alice',
  sessionToken: ''
});
assert.equal(missingToken.allowed, false, 'Owner without session token should be blocked');
assert.equal(missingToken.status, 403, 'Missing token should be forbidden');

const wrongToken = evaluateSessionAccess({
  sessionMeta,
  userId: 'alice',
  sessionToken: 'wrong-token'
});
assert.equal(wrongToken.allowed, false, 'Owner with wrong session token should be blocked');
assert.equal(wrongToken.status, 403, 'Wrong token should be forbidden');

const noStoredToken = evaluateSessionAccess({
  sessionMeta: { ...sessionMeta, sessionToken: '' },
  userId: 'alice',
  sessionToken: 'session-token-alice'
});
assert.equal(noStoredToken.allowed, false, 'Session without stored token should be blocked');

console.log('Session access policy tests passed');
