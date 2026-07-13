import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  decryptStoreData,
  encryptStoreData,
  readSecureStore,
  writeSecureStore
} from './server/secureStore.js';

const key = crypto.randomBytes(32);
const otherKey = crypto.randomBytes(32);
const data = {
  sessionMeta: {
    session_1: { id: 'session_1', ownerId: 'tester' }
  },
  sessionOutputs: {
    session_1: { architecture: 'sensitive architecture' }
  }
};

const envelope = encryptStoreData(data, key);
assert.equal(envelope.algorithm, 'aes-256-gcm');
assert.equal(JSON.stringify(envelope).includes('sensitive architecture'), false);
assert.deepEqual(decryptStoreData(envelope, key), data);
assert.throws(() => decryptStoreData(envelope, otherKey), /Unable to decrypt/);

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'mulegenie-store-'));
const encryptedFile = path.join(temporaryDirectory, 'store.enc');
const plaintextFile = path.join(temporaryDirectory, 'store.json');

try {
  writeSecureStore({ encryptedFile, plaintextFile, data, key });
  assert.equal(fs.existsSync(encryptedFile), true);
  assert.equal(fs.existsSync(plaintextFile), false);
  assert.equal(fs.readFileSync(encryptedFile, 'utf8').includes('sensitive architecture'), false);

  const loaded = readSecureStore({ encryptedFile, plaintextFile, key });
  assert.equal(loaded.source, 'encrypted');
  assert.deepEqual(loaded.data, data);

  fs.writeFileSync(plaintextFile, JSON.stringify(data), 'utf8');
  fs.rmSync(encryptedFile);
  const legacy = readSecureStore({ encryptedFile, plaintextFile, key });
  assert.equal(legacy.source, 'plaintext');
  assert.deepEqual(legacy.data, data);

  console.log('Secure store tests passed');
} finally {
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
}
