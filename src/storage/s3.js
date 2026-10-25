// S3-compatible storage (Ceph RGW, MinIO, AWS, R2-over-S3) using a minimal
// SigV4 signer on WebCrypto, so it runs unchanged on Node and on Workers.

const enc = new TextEncoder();

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256 = async (data) => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

// RFC 3986 encoding as S3 expects it (encodeURIComponent plus !'()*).
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const encodePath = (p) => p.split('/').map(rfc3986).join('/');

export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/**
 * Sign a request with AWS SigV4. Returns the headers to send (input headers
 * plus host, x-amz-date, x-amz-content-sha256 and authorization).
 */
export async function signRequest({ method, url, headers = {}, payloadHash = EMPTY_SHA256, accessKeyId, secretAccessKey, sessionToken, region = 'us-east-1', service = 's3', now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);

  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = String(v).trim().replace(/\s+/g, ' ');
  h.host = u.host;
  h['x-amz-date'] = amzDate;
  h['x-amz-content-sha256'] = payloadHash;
  if (sessionToken) h['x-amz-security-token'] = sessionToken;

  const signedHeaders = Object.keys(h).sort();
  const canonicalHeaders = signedHeaders.map((k) => `${k}:${h[k]}\n`).join('');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonicalRequest = [method, encodePath(decodeURIComponent(u.pathname)), query, canonicalHeaders, signedHeaders.join(';'), payloadHash].join('\n');
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonicalRequest)].join('\n');

  let key = await hmac(`AWS4${secretAccessKey}`, dateStamp);
  for (const part of [region, service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, stringToSign));

  const { host, ...send } = h; // fetch sets Host itself
  send.authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`;
  return send;
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&amp;/g, '&');

export class S3Storage {
  /**
   * @param {object} opts
   * @param {string} opts.endpoint e.g. http://127.0.0.1:7480 or https://<account>.r2.cloudflarestorage.com
   * @param {string} opts.bucket
   * @param {string} opts.accessKeyId
   * @param {string} opts.secretAccessKey
   * @param {string} [opts.region]
   * @param {boolean} [opts.pathStyle] default true (RGW, MinIO). false uses <bucket>.<host>.
   * @param {typeof fetch} [opts.fetch]
   */
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, sessionToken, region = 'us-east-1', pathStyle = true, fetch: fetchImpl }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) throw new Error('S3Storage needs endpoint, bucket, accessKeyId and secretAccessKey');
    this.kind = 's3';
    this.bucket = bucket;
    this.creds = { accessKeyId, secretAccessKey, sessionToken, region };
    this.fetch = fetchImpl || globalThis.fetch.bind(globalThis);
    const u = new URL(endpoint);
    this.pathStyle = pathStyle;
    this.base = pathStyle ? `${u.origin}/${bucket}` : `${u.protocol}//${bucket}.${u.host}`;
  }

  #url(key, query) {
    const u = new URL(`${this.base}/${encodePath(key)}`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) u.searchParams.set(k, v);
    return u.toString();
  }

  async #request(method, key, { query, body, headers = {} } = {}) {
    const url = this.#url(key, query);
    const bytes = body === undefined ? undefined : typeof body === 'string' ? enc.encode(body) : new Uint8Array(body);
    const payloadHash = bytes ? await sha256(bytes) : EMPTY_SHA256;
    const signed = await signRequest({ method, url, headers, payloadHash, ...this.creds });
    return this.fetch(url, { method, headers: signed, body: bytes });
  }

  async put(key, body, contentType = 'application/octet-stream') {
    const res = await this.#request('PUT', key, { body, headers: { 'content-type': contentType } });
    if (!res.ok) throw new Error(`S3 PUT ${key}: ${res.status} ${await res.text()}`);
  }

  async get(key) {
    const res = await this.#request('GET', key);
    if (res.status === 404) {
      await res.body?.cancel();
      return null;
    }
    if (!res.ok) throw new Error(`S3 GET ${key}: ${res.status} ${await res.text()}`);
    const len = res.headers.get('content-length');
    return { body: res.body, size: len ? Number(len) : undefined, contentType: res.headers.get('content-type') || undefined };
  }

  async delete(key) {
    const res = await this.#request('DELETE', key);
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key}: ${res.status} ${await res.text()}`);
    await res.body?.cancel();
  }

  async list(prefix = '') {
    const keys = [];
    let token;
    do {
      const res = await this.#request('GET', '', { query: { 'list-type': '2', prefix, 'continuation-token': token, 'max-keys': '1000' } });
      if (!res.ok) throw new Error(`S3 LIST ${prefix}: ${res.status} ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(unescapeXml(m[1]));
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      token = truncated ? unescapeXml(xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/)?.[1] || '') : undefined;
      if (truncated && !token) break;
    } while (token);
    return keys;
  }
}
