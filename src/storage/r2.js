// Cloudflare R2 storage via a Workers binding (no network signing needed).
export class R2Storage {
  constructor(bucket) {
    this.kind = 'r2';
    this.bucket = bucket;
  }

  async put(key, body, contentType) {
    await this.bucket.put(key, body, { httpMetadata: { contentType } });
  }

  async get(key) {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    return { body: obj.body, size: obj.size, contentType: obj.httpMetadata?.contentType };
  }

  async delete(key) {
    await this.bucket.delete(key);
  }

  async list(prefix = '') {
    const keys = [];
    let cursor;
    do {
      const page = await this.bucket.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) keys.push(o.key);
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return keys;
  }
}
