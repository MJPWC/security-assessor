import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const ALGORITHM = 'aes-256-gcm';
const ENVELOPE_VERSION = 1;

function envValue(name) {
  const value = String(process.env[name] || '').trim();
  return value && !/^__REPLACE_ME__$/i.test(value) ? value : '';
}

export function getDataEncryptionKey() {
  const configured = envValue('DATA_ENCRYPTION_KEY');
  if (!configured) return null;

  const hexKey = /^[a-f0-9]{64}$/i.test(configured)
    ? Buffer.from(configured, 'hex')
    : null;
  const base64Key = hexKey || Buffer.from(configured, 'base64');

  if (base64Key.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or 64 hexadecimal characters');
  }
  return base64Key;
}

export function encryptStoreData(data, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    version: ENVELOPE_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };
}

export function decryptStoreData(envelope, key) {
  if (
    envelope?.version !== ENVELOPE_VERSION ||
    envelope?.algorithm !== ALGORITHM ||
    !envelope?.iv ||
    !envelope?.tag ||
    !envelope?.ciphertext
  ) {
    throw new Error('Unsupported or invalid encrypted session store');
  }

  try {
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(envelope.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
      decipher.final()
    ]);
    return JSON.parse(plaintext.toString('utf8'));
  } catch {
    throw new Error('Unable to decrypt session store; verify DATA_ENCRYPTION_KEY');
  }
}

export function readSecureStore({ encryptedFile, plaintextFile, key }) {
  if (key && fs.existsSync(encryptedFile)) {
    return {
      data: decryptStoreData(JSON.parse(fs.readFileSync(encryptedFile, 'utf8')), key),
      source: 'encrypted'
    };
  }

  if (fs.existsSync(plaintextFile)) {
    return {
      data: JSON.parse(fs.readFileSync(plaintextFile, 'utf8')),
      source: 'plaintext'
    };
  }

  if (!key && fs.existsSync(encryptedFile)) {
    throw new Error('DATA_ENCRYPTION_KEY is required to read the encrypted session store');
  }

  return { data: null, source: 'none' };
}

export function writeSecureStore({ encryptedFile, plaintextFile, data, key }) {
  const target = key ? encryptedFile : plaintextFile;
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

  const serialized = key
    ? JSON.stringify(encryptStoreData(data, key))
    : JSON.stringify(data, null, 2);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, target);

  const obsolete = key ? plaintextFile : encryptedFile;
  if (fs.existsSync(obsolete)) fs.rmSync(obsolete, { force: true });
  return target;
}

export function assertProductionEncryption() {
  if (process.env.NODE_ENV === 'production' && !getDataEncryptionKey()) {
    throw new Error('DATA_ENCRYPTION_KEY must be configured when NODE_ENV=production');
  }
}
