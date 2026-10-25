// Filesystem storage: keys map to files under a root directory.
// Only used by the Node entry point; never imported on Workers.
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

export class FsStorage {
  constructor(root) {
    this.kind = 'fs';
    this.root = path.resolve(root);
  }

  #resolve(key) {
    const p = path.resolve(this.root, key);
    if (p !== this.root && !p.startsWith(this.root + path.sep)) {
      throw new Error(`key escapes storage root: ${key}`);
    }
    return p;
  }

  async put(key, body, _contentType) {
    const p = this.#resolve(key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, typeof body === 'string' ? body : new Uint8Array(body));
    await fs.rename(tmp, p);
  }

  async get(key) {
    const p = this.#resolve(key);
    let stat;
    try {
      stat = await fs.stat(p);
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
    if (!stat.isFile()) return null;
    return { body: Readable.toWeb(createReadStream(p)), size: stat.size };
  }

  async delete(key) {
    try {
      await fs.unlink(this.#resolve(key));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  async list(prefix = '') {
    const out = [];
    const walk = async (dir, rel) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (err) {
        if (err.code === 'ENOENT') return;
        throw err;
      }
      for (const e of entries) {
        const key = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(path.join(dir, e.name), key);
        else if (e.isFile() && !e.name.endsWith('.tmp') && key.startsWith(prefix)) out.push(key);
      }
    };
    await walk(this.root, '');
    return out.sort();
  }
}
