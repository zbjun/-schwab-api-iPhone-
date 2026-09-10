import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const AAD = Buffer.from('ths-server-vault-v1');

/** All values are one authenticated ciphertext. Mutations serialize and rename atomically. */
export class EncryptedVault {
  #directory; #key; #queue = Promise.resolve(); #values; #failed = false;
  constructor(directory, key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Vault requires a 32-byte encryption key');
    this.#directory = directory; this.#key = Buffer.from(key);
  }
  async #load() {
    if (this.#values) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    let raw;
    try { raw = await readFile(join(this.#directory, 'vault.enc')); }
    catch (error) { if (error.code === 'ENOENT') { this.#values = Object.create(null); return; } throw new Error('Vault unavailable'); }
    try {
      if (raw.length < 29 || raw[0] !== 1) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(1, 13));
      decipher.setAAD(AAD); decipher.setAuthTag(raw.subarray(13, 29));
      const values = JSON.parse(Buffer.concat([decipher.update(raw.subarray(29)), decipher.final()]).toString('utf8'));
      if (!values || Array.isArray(values) || typeof values !== 'object' || Object.values(values).some(value => typeof value !== 'string')) throw new Error();
      this.#values = Object.assign(Object.create(null), values);
    } catch { throw new Error('Vault authentication failed; restore the matching key and vault backup'); }
  }
  #serial(work) {
    const pending = this.#queue.then(async () => {
      if (this.#failed) throw new Error('Vault persistence failed; restart with verified storage before continuing');
      await this.#load(); return work();
    });
    this.#queue = pending.catch(() => undefined);
    return pending;
  }
  get(key) { return this.#serial(() => this.#values[key] ?? null); }
  set(key, value) {
    if (typeof key !== 'string' || typeof value !== 'string') return Promise.reject(new Error('Invalid vault value'));
    return this.#serial(() => this.#save({ ...this.#values, [key]: value }));
  }
  remove(key) { return this.#serial(() => { const next = { ...this.#values }; delete next[key]; return this.#save(next); }); }
  async #save(next) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    cipher.setAAD(AAD);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
    const body = Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
    const temporary = join(this.#directory, `.vault-${randomBytes(12).toString('hex')}.tmp`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(body); await file.sync(); await file.close(); file = undefined;
      await rename(temporary, join(this.#directory, 'vault.enc'));
      // Persist rename metadata on Unix before acknowledging a durable order marker.
      if (process.platform !== 'win32') { const dir = await open(this.#directory, 'r'); try { await dir.sync(); } finally { await dir.close(); } }
      this.#values = Object.assign(Object.create(null), next);
    } catch (error) {
      // A rename may have succeeded before a later durability failure. Never continue
      // using an older in-memory map that could erase a durable unknown-order marker.
      this.#failed = true;
      throw error;
    } finally { if (file) await file.close(); await unlink(temporary).catch(() => {}); }
  }
}

/** Deliberately refuses stale locks: do not automatically risk a second token owner. */
export async function acquireProcessLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'process.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch { throw new Error('Server vault is locked. Verify the previous process has stopped before removing process.lock'); }
  try { await handle.writeFile(String(process.pid)); await handle.sync(); }
  catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
  let released = false;
  return async () => { if (released) return; released = true; await handle.close(); await unlink(path); };
}
