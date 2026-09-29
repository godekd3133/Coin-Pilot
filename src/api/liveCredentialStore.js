import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const STORE_DIRECTORY = path.join(PROJECT_ROOT, '.secrets', 'live-upbit-credentials');
const CREDENTIALS_FILE = 'credentials.enc';
const KEY_FILE = 'encryption.key';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SCHEMA_VERSION = 1;
const AUTHENTICATED_DATA = Buffer.from('coinpilot.live-upbit-credentials.v1');

function operationError(code) {
  const error = new Error('Live credential operation failed.');
  error.code = code;
  return error;
}

function isNotFound(error) {
  return error?.code === 'ENOENT';
}

function syncDirectory(directory) {
  if (process.platform === 'win32') {
    throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
  }
  const descriptor = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertOwnerOnly(stat, kind) {
  if (process.platform === 'win32' ||
      (typeof process.getuid === 'function' && stat.uid !== process.getuid()) ||
      (stat.mode & 0o077) !== 0) {
    throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
  }
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
  }
}

function openOwnerOnlyFile(filePath, flags) {
  if (process.platform === 'win32') {
    throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(filePath, flags | noFollow);
  try {
    assertOwnerOnly(fs.fstatSync(descriptor), 'file');
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function validateCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
    throw operationError('LIVE_CREDENTIALS_INVALID_INPUT');
  }
  const keys = Object.keys(credentials).sort();
  if (keys.length !== 2 || keys[0] !== 'accessKey' || keys[1] !== 'secretKey' ||
      typeof credentials.accessKey !== 'string' || typeof credentials.secretKey !== 'string' ||
      credentials.accessKey.length === 0 || credentials.secretKey.length === 0 ||
      credentials.accessKey.length > 512 || credentials.secretKey.length > 512) {
    throw operationError('LIVE_CREDENTIALS_INVALID_INPUT');
  }
}

/**
 * Stores Upbit credentials encrypted with a per-install, owner-only key file.
 * The validator and update callback are server-side hooks; neither hook's
 * result or any credential material is returned from this store.
 */
export class LiveCredentialStore {
  constructor(options = {}) {
    const directoryPath = options.directoryPath ? path.resolve(options.directoryPath) : null;
    const configuredCredentialsFile = options.credentialsFile ??
      (directoryPath ? null : process.env.COINPILOT_LIVE_CREDENTIALS_FILE);
    const configuredKeyFile = options.keyFile ??
      (directoryPath ? null : process.env.COINPILOT_LIVE_CREDENTIALS_KEY_FILE);
    this.credentialsFilePath = path.resolve(configuredCredentialsFile ||
      path.join(directoryPath || STORE_DIRECTORY, CREDENTIALS_FILE));
    this.keyFilePath = path.resolve(configuredKeyFile ||
      path.join(directoryPath || STORE_DIRECTORY, KEY_FILE));
    if (this.credentialsFilePath === this.keyFilePath) {
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }
    this.directoryPath = path.dirname(this.credentialsFilePath);
    this.keyDirectoryPath = path.dirname(this.keyFilePath);
    this.validator = null;
    this.updateCallback = null;
    this.saveInProgress = false;
  }

  setCredentialValidator(callback) {
    if (callback !== null && callback !== undefined && typeof callback !== 'function') {
      throw new TypeError('Credential validator must be a function.');
    }
    this.validator = callback || null;
  }

  setUpdateCallback(callback) {
    if (callback !== null && callback !== undefined && typeof callback !== 'function') {
      throw new TypeError('Credential update callback must be a function.');
    }
    this.updateCallback = callback || null;
  }

  get credentialsPath() {
    return this.credentialsFilePath;
  }

  get keyPath() {
    return this.keyFilePath;
  }

  ensureDirectory(directory) {
    if (process.platform === 'win32') {
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const directoryStat = fs.lstatSync(directory);
      if (directoryStat.isSymbolicLink()) {
        throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      }
      assertOwnerOnly(directoryStat, 'directory');
    } catch (error) {
      if (error?.code?.startsWith('LIVE_CREDENTIALS_')) throw error;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }
  }

  verifyDirectory(directory) {
    try {
      const stat = fs.lstatSync(directory);
      if (stat.isSymbolicLink()) {
        throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      }
      assertOwnerOnly(stat, 'directory');
    } catch (error) {
      if (error?.code?.startsWith('LIVE_CREDENTIALS_')) throw error;
      if (isNotFound(error)) throw error;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }
  }

  readEncryptionKey() {
    let descriptor;
    try {
      descriptor = openOwnerOnlyFile(this.keyPath, fs.constants.O_RDONLY);
    } catch (error) {
      if (!isNotFound(error)) throw error;
      return null;
    }

    try {
      const key = fs.readFileSync(descriptor);
      if (key.length !== KEY_BYTES) {
        key.fill(0);
        throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      }
      return key;
    } finally {
      fs.closeSync(descriptor);
    }
  }

  getOrCreateEncryptionKey() {
    const existing = this.readEncryptionKey();
    if (existing) return existing;

    const key = crypto.randomBytes(KEY_BYTES);
    let descriptor;
    let createdByThisCall = false;
    try {
      descriptor = fs.openSync(
        this.keyPath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600
      );
      createdByThisCall = true;
      fs.fchmodSync(descriptor, 0o600);
      assertOwnerOnly(fs.fstatSync(descriptor), 'file');
      fs.writeFileSync(descriptor, key);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      syncDirectory(this.keyDirectoryPath);
      return key;
    } catch (error) {
      if (error?.code === 'EEXIST' && !createdByThisCall) {
        key.fill(0);
        const createdByPeer = this.readEncryptionKey();
        if (createdByPeer) return createdByPeer;
        throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      }
      if (descriptor !== undefined) {
        try {
          fs.closeSync(descriptor);
        } catch {
          // Preserve the original write error.
        }
      }
      if (createdByThisCall) {
        try {
          fs.unlinkSync(this.keyPath);
        } catch {
          // Preserve the original write error.
        }
      }
      key.fill(0);
      if (error?.code?.startsWith('LIVE_CREDENTIALS_')) throw error;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }
  }

  status() {
    try {
      this.verifyDirectory(this.directoryPath);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }

    let credentialsStat;
    try {
      credentialsStat = fs.lstatSync(this.credentialsPath);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }
    if (credentialsStat.isSymbolicLink() || !credentialsStat.isFile()) return false;
    assertOwnerOnly(credentialsStat, 'file');

    try {
      if (this.keyDirectoryPath !== this.directoryPath) this.verifyDirectory(this.keyDirectoryPath);
      const keyStat = fs.lstatSync(this.keyPath);
      if (keyStat.isSymbolicLink() || !keyStat.isFile()) return false;
      assertOwnerOnly(keyStat, 'file');
      return true;
    } catch {
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }
  }

  load() {
    try {
      this.verifyDirectory(this.directoryPath);
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error?.code?.startsWith('LIVE_CREDENTIALS_')) throw error;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }

    try {
      const stat = fs.lstatSync(this.credentialsPath);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      }
      assertOwnerOnly(stat, 'file');
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error?.code?.startsWith('LIVE_CREDENTIALS_')) throw error;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }

    try {
      if (this.keyDirectoryPath !== this.directoryPath) this.verifyDirectory(this.keyDirectoryPath);
    } catch {
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    }

    let descriptor;
    let key;
    try {
      descriptor = openOwnerOnlyFile(this.credentialsPath, fs.constants.O_RDONLY);
      const envelope = JSON.parse(fs.readFileSync(descriptor, 'utf8'));
      if (envelope?.version !== SCHEMA_VERSION ||
          typeof envelope.iv !== 'string' ||
          typeof envelope.tag !== 'string' ||
          typeof envelope.ciphertext !== 'string') {
        throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      }
      key = this.readEncryptionKey();
      if (!key) throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64url'));
      decipher.setAAD(AUTHENTICATED_DATA);
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
        decipher.final()
      ]);
      const credentials = JSON.parse(plain.toString('utf8'));
      plain.fill(0);
      validateCredentials(credentials);
      return { accessKey: credentials.accessKey, secretKey: credentials.secretKey };
    } catch (error) {
      if (isNotFound(error)) return null;
      if (error?.code?.startsWith('LIVE_CREDENTIALS_')) throw error;
      throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      key?.fill(0);
    }
  }

  async save(credentials) {
    if (this.saveInProgress) throw operationError('LIVE_CREDENTIALS_ALREADY_CONFIGURED');
    this.saveInProgress = true;
    try {
      return await this.#saveExclusive(credentials);
    } finally {
      this.saveInProgress = false;
    }
  }

  async #saveExclusive(credentials) {
    validateCredentials(credentials);
    if (!this.validator) throw operationError('LIVE_CREDENTIALS_VALIDATION_UNAVAILABLE');

    let accepted;
    try {
      accepted = await this.validator({
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey
      });
    } catch {
      throw operationError('LIVE_CREDENTIALS_VALIDATION_UNAVAILABLE');
    }
    if (accepted !== true) throw operationError('LIVE_CREDENTIALS_REJECTED');
    if (this.status()) throw operationError('LIVE_CREDENTIALS_ALREADY_CONFIGURED');

    this.ensureDirectory(this.keyDirectoryPath);
    if (this.directoryPath !== this.keyDirectoryPath) this.ensureDirectory(this.directoryPath);
    const key = this.getOrCreateEncryptionKey();
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(AUTHENTICATED_DATA);
    const plain = Buffer.from(JSON.stringify({
      accessKey: credentials.accessKey,
      secretKey: credentials.secretKey
    }), 'utf8');
    let encrypted;
    try {
      encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const envelope = JSON.stringify({
        version: SCHEMA_VERSION,
        iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'),
        ciphertext: encrypted.toString('base64url')
      });
      const temporaryPath = path.join(this.directoryPath, `.${CREDENTIALS_FILE}.${crypto.randomUUID()}.tmp`);
      let descriptor;
      try {
        descriptor = fs.openSync(
          temporaryPath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
          0o600
        );
        fs.fchmodSync(descriptor, 0o600);
        assertOwnerOnly(fs.fstatSync(descriptor), 'file');
        fs.writeFileSync(descriptor, envelope, 'utf8');
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
        descriptor = undefined;
        fs.renameSync(temporaryPath, this.credentialsPath);
        syncDirectory(this.directoryPath);
      } catch {
        if (descriptor !== undefined) {
          try {
            fs.closeSync(descriptor);
          } catch {
            // Preserve the original persistence failure.
          }
        }
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // A successful rename leaves no temporary file to remove.
        }
        throw operationError('LIVE_CREDENTIALS_SECURE_STORAGE_UNAVAILABLE');
      }
    } finally {
      key.fill(0);
      plain.fill(0);
      encrypted?.fill(0);
    }
    return this.status();
  }

  async notifyUpdate(credentials) {
    if (!this.updateCallback) throw operationError('LIVE_CREDENTIALS_APPLY_UNAVAILABLE');
    try {
      await this.updateCallback({
        accessKey: credentials.accessKey,
        secretKey: credentials.secretKey
      });
    } catch {
      throw operationError('LIVE_CREDENTIALS_APPLY_FAILED');
    }
  }
}

export function createDefaultLiveCredentialStore() {
  return new LiveCredentialStore();
}
